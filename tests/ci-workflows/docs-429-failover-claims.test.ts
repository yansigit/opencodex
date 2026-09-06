/** Keep the published 429 failover authority boundary aligned with the runtime. */
import { describe, expect, test } from "bun:test";

const CONFIG_REFERENCE = "docs-site/src/content/docs/reference/configuration/providers.md";
const CLI_REFERENCE = "docs-site/src/content/docs/reference/cli/providers-accounts.md";
const TRANSLATED = ["ko", "ja", "zh-cn", "zh-tw", "fr", "ru", "tr"] as const;

describe("429 failover docs", () => {
  test("the config reference documents presence defaults and explicit opt-outs", async () => {
    const source = await Bun.file(CONFIG_REFERENCE).text();
    const anthropicRow = source
      .split("\n")
      .find(line => line.includes("`anthropicAccountPool.enabled?`"));
    expect(anthropicRow).toBeDefined();
    expect(anthropicRow).toContain("omitted");
    expect(anthropicRow).toContain("presence");
    expect(anthropicRow).toContain("explicit `false` disables");

    const genericRow = source
      .split("\n")
      .find(line => line.includes("| `oauthAccountFailover.enabled?`"));
    expect(genericRow).toBeDefined();
    expect(genericRow).toContain("pre-dispatch account preference");
    expect(genericRow).toContain("reactive 429 rotation");
    expect(genericRow).toContain("explicit `false` disables both");

    const providerRow = source
      .split("\n")
      .find(line => line.includes("`providers.<name>.oauthAccountFailover.enabled?`"));
    expect(providerRow).toBeDefined();
    expect(providerRow).toContain("beats the global setting in either direction");
    expect(providerRow).toContain("`false` disables preference and reactive 429 rotation");
    expect(providerRow).toContain("`true` opts this provider in");
  });

  test("the CLI reference describes the explicit generic opt-out", async () => {
    const source = await Bun.file(CLI_REFERENCE).text();
    const marker = source.indexOf("`oauthAccountFailover.enabled: false`");
    expect(marker).toBeGreaterThan(-1);
    const claim = source.slice(marker, marker + 220);
    expect(claim).toContain("disable both");
    expect(claim).toContain("429 recovery");
  });

  test("every translated locale carries the Anthropic explicit-false boundary", async () => {
    const disablesByLocale: Record<(typeof TRANSLATED)[number], RegExp> = {
      ko: /`false`.*(?:끕니다|비활성화)/,
      ja: /`false`.*無効/,
      "zh-cn": /`false`.*关闭/,
      "zh-tw": /`false`.*關閉/,
      fr: /`false`.*désactive/i,
      ru: /`false`.*отключ/i,
      tr: /`false`.*(?:kapat|devre dışı)/i,
    };
    for (const locale of TRANSLATED) {
      const config = await Bun.file(
        `docs-site/src/content/docs/${locale}/reference/configuration/providers.md`,
      ).text();
      const row = config
        .split("\n")
        .find(line => line.includes("`anthropicAccountPool.enabled?`"));
      expect(row, `${locale} is missing the anthropicAccountPool row`).toBeDefined();
      expect(row, `${locale} lost the presence-defaulted 429 claim`).toContain("429");
      expect(
        disablesByLocale[locale].test(row!),
        `${locale} lost the explicit-false opt-out claim`,
      ).toBe(true);
    }
  });

  test("the Claude Code guide distinguishes omission from explicit false", async () => {
    const optOutByLocale: Record<string, RegExp> = {
      "": /Setting `anthropicAccountPool\.enabled` explicitly[\s\S]{0,30}`false` disables that reactive failover/i,
      "zh-tw/": /`anthropicAccountPool\.enabled: false`[\s\S]{0,30}關閉此反應式容錯移轉/,
      "tr/": /`anthropicAccountPool\.enabled: false`[\s\S]{0,80}reaktif yük devretmeyi[\s\S]{0,20}kapatır/i,
      "fr/": /`anthropicAccountPool\.enabled: false`[\s\S]{0,60}désactive ce basculement réactif/i,
    };
    for (const [path, optOut] of Object.entries(optOutByLocale)) {
      const label = path || "en";
      const source = await Bun.file(`docs-site/src/content/docs/${path}guides/claude-code.md`).text();
      const intro = source.slice(0, source.indexOf("anthropicAccountPool.strategy"));
      expect(intro, `${label} guide`).toContain("429");
      expect(optOut.test(intro), `${label} guide lost the explicit-false opt-out`).toBe(true);
    }
  });
});
