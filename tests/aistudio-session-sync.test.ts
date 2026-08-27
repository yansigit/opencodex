import { describe, expect, test } from "bun:test";
import {
  cookieHeaderFromSession,
  getAiStudioSessionPath,
  loadAiStudioSession,
  parseSessionBundle,
  saveAiStudioSession,
  saveAiStudioSessionFromToken,
  serializeSessionBundle,
} from "../src/oauth/aistudio-session-sync";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homedir } from "node:os";

describe("Google AI Studio Session Bundle Exporter & Importer", () => {
  const sampleData = {
    selectedProject: "gen-lang-client-123456",
    windowId: "TEST-WINDOW-ID-456",
    cookies: [
      { name: "SAPISID", value: "test_sapisid_val", domain: ".google.com", path: "/" },
      { name: "__Secure-1PSID", value: "test_psid_val", domain: ".google.com", path: "/" },
    ],
  };

  test("serializes and parses base64 session bundle correctly", () => {
    const encoded = serializeSessionBundle(sampleData);
    expect(typeof encoded).toBe("string");
    expect(encoded.length).toBeGreaterThan(20);

    const decoded = parseSessionBundle(encoded);
    expect(decoded.selectedProject).toBe("gen-lang-client-123456");
    expect(decoded.windowId).toBe("TEST-WINDOW-ID-456");
    expect(decoded.cookies.length).toBe(2);
    expect(decoded.cookies[0]?.name).toBe("SAPISID");
  });

  test("rejects invalid or tampered bundle strings", () => {
    expect(() => parseSessionBundle("invalid-not-json")).toThrow();
    expect(() => parseSessionBundle(btoa(JSON.stringify({ empty: true })))).toThrow();
    expect(() => parseSessionBundle("")).toThrow("Invalid session token");
    expect(() => parseSessionBundle(null as any)).toThrow("Invalid session token");
    expect(() => parseSessionBundle(undefined as any)).toThrow("Invalid session token");
    expect(() => parseSessionBundle(btoa("null"))).toThrow();
    expect(() => parseSessionBundle(btoa(JSON.stringify({ cookies: "not-an-array" })))).toThrow();
    expect(() => parseSessionBundle(btoa(JSON.stringify({ selectedProject: "p1" })))).toThrow();
  });

  test("saves session bundle to ~/.opencodex/aistudio-session.json", () => {
    const dest = join(mkdtempSync(join(tmpdir(), "aistudio-session-")), "aistudio-session.json");
    saveAiStudioSession(sampleData, dest);
    expect(existsSync(dest)).toBe(true);

    const loaded = JSON.parse(readFileSync(dest, "utf-8"));
    expect(loaded.selectedProject).toBe("gen-lang-client-123456");
    expect(loaded.cookies.some((c: any) => c.name === "SAPISID")).toBe(true);
  });

  test("saveAiStudioSessionFromToken decodes base64 bundle and writes session file", () => {
    const encoded = serializeSessionBundle(sampleData);
    const dest = join(mkdtempSync(join(tmpdir(), "aistudio-session-")), "aistudio-session.json");
    const savedPath = saveAiStudioSessionFromToken(encoded, dest);
    expect(existsSync(savedPath)).toBe(true);

    const loaded = JSON.parse(readFileSync(savedPath, "utf-8"));
    expect(loaded.selectedProject).toBe("gen-lang-client-123456");
  });

  test("loadAiStudioSession reads cookies into a Cookie header", () => {
    const dest = join(mkdtempSync(join(tmpdir(), "aistudio-session-")), "aistudio-session.json");
    saveAiStudioSession(sampleData, dest);
    const loaded = loadAiStudioSession(dest);
    expect(loaded?.selectedProject).toBe("gen-lang-client-123456");
    expect(loaded?.windowId).toBe("TEST-WINDOW-ID-456");
    expect(cookieHeaderFromSession(loaded)).toContain("SAPISID=test_sapisid_val");
    expect(cookieHeaderFromSession(loaded)).toContain("__Secure-1PSID=test_psid_val");
  });

  test("loadAiStudioSession returns null for missing or invalid files", () => {
    expect(loadAiStudioSession(join(tmpdir(), "missing-aistudio-session.json"))).toBeNull();
    expect(cookieHeaderFromSession(null)).toBe("");
    const tmpDir = mkdtempSync(join(tmpdir(), "aistudio-invalid-"));
    const invalidJsonPath = join(tmpDir, "corrupted.json");
    writeFileSync(invalidJsonPath, "not valid json", "utf-8");
    expect(loadAiStudioSession(invalidJsonPath)).toBeNull();
    writeFileSync(invalidJsonPath, JSON.stringify({ noCookies: true }), "utf-8");
    expect(loadAiStudioSession(invalidJsonPath)).toBeNull();
  });

  test("cookieHeaderFromSession joins cookies and filters invalid or empty entries", () => {
    const session = {
      selectedProject: "p",
      windowId: "w",
      cookies: [
        { name: "SAPISID", value: "sapisid_val" },
        { name: "EMPTY_VAL", value: "" },
        { name: "", value: "no_name" },
        { name: "__Secure-1PSID", value: "psid_val" },
        { name: "INJECTED\r\nHeader", value: "bad" },
        { name: "GOOD", value: "val\nwith_nl" },
      ],
    };
    const header = cookieHeaderFromSession(session);
    expect(header).toBe("SAPISID=sapisid_val; __Secure-1PSID=psid_val");
    expect(cookieHeaderFromSession({ selectedProject: "", windowId: "", cookies: [] })).toBe("");
    expect(cookieHeaderFromSession(null)).toBe("");
    expect(cookieHeaderFromSession(undefined)).toBe("");
  });

  test("getAiStudioSessionPath returns path in user home directory", () => {
    const expected = join(homedir(), ".opencodex", "aistudio-session.json");
    expect(getAiStudioSessionPath()).toBe(expected);
  });
});
