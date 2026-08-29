import { discoverTestFiles } from "./test-lanes";
import { renameSync } from "node:fs";

export const TIMING_VERSION = 1;
export const MAX_DURATION_MS = 24 * 60 * 60 * 1000;

export interface TimingData {
  version: number;
  files: Record<string, number>;
}

export function validateTimingData(value: unknown, files: Set<string>): TimingData {
  if (!value || typeof value !== "object") throw new Error("timing data must be an object");
  const data = value as Partial<TimingData>;
  if (data.version !== TIMING_VERSION) throw new Error(`timing data version must be ${TIMING_VERSION}`);
  if (!data.files || typeof data.files !== "object" || Array.isArray(data.files)
    || Object.keys(data.files).length === 0 || Object.keys(data.files).length > files.size) {
    throw new Error("timing entry count is outside the allowed range");
  }
  for (const [path, durationMs] of Object.entries(data.files)) {
    if (!/^tests\/[A-Za-z0-9._/-]+$/.test(path) || path.includes("..") || !files.has(path)) {
      throw new Error(`timing entry has an invalid or unknown path: ${path}`);
    }
    if (typeof durationMs !== "number" || !Number.isFinite(durationMs)
      || durationMs < 0 || durationMs > MAX_DURATION_MS) {
      throw new Error(`timing entry has an invalid duration: ${path}`);
    }
  }
  return { version: TIMING_VERSION, files: { ...data.files } };
}

if (import.meta.main) {
  const path = process.argv[2];
  if (!path) throw new Error("usage: validate-timings.ts <timings.json>");
  try {
    const value = await Bun.file(path).json();
    const timings = validateTimingData(value, new Set(discoverTestFiles()));
    console.log(`validated ${Object.keys(timings.files).length} timing entries`);
  } catch (error) {
    if (!process.argv.includes("--discard-invalid")) throw error;
    renameSync(path, `${path}.invalid`);
    console.warn(`::warning::discarded invalid restored timing data: ${error}`);
  }
}
