/** Hosted Linux Docker acceptance only; never uses provider credentials or inference. */
import { spawn } from "node:child_process";
import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const project = `ocx-smoke-${randomBytes(12).toString("hex")}`;
const image = `${project}:local`;
const cancelled = new AbortController();
const outputLimit = 8 * 1024 * 1024;
let stage = "initialization";
let scratch = "";
let composeArgs: string[] = [];
let env: Record<string, string> = {};

class SmokeFailure extends Error {}

function check(ok: unknown, message: string): asserts ok {
  if (!ok) throw new SmokeFailure(message);
}

// Do not include arguments, child output, HTTP bodies, or arbitrary error messages in diagnostics.
function progress(name: string): void {
  stage = name;
  console.log(`docker-smoke: ${name}`);
}

async function run(args: string[], input?: string, timeout = 30_000, cleanup = false) {
  if (!cleanup) cancelled.signal.throwIfAborted();
  return await new Promise<{ code: number | null; out: string }>((accept, reject) => {
    const child = spawn(args[0]!, args.slice(1), {
      cwd: root, env, detached: true, stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failed = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let reapTimer: ReturnType<typeof setTimeout> | undefined;
    const killGroup = (signal: NodeJS.Signals) => {
      if (child.pid) {
        try { process.kill(-child.pid, signal); } catch { /* already exited */ }
      }
    };
    const stop = () => {
      if (failed) return;
      failed = true;
      killGroup("SIGTERM");
      killTimer = setTimeout(() => killGroup("SIGKILL"), 1_000);
      // A daemon/plugin retaining a pipe must not keep the harness alive indefinitely.
      reapTimer = setTimeout(() => {
        child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy();
        finish();
        child.unref();
        reject(new SmokeFailure("child did not close within the termination deadline"));
      }, 4_000);
    };
    const timer = setTimeout(stop, timeout);
    const finish = () => {
      clearTimeout(timer); clearTimeout(killTimer); clearTimeout(reapTimer);
      cancelled.signal.removeEventListener("abort", stop);
    };
    if (!cleanup) cancelled.signal.addEventListener("abort", stop, { once: true });
    const collect = (data: Buffer, stdout: boolean) => {
      bytes += data.length;
      if (bytes > outputLimit) stop();
      else if (stdout) chunks.push(data);
    };
    child.stdout.on("data", (data: Buffer) => collect(data, true));
    child.stderr.on("data", (data: Buffer) => collect(data, false));
    child.stdin.on("error", () => { /* EPIPE is possible on the refused bootstrap. */ });
    child.on("error", () => { finish(); reject(new SmokeFailure("child could not start")); });
    child.on("close", code => {
      // A terminated CLI can close its pipes before its plugin exits.
      if (failed) killGroup("SIGKILL");
      finish();
      if (failed) reject(new SmokeFailure("child exceeded time/output limit or was cancelled"));
      else accept({ code, out: Buffer.concat(chunks).toString("utf8") });
    });
    child.stdin.end(input);
  });
}

async function command(args: string[], input?: string, timeout?: number, cleanup = false) {
  const result = await run(args, input, timeout, cleanup);
  check(result.code === 0, `command exited ${result.code ?? "by signal"}`);
  return result.out.trim();
}

function compose(args: string[], input?: string, timeout?: number, cleanup = false) {
  return command(["docker", ...composeArgs, ...args], input, timeout, cleanup);
}

async function build() {
  const directory = join(root, "src/generated");
  const manifest = join(directory, "compatibility-version.json");
  const directoryStat = lstatSync(directory, { throwIfNoEntry: false });
  const hadDirectory = directoryStat !== undefined;
  check(!directoryStat || directoryStat.isDirectory(), "unsafe generated directory");
  const originalStat = lstatSync(manifest, { throwIfNoEntry: false });
  check(!originalStat || originalStat.isFile(), "unsafe existing manifest");
  check(!originalStat || originalStat.size <= 8 * 1024 * 1024, "existing manifest exceeds limit");
  const original = originalStat ? readFileSync(manifest) : undefined;
  try {
    progress("generate compatibility manifest");
    await command([process.execPath, "scripts/generate-compatibility-version.ts"]);
    progress("build Docker image");
    await compose(["build", "hub"], undefined, 600_000);
  } finally {
    if (original && originalStat) {
      writeFileSync(manifest, original);
      chmodSync(manifest, originalStat.mode & 0o777);
      utimesSync(manifest, originalStat.atime, originalStat.mtime);
    } else {
      rmSync(manifest, { force: true });
    }
    if (!hadDirectory && existsSync(directory)) rmdirSync(directory);
  }
}

const fixture = JSON.stringify({ models: [{
  slug: "smoke/synthetic", display_name: "Smoke fixture", description: "Synthetic catalog only",
  priority: 1, visibility: "list", base_instructions: "Synthetic", input_modalities: ["text"],
}] });
const token = randomBytes(32).toString("hex");
const replacement = randomBytes(32).toString("hex");
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
let seededConfigHash = "";
let readyConfigHash = "";
export const smokePublicOrigin = "https://localhost:19346";

// Check the loader, including its schema-repair/default-provider fallback, before server startup
// and again in each running container. This isolates synthetic inference, not all process egress.
const fixtureConfigCheck = `
  const { loadConfig } = await import('./src/config.ts');
  const effective = loadConfig();
  const provider = effective.providers.smoke;
  if (Object.keys(effective.providers).join(',') !== 'smoke' || effective.defaultProvider !== 'smoke'
    || provider?.adapter !== 'openai-responses' || provider?.authMode !== 'local'
    || provider?.allowPrivateNetwork !== true
    || provider?.baseUrl !== 'http://127.0.0.1:9/v1' || provider?.codexAccountMode !== undefined || provider?.apiKey
    || effective.runtimeRole !== 'hub' || effective.hostname !== '0.0.0.0' || effective.port !== 10100
    || effective.codexAutoStart !== false || effective.codexShimAutoRestore !== false) throw new Error('unsafe effective fixture config');
`;

interface Container {
  Id: string;
  State: { Running: boolean; Health?: { Status: string } };
  HostConfig: { ReadonlyRootfs: boolean; CapDrop: string[]; SecurityOpt: string[]; Privileged: boolean };
  Config: { Image: string; Labels: Record<string, string> };
  NetworkSettings: { Ports: Record<string, Array<{ HostIp: string; HostPort: string }> | null> };
  Mounts: Array<{ Type: string; Name?: string; Destination: string; RW: boolean }>;
}

async function inspect() {
  const id = await compose(["ps", "-q", "hub"]);
  check(/^[a-f0-9]{64}$/.test(id), "expected exactly one container");
  const rows = JSON.parse(await command(["docker", "inspect", id])) as Container[];
  check(rows.length === 1, "unexpected inspect result");
  const container = rows[0]!;
  check(container.Id === id && container.Config.Image === image
    && container.Config.Labels["com.docker.compose.project"] === project, "container identity mismatch");
  check(container.State.Running && container.State.Health?.Status === "healthy", "container not healthy");
  check(container.HostConfig.ReadonlyRootfs && !container.HostConfig.Privileged
    && container.HostConfig.CapDrop.includes("ALL")
    && container.HostConfig.SecurityOpt.some(value => /^no-new-privileges(?::true)?$/.test(value)), "restrictions missing");
  const ports = Object.entries(container.NetworkSettings.Ports).filter(([, entries]) => entries?.length);
  check(ports.length === 1 && ports[0]![0] === "10100/tcp", "unexpected published port");
  const bindings = ports[0]![1]!;
  check(bindings.length === 1 && bindings[0]!.HostIp === "127.0.0.1", "non-loopback publication");
  const port = Number(bindings[0]!.HostPort);
  check(Number.isInteger(port) && port > 0 && port <= 65535, "invalid host port");
  const volumes = [".opencodex", ".codex"].map(home => {
    const mounts = container.Mounts.filter(mount => mount.Destination === `/home/bun/${home}`);
    check(mounts.length === 1, "missing home mount");
    const mount = mounts[0]!;
    check(mount.Type === "volume" && mount.RW && mount.Name?.startsWith(`${project}_`), "unexpected home volume");
    return mount.Name;
  });
  check(volumes[0] !== volumes[1], "homes share a volume");
  check(port !== 10100, "production host port is not a smoke target");
  return { id, volumes, url: `https://127.0.0.1:${port}` };
}

// This runs as the image's user. Only hashes/metadata leave the container, never file bytes.
const stateProbe = `
  import { readFileSync, statSync, writeFileSync } from 'node:fs';
  import { createHash } from 'node:crypto';
  import { isDeepStrictEqual } from 'node:util';
  const phase = await Bun.stdin.text();
  if (!['seed', 'first-ready', 'steady'].includes(phase)) throw new Error('invalid state phase');
  ${fixtureConfigCheck}
  const homes = ['/home/bun/.opencodex', '/home/bun/.codex'];
  if (process.env.OCX_SERVICE !== '1') throw new Error('image service lifecycle mode missing');
  const uid = process.getuid();
  if (uid === 0) throw new Error('root user');
  const status = readFileSync('/proc/self/status', 'utf8');
  if (!/^CapEff:\\s+0+$/m.test(status) || !/^NoNewPrivs:\\s+1$/m.test(status)) throw new Error('effective restrictions');
  for (const home of homes) {
    const s = statSync(home);
    if (s.uid !== uid || (s.mode & 0o777) !== 0o700) throw new Error('home permissions');
  }
  try { writeFileSync('/home/bun/app/.smoke-root-write', 'x'); throw new Error('writable root'); }
  catch (e) { if (e.code !== 'EROFS') throw e; }
  const paths = [homes[0] + '/config.json', homes[0] + '/service-api-token', homes[1] + '/opencodex-catalog.json'];
  if (phase !== 'seed') paths.push(homes[0] + '/container-tls/cert.pem', homes[0] + '/container-tls/key.pem');
  const hashes = paths.map(path => {
    const s = statSync(path);
    const expectedMode = path.endsWith('/container-tls/cert.pem') ? 0o644 : 0o600;
    if (s.uid !== uid || (s.mode & 0o777) !== expectedMode || s.size > 65536) throw new Error('file permissions/size');
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  });
  // The immutable shipped config was byte-verified before fixture creation. Reconstruct only
  // the deliberate fixture route edits, then compare every original key on disk (not loader defaults).
  const seed = JSON.parse(readFileSync('docker/config.json', 'utf8'));
  seed.providers = { smoke: { adapter: 'openai-responses', baseUrl: 'http://127.0.0.1:9/v1', authMode: 'local', allowPrivateNetwork: true } };
  seed.defaultProvider = 'smoke';
  const persisted = JSON.parse(readFileSync(paths[0], 'utf8'));
  const loaded = JSON.parse(JSON.stringify(effective));
  for (const key of Object.keys(seed)) {
    for (const config of [persisted, loaded]) {
      if (!Object.hasOwn(config, key) || !isDeepStrictEqual(config[key], seed[key])) throw new Error('seed semantics changed');
    }
  }
  // Independent oracle measured by isolated startup; update only for an intentional contract change.
  // Do not derive expected values from runtime migration/default helpers.
  const additions = {
    appOwnedMemoryBudgetMb: 256, fastRows: true, managementUsageMaxReadBytes: 67108864,
    openaiProviderTierVersion: 2,
    subagentModels: ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'],
    subagentModelsVersion: 1,
    ...(phase === 'seed' ? {} : { tls: {
      certFile: '/home/bun/.opencodex/container-tls/cert.pem',
      keyFile: '/home/bun/.opencodex/container-tls/key.pem',
      publicOrigin: ${JSON.stringify(smokePublicOrigin)},
    } }),
  };
  for (const config of [persisted, loaded]) {
    if (Object.keys(config).some(key => !Object.hasOwn(seed, key) && !Object.hasOwn(additions, key))) throw new Error('unexpected startup config addition');
    for (const [key, expected] of Object.entries(additions)) {
      if (phase !== 'seed' || Object.hasOwn(config, key)) {
        if (!Object.hasOwn(config, key) || !isDeepStrictEqual(config[key], expected)) throw new Error('startup oracle mismatch');
      }
    }
  }
  if (phase === 'seed' && Object.keys(persisted).some(key => !Object.hasOwn(seed, key))) throw new Error('premature seed addition');
  console.log(JSON.stringify(hashes));
`;

async function state(phase: "seed" | "first-ready" | "steady" = "steady") {
  const invocation = phase === "seed" ? ["run", "--rm", "-T", "--no-deps"] : ["exec", "-T"];
  const hashes = JSON.parse(await compose([...invocation, "hub", "bun", "-e", stateProbe], phase)) as string[];
  check(hashes.length === (phase === "seed" ? 3 : 5) && hashes.every(hash => /^[a-f0-9]{64}$/.test(hash)), "invalid state evidence");
  check(hashes[1] === sha256(`${token}\n`) && hashes[2] === sha256(fixture), "token/catalog changed");
  if (phase === "first-ready") {
    check(!readyConfigHash, "post-start config baseline already established");
    // stateProbe has checked persisted/effective semantics and the independent startup oracle.
    readyConfigHash = hashes[0]!;
  } else {
    check(hashes[0] === (phase === "seed" ? seededConfigHash : readyConfigHash),
      phase === "seed" ? "seeded config changed before startup" : "post-start config changed");
  }
  return JSON.stringify(hashes);
}

export async function smokeRequest(url: string, path: string, certificate: string, secret?: string) {
  const target = new URL(url);
  check(target.protocol === "https:" && target.hostname === "127.0.0.1"
    && target.port !== "10100" && target.port !== "0" && target.port !== ""
    && !target.username && !target.password && target.pathname === "/" && !target.search && !target.hash,
  "smoke requires isolated loopback HTTPS");
  check(["/healthz", "/readyz", "/v1/catalog", "/v1/responses", "/v1/responses/compact"].includes(path), "unexpected smoke path");
  check(certificate.length <= 65536 && new X509Certificate(certificate).checkIP("127.0.0.1"), "invalid smoke certificate");
  const controller = new AbortController();
  const abort = () => controller.abort();
  cancelled.signal.throwIfAborted();
  cancelled.signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, 5_000);
  try {
    const post = path !== "/healthz" && path !== "/readyz" && path !== "/v1/catalog";
    const response = await fetch(`${url}${path}`, {
      method: post ? "POST" : "GET", redirect: "error", signal: controller.signal,
      // Trust only the public certificate read from this owned disposable container.
      // Keep certificate-chain and hostname verification enabled.
      tls: { ca: certificate, rejectUnauthorized: true },
      headers: { ...(secret ? { "x-opencodex-api-key": secret } : {}), ...(post ? { "content-type": "application/json" } : {}) },
      // Never send an authorized inference request, even with synthetic input.
      body: post ? '{"model":"smoke/synthetic","input":[]}' : undefined,
    });
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (reader) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.length;
        check(size <= 64 * 1024, "HTTP body exceeds limit");
        chunks.push(next.value);
      }
    } finally { controller.abort(); reader?.releaseLock(); }
    return { status: response.status, body: Buffer.concat(chunks).toString("utf8") };
  } finally {
    clearTimeout(timer);
    cancelled.signal.removeEventListener("abort", abort);
  }
}

