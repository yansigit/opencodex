import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import AntigravityFailoverNote from "../src/components/provider-workspace/AntigravityFailoverNote";
import { LanguageProvider } from "../src/i18n/provider";

test("renders the static failover-only Antigravity contract without a toggle", () => {
  const html = renderToStaticMarkup(
    <LanguageProvider><AntigravityFailoverNote /></LanguageProvider>,
  );
  expect(html).toContain("failover only");
  expect(html).toContain("rate-limit 429 or credential failure");
  expect(html).not.toContain("toggle");
  expect(html).not.toContain("checkbox");
});
