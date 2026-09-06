/**
 * The published docs must preserve the explicit 429-failover authority switch.
 *
 * Presence supplies the default only when the relevant setting is absent. An explicit false
 * disables replay under another stored identity, and every locale must say so consistently.
 */
import { describe, expect, test } from "bun:test";

const CONFIG_REFERENCE = "docs-site/src/content/docs/reference/configuration/providers.md";
const CLI_REFERENCE = "docs-site/src/content/docs/reference/cli/providers-accounts.md";
const TRANSLATED = ["ko", "ja", "zh-cn", "zh-tw", "fr", "ru", "tr"] as const;

describe("429 failover docs", () => {
  test("the config reference distinguishes absence from an explicit false", async () => {
    const source = await Bun.file(CONFIG_REFERENCE).text();
    const anthropicRow = source
      .split("\n")
      .find(line => line.includes("`anthropicAccountPool.enabled?`"));
    expect(anthropicRow).toBeDefined();
    expect(anthropicRow).toContain("When this key is omitted");
    expect(anthropicRow).toContain("explicit `false` disables");

    const genericRow = source
      .split("\n")
      .find(line => line.includes("| `oauthAccountFailover.enabled?`"));
    expect(genericRow).toBeDefined();
    expect(genericRow).toContain("when omitted");
    expect(genericRow).toContain("explicit `false` disables both");
  });

  test("the CLI reference documents the reactive opt-out", async () => {
    const source = await Bun.file(CLI_REFERENCE).text();
    expect(source).toContain("`oauthAccountFailover.enabled: false`");
    expect(source).toContain("disable both");
    expect(source).toContain("429 recovery");
  });

  test("every translated locale carries the corrected claim", async () => {
    // Shape, not wording: each locale phrases the authority boundary natively.
    for (const locale of TRANSLATED) {
      const config = await Bun.file(
        `docs-site/src/content/docs/${locale}/reference/configuration/providers.md`,
      ).text();
      const row = config
        .split("\n")
        .find(line => line.includes("`anthropicAccountPool.enabled?`"));
      expect(row, `${locale} is missing the anthropicAccountPool row`).toBeDefined();
      expect(row, `${locale} lost the 429 authority boundary`).toContain("429");
      expect(row, `${locale} lost the explicit false setting`).toContain("`false`");
    }
  });

  test("the Claude Code guides document explicit false as the reactive boundary", async () => {
    for (const path of ["", "zh-tw/", "tr/", "fr/"]) {
      const label = path || "en";
      const source = await Bun.file(`docs-site/src/content/docs/${path}guides/claude-code.md`).text();
      const intro = source.slice(0, source.indexOf("anthropicAccountPool.strategy"));
      expect(intro, `${label} guide`).toContain("429");
      expect(intro, `${label} guide`).toContain("anthropicAccountPool.enabled");
      expect(intro, `${label} guide`).toContain("false");
    }
  });
});
