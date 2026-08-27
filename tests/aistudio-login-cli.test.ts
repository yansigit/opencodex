import { describe, expect, test } from "bun:test";
import { getProviderRegistryEntry } from "../src/providers/registry";
import {
  parseSessionBundle,
  saveAiStudioSessionFromToken,
  serializeSessionBundle,
} from "../src/oauth/aistudio-session-sync";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("google-aistudio provider registration & instructions", () => {
  test("registry entry has clear label, description, and dashboard instructions", () => {
    const entry = getProviderRegistryEntry("google-aistudio");
    expect(entry).toBeDefined();
    expect(entry?.label).toBe("Google AI Studio (Web)");
    expect(entry?.googleMode).toBe("ai-studio-web");
    expect(entry?.note).toContain("/aistudio/bridge");
    expect(entry?.baseUrl).toBe("https://alkalimakersuite-pa.clients6.google.com");
    expect(entry?.authKind).toBe("local");
    expect(entry?.keyOptional).toBe(true);
    expect(entry?.featured).toBe(true);
    expect(entry?.defaultModel).toBe("gemini-3.7-flash");
    expect(entry?.models).toEqual([
      "gemini-3.7-flash",
      "gemini-3.1-pro-preview",
      "gemini-2.5-pro",
      "gemini-2.5-flash",
      "gemini-3.5-flash",
    ]);
    expect(entry?.requestPacing).toEqual({
      enabled: true,
      requestsPerMinute: 8,
      minIntervalMs: 7500,
      jitterMs: 1500,
    });
    expect(entry?.extraMetadataAliases).toContain("aistudio");
    expect(entry?.extraMetadataAliases).toContain("gemini-aistudio");
  });

  test("validates base64 session bundle exchange", () => {
    const sample = {
      selectedProject: "gen-lang-test-001",
      windowId: "win-test",
      cookies: [{ name: "SAPISID", value: "sapisid_token" }],
    };
    const encoded = serializeSessionBundle(sample);
    const decoded = parseSessionBundle(encoded);
    expect(decoded.selectedProject).toBe("gen-lang-test-001");
    expect(decoded.cookies[0]?.name).toBe("SAPISID");
  });

  test("round-trips full session bundle with domain, path, and windowId", () => {
    const fullSession = {
      selectedProject: "project-xyz-999",
      windowId: "window-abc-123",
      cookies: [
        { name: "SAPISID", value: "sapisid_val_1", domain: ".google.com", path: "/" },
        { name: "__Secure-1PSID", value: "psid_val_2", domain: ".google.com", path: "/" },
        { name: "SSID", value: "ssid_val_3", domain: ".google.com", path: "/aistudio" },
      ],
    };
    const token = serializeSessionBundle(fullSession);
    expect(token.length).toBeGreaterThan(20);

    const tempDest = join(mkdtempSync(join(tmpdir(), "cli-token-")), "session.json");
    const saved = saveAiStudioSessionFromToken(token, tempDest);
    expect(existsSync(saved)).toBe(true);

    const parsed = JSON.parse(readFileSync(saved, "utf-8"));
    expect(parsed.selectedProject).toBe("project-xyz-999");
    expect(parsed.windowId).toBe("window-abc-123");
    expect(parsed.cookies.length).toBe(3);
    expect(parsed.cookies[2].path).toBe("/aistudio");
  });
});
