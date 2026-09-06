import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const workflow = readFileSync(join(import.meta.dir, "..", ".github", "workflows", "live-inference.yml"), "utf8");
const supervisorPath = join(import.meta.dir, "..", "scripts", "live-inference-supervisor.ts");
const supervisorSource = readFileSync(supervisorPath, "utf8");

function cleanupScript(): string {
  const stepStart = workflow.indexOf("      - name: Stop proxy and remove credentials");
  const runStart = workflow.indexOf("        run: |\n", stepStart) + "        run: |\n".length;
  const stepEnd = workflow.indexOf("\n      - name:", runStart);
  expect(stepStart).toBeGreaterThanOrEqual(0);
  expect(runStart).toBeGreaterThan("        run: |\n".length - 1);
  expect(stepEnd).toBeGreaterThan(runStart);
  return workflow.slice(runStart, stepEnd)
    .split("\n")
    .map(line => line.startsWith("          ") ? line.slice(10) : line)
    .join("\n")
    .replaceAll("${{ matrix.provider }}", "fixture");
}

function runCleanup(runnerTemp: string, opencodexHome: string, path = process.env.PATH): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync(["bash", "-e", "-o", "pipefail", "-c", cleanupScript()], {
    env: {
      ...process.env,
      PATH: path ?? "",
      RUNNER_TEMP: runnerTemp,
      OPENCODEX_HOME: opencodexHome,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function waitForFile(path: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path) && Date.now() < deadline) await Bun.sleep(20);
  expect(existsSync(path)).toBe(true);
}

describe("live inference workflow hardening", () => {
  test("runs only trusted dev code with minimal mutation permission", () => {
    expect(workflow).toContain("branches: [dev]");
    expect(workflow).toContain("github.ref == 'refs/heads/dev'");
    expect(workflow).toContain("permissions: {}");
    expect(workflow).toMatch(/changes:[\s\S]*?permissions:\n      contents: read/);
    expect(workflow).toMatch(/live:[\s\S]*?permissions:\n      contents: read\n      issues: write/);
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).not.toContain("pull_request_target:");
  });

  test("uses ephemeral homes and removes credentials before calling the supervisor", () => {
    expect(workflow).toContain("secrets[matrix.secret_name]");
    expect(workflow).toContain("mktemp -d");
    expect(workflow).toContain("OCX_LIVE_SMOKE_BUNDLE_B64");
    expect(workflow).toContain("rm -rf --");
    expect(workflow.indexOf("Stop proxy and remove credentials"))
      .toBeLessThan(workflow.indexOf("Reconcile Jules live-inference supervision"));
  });

  test("uses an owning supervisor and removes credentials only after its exit receipt", () => {
    const cleanup = cleanupScript();
    const receipt = cleanup.indexOf('[ ! -s "$control_dir/stopped" ]');
    const remove = cleanup.indexOf('rm -rf -- "$OPENCODEX_HOME"');
    const absence = cleanup.lastIndexOf('[ -e "$OPENCODEX_HOME" ]');

    expect(workflow).toContain("scripts/live-inference-supervisor.ts");
    expect(workflow.match(/scripts\/live-inference-supervisor\.ts/g)).toHaveLength(3);
    expect(supervisorSource).toContain("detached: true");
    expect(supervisorSource.indexOf('process.on("SIGTERM"'))
      .toBeLessThan(supervisorSource.indexOf("Bun.spawn(command"));
    expect(supervisorSource).toContain('signalGroup("SIGTERM")');
    expect(supervisorSource).toContain('signalGroup("SIGKILL")');
    expect(supervisorSource.indexOf("waitForGroupExit"))
      .toBeLessThan(supervisorSource.indexOf('atomicReceipt(controlDir, "stopped"'));
    expect(cleanup).not.toContain("kill ");
    expect(receipt).toBeGreaterThanOrEqual(0);
    expect(remove).toBeGreaterThan(receipt);
    expect(absence).toBeGreaterThan(remove);
    expect(cleanup).toContain('"$canonical_runner_temp"/ocx-live-home.*)');
    expect(cleanup).toContain('if [ "$cleanup_failed" = false ] && [ -n "${OPENCODEX_HOME:-}" ]');
    expect(cleanup).toContain("Retaining the credential home because proxy exit is unconfirmed");
  });

  test.skipIf(process.platform === "win32")("stops a supervised live writer before removing its credential home", async () => {
    const runnerTemp = mkdtempSync(join(tmpdir(), "ocx-live-process-cleanup-"));
    const opencodexHome = join(runnerTemp, "ocx-live-home.fixture");
    const controlDir = join(runnerTemp, "ocx-live-control-fixture");
    mkdirSync(opencodexHome);
    mkdirSync(controlDir);
    writeFileSync(join(controlDir, "launch-intent"), "");
    const supervisor = Bun.spawn([
      process.execPath,
      supervisorPath,
      controlDir,
      process.execPath,
      "-e",
      `import { mkdirSync, writeFileSync } from "node:fs";
       process.on("SIGTERM", () => process.exit(0));
       setInterval(() => {
         mkdirSync(process.env.OPENCODEX_HOME, { recursive: true });
         writeFileSync(process.env.OPENCODEX_HOME + "/state", "live");
       }, 20);`,
    ], {
      env: {
        ...process.env,
        OPENCODEX_HOME: opencodexHome,
        OCX_LIVE_SUPERVISOR_TERM_GRACE_MS: "100",
      },
      stdout: "ignore",
      stderr: "ignore",
    });

    try {
      await waitForFile(join(controlDir, "pid"));
      const cleanup = Bun.spawn(["bash", "-e", "-o", "pipefail", "-c", cleanupScript()], {
        env: {
          ...process.env,
          RUNNER_TEMP: runnerTemp,
          OPENCODEX_HOME: opencodexHome,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [cleanupExit, supervisorExit] = await Promise.all([cleanup.exited, supervisor.exited]);
      expect(cleanupExit).toBe(0);
      expect(supervisorExit).toBe(0);
      expect(existsSync(opencodexHome)).toBe(false);
    } finally {
      supervisor.kill("SIGKILL");
      await supervisor.exited;
      rmSync(runnerTemp, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "win32")("retains credentials when the owner cannot confirm process exit", () => {
    const runnerTemp = mkdtempSync(join(tmpdir(), "ocx-live-unconfirmed-cleanup-"));
    const opencodexHome = join(runnerTemp, "ocx-live-home.fixture");
    const controlDir = join(runnerTemp, "ocx-live-control-fixture");
    const binDir = join(runnerTemp, "bin");
    mkdirSync(opencodexHome);
    mkdirSync(controlDir);
    mkdirSync(binDir);
    writeFileSync(join(opencodexHome, "config.json"), "must survive");
    writeFileSync(join(controlDir, "launch-intent"), "");
    writeFileSync(join(binDir, "seq"), "#!/usr/bin/env bash\necho 1\n");
    writeFileSync(join(binDir, "sleep"), "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(join(binDir, "seq"), 0o755);
    chmodSync(join(binDir, "sleep"), 0o755);

    try {
      const result = runCleanup(runnerTemp, opencodexHome, `${binDir}:${process.env.PATH ?? ""}`);
      expect(result.exitCode).not.toBe(0);
      expect(existsSync(join(opencodexHome, "config.json"))).toBe(true);
      expect(existsSync(join(controlDir, "stop"))).toBe(true);
      expect(existsSync(join(controlDir, "launch-intent"))).toBe(true);
    } finally {
      rmSync(runnerTemp, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "win32")("the owner escalates a TERM-resistant child without PID reuse", async () => {
    const runnerTemp = mkdtempSync(join(tmpdir(), "ocx-live-supervisor-kill-"));
    const controlDir = join(runnerTemp, "control");
    const descendantPidFile = join(runnerTemp, "descendant.pid");
    mkdirSync(controlDir);
    const supervisor = Bun.spawn([
      process.execPath,
      supervisorPath,
      controlDir,
      process.execPath,
      "-e",
      `import { writeFileSync } from "node:fs";
       const descendant = Bun.spawn([
         process.execPath,
         "-e",
         "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
       ], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
       writeFileSync(${JSON.stringify(descendantPidFile)}, String(descendant.pid));
       process.on("SIGTERM", () => {});
       setInterval(() => {}, 1000);`,
    ], {
      env: { ...process.env, OCX_LIVE_SUPERVISOR_TERM_GRACE_MS: "50" },
      stdout: "ignore",
      stderr: "ignore",
    });

    try {
      await waitForFile(join(controlDir, "pid"));
      await waitForFile(descendantPidFile);
      const proxyPid = Number(readFileSync(join(controlDir, "pid"), "utf8").trim());
      const descendantPid = Number(readFileSync(descendantPidFile, "utf8").trim());
      writeFileSync(join(controlDir, "stop"), "");
      expect(await supervisor.exited).toBe(0);
      expect(JSON.parse(readFileSync(join(controlDir, "stopped"), "utf8"))).toMatchObject({ pid: proxyPid });
      expect(() => process.kill(proxyPid, 0)).toThrow();
      expect(() => process.kill(descendantPid, 0)).toThrow();
    } finally {
      supervisor.kill("SIGKILL");
      await supervisor.exited;
      rmSync(runnerTemp, { recursive: true, force: true });
    }
  });

  test("discovers an alternate runtime port, attests its PID, and passes an explicit smoke URL", () => {
    expect(workflow).toContain('runtime_file="$OPENCODEX_HOME/runtime-port.json"');
    expect(workflow).toContain(".pid == $pid");
    expect(workflow).toContain(".port != 10100");
    expect(workflow).toContain('.service == "opencodex" and .pid == $pid and .port == $port');
    expect(workflow).toContain('--url "http://127.0.0.1:${proxy_port}/v1/responses"');
    expect(workflow).not.toContain("http://127.0.0.1:10100/");
  });

  test.skipIf(process.platform === "win32")("retries a transient credential-directory removal failure", () => {
    const runnerTemp = mkdtempSync(join(tmpdir(), "ocx-live-cleanup-"));
    const opencodexHome = join(runnerTemp, "ocx-live-home.fixture");
    const binDir = join(runnerTemp, "bin");
    const counter = join(runnerTemp, "rm-attempts");
    mkdirSync(opencodexHome);
    mkdirSync(binDir);
    writeFileSync(join(opencodexHome, "config.json"), "ephemeral fixture");
    writeFileSync(join(binDir, "rm"), `#!/usr/bin/env bash
if [ "\${1:-}" = "-rf" ]; then
  attempts=0
  [ ! -f "$TEST_RM_COUNTER" ] || attempts="$(cat "$TEST_RM_COUNTER")"
  attempts=$((attempts + 1))
  echo "$attempts" > "$TEST_RM_COUNTER"
  if [ "$attempts" -eq 1 ]; then
    exit 1
  fi
fi
exec /bin/rm "$@"
`);
    chmodSync(join(binDir, "rm"), 0o755);

    try {
      const result = Bun.spawnSync(["bash", "-e", "-o", "pipefail", "-c", cleanupScript()], {
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          RUNNER_TEMP: runnerTemp,
          OPENCODEX_HOME: opencodexHome,
          TEST_RM_COUNTER: counter,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).toBe(0);
      expect(existsSync(opencodexHome)).toBe(false);
      expect(readFileSync(counter, "utf8").trim()).toBe("2");
    } finally {
      rmSync(runnerTemp, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "win32")("refuses to delete a home outside the runner's ephemeral namespace", () => {
    const runnerTemp = mkdtempSync(join(tmpdir(), "ocx-live-runner-"));
    const externalHome = mkdtempSync(join(tmpdir(), "ocx-live-external-"));
    writeFileSync(join(externalHome, "config.json"), "must survive");

    try {
      const result = runCleanup(runnerTemp, externalHome);
      expect(result.exitCode).not.toBe(0);
      expect(existsSync(join(externalHome, "config.json"))).toBe(true);
    } finally {
      rmSync(runnerTemp, { recursive: true, force: true });
      rmSync(externalHome, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "win32")("refuses a traversal-shaped home that resolves outside the namespace", () => {
    const runnerTemp = mkdtempSync(join(tmpdir(), "ocx-live-traversal-runner-"));
    const externalHome = mkdtempSync(join(tmpdir(), "ocx-live-traversal-target-"));
    mkdirSync(join(runnerTemp, "ocx-live-home.fixture"));
    const traversalHome = `${runnerTemp}/ocx-live-home.fixture/../../${basename(externalHome)}`;
    writeFileSync(join(externalHome, "config.json"), "must survive");

    try {
      const result = runCleanup(runnerTemp, traversalHome);
      expect(result.exitCode).not.toBe(0);
      expect(existsSync(join(externalHome, "config.json"))).toBe(true);
    } finally {
      rmSync(runnerTemp, { recursive: true, force: true });
      rmSync(externalHome, { recursive: true, force: true });
    }
  });

  test("retries once, reports sanitized results, and deletes raw result files", () => {
    expect(workflow).toContain("if run_attempt 1; then");
    expect(workflow).toContain("run_attempt 2");
    expect(workflow).toContain("scripts/live-smoke-report.ts");
    expect(workflow).toContain('rm -f -- "$result_file"');
    expect(workflow).not.toContain("result.error");
  });

  test("deduplicates Jules incidents and closes them on recovery", () => {
    expect(workflow).toContain("opencodex-live-inference-failure:${provider}");
    expect(workflow).toContain('"agent:jules": ["8250df", "Trusted Jules implementation request"]');
    expect(workflow).toContain("const labels = Object.keys(labelDefinitions)");
    expect(workflow).toContain('state: "closed", state_reason: "completed"');
    expect(workflow).toContain("raw provider responses and credential material are intentionally unavailable");
  });

  test("does not carry stale matrix models that the smoke runner ignores", () => {
    expect(workflow).not.toContain('{ provider: "cursor", model:');
    expect(workflow).not.toContain('{ provider: "openai", model:');
  });
});
