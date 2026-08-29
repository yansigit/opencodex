import { discoverTestFiles } from "./test-lanes";
import { validateTimingData, type TimingData } from "./validate-timings";

/** Keep only the files owned by one general shard for artifact publication. */
export function selectTimingData(value: unknown, selected: string[], inventory: Set<string>): TimingData {
  const report = validateTimingData(value, inventory);
  const selectedSet = new Set(selected);
  const files: Record<string, number> = {};
  for (const [path, durationMs] of Object.entries(report.files)) {
    if (selectedSet.has(path)) files[path] = durationMs;
  }
  return validateTimingData({ version: 1, files }, inventory);
}

if (import.meta.main) {
  const [path, ...selected] = process.argv.slice(2);
  if (!path || selected.length === 0) throw new Error("usage: select-timings.ts <timings.json> <test> [...]");
  const inventory = new Set(discoverTestFiles());
  const selectedReport = selectTimingData(await Bun.file(path).json(), selected, inventory);
  await Bun.write(path, JSON.stringify(selectedReport));
  console.log(`selected ${Object.keys(selectedReport.files).length} timing entries`);
}