async function acceptance(url: string, certificate: string) {
  check((await smokeRequest(url, "/healthz", certificate)).status === 200, "liveness failed");
  const deadline = Date.now() + 60_000;
  while (true) {
    const ready = await smokeRequest(url, "/readyz", certificate);
    const body = JSON.parse(ready.body) as { status?: string };
    if (ready.status === 200 && body.status === "ready") break;
    check(ready.status === 503 && body.status === "pending" && Date.now() < deadline, "readiness failed");
    await Bun.sleep(500);
  }
  for (const path of ["/v1/catalog", "/v1/responses", "/v1/responses/compact"]) {
    for (const secret of [undefined, replacement]) {
      const result = await smokeRequest(url, path, certificate, secret);
      check(result.status === 401, `${path} ${secret ? "wrong" : "missing"} token returned ${result.status}, expected 401`);
    }
  }
  const catalog = await smokeRequest(url, "/v1/catalog", certificate, token);
  check(catalog.status === 200 && catalog.body === fixture, "catalog not served exactly");
}

async function cleanup() {
  let failed = false;
  const attempt = async (action: () => Promise<unknown>) => {
    try { await action(); } catch { failed = true; }
  };
  if (composeArgs.length) {
    await attempt(() => compose(["down", "--volumes", "--remove-orphans", "--timeout", "10"], undefined, 45_000, true));
    for (const kind of ["container", "volume", "network"]) {
      await attempt(async () => {
        const remaining = await command(["docker", kind, "ls", "-q", ...(kind === "container" ? ["-a"] : []),
          "--filter", `label=com.docker.compose.project=${project}`], undefined, 15_000, true);
        check(!remaining, "project resources remain");
      });
    }
    await attempt(async () => {
      const ids = await command(["docker", "image", "ls", "-q", "--filter", `reference=${image}`], undefined, 15_000, true);
      if (ids) await command(["docker", "image", "rm", image], undefined, 30_000, true);
      check(!await command(["docker", "image", "ls", "-q", "--filter", `reference=${image}`], undefined, 15_000, true), "image remains");
    });
  }
  try { if (scratch) rmSync(scratch, { recursive: true, force: true, maxRetries: 0 }); } catch { failed = true; }
  check(!failed, "cleanup incomplete");
}

