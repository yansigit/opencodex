import { chmodSync, existsSync, mkdtempSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { getAiStudioSessionPath, loadAiStudioSession, saveAiStudioSession } from "./aistudio-session-sync";
import { resolveAiStudioCredentials } from "./aistudio-credentials";
import type { OcxProviderConfig } from "../types";

export function isNativeWebKitSupported(): boolean {
  return process.platform === "darwin";
}

export function getAiStudioNativeDaemonSourcePath(): string {
  return join(process.cwd(), "integrations/aistudio-daemon/main.swift");
}

export function getAiStudioNativeDaemonBinaryPath(): string {
  return join(process.cwd(), ".tmp/aistudio-webkit-daemon");
}

export async function buildAiStudioNativeDaemon(outputPath?: string): Promise<string> {
  const src = getAiStudioNativeDaemonSourcePath();
  const dest = outputPath ?? getAiStudioNativeDaemonBinaryPath();

  const proc = Bun.spawn(["swiftc", "-O", src, "-o", dest], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const errText = await new Response(proc.stderr).text();
    throw new Error(`Failed to compile native WebKit daemon: ${errText}`);
  }
  return dest;
}

type NativeLoginChild = { exited: Promise<number>; kill: () => void };
type NativeLoginSpawn = (command: string[], options: { stdout: "pipe"; stderr: "pipe" }) => NativeLoginChild;

export type AiStudioNativeLoginResult =
  | { kind: "authenticated"; sessionPath: string }
  | { kind: "cancelled" }
  | { kind: "unsupported" }
  | { kind: "failed"; error: string };

export interface AiStudioNativeLoginOptions {
  platform?: NodeJS.Platform;
  sessionPath?: string;
  signal?: AbortSignal;
  /** Test-only process seam. Production always uses Bun.spawn. */
  spawn?: NativeLoginSpawn;
}

function cleanupNativeSessionOutput(path: string, directory: string): void {
  if (existsSync(path)) {
    // Unlink by name instead of truncating first: if a same-user process swaps the
    // path for a symlink after validation, unlink removes only the link and never
    // follows it into an unrelated file. A failed unlink leaves a mode-protected
    // credential inside the owner-only staging directory.
    try { unlinkSync(path); } catch { /* hardened residual is safer than following a replacement */ }
  }
  try { rmdirSync(directory); } catch { /* retain only an owner-only staging directory */ }
}

/** Spawn one visible native login and report only after its session is durable and valid. */
export async function runAiStudioNativeLogin(options: AiStudioNativeLoginOptions = {}): Promise<AiStudioNativeLoginResult> {
  if ((options.platform ?? process.platform) !== "darwin") return { kind: "unsupported" };
  const sessionPath = options.sessionPath ?? getAiStudioSessionPath();
  const spawnLogin = options.spawn ?? ((command, spawnOptions) => Bun.spawn(command, spawnOptions) as unknown as NativeLoginChild);
  let stagingDirectory: string;
  try {
    stagingDirectory = mkdtempSync(join(tmpdir(), "opencodex-aistudio-native-"));
    chmodSync(stagingDirectory, 0o700);
  } catch {
    return { kind: "failed", error: "Could not create native AI Studio login staging" };
  }
  const sessionOutput = join(stagingDirectory, "session.json");
  let child: NativeLoginChild;
  try {
    child = spawnLogin([
      "swift",
      getAiStudioNativeDaemonSourcePath(),
      "--login",
      "--session-output",
      sessionOutput,
    ], { stdout: "pipe", stderr: "pipe" });
  } catch (error) {
    cleanupNativeSessionOutput(sessionOutput, stagingDirectory);
    return { kind: "failed", error: `Could not start native AI Studio login: ${error instanceof Error ? error.message : String(error)}` };
  }
  let aborted = options.signal?.aborted === true;
  const terminate = () => {
    aborted = true;
    try { child.kill(); } catch { /* already exited */ }
  };
  options.signal?.addEventListener("abort", terminate, { once: true });
  try {
    const exitCode = await child.exited;
    if (aborted || options.signal?.aborted) return { kind: "cancelled" };
    if (exitCode === 2) return { kind: "cancelled" };
    if (exitCode !== 0) return { kind: "failed", error: `Native AI Studio login failed (exit code ${exitCode})` };
    const session = loadAiStudioSession(sessionOutput);
    const credentials = resolveAiStudioCredentials({} as OcxProviderConfig, session);
    if (credentials.kind !== "ready" || !session) {
      return { kind: "failed", error: "Native login completed without a valid AI Studio session" };
    }
    saveAiStudioSession(session, sessionPath);
    return { kind: "authenticated", sessionPath };
  } catch {
    return { kind: "failed", error: "Native AI Studio session could not be persisted" };
  } finally {
    options.signal?.removeEventListener("abort", terminate);
    cleanupNativeSessionOutput(sessionOutput, stagingDirectory);
  }
}

export interface NativeDaemonHandle {
  process: ChildProcess;
  stop: () => void;
}

export function startAiStudioNativeDaemon(port = 10100): NativeDaemonHandle {
  const binPath = getAiStudioNativeDaemonBinaryPath();
  const srcPath = getAiStudioNativeDaemonSourcePath();

  const runner = existsSync(binPath)
    ? [binPath, "--port", String(port)]
    : ["swift", srcPath, "--port", String(port)];

  const child = spawn(runner[0]!, runner.slice(1), {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  return {
    process: child,
    stop: () => {
      try {
        child.kill();
      } catch (err) {
        void err;
      }
    },
  };
}
