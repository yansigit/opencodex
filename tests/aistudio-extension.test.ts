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
    expect(manifest.permissions).toContain("cookies");
    expect(manifest.permissions).toContain("storage");
    expect(manifest.permissions).toContain("tabs");
    expect(manifest.permissions).toContain("scripting");
    expect(manifest.host_permissions).toContain("https://aistudio.google.com/*");
    expect(manifest.host_permissions).toContain("https://*.clients6.google.com/*");
    expect(manifest.host_permissions).toContain("http://127.0.0.1/*");
  });

  test("popup.js implements harvesting of SAPISID, selectedProject, windowId, btoa token and sync", () => {
    const popupJsPath = join(EXT_DIR, "popup.js");
    expect(existsSync(popupJsPath)).toBe(true);
    const code = readFileSync(popupJsPath, "utf-8");

    // SAPISID cookie check
    expect(code).toContain("SAPISID");
    // localStorage & sessionStorage harvesting
    expect(code).toContain("selectedProject");
    expect(code).toContain("maker_suite_browser_window_id");
    // btoa serialization
    expect(code).toContain("btoa");
    // Auto-sync endpoint
    expect(code).toContain("http://127.0.0.1:10100/api/aistudio/session");
    expect(code).toContain("btnAutoSync");
    expect(code).toContain("btnCopyBundle");
    expect(code).toContain("x-opencodex-api-key");
  });

  test("popup.html contains auto-sync, copy, and status elements", () => {
    const popupHtmlPath = join(EXT_DIR, "popup.html");
    expect(existsSync(popupHtmlPath)).toBe(true);
    const html = readFileSync(popupHtmlPath, "utf-8");

    expect(html).toContain('id="btnAutoSync"');
    expect(html).toContain('id="btnCopyBundle"');
    expect(html).toContain('id="exportStatus"');
    expect(html).toContain('id="status"');
    expect(html).toContain('id="proxyApiKey"');
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
