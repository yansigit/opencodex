import { describe, expect, test } from "bun:test";
import { getProviderRegistryEntry } from "../src/providers/registry";
import { routedProviderConfig } from "../src/router";

describe("google-aistudio provider hardening & anti-ban configuration", () => {
  test("has request pacing and anti-burst jitter configured in registry", () => {
    const entry = getProviderRegistryEntry("google-aistudio");
    expect(entry).toBeDefined();
    expect(entry?.requestPacing).toBeDefined();
    expect(entry?.requestPacing?.enabled).toBe(true);
    expect(entry?.requestPacing?.minIntervalMs).toBeGreaterThanOrEqual(1000);
    expect(entry?.requestPacing?.jitterMs).toBeGreaterThanOrEqual(300);
  });

  test("backfills pacing for older saved configs that predate the registry rule", () => {
    const routed = routedProviderConfig("google-aistudio", {
      adapter: "google",
      baseUrl: "https://alkalimakersuite-pa.clients6.google.com",
      authMode: "local",
      googleMode: "ai-studio-web",
    });
    expect(routed.requestPacing?.enabled).toBe(true);
    expect(routed.requestPacing?.minIntervalMs).toBeGreaterThanOrEqual(1000);
  });
});
