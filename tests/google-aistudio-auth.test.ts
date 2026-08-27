import { describe, expect, test } from "bun:test";
import {
  buildAiStudioHeaders,
  generateSapisidHash,
  parseGoogleCookieJar,
  validateAiStudioCookies,
} from "../src/oauth/google-aistudio-auth";

describe("google aistudio auth — SAPISIDHASH generation", () => {
  test("calculates expected SHA-1 SAPISIDHASH for known inputs and timestamp", async () => {
    const sapisid = "sample_sapisid_xyz123";
    const origin = "https://aistudio.google.com";
    const timestampMs = 1740000000000;
    const timestamp = Math.floor(timestampMs / 1000);

    const hashHeader = await generateSapisidHash(sapisid, origin, timestampMs);

    // Compute expected SHA-1 manually
    const raw = `${timestamp} ${sapisid} ${origin}`;
    const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(raw));
    const expectedHex = Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    expect(hashHeader).toBe(`SAPISIDHASH ${timestamp}_${expectedHex}`);
  });
});

describe("google aistudio auth — cookie parsing", () => {
  test("parses cookie string correctly into individual keys and normalized jar", () => {
    const rawCookie = "SAPISID=my_sapisid; __Secure-1PSID=psid_1; SSID=ssid_val; HSID=hsid_val; SID=sid_val; other=xyz";
    const jar = parseGoogleCookieJar(rawCookie);

    expect(jar.sapisid).toBe("my_sapisid");
    expect(jar.psid).toBe("psid_1");
    expect(jar.ssid).toBe("ssid_val");
    expect(jar.hsid).toBe("hsid_val");
    expect(jar.sid).toBe("sid_val");
    expect(jar.cookieHeader).toContain("SAPISID=my_sapisid");
  });

  test("validates required cookies for AI Studio authorization", () => {
    expect(validateAiStudioCookies({ sapisid: "abc", cookieHeader: "SAPISID=abc" }).valid).toBe(true);
    expect(validateAiStudioCookies({ sapisid: "", cookieHeader: "" }).valid).toBe(false);
  });

  test("rejects cookie input containing header control characters", () => {
    const jar = parseGoogleCookieJar("SAPISID=abc\r\nX-Injected: yes");
    expect(jar.cookieHeader).toBe("");
    expect(validateAiStudioCookies(jar).valid).toBe(false);
  });
});

describe("google aistudio auth — request headers builder", () => {
  test("builds complete HTTP request headers for AI Studio internal API", async () => {
    const rawCookie = "SAPISID=my_sapisid_value; __Secure-1PSID=psid_val; HSID=hsid_val";
    const jar = parseGoogleCookieJar(rawCookie);

    const headers = await buildAiStudioHeaders(jar);

    expect(headers["Authorization"]).toMatch(/^SAPISIDHASH \d+_[a-f0-9]{40}$/);
    expect(headers["Cookie"]).toContain("SAPISID=my_sapisid_value");
    expect(headers["X-Goog-AuthUser"]).toBe("0");
    expect(headers["Origin"]).toBe("https://aistudio.google.com");
    expect(headers["Referer"]).toBe("https://aistudio.google.com/");
    expect(headers["Content-Type"]).toBe("application/json");
  });
});
