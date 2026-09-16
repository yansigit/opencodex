import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { getAiStudioSessionPath, loadAiStudioSession } from "./aistudio-session-sync";
import { resolveAiStudioCredentials } from "./aistudio-credentials";

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

export type AiStudioNativeLoginResult =
  | { kind: "authenticated"; sessionPath: string }
  | { kind: "cancelled" }
  | { kind: "unsupported" }
  | { kind: "failed"; error: string };

export interface AiStudioNativeLoginProcess {
  exited: Promise<number>;
  kill?: () => void;
}

export type AiStudioNativeLoginSpawn = (command: string, args: string[]) => AiStudioNativeLoginProcess;

export async function runAiStudioNativeLogin(options?: {
  spawn?: AiStudioNativeLoginSpawn;
  signal?: AbortSignal;
  loadSession?: typeof loadAiStudioSession;
  sessionPath?: string;
  platform?: NodeJS.Platform;
}): Promise<AiStudioNativeLoginResult> {
  const platform = options?.platform ?? process.platform;
  if (!options?.spawn && platform !== "darwin") {
    return { kind: "unsupported" };
  }

  const command = "swift";
  const args = [getAiStudioNativeDaemonSourcePath(), "--login"];
  const spawnFn = options?.spawn ?? ((cmd, spawnArgs) => {
    const proc = Bun.spawn([cmd, ...spawnArgs], { stdout: "inherit", stderr: "inherit" });
    return {
      exited: proc.exited,
      kill: () => { try { proc.kill(); } catch { /* already exited */ } },
    };
  });

  let child: AiStudioNativeLoginProcess;
  try {
    child = spawnFn(command, args);
  } catch (err) {
    return { kind: "failed", error: err instanceof Error ? err.message : String(err) };
  }

  const abort = () => { try { child.kill?.(); } catch { /* already exited */ } };
  if (options?.signal?.aborted) {
    abort();
    return { kind: "cancelled" };
  }
  options?.signal?.addEventListener("abort", abort, { once: true });

  let code: number;
  try {
    code = await child.exited;
  } catch (err) {
    return { kind: "failed", error: err instanceof Error ? err.message : String(err) };
  } finally {
    options?.signal?.removeEventListener("abort", abort);
  }

  if (options?.signal?.aborted || code === 2) return { kind: "cancelled" };
  if (code !== 0) return { kind: "failed", error: `Native login failed (exit ${code})` };

  const session = (options?.loadSession ?? loadAiStudioSession)();
  const credentials = resolveAiStudioCredentials({ adapter: "google-aistudio", baseUrl: "https://aistudio.google.com" }, session);
  if (credentials.kind !== "ready") {
    return { kind: "failed", error: "Native login did not produce a valid session." };
  }
  return { kind: "authenticated", sessionPath: options?.sessionPath ?? getAiStudioSessionPath() };
}
