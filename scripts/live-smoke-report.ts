type SmokeStatus = "passed" | "skipped" | "failed";

interface SmokeResultLike {
  provider?: unknown;
  status?: unknown;
  reason?: unknown;
  level1Passed?: unknown;
  level2Passed?: unknown;
  level3Passed?: unknown;
  claudeMcpPassed?: unknown;
  durationMs?: unknown;
  error?: unknown;
}

export type LiveSmokeFailureCategory =
  | "assertion"
  | "auth"
  | "decode"
  | "provider"
  | "quota"
  | "timeout"
  | "transport"
  | "upstream";

function safeProvider(value: unknown): string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(value)
    ? value
    : "unknown-provider";
}

function safeStatus(value: unknown): SmokeStatus {
  if (value === "passed" || value === "skipped" || value === "failed") return value;
  throw new Error("invalid live smoke status");
}

export function classifyLiveSmokeFailure(error: unknown): LiveSmokeFailureCategory {
  const message = typeof error === "string" ? error : "";
  if (/abort|deadline|no response|timed?\s*out|timeout/i.test(message)) return "timeout";
  if (/\b(?:401|403)\b|auth(?:entication|orization)?|credential|not_authenticated/i.test(message)) return "auth";
  if (/\b429\b|billing|credit|quota|rate.?limit/i.test(message)) return "quota";
  if (/\b5\d\d\b|bad gateway|service unavailable|upstream/i.test(message)) return "upstream";
  if (/assertion|expected|tool call/i.test(message)) return "assertion";
  if (/decode|invalid json|parse|protobuf/i.test(message)) return "decode";
  if (/connection|fetch failed|network|socket|transport|econn/i.test(message)) return "transport";
  return "provider";
}

function skippedCategory(reason: unknown): string {
  if (reason === "not_authenticated" || reason === "quota_exhausted" || reason === "cached_pass") {
    return reason;
  }
  return "provider_skip";
}

export function formatLiveSmokeReport(value: unknown, attempt: number): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("invalid live smoke result");
  if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > 2) throw new Error("invalid live smoke attempt");

  return value.map((entry: SmokeResultLike) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("invalid live smoke entry");
    const provider = safeProvider(entry.provider);
    const status = safeStatus(entry.status);
    const duration = Number.isFinite(entry.durationMs) ? Math.max(0, Math.round(Number(entry.durationMs))) : 0;
    const gates = [entry.level1Passed, entry.level2Passed, entry.level3Passed, entry.claudeMcpPassed]
      .map(passed => passed === true ? "pass" : "fail")
      .join(",");
    const category = status === "failed"
      ? classifyLiveSmokeFailure(entry.error)
      : status === "skipped"
        ? skippedCategory(entry.reason)
        : "none";
    return `${provider} attempt ${attempt}: ${status} (duration=${duration}ms; gates=${gates}; category=${category})`;
  });
}

async function main(): Promise<void> {
  const resultIndex = process.argv.indexOf("--result");
  const attemptIndex = process.argv.indexOf("--attempt");
  const resultPath = resultIndex >= 0 ? process.argv[resultIndex + 1] : undefined;
  const attempt = attemptIndex >= 0 ? Number(process.argv[attemptIndex + 1]) : Number.NaN;
  if (!resultPath) throw new Error("missing live smoke result path");
  const value = JSON.parse(await Bun.file(resultPath).text()) as unknown;
  for (const line of formatLiveSmokeReport(value, attempt)) console.log(line);
}

if (import.meta.main) {
  await main().catch(() => {
    console.error("live smoke report unavailable: invalid result file");
    process.exit(2);
  });
}
