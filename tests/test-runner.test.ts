import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  createIsolatedTestEnvironment,
  isFullSuiteRun,
  runTestLaneForTests,
  runTestMainForTests,
  resolveBunTestArgs,
  resolveBunTestPlan,
  testLaneTimedOut,
  laneExitCodeForTests,
  terminationCommandForTests,
  terminateSpawnedTestProcessForTests,
  terminateTestProcessForTests,
  SERIAL_FULL_SUITE_FILES,
} from "../scripts/test";
import {
  acquireTestRunLock,
  resolveBareTestRunIdentity,
  TEST_RUN_NO_QUEUE_ENV,
} from "../scripts/test-run-lock";
import {
  decodeWindowsIdentityPowerShellOutputForTests,
  windowsIdentityPowerShellCommandForTests,
  windowsIdentityPowerShellSpawnOptionsForTests,
} from "../src/codex/user-identity";
import {
  setTrustedWindowsSystemDirectoryResolverForTests,
} from "../src/lib/windows-elevation";

async function exitWithin(child: Bun.Subprocess, timeoutMs = 5_000): Promise<number> {
  return await Promise.race([
    child.exited,
    Bun.sleep(timeoutMs).then(() => { throw new Error(`pid ${child.pid} did not exit within ${timeoutMs}ms`); }),
  ]);
}

async function stopWithin(child: Bun.Subprocess): Promise<void> {
  if (!processIsAlive(child.pid)) return;
  child.kill("SIGTERM");
  try { await exitWithin(child, 500); } catch {
    child.kill("SIGKILL");
    await exitWithin(child, 500);
  }
}

async function waitForFile(path: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await Bun.sleep(10);
  }
}

