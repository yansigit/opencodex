/**
 * The Claude pool toggle must state its 429 failover authority accurately.
 *
 * Presence enables reactive rotation by default only while the setting is absent. Once the
 * operator explicitly turns the pool off, replay under another stored identity is off too.
 *
 * These assertions are deliberately about meaning rather than exact wording: a locale may
 * rephrase freely, but the enabled strings may stay focused on proactive behavior while every
 * locale's disabled string must still state the actual off state. Copy drift in one of ten
 * files is exactly how the original inconsistency survived.
 */
import { describe, expect, test } from "bun:test";

const LOCALE_PATHS = [
  "gui/src/i18n/en.ts",
  "gui/src/i18n/de.ts",
  "gui/src/i18n/fr.ts",
  "gui/src/i18n/ja.ts",
  "gui/src/i18n/ko.ts",
  "gui/src/i18n/ru.ts",
  "gui/src/i18n/tr.ts",
  "gui/src/i18n/zh.ts",
  "gui/src/i18n/zh-TW.ts",
] as const;

function valueOf(source: string, key: string): string {
  // The dictionaries are flat single-line entries, so the value is everything between the
  // first quote after the key and the closing quote of that line.
  const line = source.split("\n").find(candidate => candidate.includes(`"${key}":`));
  expect(line, `${key} is missing`).toBeDefined();
  const start = line!.indexOf(":") + 1;
  return line!.slice(start).trim();
}

describe("Claude account pool toggle copy", () => {
  test("no locale promises 429 failover in the ENABLED descriptions", async () => {
    // "429" is the load-bearing token: every locale writes the status code as digits, including
    // the CJK and Cyrillic ones. The concise enabled copy remains focused on proactive behavior;
    // the disabled copy below owns the cross-account replay statement.
    for (const path of LOCALE_PATHS) {
      const source = await Bun.file(path).text();
      expect(valueOf(source, "anthropicPool.enabledDesc"), path).not.toContain("429");
      expect(valueOf(source, "anthropicPool.enabledNoProactiveDesc"), path).not.toContain("429");
    }
  });

  test("every locale still states what the OFF position actually means", async () => {
    // The off position must keep describing the one-account-per-session behaviour it does own.
    // An empty or removed string would silently drop the explanation rather than fix it.
    for (const path of LOCALE_PATHS) {
      const source = await Bun.file(path).text();
      const disabled = valueOf(source, "anthropicPool.disabledDesc");
      expect(disabled.length, path).toBeGreaterThan(20);
    }
  });

  test("English names the disabled failover explicitly", async () => {
    const source = await Bun.file("gui/src/i18n/en.ts").text();
    const disabled = valueOf(source, "anthropicPool.disabledDesc");
    expect(disabled).toContain("429");
    expect(disabled).toContain("is off");
  });

  test("the experimental warning is untouched", async () => {
    // Proactive multi-account routing remains experimental. The authority correction does not
    // change that warning.
    const source = await Bun.file("gui/src/i18n/en.ts").text();
    const warning = valueOf(source, "anthropicPool.experimentalWarning");
    expect(warning).toContain("Experimental and not battle-tested");
    expect(warning).toContain("automated multi-account rotation");
  });
});
