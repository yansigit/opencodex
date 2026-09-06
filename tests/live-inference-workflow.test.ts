import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const workflow = readFileSync(join(import.meta.dir, "..", ".github", "workflows", "live-inference.yml"), "utf8");

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

function processStartTime(pid: number): string {
  return readFileSync(`/proc/${pid}/stat`, "utf8").trim().split(/\s+/)[21] ?? "";
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

  test("waits for TERM, escalates only while the proxy lives, then verifies cleanup", () => {
    const cleanup = cleanupScript();
    const term = cleanup.indexOf('kill -TERM "$proxy_pid"');
    const kill = cleanup.indexOf('kill -KILL "$proxy_pid"');
    const escalationGuard = cleanup.lastIndexOf('kill -0 "$proxy_pid"', kill);
    const wait = cleanup.indexOf('wait "$proxy_pid"');
    const remove = cleanup.indexOf('rm -rf -- "$OPENCODEX_HOME"');
    const absence = cleanup.lastIndexOf('[ -e "$OPENCODEX_HOME" ]');

    expect(term).toBeGreaterThanOrEqual(0);
    expect(escalationGuard).toBeGreaterThan(term);
    expect(kill).toBeGreaterThan(escalationGuard);
    expect(wait).toBeGreaterThan(kill);
    expect(remove).toBeGreaterThan(wait);
    expect(absence).toBeGreaterThan(remove);
    expect(cleanup).toContain('"$canonical_runner_temp"/ocx-live-home.*)');
    expect(cleanup).toContain('actual_start_time="$(awk');
  });

  test.skipIf(process.platform !== "linux")("stops a live writer before removing its credential home", async () => {
    const runnerTemp = mkdtempSync(join(tmpdir(), "ocx-live-process-cleanup-"));
    const opencodexHome = join(runnerTemp, "ocx-live-home.fixture");
    const pidFile = join(runnerTemp, "ocx-live-fixture.pid");
    const pidStartFile = join(runnerTemp, "ocx-live-fixture.pid-start");
    mkdirSync(opencodexHome);
    const writer = Bun.spawn([
      "bash",
      "-c",
      'trap "exit 0" TERM; while :; do mkdir -p "$OPENCODEX_HOME"; touch "$OPENCODEX_HOME/state"; sleep 0.02; done',
    ], {
      env: { ...process.env, OPENCODEX_HOME: opencodexHome },
      stdout: "ignore",
      stderr: "ignore",
    });
    writeFileSync(pidFile, String(writer.pid));
    writeFileSync(pidStartFile, processStartTime(writer.pid));

    try {
      const cleanup = Bun.spawn(["bash", "-e", "-o", "pipefail", "-c", cleanupScript()], {
        env: {
          ...process.env,
          RUNNER_TEMP: runnerTemp,
          OPENCODEX_HOME: opencodexHome,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [cleanupExit, writerExit] = await Promise.all([cleanup.exited, writer.exited]);
      expect(cleanupExit).toBe(0);
      expect(writerExit).toBe(0);
      expect(existsSync(opencodexHome)).toBe(false);
    } finally {
      writer.kill("SIGKILL");
      await writer.exited;
      rmSync(runnerTemp, { recursive: true, force: true });
    }
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
