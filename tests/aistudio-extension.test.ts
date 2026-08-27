import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const EXT_DIR = join(process.cwd(), "integrations/aistudio-extension");

describe("Google AI Studio Chrome/Brave Session Exporter Extension", () => {
  test("manifest.json has valid Manifest V3 structure without background or content scripts", () => {
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

    expect(manifest.background).toBeUndefined();
    expect(manifest.content_scripts).toBeUndefined();
  });

  test("popup.js implements harvesting of SAPISID, project/window, port persistence, and auto-sync", () => {
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
    // Dynamic port via chrome.storage.local with 10100 default
    expect(code).toContain("proxyPort");
    expect(code).toContain("getValidatedPort");
    expect(code).toContain("10100");
    expect(code).toContain("/api/aistudio/session");
    expect(code).toContain("btnAutoSync");
    expect(code).toContain("btnCopyBundle");
    expect(code).toContain("x-opencodex-api-key");
  });

  test("popup.html contains port input, auto-sync, copy, and status elements without relay status", () => {
    const popupHtmlPath = join(EXT_DIR, "popup.html");
    expect(existsSync(popupHtmlPath)).toBe(true);
    const html = readFileSync(popupHtmlPath, "utf-8");

    expect(html).toContain('id="proxyPort"');
    expect(html).toContain('id="btnAutoSync"');
    expect(html).toContain('id="btnCopyBundle"');
    expect(html).toContain('id="exportStatus"');
    expect(html).toContain('id="proxyApiKey"');
    expect(html).not.toContain('id="status"');
  });

  test("obsolete background, content, and offscreen files are deleted", () => {
    expect(existsSync(join(EXT_DIR, "background.js"))).toBe(false);
    expect(existsSync(join(EXT_DIR, "content.js"))).toBe(false);
    expect(existsSync(join(EXT_DIR, "offscreen.js"))).toBe(false);
    expect(existsSync(join(EXT_DIR, "offscreen.html"))).toBe(false);
  });
});
