import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { loadAiStudioSession, getAiStudioSessionPath } from "./aistudio-session-sync";
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

/** Spawn one visible native login and report only after its session is durable and valid. */
export async function runAiStudioNativeLogin(options: AiStudioNativeLoginOptions = {}): Promise<AiStudioNativeLoginResult> {
  if ((options.platform ?? process.platform) !== "darwin") return { kind: "unsupported" };
  const sessionPath = options.sessionPath ?? getAiStudioSessionPath();
  const spawnLogin = options.spawn ?? ((command, spawnOptions) => Bun.spawn(command, spawnOptions) as unknown as NativeLoginChild);
  let child: NativeLoginChild;
  try {
    child = spawnLogin(["swift", getAiStudioNativeDaemonSourcePath(), "--login"], { stdout: "pipe", stderr: "pipe" });
  } catch (error) {
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
    const session = loadAiStudioSession(sessionPath);
    const credentials = resolveAiStudioCredentials({} as OcxProviderConfig, session);
    return credentials.kind === "ready"
      ? { kind: "authenticated", sessionPath }
      : { kind: "failed", error: "Native login completed without a valid AI Studio session" };
  } catch (error) {
    return { kind: "failed", error: error instanceof Error ? error.message : String(error) };
  } finally {
    options.signal?.removeEventListener("abort", terminate);
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
