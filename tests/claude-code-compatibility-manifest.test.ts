import { describe, expect, test } from "bun:test";
import manifest from "./fixtures/claude-code-compatibility-manifest.json";
import { analyzeClaudeCompatibility } from "../src/claude/compatibility";
import { anthropicToResponsesTranslation } from "../src/claude/inbound";

describe("frozen Claude Code compatibility matrix", () => {
  test("pins two adjacent stable releases, the audit baseline, and reference SHAs", () => {
    expect(manifest.claudeCode.latestStable).toBe("2.1.251");
    expect(manifest.claudeCode.previousStable).toBe("2.1.250");
    expect(manifest.claudeCode.implementationBaseline).toEqual(["2.1.248", "2.1.247"]);
    expect(manifest.claudeCode.compatibilityFloor).toBe("2.1.201");
    expect(manifest.references.map(reference => reference.repository)).toEqual([
      "diegosouzapw/OmniRoute",
      "router-for-me/CLIProxyAPI",
      "musistudio/claude-code-router",
      "BerriAI/litellm",
      "Portkey-AI/gateway",
    ]);
    for (const reference of manifest.references) expect(reference.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  test("current and previous stable sanitized captures remain routable", () => {
    expect(manifest.stableRequestCaptures.map(capture => capture.version)).toEqual([
      manifest.claudeCode.latestStable,
      manifest.claudeCode.previousStable,
    ]);
    for (const capture of manifest.stableRequestCaptures) {
      expect(capture.userAgent).toBe(`claude-cli/${capture.version} (external, sdk-cli)`);
    }

    const request = manifest.sanitizedStableRequest.body;
    const compat = analyzeClaudeCompatibility(request, {
      mode: "enforce",
      adapter: "openai-responses",
      anthropicBeta: manifest.sanitizedStableRequest.headers["anthropic-beta"],
    });
    expect(compat.compatible).toBe(true);
    expect(compat.decision).toBe("allow");
    expect(compat.featureCodes).toEqual(expect.arrayContaining(["cache_control", "context_management", "thinking_block"]));

    const translation = anthropicToResponsesTranslation(request);
    expect(translation.body.reasoning).toEqual({ summary: "auto", effort: "high" });
    expect(translation.body.tools).toEqual([expect.objectContaining({ type: "function", name: "Read" })]);
  });
});
