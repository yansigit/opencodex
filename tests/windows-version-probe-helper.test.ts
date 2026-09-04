import { describe, expect, test } from "bun:test";
import { runWindowsVersionProbeHelper, WINDOWS_HELPER_CLEANUP_RESERVE_MS, WINDOWS_HELPER_MAX_OUTPUT_BYTES, type WindowsProbeChild } from "../src/claude/windows-version-probe-helper";
import type { WindowsCommandShimProbeRequest } from "../src/claude/client-version";

class FakeChild implements WindowsProbeChild {
  pid = 42;
  private readonly listeners = new Map<string, ((...args: never[]) => void)[]>();
  stdout = { on: (_event: "data", listener: (chunk: Uint8Array | string) => void) => { this.data = listener; } };
  private data: ((chunk: Uint8Array | string) => void) | undefined;
  once(event: "exit" | "close" | "error", listener: (...args: never[]) => void): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
  }
  emit(event: "exit" | "close" | "error", ...args: never[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
  write(value: string): void { this.data?.(value); }
}

const request = (deadlineAtMs = 1_000): WindowsCommandShimProbeRequest => ({
  file: "cmd.exe",
  args: ["/d", "/s", "/c", '"claude.cmd --version"'],
  options: { encoding: "utf8", timeout: 5_000, windowsHide: true, windowsVerbatimArguments: true },
  deadlineAtMs,
});

describe("Windows Claude version helper lifecycle", () => {
  test("refuses a late start that cannot reserve cleanup time", async () => {
    let spawned = false;
    const result = await runWindowsVersionProbeHelper(request(WINDOWS_HELPER_CLEANUP_RESERVE_MS), {
      now: () => 0,
      spawnTarget: () => { spawned = true; return new FakeChild(); },
    });
    expect(spawned).toBe(false);
    expect(result.error).toEqual({ code: "ETIMEDOUT" });
  });

  test("starts taskkill and waits for its close before reporting timeout", async () => {
    const target = new FakeChild();
    const killer = new FakeChild();
    const timers: (() => void)[] = [];
    let settled = false;
    const pending = runWindowsVersionProbeHelper(request(), {
      now: () => 0,
      spawnTarget: () => target,
      spawnTaskkill: pid => { expect(pid).toBe(42); return killer; },
      setTimer: callback => { timers.push(callback); return timers.length as unknown as ReturnType<typeof setTimeout>; },
      clearTimer: () => {},
    }).then(result => { settled = true; return result; });
    timers[0]!();
    await Promise.resolve();
    expect(settled).toBe(false);
    killer.emit("close", 0 as never, null as never);
    expect((await pending).error).toEqual({ code: "ETIMEDOUT" });
  });

  test("serializes only after close so drained output and exit status survive", async () => {
    const child = new FakeChild();
    let settled = false;
    const pending = runWindowsVersionProbeHelper(request(), {
      now: () => 0,
      spawnTarget: () => child,
      setTimer: () => 1 as unknown as ReturnType<typeof setTimeout>,
      clearTimer: () => {},
    }).then(result => { settled = true; return result; });
    child.emit("exit", 7 as never, null as never);
    child.write("2.1.207\n");
    await Promise.resolve();
    expect(settled).toBe(false);
    child.emit("close", 7 as never, null as never);
    await expect(pending).resolves.toMatchObject({ status: 7, stdout: "2.1.207\n" });
  });

  test("caps private stdout before returning it to the parent", async () => {
    const child = new FakeChild();
    const pending = runWindowsVersionProbeHelper(request(), {
      now: () => 0,
      spawnTarget: () => child,
      setTimer: () => 1 as unknown as ReturnType<typeof setTimeout>,
      clearTimer: () => {},
    });
    child.write("x".repeat(WINDOWS_HELPER_MAX_OUTPUT_BYTES + 100));
    child.emit("exit", 0 as never, null as never);
    child.emit("close", 0 as never, null as never);
    expect((await pending).stdout).toHaveLength(WINDOWS_HELPER_MAX_OUTPUT_BYTES);
  });
});
