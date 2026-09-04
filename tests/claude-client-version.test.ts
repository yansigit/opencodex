import { describe, expect, test } from "bun:test";
import manifest from "./fixtures/claude-code-compatibility-manifest.json";
import {
  CLAUDE_CODE_COMPATIBILITY_FLOOR,
  classifyClaudeClientVersion,
  compareClaudeClientVersions,
  parseClaudeClientVersion,
  probeClaudeClientVersion,
  type ClaudeClientState,
  type ClaudeVersionProbeOutput,
} from "../src/claude/client-version";

const allStates: readonly ClaudeClientState[] = [
  "compatible",
  "outdated",
  "missing",
  "timed-out",
  "unparseable",
];

function probe(output: ClaudeVersionProbeOutput) {
  return probeClaudeClientVersion({ versionProbe: () => output });
}

describe("Claude client version parser and compatibility policy", () => {
  test("accepts fixture versions and normal Claude --version banners", () => {
    const fixtureVersions = [
      manifest.claudeCode.compatibilityFloor,
      manifest.claudeCode.latestStable,
      manifest.claudeCode.previousStable,
      ...manifest.claudeCode.implementationBaseline,
      ...manifest.stableRequestCaptures.map(capture => capture.version),
    ];
    for (const version of fixtureVersions) expect(parseClaudeClientVersion(version)).toBe(version);
    expect(parseClaudeClientVersion("2.1.207 (Claude Code)")).toBe("2.1.207");
    expect(parseClaudeClientVersion("  v2.1.207 (Claude Code)  ")).toBe("2.1.207");
  });

  test("does not mistake embedded diagnostic digits for a Claude version", () => {
    expect(parseClaudeClientVersion("claude-cli/2.1.251 (external, sdk-cli)")).toBeNull();
    expect(parseClaudeClientVersion("failed after 2.1.207 milliseconds")).toBeNull();
    expect(parseClaudeClientVersion("2.1")).toBeNull();
  });

  test("orders strict dotted versions", () => {
    expect(compareClaudeClientVersions("2.1.200", CLAUDE_CODE_COMPATIBILITY_FLOOR)).toBeLessThan(0);
    expect(compareClaudeClientVersions(CLAUDE_CODE_COMPATIBILITY_FLOOR, CLAUDE_CODE_COMPATIBILITY_FLOOR)).toBe(0);
    expect(compareClaudeClientVersions("2.1.207", CLAUDE_CODE_COMPATIBILITY_FLOOR)).toBeGreaterThan(0);
  });

  test("classifies floor, below-floor, and every probe failure state", () => {
    const results = [
      probe({ stdout: CLAUDE_CODE_COMPATIBILITY_FLOOR }),
      probe({ stdout: "2.1.200" }),
      probe({ error: { code: "ENOENT" } }),
      probe({ status: 9_009 }),
      probe({ error: { code: "ETIMEDOUT" } }),
      probe({ error: new Error("spawn failed") }),
      probe({ signal: "SIGTERM" }),
      probe({ stdout: "not a version" }),
    ];
    expect(results.map(result => result.state)).toEqual([
      "compatible",
      "outdated",
      "missing",
      "missing",
      "timed-out",
      "timed-out",
      "timed-out",
      "unparseable",
    ]);
    expect(new Set(results.map(result => result.state))).toEqual(new Set(allStates));
    expect(results[0]?.version).toBe(CLAUDE_CODE_COMPATIBILITY_FLOOR);
    expect(results.slice(2).every(result => result.version === null)).toBe(true);
  });

  test("is total when the injected runner or invocation builder throws", () => {
    expect(probeClaudeClientVersion({ versionProbe: () => { throw new Error("hostile failure"); } }))
      .toEqual({ state: "timed-out", version: null, source: "path" });
    expect(probeClaudeClientVersion({
      commandInvocation: () => { throw new Error("hostile path"); },
    })).toEqual({ state: "timed-out", version: null, source: "path" });
  });
});

describe("Claude client version probing", () => {
  test("passes the bounded --version invocation to its injected synchronous runner", () => {
    const calls: Array<{ file: string; args: readonly string[]; options: unknown }> = [];
    const result = probeClaudeClientVersion({
      versionProbe(file, args, options) {
        calls.push({ file, args, options });
        return { stdout: "2.1.207" };
      },
    });
    expect(result).toEqual({ state: "compatible", version: "2.1.207", source: "path" });
    expect(calls).toEqual([{
      file: "claude",
      args: ["--version"],
      options: { encoding: "utf8", timeout: 5_000, windowsHide: true },
    }]);
  });

  test("keeps Windows resolution private and exposes only its bounded source tag", () => {
    const hostilePath = "C:\\Users\\private\\secrets\\claude.cmd";
    const result = probeClaudeClientVersion({
      platform: "win32",
      commandInvocation: () => ({
        file: hostilePath,
        args: ["/d", "/s", "/c", '"claude.cmd --version"'],
        options: { windowsVerbatimArguments: true },
      }),
      versionProbe(file, args, options) {
        expect(file).toBe(hostilePath);
        expect(args).toEqual(["/d", "/s", "/c", '"claude.cmd --version"']);
        expect(options).toEqual({
          encoding: "utf8",
          timeout: 5_000,
          windowsHide: true,
          windowsVerbatimArguments: true,
        });
        return { stdout: "2.1.207" };
      },
    });
    expect(result).toEqual({ state: "compatible", version: "2.1.207", source: "windows-command-shim" });
    expect(JSON.stringify(result)).not.toContain(hostilePath);
  });

  test("never serializes hostile output or error text", () => {
    const hostile = "very-secret-output-/Users/private/claude";
    const result = classifyClaudeClientVersion({ stdout: hostile, error: { code: "ENOENT", message: hostile } });
    expect(result).toEqual({ state: "missing", version: null, source: "path" });
    expect(JSON.stringify(result)).not.toContain(hostile);
  });
});
