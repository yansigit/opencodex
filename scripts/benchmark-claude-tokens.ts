import {
  defaultTokenBenchmarkFixtureSet,
  formatBenchmarkReport,
  materializeFixture,
  runTokenBenchmark,
  serializeBenchmarkReport,
  type AuthoritativeCountResult,
  type ClaudeFixtureBody,
} from "../src/claude/token-benchmark";
import { loadConfig } from "../src/config";
import { routedSlug } from "../src/providers/slug-codec";
import { routeModel, type RouteResult } from "../src/router";
import { resolveWireProtocolOverride } from "../src/server/adapter-resolve";
import { handleClaudeMessages, type ClaudeBenchmarkRawUsage } from "../src/server/claude-messages";
import type { OcxConfig, OcxUsage } from "../src/types";

export const USAGE = "Usage: bun run benchmark:claude-tokens -- --provider <provider> --model <model> --confirm-live-provider-charges [--json]\nThis command can charge the selected provider. It does not reveal configured data. Consent is required before any provider request.";

export interface BenchmarkArgs { provider: string; model: string; json: boolean; confirmed: boolean }
export interface BenchmarkDeps {
  loadConfig: () => OcxConfig;
  resolveRoute: (config: OcxConfig, provider: string, model: string) => RouteResult;
  send: (fixture: ClaudeFixtureBody, target: RouteResult, config: OcxConfig, observe: (o: ClaudeBenchmarkRawUsage) => void) => Promise<Response>;
  write: (text: string) => void;
  /** Optional status channel; JSON reports keep stdout parseable. */
  writeStatus?: (text: string) => void;
}

export function parseArgs(argv: readonly string[]): BenchmarkArgs {
  let provider: string | undefined, model: string | undefined, json = false, confirmed = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--json") { if (json) throw new Error("invalid arguments"); json = true; continue; }
    if (flag === "--confirm-live-provider-charges") { if (confirmed) throw new Error("invalid arguments"); confirmed = true; continue; }
    if (flag === "--provider" || flag === "--model") {
      if (i + 1 >= argv.length || argv[i + 1].length === 0 || argv[i + 1].startsWith("-")) throw new Error("invalid arguments");
      if (flag === "--provider" ? provider !== undefined : model !== undefined) throw new Error("invalid arguments");
      if (flag === "--provider") provider = argv[++i]; else model = argv[++i];
      continue;
    }
    throw new Error("invalid arguments");
  }
  if (!provider || !model) throw new Error("invalid arguments");
  return { provider, model, json, confirmed };
}

/** Adapter provenance is intentionally narrow: Anthropic parses input_tokens directly from upstream usage. */
export const AUTHORITATIVE_ADAPTER_KINDS = new Set(["anthropic"]);

function safeRoute(config: OcxConfig, args: BenchmarkArgs, resolve: BenchmarkDeps["resolveRoute"]): RouteResult {
  const provider = config.providers[args.provider];
  if (!provider || provider.disabled === true || (provider.authMode !== undefined && provider.authMode !== "key")) throw new Error("unsupported target");
  const known = new Set([...(provider.models ?? []), ...(provider.selectedModels ?? []), ...(provider.defaultModel ? [provider.defaultModel] : [])]);
  if (!known.has(args.model)) throw new Error("unsupported target");
  const route = resolve(config, args.provider, args.model);
  const effectiveAdapter = resolveWireProtocolOverride(route.providerName, route.modelId, route.provider, "anthropic").adapter;
  if (route.providerName !== args.provider || route.modelId !== args.model || route.routeKind !== "explicit-provider" || route.combo || effectiveAdapter !== route.provider.adapter || !AUTHORITATIVE_ADAPTER_KINDS.has(effectiveAdapter)) throw new Error("unsupported target");
  return route;
}

export async function executeBenchmark(args: BenchmarkArgs, deps: BenchmarkDeps): Promise<number> {
  if (!args.confirmed) { deps.write(USAGE); return 2; }
  let route: RouteResult;
  let config: OcxConfig;
  try { config = deps.loadConfig(); route = safeRoute(config, args, deps.resolveRoute); } catch { deps.write(USAGE); return 2; }
  const fixtures = defaultTokenBenchmarkFixtureSet;
  (args.json ? deps.writeStatus : deps.write)?.(`planned requests: ${fixtures.length}`);
  const results = new Map<string, AuthoritativeCountResult>();
  for (const fixture of fixtures) {
    const observations: ClaudeBenchmarkRawUsage[] = [];
    try {
      const materialized = materializeFixture(fixture);
      const response = await deps.send({ ...materialized, model: route.modelId, stream: false, max_tokens: 1 }, route, config, (o) => observations.push(o));
      // Drain the client-facing response so the routed bridge performs its one
      // upstream send and reaches terminal usage observation. The body is never
      // logged or parsed here.
      await response.text();
      if (!response.ok) { results.set(fixture.id, { state: "failed" }); continue; }
      if (observations.length !== 1) { results.set(fixture.id, { state: "unsupported" }); continue; }
      const obs = observations[0];
      if (obs.adapterKind !== route.provider.adapter || obs.modelId !== route.modelId || !AUTHORITATIVE_ADAPTER_KINDS.has(obs.adapterKind) || !obs.usage) { results.set(fixture.id, { state: "unsupported" }); continue; }
      results.set(fixture.id, { state: "supported", usage: obs.usage as OcxUsage });
    } catch { results.set(fixture.id, { state: "failed" }); }
  }
  const report = runTokenBenchmark(fixtures, (call) => results.get(call.fixtureId) ?? { state: "failed" }, { modelId: route.modelId, providerKind: route.provider.adapter });
  deps.write(args.json ? serializeBenchmarkReport(report) : formatBenchmarkReport(report));
  return report.status === "pass" ? 0 : 1;
}

const productionDeps: BenchmarkDeps = {
  loadConfig,
  resolveRoute: (config, provider, model) => routeModel(config, routedSlug(provider, model)),
  send: async (fixture, target, config, observe) => {
    // Keep the physical provider binding explicit through Claude's route resolver;
    // the outbound wire still receives the target's native model id after routing.
    const body = { ...fixture, model: `${target.providerName}/${target.modelId}`, stream: false, max_tokens: 1 };
    const req = new Request("http://localhost/v1/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    // Benchmark sends are always routed; disable the credential-triggered native
    // Anthropic passthrough branch even if the user's config enables it.
    const routedConfig: OcxConfig = {
      ...config,
      emptyCompletionRetry: false,
      claudeCode: { ...config.claudeCode, nativePassthrough: false },
      images: undefined,
      webSearchSidecar: undefined,
      providers: {
        ...config.providers,
        [target.providerName]: {
          ...target.provider,
          retryOn429: undefined,
          replayTransientFailures: false,
          transientRetryOn5xx: undefined,
          oauthAccountFailover: { ...target.provider.oauthAccountFailover, enabled: false },
        },
      },
    };
    return handleClaudeMessages(req, routedConfig, { model: target.modelId, provider: target.providerName, surface: "claude" }, undefined, routedConfig, { onRawUsage: observe });
  },
  write: (text) => process.stdout.write(`${text}\n`),
  writeStatus: (text) => process.stderr.write(`${text}\n`),
};

if (import.meta.main) {
  let code = 2;
  try { code = await executeBenchmark(parseArgs(Bun.argv.slice(2)), productionDeps); } catch { productionDeps.write(USAGE); code = 2; }
  process.exitCode = code;
}
