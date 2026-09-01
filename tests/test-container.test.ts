import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";

const ROOT = join(import.meta.dir, "..");
const RUNNER = join(ROOT, "scripts/test-container.ts");
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fakeContainer(system: "running" | "stopped" = "running", version = "1.3.0") {
  const dir = mkdtempSync(join(tmpdir(), "ocx-container-cli-"));
  dirs.push(dir);
  const record = join(dir, "calls.jsonl");
  const executable = join(dir, "container");
  writeFileSync(executable, `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.OCX_CONTAINER_RECORD!, JSON.stringify(args) + "\\n");
if (args[0] === "--version") { console.log("container version ${version}"); process.exit(0); }
if (args[0] === "system" && args[1] === "status") process.exit(${system === "running" ? 0 : 1});
if (args[0] === "builder" && args[1] === "status") {
  if (process.env.OCX_FAKE_BUILDER_EXISTS === "1") console.log("buildkit");
  process.exit(0);
}
if (args[0] === process.env.OCX_FAKE_FAIL) process.exit(1);
process.exit(0);
`);
  chmodSync(executable, 0o755);
  return { dir, record };
}

function run(system: "running" | "stopped" = "running", args: string[] = [], version = "1.3.0", env: Record<string, string> = {}) {
  const fake = fakeContainer(system, version);
  const result = Bun.spawnSync([process.execPath, "run", RUNNER, ...args], {
    cwd: ROOT, env: { ...process.env, ...env, PATH: `${fake.dir}:${process.env.PATH}`, OCX_CONTAINER_RECORD: fake.record }, stdout: "pipe", stderr: "pipe",
  });
  const calls = existsSync(fake.record) ? readFileSync(fake.record, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) as string[][] : [];
  return { result, calls };
}
function output(result: ReturnType<typeof Bun.spawnSync>) { return new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr); }

test("build precedes the locked-down run with exact flags", () => {
  const { result, calls } = run();
  expect(result.exitCode).toBe(0);
  expect(calls[2]).toEqual(["builder", "status", "--quiet"]);
  const image = calls[3]?.[2];
  expect(image).toMatch(/^opencodex-test-\d+$/);
  expect(calls[3]).toEqual(["build", "--tag", image, "--file", "Containerfile.test", "."]);
  expect(calls[4]).toEqual([
    "run", "--rm", "--init", "--read-only", "--cap-drop", "ALL", "--network", "none", "--no-dns",
    "--cpus", "8", "--memory", "8G", "--tmpfs", "/tmp", "--tmpfs", "/home/ocx", "--user", "ocx",
    "--env", "HOME=/home/ocx", "--env", "TMPDIR=/tmp", "--env", "XDG_CACHE_HOME=/home/ocx/.cache",
    image, "bun", "scripts/test-container-entrypoint.ts",
  ]);
  expect(calls[4].some(arg => ["--mount", "--volume", "--publish", "-p", "--env-file", "--ssh"].includes(arg))).toBe(false);
  expect(calls.slice(5)).toEqual([
    ["image", "delete", "--force", image],
    ["builder", "delete", "--force"],
  ]);
});

test("rejects positional arguments before touching Container", () => {
  const { result, calls } = run("running", ["unexpected"]);
  expect(result.exitCode).not.toBe(0);
  expect(output(result)).toContain("does not accept arguments");
  expect(calls).toEqual([]);
});

test("passes only resource overrides", () => {
  const { result, calls } = run("running", [], "1.3.0", { OCX_CONTAINER_CPUS: "2", OCX_CONTAINER_MEMORY: "3G" });
  expect(result.exitCode).toBe(0);
  expect(calls[4]).toContain("2");
  expect(calls[4]).toContain("3G");
});

test("refuses to grow a pre-existing global builder unless explicitly allowed", () => {
  const refused = run("running", [], "1.3.0", { OCX_FAKE_BUILDER_EXISTS: "1" });
  expect(refused.result.exitCode).not.toBe(0);
  expect(output(refused.result)).toContain("OCX_CONTAINER_USE_SHARED_BUILDER=1");
  expect(refused.calls).toEqual([["--version"], ["system", "status"], ["builder", "status", "--quiet"]]);

  const allowed = run("running", [], "1.3.0", {
    OCX_FAKE_BUILDER_EXISTS: "1",
    OCX_CONTAINER_USE_SHARED_BUILDER: "1",
  });
  expect(allowed.result.exitCode).toBe(0);
  expect(allowed.calls.at(-1)?.slice(0, 3)).toEqual(["image", "delete", "--force"]);
  expect(allowed.calls.some(call => call[0] === "builder" && call[1] === "delete")).toBe(false);
});

test("cleans its image and builder when the container test fails", () => {
  const { result, calls } = run("running", [], "1.3.0", { OCX_FAKE_FAIL: "run" });
  expect(result.exitCode).not.toBe(0);
  expect(output(result)).toContain("Container test run failed");
  const image = calls.find(call => call[0] === "build")?.[2];
  expect(calls.slice(-2)).toEqual([
    ["image", "delete", "--force", image],
    ["builder", "delete", "--force"],
  ]);
});

test("rejects zero and malformed resources before build", () => {
  for (const env of [{ OCX_CONTAINER_CPUS: "0" }, { OCX_CONTAINER_MEMORY: "0G" }, { OCX_CONTAINER_MEMORY: "wat" }]) {
    const { result, calls } = run("running", [], "1.3.0", env);
    expect(result.exitCode).not.toBe(0);
    expect(output(result)).toContain("positive Container memory value");
    expect(calls).toEqual([["--version"], ["system", "status"]]);
  }
});

