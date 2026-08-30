import { describe, expect, test } from "bun:test";
import manifest from "./fixtures/claude-code-compatibility-manifest.json";

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
});