async function waitForCondition(condition: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`);
    await Bun.sleep(10);
  }
}

function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function expectProcessTreeDead(markerPath: string): Promise<void> {
  const pids = JSON.parse(await Bun.file(markerPath).text()) as { child: number; grandchild: number };
  const deadline = Date.now() + 2_000;
  while ((processIsAlive(pids.child) || processIsAlive(pids.grandchild)) && Date.now() < deadline) {
    await Bun.sleep(10);
  }
  expect(processIsAlive(pids.child)).toBe(false);
  expect(processIsAlive(pids.grandchild)).toBe(false);
}

describe("test runner isolation", () => {
  test("redirects user homes to a disposable root", () => {
    const isolated = createIsolatedTestEnvironment({ PATH: "/test/bin", HOME: "/real/home" });
    try {
      expect(isolated.env).toMatchObject({
        PATH: "/test/bin",
        HOME: isolated.root,
        USERPROFILE: isolated.root,
        TMPDIR: join(isolated.root, "tmp"),
        TMP: join(isolated.root, "tmp"),
        TEMP: join(isolated.root, "tmp"),
        OPENCODEX_HOME: join(isolated.root, ".opencodex"),
        CODEX_HOME: join(isolated.root, ".codex"),
        OCX_TEST_HOME_GUARD: "1",
      });
      expect(existsSync(isolated.env.OPENCODEX_HOME!)).toBe(true);
      expect(existsSync(isolated.env.CODEX_HOME!)).toBe(true);
      expect(existsSync(isolated.env.TMPDIR!)).toBe(true);
    } finally {
      isolated.cleanup();
    }
    expect(existsSync(isolated.root)).toBe(false);
  });

  test("sharded lanes arm the home guard before Bun starts", async () => {
    const exitCode = await runTestLaneForTests(
      { label: "shard guard", args: ["--shard=1/1"], timeoutMs: 1_000 },
      "shard-guard-fixture",
      { command: [process.execPath, "-e", "process.exit(process.env.OCX_TEST_HOME_GUARD === '1' ? 0 : 2)"] },
    );
    expect(exitCode).toBe(0);
  });

  test.if(process.platform === "win32")("gives the Windows sandbox a real profile shape", () => {
    const isolated = createIsolatedTestEnvironment({ PATH: "C:\\test\\bin" });
    try {
      expect(existsSync(join(isolated.root, "AppData", "Local"))).toBe(true);
      expect(existsSync(join(isolated.root, "AppData", "Roaming"))).toBe(true);
    } finally {
      isolated.cleanup();
    }
  });

  // The bug this pins: .NET's known-folder API resolves against USERPROFILE and returns an
  // EMPTY STRING — not an error — for a folder that does not exist. With the sandbox missing
  // AppData, `resolveWindowsRuntimeRoot` refused every Codex coordinator lookup with "Windows
  // effective-account lookup returned an empty value", and each refusal surfaced as an
  // unrelated assertion in whichever suite touched a Codex home.
  test.if(process.platform === "win32")(
    "keeps the .NET known-folder lookup resolvable inside the sandbox",
    () => {
      const isolated = createIsolatedTestEnvironment();
      try {
        const command = windowsIdentityPowerShellCommandForTests(
          "[Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)",
        );
        const result = Bun.spawnSync(command, {
          ...windowsIdentityPowerShellSpawnOptionsForTests(),
          env: { ...process.env, USERPROFILE: isolated.root, HOME: isolated.root },
        });

        expect(result.exitCode).toBe(0);
        const localAppData = decodeWindowsIdentityPowerShellOutputForTests(
          result.stdout ?? new Uint8Array(),
        );
        expect(localAppData).not.toBe("");
        expect(isAbsolute(localAppData)).toBe(true);
        expect(localAppData.toLowerCase()).toStartWith(isolated.root.toLowerCase());
      } finally {
        isolated.cleanup();
      }
    },
  );
});

/**
 * Without `--parallel`, `--isolate` re-evaluates the module graph once per file on a single
 * core. Past ~900 files that stops reading as slow and starts reading as hung: measured at
 * 1 h 29 m with zero output, ~57 % CPU and 8.5 MB RSS. Four workers keep the suite inside a
 * few minutes without the deadline-sensitive failures observed when Bun selected all ten cores.
 * These pin the argv so the bound cannot be dropped again silently.
 */
describe("bun test argv", () => {
  test("classifies only filter-less invocations as the full suite", () => {
    expect(isFullSuiteRun([])).toBe(true);
    expect(isFullSuiteRun(["--isolate", "--parallel=4", "./tests/"])).toBe(true);
    expect(isFullSuiteRun(["tests/foo.test.ts"])).toBe(false);
    expect(isFullSuiteRun(["--", "tests/foo.test.ts"])).toBe(false);
    for (const focused of [
      ["--shard", "1/3"],
      ["--shard=1/3"],
      ["--changed"],
      ["--changed=origin/dev"],
      ["--only"],
      ["-t", "one test"],
      ["--test-name-pattern=one test"],
      ["--grep", "one test"],
      ["--path-ignore-patterns", "**/slow.test.ts"],
    ]) {
      expect(isFullSuiteRun(focused)).toBe(false);
    }
  });

  test("a filter-less run gets isolate, bounded parallelism and the suite path", () => {
    expect(resolveBunTestArgs([])).toEqual(["--isolate", "--parallel=4", "./tests/"]);
  });

  test("the default full suite quarantines load-sensitive files into one-worker lanes", () => {
    const plan = resolveBunTestPlan([]);
    expect(plan).toHaveLength(SERIAL_FULL_SUITE_FILES.length + 1);
    expect(plan[0]?.label).toBe("parallel suite");
    expect(plan[0]?.args).toContain("--parallel=4");
    expect(plan[0]?.args).toContain("./tests/");
    for (const file of SERIAL_FULL_SUITE_FILES) {
      expect(plan[0]?.args).toContain(`**/${file}`);
      expect(plan.find(lane => lane.label === file)?.args).toEqual([
        "--isolate",
        "--parallel=1",
        `./tests/${file}`,
      ]);
    }
    expect(plan.find(lane => lane.label === "release-helper.test.ts")?.timeoutMs).toBe(5 * 60 * 1000);
    expect(plan.find(lane => lane.label === "codex-shim.test.ts")?.timeoutMs).toBe(3 * 60 * 1000);
  });

  test("isolates the journal suite in its own one-worker lane", () => {
    expect(SERIAL_FULL_SUITE_FILES).toContain("codex-journal.test.ts");
    expect(resolveBunTestPlan([]).find(lane => lane.label === "codex-journal.test.ts")?.args)
      .toEqual(["--isolate", "--parallel=1", "./tests/codex-journal.test.ts"]);
  });

  test("isolates request decompression memory spikes in their own one-worker lane", () => {
    expect(SERIAL_FULL_SUITE_FILES).toContain("request-decompress.test.ts");
    expect(resolveBunTestPlan([]).find(lane => lane.label === "request-decompress.test.ts")?.args)
      .toEqual(["--isolate", "--parallel=1", "./tests/request-decompress.test.ts"]);
  });

  test("serial lanes override caller parallelism without changing the main lane", () => {
    const plan = resolveBunTestPlan(["--parallel=2", "--only-failures"]);
    expect(plan[0]?.args).toContain("--parallel=2");
    for (const lane of plan.slice(1)) {
      expect(lane.args).toContain("--parallel=1");
      expect(lane.args).not.toContain("--parallel=2");
      expect(lane.args).toContain("--only-failures");
    }
  });

  test("sharded and reporter-file runs stay a single caller-controlled lane", () => {
    expect(resolveBunTestPlan(["--shard=1/3"])).toHaveLength(1);
    expect(resolveBunTestPlan(["--reporter=junit", "--reporter-outfile", "results.xml"]))
      .toHaveLength(1);
  });

  test("a file filter keeps isolate and bounded parallelism but no suite path", () => {
    expect(resolveBunTestArgs(["tests/foo.test.ts"]))
      .toEqual(["--isolate", "--parallel=4", "tests/foo.test.ts"]);
    expect(resolveBunTestArgs(["-"]))
      .toEqual(["--isolate", "--parallel=4", "-"]);
  });

  test("a caller-supplied concurrency is left alone", () => {
    expect(resolveBunTestArgs(["--parallel=2"]))
      .toEqual(["--isolate", "--parallel=2", "./tests/"]);
    expect(resolveBunTestArgs(["--parallel"]))
      .toEqual(["--isolate", "--parallel", "./tests/"]);
    expect(resolveBunTestArgs(["--parallel", "tests/foo.test.ts"]))
      .toEqual(["--isolate", "--parallel", "tests/foo.test.ts"]);
    expect(resolveBunTestArgs(["--parallel=2", "tests/foo.test.ts"]))
      .toEqual(["--isolate", "--parallel=2", "tests/foo.test.ts"]);
  });

  test("option-only arguments still count as a full suite run", () => {
    expect(resolveBunTestArgs(["--timeout=30000"]))
      .toEqual(["--isolate", "--parallel=4", "--timeout=30000", "./tests/"]);
    expect(resolveBunTestArgs(["--timeout", "30000"]))
      .toEqual(["--isolate", "--parallel=4", "--timeout", "30000", "./tests/"]);
    expect(resolveBunTestArgs(["--timeout", "30000", "tests/foo.test.ts"]))
      .toEqual(["--isolate", "--parallel=4", "--timeout", "30000", "tests/foo.test.ts"]);
    expect(resolveBunTestArgs(["--timings", ".bun-test-timings/current.json"]))
      .toEqual([
        "--isolate",
        "--parallel=4",
        "--timings",
        ".bun-test-timings/current.json",
        "./tests/",
      ]);
    for (const configFlag of ["-c", "--config"]) {
      expect(resolveBunTestArgs([configFlag, "ci.bunfig.toml"]))
        .toEqual(["--isolate", "--parallel=4", configFlag, "ci.bunfig.toml", "./tests/"]);
    }
    expect(resolveBunTestArgs(["-t", "serial test"])).toEqual([
      "--isolate",
      "--parallel=4",
      "-t",
      "serial test",
    ]);
  });

  test("arguments after the delimiter are passed through instead of parsed as wrapper flags", () => {
    expect(resolveBunTestArgs(["--", "--parallel=2"]))
      .toEqual(["--isolate", "--parallel=4", "--", "--parallel=2"]);
  });

  test("the wrapper passes parallel execution through to bun", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "opencodex-test-runner-"));
    const fixturePath = join(fixtureRoot, "parallel-smoke.test.ts");
    const markerPath = join(fixtureRoot, "executed.marker");
    writeFileSync(
      fixturePath,
      `import { test } from "bun:test"; import { writeFileSync } from "node:fs"; test("smoke", () => writeFileSync(${JSON.stringify(markerPath)}, "executed"));\n`,
    );
    try {
      const result = Bun.spawnSync([
        process.execPath,
        join(import.meta.dir, "../scripts/test.ts"),
        fixturePath,
      ], {
        cwd: join(import.meta.dir, ".."),
        env: { ...process.env, OCX_TEST_NO_QUEUE: "1" },
        stdout: "pipe",
        stderr: "pipe",
      });

      const output = new TextDecoder().decode(result.stdout)
        + new TextDecoder().decode(result.stderr);
      expect(result.exitCode).toBe(0);
      expect(output).toContain("PARALLEL");
      expect(existsSync(markerPath)).toBe(true);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});

describe("test-runner termination", () => {
  test("only an unresolved exit is a timeout; exit code zero succeeds", () => {
    expect(testLaneTimedOut(null)).toBe(true);
    expect(testLaneTimedOut(0)).toBe(false);
    expect(testLaneTimedOut(130)).toBe(false);
  });

  test("preserves timeout and cancellation exit codes", () => {
    expect(laneExitCodeForTests(null, null)).toBe(124);
    expect(laneExitCodeForTests(0, "SIGINT")).toBe(130);
    expect(laneExitCodeForTests(0, "SIGTERM")).toBe(143);
    expect(laneExitCodeForTests(7, null)).toBe(7);
  });

  test("resolves Windows taskkill from the native trusted system directory, not SystemRoot", () => {
    const trustedSystem = mkdtempSync(join(tmpdir(), "opencodex-trusted-system32-"));
    const taskkill = join(trustedSystem, "taskkill.exe");
    writeFileSync(taskkill, "fixture");
    const previousSystemRoot = process.env.SystemRoot;
    process.env.SystemRoot = "C:\\attacker-controlled";
    setTrustedWindowsSystemDirectoryResolverForTests(() => trustedSystem);
    try {
      expect(terminationCommandForTests(42, "win32")).toEqual([
        taskkill, "/PID", "42", "/T", "/F",
      ]);
    } finally {
      setTrustedWindowsSystemDirectoryResolverForTests(null);
      if (previousSystemRoot === undefined) delete process.env.SystemRoot;
      else process.env.SystemRoot = previousSystemRoot;
      rmSync(trustedSystem, { recursive: true, force: true });
    }
  });

  test("rejects invalid process IDs before any group signal or taskkill resolution", async () => {
    for (const pid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      let signals = 0;
      let resolutions = 0;
      await expect(terminateTestProcessForTests({
        pid,
        platform: "linux",
        exited: Promise.resolve(0),
        signalGroup: () => { signals += 1; },
      })).rejects.toThrow("positive safe integer");
      await expect(terminateTestProcessForTests({
        pid,
        platform: "win32",
        exited: Promise.resolve(0),
        resolveTaskkill: () => { resolutions += 1; return "C:\\trusted\\taskkill.exe"; },
        taskkill: () => 0,
      })).rejects.toThrow("positive safe integer");
      expect(signals).toBe(0);
      expect(resolutions).toBe(0);
    }
  });

  test("polls POSIX group liveness after the leader exits during graceful shutdown", async () => {
    const signals: string[] = [];
    let polls = 0;
    await terminateTestProcessForTests({
      pid: 42,
      platform: "linux",
      exited: Promise.resolve(0),
      signalGroup: signal => { signals.push(signal); },
      isAlive: () => ++polls < 3,
      graceMs: 50,
      killGraceMs: 50,
    });
    expect(signals).toEqual(["SIGTERM"]);
  });

  test("polls POSIX group liveness after SIGKILL when the leader already exited", async () => {
    const signals: string[] = [];
    let killed = false;
    let forcedPolls = 0;
    await terminateTestProcessForTests({
      pid: 42,
      platform: "linux",
      exited: Promise.resolve(0),
      signalGroup: signal => { signals.push(signal); if (signal === "SIGKILL") killed = true; },
      isAlive: () => !killed || ++forcedPolls < 3,
      graceMs: 1,
      killGraceMs: 50,
    });
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("escalates TERM to KILL and confirms an already-dead group", async () => {
    const signals: string[] = [];
    let alive = true;
    await terminateTestProcessForTests({
      pid: 42,
      platform: "linux",
      signalGroup: signal => { signals.push(signal); if (signal === "SIGKILL") alive = false; },
      isAlive: () => alive,
      exited: Promise.resolve(0),
      graceMs: 1,
      killGraceMs: 1,
    });
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("Windows taskkill success is authoritative and failure is loud", async () => {
    const calls: string[][] = [];
    await terminateTestProcessForTests({
      pid: 42, platform: "win32", exited: Promise.resolve(0),
      resolveTaskkill: () => "C:\\trusted-system32\\taskkill.exe",
      taskkill: command => { calls.push(command); return 0; },
    });
    expect(calls[0]).toEqual(["C:\\trusted-system32\\taskkill.exe", "/PID", "42", "/T", "/F"]);
    await expect(terminateTestProcessForTests({
      pid: 42, platform: "win32", exited: Promise.resolve(0),
      resolveTaskkill: () => "C:\\trusted-system32\\taskkill.exe",
      taskkill: () => 1, graceMs: 1,
    })).rejects.toThrow("failed to terminate");
  });

  test("signal termination rejects promptly even while the child is still running", async () => {
    const baseline = process.listenerCount("SIGTERM");
    let spawned: Bun.Subprocess | undefined;
    const lane = runTestLaneForTests(
      { label: "signal rejection", args: [], timeoutMs: 1_000 },
      "signal-rejection-fixture",
      {
        command: [process.execPath, "-e", "await Bun.sleep(150)"],
        terminateProcess: async child => {
          spawned = child;
          throw new Error("injected termination rejection");
        },
      },
    );
    await waitForCondition(
      () => process.listenerCount("SIGTERM") === baseline + 1,
      "SIGTERM forwarding handler",
    );
    process.emit("SIGTERM");
    await expect(Promise.race([
      lane,
      Bun.sleep(100).then(() => { throw new Error("termination rejection was not awaited"); }),
    ])).rejects.toThrow("injected termination rejection");
    if (spawned) await spawned.exited;
  });

  test("signal handlers stay idempotent until termination and sandbox cleanup finish", async () => {
    const baselineInt = process.listenerCount("SIGINT");
    const baselineTerm = process.listenerCount("SIGTERM");
    const events: string[] = [];
    let terminationCalls = 0;
    let releaseTermination!: () => void;
    const terminationGate = new Promise<void>(resolve => { releaseTermination = resolve; });
    const lane = runTestLaneForTests(
      { label: "signal ordering", args: [], timeoutMs: 1_000 },
      "signal-ordering-fixture",
      {
        command: [process.execPath, "-e", "await new Promise(() => {})"],
        createEnvironment: baseEnv => {
          const isolated = createIsolatedTestEnvironment(baseEnv);
          return { ...isolated, cleanup() { events.push("cleanup"); isolated.cleanup(); } };
        },
        terminateProcess: async child => {
          terminationCalls += 1;
          child.kill("SIGKILL");
          await child.exited;
          await terminationGate;
          events.push("termination");
        },
      },
    );
    await waitForCondition(
      () => process.listenerCount("SIGINT") === baselineInt + 1,
      "SIGINT forwarding handler",
    );
    process.emit("SIGINT");
    await waitForCondition(() => terminationCalls === 1, "termination start");
    expect(process.listenerCount("SIGINT")).toBe(baselineInt + 1);
    expect(process.listenerCount("SIGTERM")).toBe(baselineTerm + 1);
    process.emit("SIGINT");
    process.emit("SIGTERM");
    expect(terminationCalls).toBe(1);
    releaseTermination();
    expect(await lane).toBe(130);
    expect(events).toEqual(["termination", "cleanup"]);
    expect(process.listenerCount("SIGINT")).toBe(baselineInt);
    expect(process.listenerCount("SIGTERM")).toBe(baselineTerm);
  });

  test("a signal during timeout cleanup does not replace the in-flight termination", async () => {
    let calls = 0;
    const exitCode = await runTestLaneForTests(
      { label: "timeout signal race", args: [], timeoutMs: 10 },
      "timeout-signal-race-fixture",
      {
        command: [process.execPath, "-e", "await new Promise(() => {})"],
        terminateProcess: async child => {
          calls += 1;
          if (calls === 1) process.emit("SIGINT");
          child.kill("SIGKILL");
          await child.exited;
        },
      },
    );
    expect(calls).toBe(1);
    expect(exitCode).toBe(124);
  });

  test.if(process.platform !== "win32")(
    "real child and grandchild groups preserve timeout and signal exits and are dead before return",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "opencodex-test-tree-"));
      const controllerPath = join(import.meta.dir, "fixtures/test-runner-tree-controller.ts");
      const controllers: Bun.Subprocess[] = [];
      try {
        for (const [mode, expected] of [["timeout", 124], ["SIGINT", 130], ["SIGTERM", 143]] as const) {
          const markerPath = join(root, `${mode}.json`);
          const controller = Bun.spawn([process.execPath, controllerPath, mode, markerPath], {
            cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe",
          });
          controllers.push(controller);
          await waitForFile(markerPath);
          if (mode !== "timeout") controller.kill(mode);
          expect(await exitWithin(controller)).toBe(expected);
          await expectProcessTreeDead(markerPath);
        }

        const markerPath = join(root, "already-dead.json");
        const controller = Bun.spawn([process.execPath, controllerPath, "already-dead", markerPath], {
          cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe",
        });
        controllers.push(controller);
        expect(await exitWithin(controller)).toBe(0);
        await expectProcessTreeDead(markerPath);
      } finally {
        for (const controller of controllers) await stopWithin(controller);
        for (const markerPath of ["timeout", "SIGINT", "SIGTERM", "already-dead"].map(mode => join(root, `${mode}.json`))) {
          if (!existsSync(markerPath)) continue;
          const { child } = JSON.parse(await Bun.file(markerPath).text()) as { child: number };
          try { process.kill(-child, "SIGKILL"); } catch { /* already dead */ }
        }
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  test("termination errors cannot skip sandbox cleanup and cleanup errors stay loud", async () => {
    let cleaned = 0;
    await expect(runTestLaneForTests(
      { label: "cleanup", args: [], timeoutMs: 20 },
      "cleanup-fixture",
      {
        command: [process.execPath, "-e", "await new Promise(() => {})"],
        createEnvironment: baseEnv => {
          const isolated = createIsolatedTestEnvironment(baseEnv);
          return { ...isolated, cleanup() { cleaned += 1; isolated.cleanup(); } };
        },
        terminateProcess: async child => {
          child.kill("SIGKILL");
          await child.exited;
          throw new Error("injected termination failure");
        },
      },
    )).rejects.toThrow("injected termination failure");
    expect(cleaned).toBe(1);

    await expect(runTestLaneForTests(
      { label: "cleanup failure", args: [], timeoutMs: 1_000 },
      "cleanup-fixture",
      {
        command: [process.execPath, "-e", "process.exit(0)"],
        createEnvironment: baseEnv => {
          const isolated = createIsolatedTestEnvironment(baseEnv);
          return { ...isolated, cleanup() { isolated.cleanup(); throw new Error("injected cleanup failure"); } };
        },
      },
    )).rejects.toThrow("injected cleanup failure");
  });

  test("synchronous spawn failure still removes the sandbox", async () => {
    let cleaned = 0;
    await expect(runTestLaneForTests(
      { label: "spawn failure", args: [], timeoutMs: 1_000 },
      "spawn-failure-fixture",
      {
        command: [join(tmpdir(), "missing-opencodex-test-executable")],
        createEnvironment: baseEnv => ({
          root: "fixture",
          env: baseEnv,
          cleanup() { cleaned += 1; },
        }),
      },
    )).rejects.toThrow();
    expect(cleaned).toBe(1);
  });
});

describe("bun test machine lock", () => {
  test("bare and focused runs bypass a held lock while a full wrapper waits then resumes", async () => {
    const root = mkdtempSync(join(tmpdir(), "opencodex-test-lock-integration-"));
    const lockPath = join(root, "suite.lock");
    const probePath = join(import.meta.dir, "fixtures/test-runner-lock-probe.test.ts");
    const owner = await acquireTestRunLock({ runId: "holder", lockPath, pollMs: 5, maxWaitMs: 100 });
    let bare: Bun.Subprocess | undefined;
    try {
      bare = Bun.spawn([process.execPath, "test", probePath], {
        cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe",
      });
      expect(await exitWithin(bare)).toBe(0);

      expect(await runTestMainForTests([probePath], {
        lockPath, pollMs: 5, maxWaitMs: 200, runLane: async () => 0,
      })).toBe(0);

      for (const focused of [
        ["--shard=1/3"],
        ["--changed"],
        ["--changed=origin/dev"],
        ["--test-name-pattern", "one test"],
      ]) {
        expect(await runTestMainForTests(focused, {
          lockPath, pollMs: 5, maxWaitMs: 20, runLane: async () => 0,
        })).toBe(0);
      }

      let settled = false;
      const full = runTestMainForTests([], {
        lockPath, pollMs: 5, maxWaitMs: 500, runLane: async () => 0,
      }).then(code => { settled = true; return code; });
      await Bun.sleep(30);
      expect(settled).toBe(false);
      owner.release();
      expect(await full).toBe(0);
    } finally {
      if (bare) await stopWithin(bare);
      owner.release();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("independent bare runners do not inherit a shared long-lived parent identity", () => {
    expect(resolveBareTestRunIdentity({ pid: 101, ppid: 50 })).toEqual({
      ownerPid: 101,
      runId: "bare-101",
    });
    expect(resolveBareTestRunIdentity({ pid: 102, ppid: 50 })).toEqual({
      ownerPid: 102,
      runId: "bare-102",
    });
  });

  test("parallel Bun workers rendezvous on their short-lived controller PID", () => {
    expect(resolveBareTestRunIdentity({ pid: 101, ppid: 90, workerId: "1" })).toEqual({
      ownerPid: 101,
      runId: "bare-90",
    });
    expect(resolveBareTestRunIdentity({ pid: 102, ppid: 90, workerId: "2" })).toEqual({
      ownerPid: 102,
      runId: "bare-90",
    });
  });

  test("one run owns the lock while sibling workers with its run ID join", async () => {
    const root = mkdtempSync(join(tmpdir(), "opencodex-test-lock-"));
    const lockPath = join(root, "suite.lock");
    try {
      const owner = await acquireTestRunLock({ runId: "suite-a", lockPath, pollMs: 5, maxWaitMs: 50 });
      const sibling = await acquireTestRunLock({ runId: "suite-a", lockPath, pollMs: 5, maxWaitMs: 50 });
      expect(owner.acquired).toBe(true);
      expect(sibling.acquired).toBe(false);
      sibling.release();
      expect(existsSync(lockPath)).toBe(true);
      owner.release();
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a dead owner is reclaimed even when the next bare invocation derives the same run ID", async () => {
    const root = mkdtempSync(join(tmpdir(), "opencodex-test-lock-"));
    const lockPath = join(root, "suite.lock");
    try {
      const stale = await acquireTestRunLock({
        runId: "stale",
        ownerPid: 2_147_483_647,
        lockPath,
        pollMs: 5,
        maxWaitMs: 50,
      });
      const replacement = await acquireTestRunLock({ runId: "stale", lockPath, pollMs: 5, maxWaitMs: 50 });
      expect(replacement.acquired).toBe(true);
      stale.release();
      expect(existsSync(lockPath)).toBe(true);
      replacement.release();
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a live competing run fails closed after the bounded wait", async () => {
    const root = mkdtempSync(join(tmpdir(), "opencodex-test-lock-"));
    const lockPath = join(root, "suite.lock");
    try {
      const owner = await acquireTestRunLock({ runId: "live", lockPath, pollMs: 5, maxWaitMs: 50 });
      let waits = 0;
      await expect(acquireTestRunLock({
        runId: "blocked",
        lockPath,
        pollMs: 5,
        maxWaitMs: 20,
        onWait: () => { waits += 1; },
      })).rejects.toThrow("timed out");
      expect(waits).toBe(1);
      owner.release();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the explicit no-queue escape hatch does not create a lock", async () => {
    const root = mkdtempSync(join(tmpdir(), "opencodex-test-lock-"));
    const lockPath = join(root, "suite.lock");
    try {
      const lock = await acquireTestRunLock({
        runId: "opt-out",
        lockPath,
        env: { [TEST_RUN_NO_QUEUE_ENV]: "1" },
      });
      expect(lock.acquired).toBe(false);
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
