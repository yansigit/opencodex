import { describe, expect, test } from "bun:test";
import { fetchProviderQuotaReports } from "../src/providers/quota";
import { globalAiStudioRelayHub } from "../src/server/aistudio-ws-hub";
import type { OcxConfig } from "../src/types";

describe("google-aistudio quota reporting", () => {
  test("reports rate limits and relay status for google-aistudio", async () => {
    const config: OcxConfig = {
      port: 4000,
      providers: {
        "google-aistudio": {
          adapter: "google",
          googleMode: "ai-studio-web",
          baseUrl: "https://alkalimakersuite-pa.clients6.google.com",
          authMode: "local",
        },
      },
    } as unknown as OcxConfig;

    const res = await fetchProviderQuotaReports(config, true);
    const report = res.reports.find((r) => r.provider === "google-aistudio");
    expect(report).toBeDefined();
    expect(report?.label).toContain("Google AI Studio");
    expect(report?.source).toContain("Browser Relay");
    expect(report?.quota.customWindows).toBeUndefined();
  });
});
