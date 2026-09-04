/**
 * Windows-only companion for the Claude version probe. It is intentionally a
 * small process boundary: the caller's synchronous 5s timeout bounds this
 * helper, while this helper owns the cmd.exe tree and reaps it before reporting
 * a timeout. A Job Object would be stronger, but no maintained Job Object
 * binding is present in this Bun-native dependency set; taskkill /T is the
 * established repository fallback for cmd.exe trees.
 */
import { spawn } from "node:child_process";
import { resolveTrustedWindowsTaskkillExe } from "../lib/windows-elevation";
import type { ClaudeVersionProbeOptions, WindowsCommandShimProbeRequest } from "./client-version";

const HELPER_DEADLINE_MS = 4_500;
const MAX_OUTPUT_BYTES = 4_096;

function taskkillTree(pid: number): void {
  try {
    const killer = spawn(resolveTrustedWindowsTaskkillExe(), ["/PID", String(pid), "/T", "/F"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    killer.unref();
  } catch {
    // A raced exit or unavailable taskkill is still a typed, nonthrowing result.
  }
}

function readRequest(): WindowsCommandShimProbeRequest | null {
  try {
    const value = JSON.parse(process.argv[2] ?? "") as Partial<WindowsCommandShimProbeRequest>;
    if (typeof value.file !== "string" || !Array.isArray(value.args) || value.args.some(arg => typeof arg !== "string")) return null;
    const options = value.options as ClaudeVersionProbeOptions;
    if (!options || options.encoding !== "utf8" || options.timeout !== 5_000 || options.windowsHide !== true) return null;
    return { file: value.file, args: value.args, options };
  } catch {
    return null;
  }
}

function run(): void {
  const request = readRequest();
  if (!request) {
    process.stdout.write(JSON.stringify({ error: { code: "ETIMEDOUT" } }), () => process.exit(0));
    return;
  }
  let finished = false;
  let output = "";
  const finish = (result: object): void => {
    if (finished) return;
    finished = true;
    process.stdout.write(JSON.stringify({ ...result, stdout: output }), () => process.exit(0));
  };
  try {
    // Child stdout is private to this helper; neither stdout nor stderr can keep
    // the synchronous parent pipe open after cmd.exe exits.
    const { encoding: _encoding, timeout: _timeout, ...childOptions } = request.options;
    const child = spawn(request.file, [...request.args], {
      ...childOptions,
      stdio: ["ignore", "pipe", "ignore"],
    });
    child.stdout?.on("data", (chunk: Uint8Array) => {
      if (output.length < MAX_OUTPUT_BYTES) output += new TextDecoder().decode(chunk).slice(0, MAX_OUTPUT_BYTES - output.length);
    });
    const timer = setTimeout(() => {
      if (child.pid) taskkillTree(child.pid);
      finish({ error: { code: "ETIMEDOUT" }, status: null, signal: null });
    }, HELPER_DEADLINE_MS);
    child.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      finish({ error: { code: typeof error.code === "string" ? error.code : "ETIMEDOUT" }, status: null, signal: null });
    });
    child.once("exit", (status, signal) => {
      clearTimeout(timer);
      finish({ error: null, status, signal });
    });
  } catch {
    finish({ error: { code: "ETIMEDOUT" }, status: null, signal: null });
  }
}

run();
