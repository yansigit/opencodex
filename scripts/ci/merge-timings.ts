import { discoverTestFiles } from "./test-lanes";
import { validateTimingData, type TimingData } from "./validate-timings";

/** Merge trusted shard reports after validating every report independently. */
export function mergeTimingData(values: unknown[], files: Set<string>): TimingData {
  if (values.length === 0) throw new Error("no timing reports were supplied");
  const merged: Record<string, number> = {};
  for (const value of values) {
    const report = validateTimingData(value, files);
    for (const [path, durationMs] of Object.entries(report.files)) {
      if (path in merged) throw new Error(`duplicate timing entry: ${path}`);
      merged[path] = durationMs;
    }
  }
  return validateTimingData({ version: 1, files: merged }, files);
}

if (import.meta.main) {
  const paths = process.argv.slice(2);
  if (paths.length === 0) throw new Error("usage: merge-timings.ts <timings.json> [...]");
  const reports = await Promise.all(paths.map(path => Bun.file(path).json()));
  const merged = mergeTimingData(reports, new Set(discoverTestFiles()));
  await Bun.write(".bun-timings.json", JSON.stringify(merged));
  console.log(`merged ${Object.keys(merged.files).length} timing entries`);
}