async function main() {
  check(process.platform === "linux", "requires a disposable Linux Docker runner");
  scratch = mkdtempSync(join(tmpdir(), `${project}-`));
  mkdirSync(join(scratch, "docker"), { mode: 0o700 });
  writeFileSync(join(scratch, "empty.env"), "", { mode: 0o600 });
  writeFileSync(join(scratch, "override.json"), JSON.stringify({
    services: { hub: { image, restart: "no" } },
  }), { mode: 0o600 });
  env = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", TMPDIR: scratch,
    DOCKER_CONFIG: join(scratch, "docker"), DOCKER_HOST: "unix:///var/run/docker.sock",
    COMPOSE_DISABLE_ENV_FILE: "1", OPENCODEX_BIND_ADDRESS: "127.0.0.1", OPENCODEX_PORT: "0",
    // Public-origin override is independent of Docker's ephemeral host-port allocation.
    // Exercise the explicit operator origin while connecting to the inspected host binding.
    OPENCODEX_PUBLIC_ORIGIN: smokePublicOrigin,
  };
  composeArgs = ["compose", "--project-name", project, "--project-directory", root,
    "--env-file", join(scratch, "empty.env"), "-f", join(root, "compose.yaml"), "-f", join(scratch, "override.json")];
  progress("validate and build");
  await compose(["config", "--quiet"]);
  await build();
  progress("verify shipped config and seed loopback-only fixture");
  const seeded = await run(["docker", ...composeArgs, "run", "--rm", "-T", "--no-deps", "hub", "bun", "-e",
    `
      import { readFileSync, writeFileSync } from 'node:fs';
      import { createHash } from 'node:crypto';
      // Exit codes are fixed diagnostic markers; never serialize the caught exception.
      let seedStage = 70;
      try {
      const { atomicWriteFile } = await import('./src/config/atomic-write.ts');
      seedStage = 71;
      const { shipped, catalog } = JSON.parse(await Bun.stdin.text());
      const path = '/home/bun/.opencodex/config.json';
      seedStage = 72;
      if (readFileSync(path, 'utf8') !== shipped || readFileSync('docker/config.json', 'utf8') !== shipped) {
        throw new Error('shipped config mismatch');
      }
      const config = JSON.parse(shipped);
      if (config.runtimeRole !== 'hub' || config.hostname !== '0.0.0.0' || config.port !== 10100
        || config.codexAutoStart !== false || config.codexShimAutoRestore !== false) throw new Error('shipped runtime contract');
      // Port 9 has no listener in this image. Replace all provider routes before any server starts;
      // even an admission regression cannot send these synthetic requests to a real provider.
      config.providers = { smoke: { adapter: 'openai-responses', baseUrl: 'http://127.0.0.1:9/v1', authMode: 'local', allowPrivateNetwork: true } };
      config.defaultProvider = 'smoke';
      seedStage = 73;
      const { validateConfigCandidate } = await import('./src/config.ts');
      if (!validateConfigCandidate(config).ok) throw new Error('invalid fixture');
      seedStage = 74;
      atomicWriteFile(path, JSON.stringify(config) + '\\n');
      seedStage = 75;
      ${fixtureConfigCheck}
      seedStage = 76;
      writeFileSync('/home/bun/.codex/opencodex-catalog.json', catalog, { mode: 0o600, flag: 'wx' });
      seedStage = 77;
      console.log(createHash('sha256').update(readFileSync(path)).digest('hex'));
      } catch { process.exitCode = seedStage; }
    `], JSON.stringify({ shipped: readFileSync(join(root, "docker/config.json"), "utf8"), catalog: fixture }));
  const seedFailures: Record<number, string> = {
    70: "imports", 71: "input", 72: "shipped config contract", 73: "fixture validation",
    74: "atomic config write", 75: "effective config", 76: "catalog write", 77: "config hash",
  };
  check(seeded.code === 0, `seed failed: ${seedFailures[seeded.code ?? -1] ?? "unclassified child failure"} (exit ${seeded.code ?? "signal"})`);
  seededConfigHash = seeded.out.trim();
  check(/^[a-f0-9]{64}$/.test(seededConfigHash), "invalid seeded config evidence");
  progress("bootstrap throwaway token");
  await compose(["run", "--rm", "-T", "--no-deps", "hub", "bun", "run", "docker/bootstrap-token.ts"], `${token}\n`);
  progress("verify exact seed state before startup");
  await state("seed");
  progress("start and check admission");
  await compose(["up", "--no-build", "--wait", "--wait-timeout", "120", "hub"], undefined, 150_000);
  const first = await inspect();
  const certificate = await compose(["exec", "-T", "hub", "bun", "-e",
    "const p='/home/bun/.opencodex/container-tls/cert.pem'; const s=require('node:fs').lstatSync(p); if(!s.isFile() || s.size>65536) process.exit(1); process.stdout.write(require('node:fs').readFileSync(p,'utf8'));"]);
  await acceptance(first.url, certificate);
  const before = await state("first-ready");
  progress("refuse token replacement");
  const refused = await run(["docker", ...composeArgs, "run", "--rm", "-T", "--no-deps", "hub",
    "bun", "run", "docker/bootstrap-token.ts"], `${replacement}\n`);
  check(refused.code === 1, "bootstrap did not refuse replacement");
  check(await state() === before, "state changed after refused bootstrap");
  await acceptance(first.url, certificate);
  progress("replace container and verify persistence");
  await compose(["up", "--no-build", "--force-recreate", "--wait", "--wait-timeout", "120", "hub"], undefined, 150_000);
  const second = await inspect();
  check(second.id !== first.id && JSON.stringify(second.volumes) === JSON.stringify(first.volumes), "replacement/volume identity failed");
  check(await state() === before, "persistent state changed");
  await acceptance(second.url, certificate);
}

if (import.meta.main) {
  const abort = () => cancelled.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  const deadline = setTimeout(abort, 16 * 60_000);
  try {
    await main();
  } catch (error) {
    const reason = error instanceof SmokeFailure ? error.message : "unexpected failure; details suppressed";
    console.error(`docker-smoke: failed at ${stage}: ${reason}`);
    process.exitCode = 1;
  } finally {
    clearTimeout(deadline);
    try { await cleanup(); } catch {
      console.error("docker-smoke: cleanup incomplete");
      process.exitCode = 1;
    }
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
  if (!process.exitCode) console.log("docker-smoke: build/start/recreate acceptance passed; cleanup complete");
}
