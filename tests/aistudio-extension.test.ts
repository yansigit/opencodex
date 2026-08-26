import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAiStudioBridgeHtml } from "../src/server/aistudio-ws-hub";

const EXT_DIR = join(process.cwd(), "integrations/aistudio-extension");

describe("Google AI Studio Chrome/Brave Extension", () => {
  test("manifest.json has valid Manifest V3 structure and permissions", () => {
    const manifestPath = join(EXT_DIR, "manifest.json");
    expect(existsSync(manifestPath)).toBe(true);

    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.name).toContain("AI Studio");
    expect(manifest.permissions).toContain("tabs");
    expect(manifest.host_permissions).toContain("https://aistudio.google.com/*");
    expect(manifest.host_permissions).toContain("https://*.clients6.google.com/*");
  });

  test("content.js exists for direct aistudio.google.com page execution", () => {
    const contentPath = join(EXT_DIR, "content.js");
    expect(existsSync(contentPath)).toBe(true);
    const code = readFileSync(contentPath, "utf-8");
    expect(code).toContain("streamGenerateContent");
  });

  test("bridge html includes extension instructions and copy path", () => {
    const html = getAiStudioBridgeHtml(10100);
    expect(html).toContain("aistudio-extension");
    expect(html).toContain("Load unpacked");
    expect(html).toContain("brave://extensions");
  });
});
