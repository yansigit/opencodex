/**
 * Windows command-shim companion for the Claude version probe. A Job Object
 * would provide stronger OS-level containment, but this Bun-native project has
 * no maintained Job Object dependency. This uses the repository-standard
 * best-effort `taskkill /T` while cmd.exe is still a live tree root.
 */
import { spawn } from "node:child_process";
import { resolveTrustedWindowsTaskkillExe } from "../lib/windows-elevation";
import type { ClaudeVersionProbeOptions, ClaudeVersionProbeOutput, WindowsCommandShimProbeRequest } from "./client-version";

export const WINDOWS_HELPER_CLEANUP_RESERVE_MS = 400;
export const WINDOWS_HELPER_MAX_OUTPUT_BYTES = 4_096;
const TASKKILL_WAIT_CAP_MS = 250;

type Timer = ReturnType<typeof setTimeout> | number;
type ExitListener = (status: number | null, signal: NodeJS.Signals | null) => void;
type ErrorListener = (error: NodeJS.ErrnoException) => void;

export interface WindowsProbeChild {
  readonly pid?: number;
  readonly stdout?: { on(event: "data", listener: (chunk: Uint8Array | string) => void): void } | null;
  once(event: "exit", listener: ExitListener): void;
  once(event: "close", listener: ExitListener): void;
  once(event: "error", listener: ErrorListener): void;
}

export interface WindowsHelperDeps {
  now?: () => number;
  spawnTarget?: (request: WindowsCommandShimProbeRequest) => WindowsProbeChild;
  spawnTaskkill?: (pid: number) => WindowsProbeChild | null;
  setTimer?: (callback: () => void, ms: number) => Timer;
  clearTimer?: (timer: Timer) => void;
}

function defaultSpawnTarget(request: WindowsCommandShimProbeRequest): WindowsProbeChild {
  const { encoding: _encoding, timeout: _timeout, ...childOptions } = request.options;
  return spawn(request.file, [...request.args], {
    ...childOptions,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function defaultSpawnTaskkill(pid: number): WindowsProbeChild | null {
  try {
    return spawn(resolveTrustedWindowsTaskkillExe(), ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
  } catch {
    return null;
  }
}

function awaitClose(child: WindowsProbeChild | null, waitMs: number, deps: Required<Pick<WindowsHelperDeps, "setTimer" | "clearTimer">>): Promise<void> {
  if (!child || waitMs <= 0) return Promise.resolve();
  return new Promise(resolve => {
    const timer = deps.setTimer(resolve, waitMs);
    child.once("close", () => { deps.clearTimer(timer); resolve(); });
    child.once("error", () => { deps.clearTimer(timer); resolve(); });
  });
}

/** Run the helper lifecycle without writing stdout, for deterministic unit tests. */
export async function runWindowsVersionProbeHelper(
  request: WindowsCommandShimProbeRequest,
  deps: WindowsHelperDeps = {},
): Promise<ClaudeVersionProbeOutput> {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? setTimeout;
  const clearTimer = deps.clearTimer ?? clearTimeout;
  if (request.deadlineAtMs - now() <= WINDOWS_HELPER_CLEANUP_RESERVE_MS) {
    return { error: { code: "ETIMEDOUT" } };
  }
  let child: WindowsProbeChild;
  try {
    child = (deps.spawnTarget ?? defaultSpawnTarget)(request);
  } catch {
    return { error: { code: "ETIMEDOUT" } };
  }
  let output = "";
  child.stdout?.on("data", chunk => {
    if (output.length >= WINDOWS_HELPER_MAX_OUTPUT_BYTES) return;
    const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    output += text.slice(0, WINDOWS_HELPER_MAX_OUTPUT_BYTES - output.length);
  });
  return await new Promise(resolve => {
    let finished = false;
    let timedOut = false;
    let exit: { status: number | null; signal: NodeJS.Signals | null } | null = null;
    const finish = (result: ClaudeVersionProbeOutput): void => {
      if (finished) return;
      finished = true;
      clearTimer(timeoutTimer);
      resolve({ ...result, stdout: output });
    };
    const timeoutAtMs = request.deadlineAtMs - WINDOWS_HELPER_CLEANUP_RESERVE_MS;
    const timeoutTimer = setTimer(() => {
      timedOut = true;
      const killer = child.pid ? (deps.spawnTaskkill ?? defaultSpawnTaskkill)(child.pid) : null;
      // Start cleanup while cmd.exe is live, then wait only inside the absolute reserve.
      void awaitClose(killer, Math.min(TASKKILL_WAIT_CAP_MS, Math.max(0, request.deadlineAtMs - now())), { setTimer, clearTimer })
        .then(() => finish({ error: { code: "ETIMEDOUT" } }));
    }, Math.max(0, timeoutAtMs - now()));
    child.once("error", error => {
      if (!timedOut) finish({ error: { code: typeof error.code === "string" ? error.code : "ETIMEDOUT" } });
    });
    child.once("exit", (status, signal) => {
      if (!timedOut) exit = { status, signal };
    });
    // `close`, not `exit`, guarantees the private stdout has drained before serialization.
    child.once("close", (status, signal) => {
      if (!timedOut) finish({
        status: exit?.status ?? status,
        signal: exit?.signal ?? signal,
        error: null,
      });
    });
  });
}

function readRequest(): WindowsCommandShimProbeRequest | null {
  try {
    const value = JSON.parse(process.argv[2] ?? "") as Partial<WindowsCommandShimProbeRequest>;
    const options = value.options as ClaudeVersionProbeOptions;
    if (typeof value.file !== "string" || !Array.isArray(value.args) || value.args.some(arg => typeof arg !== "string")
      || !options || options.encoding !== "utf8" || options.timeout !== 5_000 || options.windowsHide !== true
      || typeof value.deadlineAtMs !== "number") return null;
    return { file: value.file, args: value.args, options, deadlineAtMs: value.deadlineAtMs };
  } catch {
    return null;
  }
}

if (import.meta.main) {
  const request = readRequest();
  void runWindowsVersionProbeHelper(request ?? {
    file: "",
    args: [],
    options: { encoding: "utf8", timeout: 5_000, windowsHide: true },
    deadlineAtMs: 0,
  }).then(result => process.stdout.write(JSON.stringify(result), () => process.exit(0)));
}
