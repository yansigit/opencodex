import { describe, expect, test } from "bun:test";
import { fetchProviderQuotaReports } from "../src/providers/quota";
import type { OcxConfig } from "../src/types";

describe("google-aistudio quota reporting", () => {
  test("reports local direct session status for google-aistudio without relay active state", async () => {
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
    expect(report?.source).toContain("Direct Session");
    expect(report?.source).not.toContain("Browser Relay");
    expect(report?.quota.customWindows).toBeUndefined();
  });
});
