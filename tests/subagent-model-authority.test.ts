import { describe, expect, test } from "bun:test";
import {
  parseSubagentModelAuthorityInput,
  resolveSubagentModelAuthority,
  type SubagentModelAuthorityHost,
  type SubagentModelAuthorityInput,
} from "../src/codex/subagent-model-authority";

const input = (overrides: Partial<SubagentModelAuthorityInput> = {}): SubagentModelAuthorityInput => ({
  schemaVersion: 1,
  role: "reviewer",
  agentType: "reviewer",
  spawnAgent: {
    surface: "v2",
    supportsAgentType: true,
    supportsModel: true,
    supportsEffort: true,
    supportsForkTurns: true,
  },
  ...overrides,
});

const host = (overrides: Partial<SubagentModelAuthorityHost> = {}): SubagentModelAuthorityHost => ({
  catalogState: "fresh",
  nativeDefaultState: "active",
  preferredModel: "gpt-5.6-luna",
  preferredEffort: "high",
  executableModels: [
    { model: "gpt-5.6-luna", efforts: ["low", "medium", "high"] },
    { model: "provider/other", efforts: ["medium", "high"] },
  ],
  ...overrides,
});

describe("subagent model authority contract", () => {
  test("forwards the host preference with typed dispatch and fork isolation", () => {
    expect(resolveSubagentModelAuthority(input(), host())).toEqual({
      schemaVersion: 1,
      decision: "forward",
      requestClassification: "inherit",
      reason: "OpenCodex preferred model is executable",
      spawn: { agent_type: "reviewer", model: "gpt-5.6-luna", reasoning_effort: "high", fork_turns: "none" },
    });
  });

  test("requires one-spawn confirmation for an executable exception", () => {
    const request = input({ requestedModel: "provider/other", requestedEffort: "medium" });
    expect(resolveSubagentModelAuthority(request, host())).toMatchObject({
      decision: "confirm",
      requestClassification: "exception",
      confirmation: { requestedModel: "provider/other", scope: "single spawn" },
    });
    expect(resolveSubagentModelAuthority({ ...request, confirmation: { decision: "approve" } }, host())).toMatchObject({
      decision: "forward",
      requestClassification: "exception",
      spawn: { model: "provider/other", reasoning_effort: "medium", fork_turns: "none" },
    });
  });

  test("blocks stale evidence and models absent from the executable catalog", () => {
    expect(resolveSubagentModelAuthority(input(), host({ catalogState: "stale" })).decision).toBe("blocked");
    expect(resolveSubagentModelAuthority(input({ requestedModel: "missing" }), host()).decision).toBe("blocked");
  });

  test("omits overrides only when native defaults are active", () => {
    const withoutPreference = host({ preferredModel: null, preferredEffort: null });
    expect(resolveSubagentModelAuthority(input(), withoutPreference).decision).toBe("omit");
    expect(resolveSubagentModelAuthority(input(), { ...withoutPreference, nativeDefaultState: "pending" }).decision).toBe("blocked");
  });

  test("validates the versioned JSON trust boundary", () => {
    expect(parseSubagentModelAuthorityInput(input())).not.toBeNull();
    expect(parseSubagentModelAuthorityInput({ ...input(), schemaVersion: 2 })).toBeNull();
    expect(parseSubagentModelAuthorityInput({ ...input(), spawnAgent: {} })).toBeNull();
  });
});
