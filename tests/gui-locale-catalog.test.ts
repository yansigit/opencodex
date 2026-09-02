import { describe, test, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";

function parseCatalog(filePath: string): Record<string,string> {
  const src = fs.readFileSync(filePath, "utf8");
  const exportIdx = src.indexOf("export const");
  if (exportIdx === -1) throw new Error(filePath + " missing export const");
  const braceStart = src.indexOf("{", exportIdx);
  const braceEnd = src.lastIndexOf("}");
  const body = src.slice(braceStart, braceEnd + 1);
  // Use Function to evaluate JS object literal with proper escaping (handles \" etc)
  return (new Function(`return (${body})`))() as Record<string,string>;
}

const LOCALES = ["de","fr","ja","ko","ru","tr","zh","zh-TW"] as const;
const EN_PATH = path.join(import.meta.dir, "../gui/src/i18n/en.ts");

// Representative union sentinels: fork-retained keys (only on origin/dev) and upstream v2.40.0 keys (only on vendor/main).
// If either side regresses, this test fails before lint/build can hide it.
const FORK_SENTINELS = [
  "common.copy",
  "common.copied",
  "dash.activity.title",
  "dash.serverSettingsTitle",
  "prov.cooldownCleared",
  "cursorPool.title",
  "antigravityRouting.failoverOnlyTitle",
  "models.contextMetadataSource",
  "sub.roles",
  "replitGateway.title",
] as const;

const UPSTREAM_SENTINELS = [
  "api.rotation.title",
  "integrations.cursor.title",
  "integrations.tab.cursor",
  "cws.capability.adaptiveEffort",
  "pws.capacity.uncalibratedPlan",
  "connection.discovering",
  "connection.pairing.title",
  "usage.scope.label",
  "connection.machine.title",
] as const;

describe("GUI locale catalog union", () => {
  test("en contains union of fork-retained and upstream v2.40.0 keys", () => {
    const en = parseCatalog(EN_PATH);
    for (const k of FORK_SENTINELS) {
      expect(k in en, "en missing fork sentinel " + k).toBe(true);
      expect(en[k] && en[k].trim().length > 0, "en fork sentinel empty " + k).toBe(true);
    }
    for (const k of UPSTREAM_SENTINELS) {
      expect(k in en, "en missing upstream sentinel " + k).toBe(true);
      expect(en[k] && en[k].trim().length > 0, "en upstream sentinel empty " + k).toBe(true);
    }
    // Union size: dev 2522 ∪ vendor 2383 = 2596 (intersection 2309)
    expect(Object.keys(en).length).toBe(2596);
  });

  test("every locale matches en exactly (no missing or extra keys)", () => {
    const en = parseCatalog(EN_PATH);
    const enKeys = new Set(Object.keys(en));
    for (const locale of LOCALES) {
      const p = path.join(import.meta.dir, "../gui/src/i18n/" + locale + ".ts");
      const cat = parseCatalog(p);
      const missing = Object.keys(en).filter(k => !(k in cat));
      const extra = Object.keys(cat).filter(k => !enKeys.has(k));
      expect({ locale, missing, extra }, locale + " missing/extra: " + JSON.stringify({missing: missing.slice(0,5), extra: extra.slice(0,5)} ) ).toEqual({ locale, missing: [], extra: [] });
    }
  });

  test("fork-retained translations are preserved (not English filler or empty)", () => {
    const en = parseCatalog(EN_PATH);
    // Check de/fr/ja/ko have real translations for fork keys
    for (const locale of ["de","fr","ja","ko"] as const) {
      const cat = parseCatalog(path.join(import.meta.dir, "../gui/src/i18n/" + locale + ".ts"));
      for (const k of FORK_SENTINELS) {
        const v = cat[k];
        expect(v && v.trim().length > 0, locale + " sentinel empty " + k).toBe(true);
        // For core fork keys the translation must not be identical to English (would indicate fallback)
        if (k === "common.copy" || k === "common.copied" || k === "cursorPool.title" || k === "prov.cooldownCleared") {
          expect(v !== en[k], locale + " " + k + " is English filler").toBe(true);
        }
      }
    }
  });
});
