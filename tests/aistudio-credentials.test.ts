import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { resolveAiStudioCredentials } from "../src/oauth/aistudio-credentials";
import type { OcxProviderConfig } from "../src/types";

const provider = (overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig => ({
  adapter: "google",
  googleMode: "ai-studio-web",
  baseUrl: "https://alkalimakersuite-pa.clients6.google.com",
  ...overrides,
});

const session = (cookieValue = "session-sapisid") => ({
  selectedProject: "project",
  windowId: "window",
  cookies: [{ name: "SAPISID", value: cookieValue }],
});

describe("AI Studio credential resolution", () => {
  test("uses a valid provider apiKey and returns a stable SHA-256 fingerprint", () => {
    const cookieHeader = "SAPISID=api-sapisid; SID=api-sid";
    const result = resolveAiStudioCredentials(provider({ apiKey: cookieHeader }), null);

    expect(result).toEqual({
      kind: "ready",
      cookieHeader,
      source: "provider-api-key",
      fingerprint: createHash("sha256").update(cookieHeader).digest("hex"),
    });
    expect(result.fingerprint).not.toContain("api-sapisid");
  });

  test("uses Cookie headers case-insensitively when apiKey is absent", () => {
    const cookieHeader = "SAPISID=header-sapisid; SID=header-sid";
    const result = resolveAiStudioCredentials(provider({ headers: { cOoKiE: cookieHeader } }), null);

    expect(result).toMatchObject({ kind: "ready", source: "provider-header", cookieHeader });
  });

  test("falls through invalid higher-priority values to a valid lower-priority source", () => {
    const cookieHeader = "SAPISID=session-sapisid";
    const result = resolveAiStudioCredentials(
      provider({ apiKey: "arbitrary-api-key", headers: { Cookie: "SID=header-without-sapisid" } }),
      session("session-sapisid"),
    );

    expect(result).toMatchObject({ kind: "ready", source: "session", cookieHeader });
  });

  test("does not treat arbitrary strings as credentials", () => {
    const result = resolveAiStudioCredentials(provider({ apiKey: "arbitrary-api-key" }), null);

    expect(result.kind).toBe("invalid");
    expect(result.reason).toMatch(/SAPISID/i);
  });

  test("reports missing SAPISID as invalid when no source is usable", () => {
    const result = resolveAiStudioCredentials(provider({ apiKey: "SID=only-sid" }), null);

    expect(result).toEqual({
      kind: "invalid",
      reason: "Missing SAPISID cookie required for Google AI Studio authorization.",
    });
  });

  test("rejects control characters without returning cookie text", () => {
    const result = resolveAiStudioCredentials(provider({ apiKey: "SAPISID=bad\nvalue" }), null);

    expect(result.kind).toBe("invalid");
    expect(JSON.stringify(result)).not.toContain("bad");
  });

  test("uses a saved session when provider sources are absent", () => {
    const result = resolveAiStudioCredentials(provider(), session());

    expect(result).toMatchObject({ kind: "ready", source: "session" });
  });
});