test("fails clearly for unavailable service and old CLI", () => {
  const stopped = run("stopped");
  expect(output(stopped.result)).toContain("container system start");
  expect(stopped.calls).toEqual([["--version"], ["system", "status"]]);
  const old = run("running", [], "1.2.9");
  expect(output(old.result)).toContain("1.3.0 or newer");
  expect(old.calls).toEqual([["--version"]]);
});

test("image and ignore policy freeze dependencies and exclude host state", () => {
  const packageJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const image = readFileSync(join(ROOT, "Containerfile.test"), "utf8");
  const ignored = readFileSync(join(ROOT, ".dockerignore"), "utf8").split("\n");
  const entrypoint = readFileSync(join(ROOT, "scripts/test-container-entrypoint.ts"), "utf8");
  expect(packageJson.scripts?.["test:container"]).toBe("bun scripts/test-container.ts");
  expect(image).toContain("FROM oven/bun:1.4.0@sha256:5ff609364c049b54eb0ff560ec96319729a972078ef2c755d758f0c6ef89c2d6");
  expect(image.match(/bun install --frozen-lockfile/g)).toHaveLength(3);
  expect(image).toContain("bun run build");
  expect(image).toContain("git init");
  expect(image).toContain("git add -A");
  expect(image).toContain("test -z \"$(git remote)\"");
  expect(image).toContain("USER ocx");
  for (const pin of ["adduser=3.152", "git=1:2.47.3-0+deb13u1", "jq=1.7.1-6+deb13u3", "nodejs=20.19.2+dfsg-1+deb13u2", "procps=2:4.0.4-9", "net-tools=2.10-1.3", "ca-certificates=20250419"]) expect(image).toContain(pin);
  expect(image).toContain("commit -qm container-baseline");
  expect(image).toContain("find /app -path");
  expect(image).toContain("-name '*.pem'");
  expect(image).toContain("-name '*.db'");
  expect(image).toContain("! -path '/app/tests/fixtures/network-tls-test-cert.pem'");
  expect(image).toContain("! -path '/app/tests/fixtures/network-tls-test-key.pem'");
  expect(image).toContain("-path '*/node_modules' -prune -o");
  expect(image.indexOf("-name '*.db' \\) ! -path")).toBeGreaterThan(image.indexOf("find /app -path"));
  expect(image).not.toContain("OCX_REPLIT_GATEWAY_DEPS_PREINSTALLED");
  expect(entrypoint).toContain("process.getuid?.() === 0");
  expect(entrypoint).toContain("/app");
  expect(entrypoint).toContain("/tmp");
  expect(entrypoint).toContain("/home/ocx");
  expect(entrypoint).toContain('readdirSync("/sys/class/net")');
  expect(entrypoint).toContain('writeFileSync("/app/.ocx-write-test"');
  expect(entrypoint).toContain("let appWriteSucceeded = false");
  expect(entrypoint).toMatch(/if \(appWriteSucceeded\)[\s\S]*throw new Error\("\/app must be unwritable"\)/);
  expect(entrypoint).toContain('const workspace = "/tmp/ocx-test-workspace"');
  expect(entrypoint).toContain('OCX_TEST_NETWORK_ISOLATED: "1"');
  expect(entrypoint).toContain('["cp", "-a", "/app/.", workspace]');
  expect(entrypoint).toContain('["chmod", "-R", "u+rwX", workspace]');
  expect(entrypoint).toContain('await run(workspace, ["run", "test", "--timeout", "60000"])');
  expect(entrypoint).toContain('await run(`${workspace}/integrations/replit-gateway`, ["run", "test", "--timeout", "60000"])');
  expect(entrypoint).toContain("[\"run\", \"test\", \"--timeout\", \"60000\"]");
  expect(entrypoint.indexOf('writeFileSync("/app/.ocx-write-test"')).toBeLessThan(entrypoint.indexOf('const workspace = "/tmp/ocx-test-workspace"'));
  expect(entrypoint).not.toContain('await run("/app", ["run", "test"])');
  expect(entrypoint).not.toContain('await run("/app/integrations/replit-gateway", ["run", "test"])');
  for (const pattern of [".git", ".worktrees", ".tmp", ".planning", ".agents", ".claude", ".cursor", ".windsurf", ".ssh", ".gnupg", ".aws", ".docker/config.json", "**/.docker/config.json", ".config/containers/auth.json", "**/.config/containers/auth.json", ".config/gh/hosts.yml", "**/.config/gh/hosts.yml", "**/.opencodex", "**/.env.*", "**/.npmrc", "**/.netrc", "**/.pypirc", "**/auth.json", "**/credentials.json", "**/node_modules", "dist", "gui/dist", "*.log", "coverage", "*.tgz", "*.tar", "*.zip", "**/*.pem", "**/*.key", "**/*.p12", "**/*.pfx", "**/*.jks", "**/*.sqlite", "**/*.sqlite3", "**/*.db"]) expect(ignored).toContain(pattern);
  expect(ignored).toContain("!tests/fixtures/network-tls-test-cert.pem");
  expect(ignored).toContain("!tests/fixtures/network-tls-test-key.pem");
  expect(ignored.indexOf("!tests/fixtures/network-tls-test-cert.pem")).toBeGreaterThan(ignored.indexOf("**/*.pem"));
  expect(ignored.indexOf("!tests/fixtures/network-tls-test-key.pem")).toBeGreaterThan(ignored.indexOf("**/*.key"));
});
