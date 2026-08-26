import { describe, expect, test } from "bun:test";
import { getProviderRegistryEntry } from "../src/providers/registry";

describe("google-aistudio provider registration & instructions", () => {
  test("registry entry has clear label, description, and dashboard instructions", () => {
    const entry = getProviderRegistryEntry("google-aistudio");
    expect(entry).toBeDefined();
    expect(entry?.label).toBe("Google AI Studio (Web)");
    expect(entry?.googleMode).toBe("ai-studio-web");
    expect(entry?.note).toContain("/aistudio/bridge");
  });
});
