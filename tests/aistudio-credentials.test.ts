import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { resolveAiStudioCredentials } from "../src/oauth/aistudio-credentials";
import type { AiStudioSessionData } from "../src/oauth/aistudio-session-sync";
import type { OcxProviderConfig } from "../src/types";

const baseProvider: OcxProviderConfig = {
  adapter: "google",
  googleMode: "ai-studio-web",
  baseUrl: "https://alkalimakersuite-pa.clients6.google.com",
};

const session: AiStudioSessionData = {
  selectedProject: "project",
  windowId: "window",
  cookies: [
    { name: "SAPISID", value: "session-sapisid" },
    { name: "SID", value: "session-sid" },
  ],
};

const fingerprint = (cookieHeader: string) => createHash("sha256").update(cookieHeader).digest("hex");

describe("AI Studio credential resolution", () => {
  test("resolves a valid provider apiKey first and fingerprints only the cookie header", () => {
    const cookieHeader = "SAPISID=api-sapisid; SID=api-sid";
    const result = resolveAiStudioCredentials({ ...baseProvider, apiKey: cookieHeader }, session);

    expect(result).toEqual({
      kind: "ready",
      cookieHeader,
      source: "provider-api-key",
      fingerprint: fingerprint(cookieHeader),
    });
    expect(JSON.stringify(result)).not.toContain("session-sapisid");
  });

  test("falls back from an invalid apiKey to a valid Cookie header", () => {
    const cookieHeader = "SAPISID=header-sapisid; SID=header-sid";
    const result = resolveAiStudioCredentials({
      ...baseProvider,
      apiKey: "not-an-api-key-or-cookie",
      headers: { cookie: cookieHeader },
    }, session);

    expect(result).toEqual({
      kind: "ready",
      cookieHeader,
      source: "provider-header",
      fingerprint: fingerprint(cookieHeader),
    });
  });

  test("looks up Cookie headers case-insensitively", () => {
    const cookieHeader = "SAPISID=header-sapisid";
    const result = resolveAiStudioCredentials({
      ...baseProvider,
      headers: { CoOkIe: cookieHeader },
    }, session);

    expect(result.kind).toBe("ready");
    expect(result).toMatchObject({ source: "provider-header", cookieHeader });
  });

  test("falls back from malformed higher-priority candidates to the saved session", () => {
    const result = resolveAiStudioCredentials({
      ...baseProvider,
      apiKey: "missing SAPISID=",
      headers: { Cookie: "arbitrary text" },
    }, session);

    expect(result).toMatchObject({
      kind: "ready",
      source: "session",
      cookieHeader: "SAPISID=session-sapisid; SID=session-sid",
    });
  });

  test("rejects arbitrary strings, missing SAPISID, and control characters", () => {
    for (const apiKey of ["arbitrary", "SID=only", "SAPISID=\u0001bad"]) {
      const result = resolveAiStudioCredentials({ ...baseProvider, apiKey }, null);
      expect(result.kind).toBe("invalid");
      expect(result).not.toHaveProperty("cookieHeader");
      expect(JSON.stringify(result)).not.toContain(apiKey);
    }
  });

  test("reports missing when no candidate is configured", () => {
    expect(resolveAiStudioCredentials(baseProvider, null).kind).toBe("missing");
  });

  test("returns invalid instead of throwing for malformed persisted runtime values", () => {
    expect(() => resolveAiStudioCredentials({
      ...baseProvider,
      apiKey: 123 as unknown as string,
      headers: { Cookie: 456 as unknown as string },
    }, null)).not.toThrow();
    expect(resolveAiStudioCredentials({
      ...baseProvider,
      apiKey: 123 as unknown as string,
      headers: { Cookie: 456 as unknown as string },
    }, null).kind).toBe("invalid");
  });
});
