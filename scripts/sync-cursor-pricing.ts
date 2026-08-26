import { EXPECTED_PRICE_OVERLAYS } from "../src/usage/expected-prices";

type Cost4 = { input: number; output: number; cacheRead: number; cacheWrite: number };
type DocModel = {
  id: string;
  provider: string;
  uncachedInput?: number;
  cacheWrite?: number;
  cacheRead?: number;
  output?: number;
  subRows?: DocModel[];
};

const DOCS_URL = "https://cursor.com/docs/models-and-pricing";
const DOCS_ORIGIN = new URL(DOCS_URL).origin;

async function fetchDocsCatalog(): Promise<DocModel[]> {
  const page = await fetch(DOCS_URL, {
    headers: { "User-Agent": "opencodex-cursor-pricing-sync" },
  });
  if (!page.ok) throw new Error(`Failed to fetch Cursor docs: HTTP ${page.status}`);

  const html = await page.text();
  const chunkPaths = [...new Set(
    [...html.matchAll(/\/docs-static\/_next\/static\/chunks\/[^"\\\s]+\.js/g)].map(match => match[0]),
  )];
  const token = 'e.s(["MODELS",0,';

  for (const chunkPath of chunkPaths) {
    const response = await fetch(`${DOCS_ORIGIN}${chunkPath}`);
    if (!response.ok) continue;
    const js = await response.text();
    const start = js.indexOf(token);
    if (start < 0) continue;

    const arrayStart = start + token.length;
    let depth = 0;
    for (let i = arrayStart; i < js.length; i++) {
      if (js[i] === "[") depth++;
      else if (js[i] === "]" && --depth === 0) {
        const models = new Function(`return ${js.slice(arrayStart, i + 1)}`)() as unknown;
        if (!Array.isArray(models)) throw new Error("Cursor MODELS export is not an array");
        return models as DocModel[];
      }
    }
  }
  throw new Error("Could not find Cursor MODELS catalog in any Next.js chunk");
}

function flattenModels(models: readonly DocModel[]): Array<{ id: string; provider: string; cost4: Cost4 }> {
  const rows: Array<{ id: string; provider: string; cost4: Cost4 }> = [];
  for (const model of models) {
    for (const row of [model, ...(model.subRows ?? [])]) {
      if (typeof row.uncachedInput !== "number" || typeof row.output !== "number") continue;
      rows.push({
        id: row.id === "auto-cost" ? "auto" : row.id,
        provider: model.provider,
        cost4: {
          input: row.uncachedInput,
          output: row.output,
          cacheRead: row.cacheRead ?? 0,
          cacheWrite: row.cacheWrite ?? 0,
        },
      });
    }
  }
  return rows;
}

function sameCost(a: Cost4, b: Cost4): boolean {
  return a.input === b.input
    && a.output === b.output
    && a.cacheRead === b.cacheRead
    && a.cacheWrite === b.cacheWrite;
}

async function main(): Promise<void> {
  console.log(`Fetching Cursor model catalog from ${DOCS_URL}...`);
  const rows = flattenModels(await fetchDocsCatalog());
  const overlays = new Map(
    EXPECTED_PRICE_OVERLAYS
      .filter(row => row.provider === "cursor")
      .map(row => [row.modelId, row.cost4] as const),
  );
  const seen = new Set<string>();
  let differences = 0;

  console.log("Model ID                      | Docs rates (input/read/write/output) | Overlay");
  console.log("-".repeat(88));
  for (const row of rows) {
    const overlay = overlays.get(row.id);
    if (!overlay && row.provider.toLowerCase() !== "cursor") continue;
    seen.add(row.id);
    const docsRates = `$${row.cost4.input} / $${row.cost4.cacheRead} / $${row.cost4.cacheWrite} / $${row.cost4.output}`;
    const overlayRates = overlay
      ? `$${overlay.input} / $${overlay.cacheRead} / $${overlay.cacheWrite} / $${overlay.output}`
      : "MISSING";
    const state = !overlay ? "NEW" : sameCost(row.cost4, overlay) ? "OK" : "CHANGED";
    if (state !== "OK") differences++;
    console.log(`${row.id.padEnd(28)} | ${docsRates.padEnd(37)} | ${overlayRates} [${state}]`);
  }
  for (const id of overlays.keys()) {
    if (seen.has(id)) continue;
    differences++;
    console.log(`${id.padEnd(28)} | ${"—".padEnd(37)} | STALE overlay`);
  }

  console.log(differences === 0
    ? "\nCursor pricing overlays are in sync."
    : `\n${differences} pricing difference(s) found; update src/usage/expected-prices.ts.`);
  if (differences > 0) process.exitCode = 1;
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
