import { loadConfig, resolveEnvValue } from "../config";
import { getCredential } from "../oauth/store";
import type { OAuthCredentials } from "../oauth/types";
import type { OcxProviderConfig } from "../types";
import { computeProviderSourceFingerprint, loadSmokeCache, recordSmokeResult, shouldRunSmokeForProvider } from "./fingerprint-cache";
import { buildSmokeScenarioRequest } from "./live-scenarios";

export interface ProviderSmokeResult {
  provider: string;
  modelId: string;
  status: "passed" | "skipped" | "failed";
  reason?: string;
  level1Passed: boolean;
  level2Passed: boolean;
  level3Passed: boolean;
  durationMs: number;
  error?: string;
}

function result(provider: string, modelId: string, started: number, extra: Partial<ProviderSmokeResult>): ProviderSmokeResult {
  return { provider, modelId, status: "failed", level1Passed: false, level2Passed: false, level3Passed: false, durationMs: Date.now() - started, ...extra };
}

export function providerHasSmokeCredential(
  provider: Partial<Pick<OcxProviderConfig, "apiKey" | "authMode" | "headers">>,
  credential?: OAuthCredentials | null,
): boolean {
  if (resolveEnvValue(provider.apiKey)?.trim()) return true;
  if (Object.entries(provider.headers ?? {}).some(([name, value]) => /authorization|cookie|api[-_]?key/i.test(name) && typeof value === "string" && value.trim().length > 0)) return true;
  if (provider.authMode === "forward") return true;
  return provider.authMode === "oauth" && Boolean(credential?.access?.trim() || credential?.refresh?.trim());
}

function classifyHttp(status: number, body: string): "not_authenticated" | "quota_exhausted" | undefined {
  if (status === 401 || status === 403) return "not_authenticated";
  if (status === 429 || /credit|quota|insufficient.?balance|billing/i.test(body)) return "quota_exhausted";
  return undefined;
}

export async function runProviderSmoke(options: { provider: string; modelId?: string; proxyUrl?: string; force?: boolean; cachePath?: string }): Promise<ProviderSmokeResult> {
  const started = Date.now();
  const config = loadConfig();
  const providerConfig = config.providers[options.provider];
  const modelId = options.modelId ?? config.subagentModels?.[0] ?? "gpt-5";
  if (!providerConfig || providerConfig.disabled === true) return result(options.provider, modelId, started, { status: "skipped", reason: "not_authenticated" });
  const credential = providerConfig.authMode === "oauth" ? getCredential(options.provider) : null;
  if (!providerHasSmokeCredential(providerConfig, credential)) return result(options.provider, modelId, started, { status: "skipped", reason: "not_authenticated" });
  const fingerprint = await computeProviderSourceFingerprint(options.provider);
  const cache = await loadSmokeCache(options.cachePath);
  if (!shouldRunSmokeForProvider(options.provider, fingerprint, { force: options.force, cache })) return result(options.provider, modelId, started, { status: "skipped", reason: "cached_pass" });

  const baseUrl = options.proxyUrl ?? "http://127.0.0.1:10100/v1/responses";
  let level1Passed = false, level2Passed = false, level3Passed = false;
  let previousResponseId: string | undefined;
  let emittedToolCallId: string | undefined;
  try {
    for (const level of [1, 2, 3] as const) {
      const reqBody = buildSmokeScenarioRequest(level, modelId, {
        previousResponseId,
        toolCallId: emittedToolCallId,
        toolResult: "smoke_test_123",
      });
      const response = await fetch(baseUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(reqBody),
        signal: AbortSignal.timeout(30000),
      });
      const body = await response.text();
      if (!response.ok) {
        const reason = classifyHttp(response.status, body);
        if (reason) {
          const skipped = result(options.provider, modelId, started, { status: "skipped", reason, level1Passed, level2Passed, level3Passed });
          await recordSmokeResult(options.provider, { fingerprint, timestamp: Date.now(), status: "skipped", reason, modelsTested: [modelId] }, options.cachePath);
          return skipped;
        }
        throw new Error(`HTTP ${response.status}: ${body.slice(0, 200)}`);
      }
      const events = body.split(/\r?\n/).filter(line => line.startsWith("data: ")).flatMap(line => { try { return [JSON.parse(line.slice(6)) as Record<string, unknown>]; } catch { return []; } });
      let jsonPayload: Record<string, unknown> | undefined;
      try {
        jsonPayload = JSON.parse(body) as Record<string, unknown>;
      } catch {
        jsonPayload = undefined;
      }
      const completed = events.find(event => event.type === "response.completed");
      const responseData = (completed?.response as Record<string, unknown> | undefined) ?? (jsonPayload?.status === "completed" ? jsonPayload : undefined);
      if (level === 1) level1Passed = events.some(event => event.type === "response.output_text.delta" || event.type === "response.output_item.added") || responseData?.status === "completed";
      if (level === 2) {
        const itemsFromEvents = events.flatMap(event => {
          const item = event.item as Record<string, unknown> | undefined;
          const output = (event.response as Record<string, unknown> | undefined)?.output;
          return [item, ...(Array.isArray(output) ? output : [])].filter(value => value?.type === "function_call") as Record<string, unknown>[];
        });
        const itemsFromJson = Array.isArray(jsonPayload?.output) ? (jsonPayload!.output as Record<string, unknown>[]).filter(v => v?.type === "function_call") : [];
        const calls = [...itemsFromEvents, ...itemsFromJson];
        level2Passed = calls.some(call => {
          try {
            const rawArgs = typeof call.arguments === "string" ? JSON.parse(call.arguments) : call.arguments;
            const args = rawArgs && typeof rawArgs === "object" ? rawArgs as Record<string, unknown> : {};
            if (call.call_id || call.id) {
              emittedToolCallId = String(call.call_id ?? call.id);
            }
            return typeof args.cmd === "string" && args.cmd.includes("echo") && args.cmd.includes("smoke_test_123");
          } catch { return false; }
        });
      }
      if (level === 3) level3Passed = (Boolean(completed) || responseData?.status === "completed") && !/400|thought.?signature|continuity/i.test(body);
      if (responseData?.id) previousResponseId = String(responseData.id);
      if (![level1Passed, level2Passed, level3Passed][level - 1]) throw new Error(`level ${level} assertion failed`);
    }
    await recordSmokeResult(options.provider, { fingerprint, timestamp: Date.now(), status: "passed", modelsTested: [modelId] }, options.cachePath);
    return result(options.provider, modelId, started, { status: "passed", level1Passed, level2Passed, level3Passed });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recordSmokeResult(options.provider, { fingerprint, timestamp: Date.now(), status: "failed", reason: message, modelsTested: [modelId] }, options.cachePath);
    return result(options.provider, modelId, started, { status: "failed", level1Passed, level2Passed, level3Passed, error: message });
  }
}
