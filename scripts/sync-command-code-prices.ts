#!/usr/bin/env bun
/**
 * Sync / verify Command Code model pricing against https://commandcode.ai/models.data.
 *
 * Usage:
 *   bun scripts/sync-command-code-prices.ts
 */
import { fetchCommandCodeModelPricing, commandCodePricingToExpectedOverlays } from "../src/usage/command-code-manifest";
import { VERIFIED_PRICE_OVERRIDES } from "../src/usage/expected-prices";

console.log("Fetching Command Code model pricing from https://commandcode.ai/models.data...");
const models = await fetchCommandCodeModelPricing();
console.log(`Found ${models.length} total models in manifest.`);

const liveOverlays = commandCodePricingToExpectedOverlays(models);
console.log(`${liveOverlays.length} models have non-zero pricing.`);

const currentMap = new Map(
  VERIFIED_PRICE_OVERRIDES.filter(r => r.provider === "command-code").map(r => [r.modelId, r.cost4])
);

let driftCount = 0;
let newCount = 0;

for (const live of liveOverlays) {
  const current = currentMap.get(live.modelId);
  if (!current) {
    console.log(`[NEW MODEL] ${live.modelId}: in=${live.cost4.input}, out=${live.cost4.output}, cacheRead=${live.cost4.cacheRead}, cacheWrite=${live.cost4.cacheWrite}`);
    newCount += 1;
  } else if (
    current.input !== live.cost4.input ||
    current.output !== live.cost4.output ||
    current.cacheRead !== live.cost4.cacheRead ||
    current.cacheWrite !== live.cost4.cacheWrite
  ) {
    console.log(`[PRICE DRIFT] ${live.modelId}: current=${JSON.stringify(current)} live=${JSON.stringify(live.cost4)}`);
    driftCount += 1;
  }
}

if (driftCount === 0 && newCount === 0) {
  console.log("All Command Code model prices in opencodex are up-to-date with live manifest!");
} else {
  console.log(`Summary: ${newCount} new models, ${driftCount} price drifts.`);
}
