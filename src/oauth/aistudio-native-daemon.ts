import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

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
