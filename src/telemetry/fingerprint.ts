import { createHash } from "node:crypto";
import type { FailureEvent, FailureFingerprint } from "./types";

const EPHEMERAL_KEYS = /^(timestamp|.*(?:request|session)[_-]?id|line|column|col)$/i;
const EPHEMERAL_TEXT = [
  /\b(?:request|session)[_-]?id\s*[:=]\s*[^\s,;]+/gi,
  /\b(?:timestamp|time)\s*[:=]\s*[^\s,;]+/gi,
  /:\d+\s*:\s*\d+(?=\b|\D)/g,
  /\b(?:line|col(?:umn)?)\s*[:=]?\s*\d+/gi,
  /\b\d{10,13}\b/g,
];

function canonical(value: unknown): unknown {
  if (typeof value === "string") return EPHEMERAL_TEXT.reduce((text, pattern) => text.replace(pattern, ""), value).replace(/\s+/g, " ").trim();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([key]) => !EPHEMERAL_KEYS.test(key)).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

export function computeFailureFingerprint(event: FailureEvent): FailureFingerprint {
  return createHash("sha256").update(JSON.stringify(canonical(event))).digest("hex");
}
