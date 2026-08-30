import { describe, expect, spyOn, test } from "bun:test";
import { toBinary } from "@bufbuild/protobuf";
import { buildCursorRequestContext, buildCursorRequestContextRules } from "../src/adapters/cursor/request-context";
import { RequestContextSchema } from "../src/adapters/cursor/gen/agent_pb";

describe("Cursor request context rules", () => {
  test("maps ordered non-empty system entries to global USER rules", () => {
    const rules = buildCursorRequestContextRules(["first", "   ", "second"]);
    expect(rules.map(rule => ({ path: rule.fullPath, content: rule.content, source: rule.source, type: rule.type?.type.case }))).toEqual([
      { path: "/opencodex/system-prompt/0.mdc", content: "first", source: 2, type: "global" },
      { path: "/opencodex/system-prompt/2.mdc", content: "second", source: 2, type: "global" },
    ]);
  });

  test("builds env plus rules without duplicating cloud/skill/subagent channels", () => {
    const context = buildCursorRequestContext({ system: ["canary"] });
    expect(context.rules).toHaveLength(1);
    expect(context.env?.timeZone).toBeTruthy();
    expect(context.cloudRule).toBeUndefined();
    expect(context.skillOptions).toBeUndefined();
    expect(context.customSubagents).toEqual([]);
  });

  test("post-assembly budget drops only trailing rules", () => {
    const previousDebug = process.env.OCX_DEBUG;
    process.env.OCX_DEBUG = "1";
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      const context = buildCursorRequestContext({ system: ["a", "b".repeat(600_000), "c"] });
      expect(toBinary(RequestContextSchema, context).byteLength).toBeLessThanOrEqual(512 * 1024);
      expect(context.rules.map(rule => rule.content)).toEqual(["a"]);
      expect(error).toHaveBeenCalledTimes(1);
      expect(String(error.mock.calls[0]?.[0] ?? "")).toContain(
        '[ocx:cursor:request-context-truncated] {"originalRules":3,"keptRules":1',
      );
    } finally {
      error.mockRestore();
      if (previousDebug === undefined) delete process.env.OCX_DEBUG;
      else process.env.OCX_DEBUG = previousDebug;
    }
  });
});
