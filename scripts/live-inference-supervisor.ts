#!/usr/bin/env bun
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

function duration(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return fallback;
  return Math.max(50, Math.min(Number(raw), fallback));
}

function atomicReceipt(controlDir: string, name: string, value: string): void {
  const target = join(controlDir, name);
  const temporary = `${target}.tmp-${process.pid}`;
  writeFileSync(temporary, value, { mode: 0o600 });
  renameSync(temporary, target);
}

const [rawControlDir, ...command] = Bun.argv.slice(2);
if (!rawControlDir || command.length === 0) {
  console.error("usage: live-inference-supervisor <control-dir> <command> [args...]");
  process.exit(2);
}

const controlDir = resolve(rawControlDir);
mkdirSync(controlDir, { recursive: true, mode: 0o700 });

// Install cancellation handlers before the detached child exists. A signal in
// the spawn/receipt window is then remembered and handled by the same owner.
let signalRequested = false;
process.on("SIGINT", () => { signalRequested = true; });
process.on("SIGTERM", () => { signalRequested = true; });

const child = Bun.spawn(command, {
  detached: true,
  env: process.env,
  stdin: "ignore",
  stdout: "inherit",
  stderr: "inherit",
});
atomicReceipt(controlDir, "pid", `${child.pid}\n`);

const stopPath = join(controlDir, "stop");
while (child.exitCode === null && !signalRequested && !existsSync(stopPath)) {
  await Bun.sleep(100);
}

function groupAlive(): boolean {
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitForGroupExit(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (groupAlive() && Date.now() < deadline) await Bun.sleep(100);
  return !groupAlive();
}

function signalGroup(signal: NodeJS.Signals): void {
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

if (groupAlive()) {
  signalGroup("SIGTERM");
  if (!await waitForGroupExit(duration("OCX_LIVE_SUPERVISOR_TERM_GRACE_MS", 15_000))) {
    console.error("Proxy process group did not exit after TERM; escalating to KILL.");
    signalGroup("SIGKILL");
    if (!await waitForGroupExit(duration("OCX_LIVE_SUPERVISOR_KILL_GRACE_MS", 5_000))) {
      throw new Error("proxy process group survived KILL");
    }
  }
}

const exitCode = await child.exited;
atomicReceipt(controlDir, "stopped", `${JSON.stringify({ pid: child.pid, exitCode })}\n`);
