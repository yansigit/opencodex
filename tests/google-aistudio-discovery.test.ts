import { describe, expect, test } from "bun:test";
import { getProviderRegistryEntry } from "../src/providers/registry";

describe("google-aistudio static model discovery", () => {
  test("registry entry specifies static models and liveModels is false or unset", () => {
    const entry = getProviderRegistryEntry("google-aistudio");
    expect(entry).toBeDefined();
    expect(entry?.id).toBe("google-aistudio");
    expect(entry?.models).toBeDefined();
    expect(entry?.models).toContain("gemini-3.7-flash");
    expect(entry?.liveModels).toBeFalsy();
  });
});
