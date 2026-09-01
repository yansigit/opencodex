import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { resolveTrustedWindowsTaskkillExe } from "../src/lib/windows-elevation";
import { acquireTestRunLock, TEST_RUN_ID_ENV } from "./test-run-lock";

export interface IsolatedTestEnvironment {
  root: string;
  env: Record<string, string | undefined>;
  cleanup(): void;
}

export function createIsolatedTestEnvironment(
  baseEnv: Record<string, string | undefined> = process.env,
): IsolatedTestEnvironment {
  const root = mkdtempSync(join(tmpdir(), "opencodex-test-"));
  const opencodexHome = join(root, ".opencodex");
  const codexHome = join(root, ".codex");
  const temp = join(root, "tmp");
  mkdirSync(opencodexHome, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(temp, { recursive: true });
  if (process.platform === "win32") {
    // A Windows sandbox has to look like a real profile, because the known-folder APIs
    // resolve relative to USERPROFILE and .NET returns an EMPTY STRING — not an error —
    // when the folder it computes does not exist. `resolveWindowsRuntimeRoot` asks
    // PowerShell for `GetFolderPath(LocalApplicationData)`, so without these directories
    // every Codex coordinator lookup refuses with "Windows effective-account lookup
    // returned an empty value" and each refusal surfaces as an unrelated assertion in
    // whichever suite happened to touch a Codex home.
    mkdirSync(join(root, "AppData", "Local"), { recursive: true });
    mkdirSync(join(root, "AppData", "Roaming"), { recursive: true });
  }

  return {
    root,
    env: {
      ...baseEnv,
      // Captured BEFORE HOME is overwritten: once the child starts with a rewritten
      // HOME, `homedir()` returns the sandbox, so this hand-off is the only way the
      // real-home write guard can still know which path to protect.
      // (devlog 260730_codex_rs_upstream_v2_live_handoff/070.)
      OCX_REAL_HOME: baseEnv.OCX_REAL_HOME ?? homedir(),
      OCX_TEST_HOME_GUARD: "1",
      // Pin git's global config to the developer's real one before HOME moves.
      //
      // git resolves ~/.gitconfig from HOME, so a sandboxed HOME makes it invisible.
      // That silently drops `safe.directory`, and on a checkout whose directory owner
      // differs from the running account -- ordinary on Windows when a tool or
      // installer created the tree -- every `git` call a test makes then fails with
      // "detected dubious ownership". The test reads that as "this is not a git
      // repository" and asserts against a fallback, which looks like a product bug in
      // whichever adapter collected the metadata. Naming the file keeps the sandbox
      // (git still writes nothing here) while leaving git's own trust decisions intact.
      GIT_CONFIG_GLOBAL: baseEnv.GIT_CONFIG_GLOBAL ?? join(homedir(), ".gitconfig"),
      HOME: root,
      USERPROFILE: root,
      TMPDIR: temp,
      TMP: temp,
      TEMP: temp,
      OPENCODEX_HOME: opencodexHome,
      CODEX_HOME: codexHome,
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function hasCliFlag(requested: string[], name: string): boolean {
  const delimiterIndex = requested.indexOf("--");
  const wrapperArgs = delimiterIndex === -1 ? requested : requested.slice(0, delimiterIndex);
  return wrapperArgs.some(arg => arg === name || arg.startsWith(`${name}=`));
}

const DEFAULT_TEST_PARALLELISM = 4;

// Bun 1.4.0 builds `bun test` options from its test, runtime, transpiler, and base tables.
// Only required values consume the next argument. Optional values such as `--parallel=2`
// must stay attached so a bare option cannot hide the positional filter that follows it.
const BUN_TEST_OPTIONS_REQUIRING_VALUES = new Set([
  // Test options.
  "--timeout",
  "--rerun-each",
  "--retry",
  "--seed",
  "--coverage-reporter",
  "--coverage-dir",
  "-t",
  "--test-name-pattern",
  "--grep",
  "--reporter",
  "--reporter-outfile",
  "--max-concurrency",
  "--path-ignore-patterns",
  "--parallel-delay",
  "--shard",
  "--timings",
  // Runtime options accepted by `bun test`.
  "--watch-kill-signal",
  "-r",
  "--preload",
  "--require",
  "--import",
  "--cpu-prof-name",
  "--cpu-prof-dir",
  "--cpu-prof-interval",
  "--heap-prof-name",
  "--heap-prof-dir",
  "--heap-prof-interval",
  "--install",
  "-e",
  "--eval",
  "-p",
  "--print",
  "--port",
  "--origin",
  "--conditions",
  "--fetch-preconnect",
  "--max-http-header-size",
  "--dns-result-order",
  "--redirect-warnings",
  "--disable-warning",
  "--title",
  "--unhandled-rejections",
  "--console-depth",
  "--user-agent",
  "--cron-title",
  "--cron-period",
  "--trace-event-categories",
  "--trace-event-file-pattern",
  "--stack-trace-limit",
  // Transpiler and base options accepted by `bun test`.
  "--main-fields",
  "--extension-order",
  "--tsconfig-override",
  "-d",
  "--define",
  "--drop",
  "--feature",
  "-l",
  "--loader",
  "--jsx-factory",
  "--jsx-fragment",
  "--jsx-import-source",
  "--jsx-runtime",
  "--env-file",
  "--cwd",
  "-c",
  "--config",
]);

const BUN_TEST_SELECTION_FLAGS = [
  "--changed",
  "--grep",
  "--only",
  "--path-ignore-patterns",
  "--shard",
  "--test-name-pattern",
  "-t",
] as const;

/** True for a filter-less `bun run test`. `--timeout` / `--dots` / `--parallel=N` still count. */
export function isFullSuiteRun(requested: string[]): boolean {
  const delimiterIndex = requested.indexOf("--");
  const wrapperArgs = delimiterIndex === -1 ? requested : requested.slice(0, delimiterIndex);
  const passedThrough = delimiterIndex === -1 ? [] : requested.slice(delimiterIndex + 1);
  if (passedThrough.length > 0) return false;
  if (BUN_TEST_SELECTION_FLAGS.some(flag => hasCliFlag(wrapperArgs, flag))) return false;

  for (let index = 0; index < wrapperArgs.length; index++) {
    const arg = wrapperArgs[index];
    if (arg === "-") return false;
    if (!arg.startsWith("-")) {
      if (arg !== "./tests/") return false;
      continue;
    }
    if (!arg.includes("=") && BUN_TEST_OPTIONS_REQUIRING_VALUES.has(arg)) index++;
  }
  return true;
}

/**
 * Default `bun test` argv for this repo.
 *
 * `--isolate` keeps a fresh global per file. Bounded parallelism is what makes the suite
 * finishable: with isolate alone Bun re-evaluates
 * the module graph once per file on a single core, so past ~900 files the run stops looking slow
 * and starts looking hung — measured here at 1 h 29 m with zero output, ~57 % CPU and 8.5 MB RSS,
 * against a few minutes for the identical suite with four workers. Leaving Bun to select all ten
 * workers made deadline-sensitive tests fail under load, so the repository default is deterministic.
 * A caller-supplied `--parallel` or `--parallel=N` is left alone.
 */
export function resolveBunTestArgs(
  requested: string[],
  comparisonCommit?: string,
): string[] {
  const delimiterIndex = requested.indexOf("--");
  const effectiveRequested = comparisonCommit
    ? requested.map((arg, index) => (
        (delimiterIndex === -1 || index < delimiterIndex)
          && (arg === "--changed" || arg.startsWith("--changed="))
          ? "--changed=" + comparisonCommit
          : arg
      ))
    : requested;
  const args = ["--isolate"];
  if (!hasCliFlag(effectiveRequested, "--parallel")) {
    args.push(`--parallel=${DEFAULT_TEST_PARALLELISM}`);
  }
  args.push(...effectiveRequested);
  if (isFullSuiteRun(effectiveRequested)) args.push("./tests/");
  return args;
}

export const SERIAL_FULL_SUITE_FILES = [
  "codex-shim.test.ts",
  "cursor-native-exec-shell.test.ts",
  "issue-452-empty-503.test.ts",
  "openai-provider-option-e2e.test.ts",
  "release-helper.test.ts",
  "update-stop-first.test.ts",
  // This suite creates shared journal subprocesses; keep it out of the parallel lane.
  "codex-journal.test.ts",
  // This suite inflates ~256 MiB bodies; keep aggregate memory below container limits.
  "request-decompress.test.ts",
] as const;

const SERIAL_LANE_TIMEOUT_MS: Partial<Record<(typeof SERIAL_FULL_SUITE_FILES)[number], number>> = {
  // This file intentionally exercises 33 complete release-script subprocess trees.
  // It is ~90s on an idle machine and measured at ~170s under unrelated host load.
  "release-helper.test.ts": 5 * 60 * 1000,
};

export interface BunTestLane {
  label: string;
  args: string[];
  timeoutMs: number;
}

export function terminationCommandForTests(
  pid: number,
  platform = process.platform,
  resolveTaskkill: () => string = resolveTrustedWindowsTaskkillExe,
): string[] | null {
  return platform === "win32"
    ? [resolveTaskkill(), "/PID", String(pid), "/T", "/F"]
    : null;
}

export function testLaneTimedOut(exitCode: number | null): boolean {
  return exitCode === null;
}

export function laneExitCodeForTests(exitCode: number | null, interrupted: NodeJS.Signals | null): number {
  if (testLaneTimedOut(exitCode)) return 124;
  if (interrupted === "SIGINT") return 130;
  if (interrupted === "SIGTERM") return 143;
  return exitCode!;
}

export interface TestTerminationOptions {
  pid: number;
  platform: string;
  signal?: NodeJS.Signals;
  exited: Promise<number>;
  signalGroup?: (signal: NodeJS.Signals) => void;
  isAlive?: () => boolean;
  resolveTaskkill?: () => string;
  taskkill?: (command: string[]) => number;
  graceMs?: number;
  killGraceMs?: number;
}

export interface TestTerminationGraceOptions {
  graceMs?: number;
  killGraceMs?: number;
}

export async function terminateTestProcessForTests(options: TestTerminationOptions): Promise<void> {
  if (!Number.isSafeInteger(options.pid) || options.pid <= 0) {
    throw new Error(`[test] child pid must be a positive safe integer; received ${options.pid}`);
  }
  const graceMs = options.graceMs ?? 5_000;
  const killGraceMs = options.killGraceMs ?? 2_000;
  if (options.platform === "win32") {
    const command = terminationCommandForTests(options.pid, "win32", options.resolveTaskkill)!;
    const result = options.taskkill?.(command) ?? 0;
    if (result !== 0) {
      throw new Error(`[test] failed to terminate process tree with ${command[0]} (exit ${result})`);
    }
    if (await waitWithTimeout(options.exited, killGraceMs) === null) {
      throw new Error(`[test] process tree ${options.pid} did not terminate after taskkill`);
    }
    return;
  }
  const signal = options.signalGroup ?? (() => {});
  const alive = options.isAlive ?? (() => false);
  signal(options.signal ?? "SIGTERM");
  if (await waitForProcessDeath(alive, graceMs)) return;
  signal("SIGKILL");
  if (!await waitForProcessDeath(alive, killGraceMs)) {
    throw new Error(`[test] process group ${options.pid} did not terminate after SIGKILL`);
  }
}

async function waitForProcessDeath(isAlive: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isAlive()) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await Bun.sleep(Math.min(10, remaining));
  }
  return true;
}

function withoutParallelOverride(requested: string[]): string[] {
  return requested.filter(arg => arg !== "--parallel" && !arg.startsWith("--parallel="));
}

function canUseSerialLanes(requested: string[]): boolean {
  if (!isFullSuiteRun(requested)) return false;
  return !["--changed", "--shard", "--reporter-outfile", "--update-timings"].some(flag => hasCliFlag(requested, flag));
}

/** Build the default full-suite plan: one bounded main lane plus isolated risky files. */
export function resolveBunTestPlan(requested: string[], comparisonCommit?: string): BunTestLane[] {
  if (!canUseSerialLanes(requested)) {
    return [{ label: "suite", args: resolveBunTestArgs(requested, comparisonCommit), timeoutMs: 15 * 60 * 1000 }];
  }

  const mainArgs = resolveBunTestArgs(requested, comparisonCommit);
  const rootIndex = mainArgs.lastIndexOf("./tests/");
  const ignores = SERIAL_FULL_SUITE_FILES.flatMap(file => ["--path-ignore-patterns", `**/${file}`]);
  mainArgs.splice(rootIndex === -1 ? mainArgs.length : rootIndex, 0, ...ignores);
  const serialRequested = withoutParallelOverride(requested);
  return [
    { label: "parallel suite", args: mainArgs, timeoutMs: 15 * 60 * 1000 },
    ...SERIAL_FULL_SUITE_FILES.map(file => ({
      label: file,
      args: resolveBunTestArgs(["--parallel=1", ...serialRequested, `./tests/${file}`]),
      timeoutMs: SERIAL_LANE_TIMEOUT_MS[file] ?? 3 * 60 * 1000,
    })),
  ];
}

function waitWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export interface TestLaneRuntimeOptions extends TestTerminationGraceOptions {
  command?: string[];
  createEnvironment?: typeof createIsolatedTestEnvironment;
  terminateProcess?: (child: Bun.Subprocess, signal: NodeJS.Signals) => Promise<void>;
}

export async function runTestLaneForTests(
  lane: BunTestLane,
  runId: string,
  options: TestLaneRuntimeOptions = {},
): Promise<number> {
  const isolated = (options.createEnvironment ?? createIsolatedTestEnvironment)({
    ...process.env,
    [TEST_RUN_ID_ENV]: runId,
  });
  const startedAt = Date.now();
  let interrupted: NodeJS.Signals | null = null;
  let termination: Promise<void> | null = null;
  let onInterrupt: (() => void) | null = null;
  let onTerminate: (() => void) | null = null;
  try {
    const child = Bun.spawn(options.command ?? [process.execPath, "test", ...lane.args], {
      env: isolated.env,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      detached: process.platform !== "win32",
    });
    const terminate = options.terminateProcess ?? ((target, signal) => terminateSpawnedTestProcessForTests(
      target,
      signal,
      options,
    ));
    let resolveInterrupt!: (signal: NodeJS.Signals) => void;
    const interruptRequested = new Promise<NodeJS.Signals>(resolve => { resolveInterrupt = resolve; });
    const forward = (signal: NodeJS.Signals) => {
      if (interrupted) return;
      interrupted = signal;
      termination ??= Promise.resolve().then(() => terminate(child, signal));
      resolveInterrupt(signal);
    };
    onInterrupt = () => forward("SIGINT");
    onTerminate = () => forward("SIGTERM");
    process.on("SIGINT", onInterrupt);
    process.on("SIGTERM", onTerminate);

    const outcome = await Promise.race([
      waitWithTimeout(child.exited, lane.timeoutMs).then(exitCode => ({ kind: "exit" as const, exitCode })),
      interruptRequested.then(async signal => {
        await termination;
        return { kind: "interrupt" as const, signal };
      }),
    ]);
    if (outcome.kind === "interrupt") return laneExitCodeForTests(0, outcome.signal);

    const exitCode = outcome.exitCode;
    if (testLaneTimedOut(exitCode)) {
      console.error(`[test] ${lane.label} exceeded ${Math.round(lane.timeoutMs / 1000)}s; terminating pid ${child.pid}.`);
      termination ??= Promise.resolve().then(() => terminate(child, "SIGTERM"));
      await termination;
      return 124;
    }
    if (interrupted === "SIGINT") return laneExitCodeForTests(exitCode, interrupted);
    if (interrupted === "SIGTERM") return laneExitCodeForTests(exitCode, interrupted);
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.warn(`[test] ${lane.label} finished in ${seconds}s (exit ${exitCode}).`);
    return { exitCode, output };
  } finally {
    try {
      try {
        if (termination) await termination;
      } finally {
        isolated.cleanup();
      }
    } finally {
      if (onInterrupt) process.off("SIGINT", onInterrupt);
      if (onTerminate) process.off("SIGTERM", onTerminate);
    }
  }
}

export async function terminateSpawnedTestProcessForTests(
  child: { pid: number; exited: Promise<number>; kill(signal: NodeJS.Signals): void },
  signal: NodeJS.Signals,
  grace: TestTerminationGraceOptions = {},
): Promise<void> {
  if (process.platform === "win32") {
    return terminateTestProcessForTests({ pid: child.pid, platform: "win32", signal, exited: child.exited,
      taskkill: command => Bun.spawnSync(command, { stdout: "ignore", stderr: "pipe" }).exitCode,
      ...grace });
  }

  const signalGroup = (name: NodeJS.Signals) => {
    try { process.kill(-child.pid, name); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  return terminateTestProcessForTests({ pid: child.pid, platform: process.platform, signal, exited: child.exited,
    signalGroup, isAlive: () => processGroupAlive(child.pid), ...grace });
}

function processGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface TestMainRuntimeOptions {
  lockPath?: string;
  pollMs?: number;
  maxWaitMs?: number;
  runLane?: (lane: BunTestLane, runId: string) => Promise<number>;
}

export async function runTestMainForTests(
  requestedTests: string[],
  options: TestMainRuntimeOptions = {},
): Promise<number> {
  const fullSuite = isFullSuiteRun(requestedTests);
  const runId = fullSuite ? randomUUID() : undefined;
  const lock = fullSuite ? await acquireTestRunLock({
    runId: runId!,
    lockPath: options.lockPath,
    pollMs: options.pollMs,
    maxWaitMs: options.maxWaitMs,
    onWait: owner => console.warn(
      `[test] another Bun test run${owner ? ` (pid ${owner.pid})` : ""} holds the machine lock; waiting. `
      + "Set OCX_TEST_NO_QUEUE=1 only for intentional overlap.",
    ),
    onAcquiredAfterWait: elapsedMs => console.warn(`[test] acquired the machine lock after ${Math.round(elapsedMs / 1000)}s.`),
  }) : { release() {} };
  const startedAt = Date.now();
  try {
    let exitCode = 0;
    for (const lane of resolveBunTestPlan(requestedTests)) {
      const laneExitCode = await (options.runLane ?? runTestLaneForTests)(lane, runId ?? "focused");
      if (laneExitCode !== 0 && exitCode === 0) exitCode = laneExitCode;
      if ([124, 130, 143].includes(laneExitCode)) break;
    }
  }
  if (process.exitCode !== 1) {
    if (changedRun) {
      console.warn(
        `[test] changed mode comparison ref: ${changedRun.comparisonRef}; merge base: ${changedRun.comparisonCommit}`,
      );
    }
    return exitCode;
  } finally {
    lock.release();
  }
}

if (import.meta.main) {
  process.exitCode = await runTestMainForTests(process.argv.slice(2));
}
