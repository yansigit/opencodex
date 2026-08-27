#!/usr/bin/env bun
import { loadConfig } from "../src/config";
import { PROVIDER_REGISTRY } from "../src/providers/registry";
import { runProviderSmoke, type ProviderSmokeResult } from "../src/smoke/runner";
import { defaultSmokeCachePath, loadSmokeCache } from "../src/smoke/fingerprint-cache";

const args = process.argv.slice(2);
const force = args.includes("--force") || args.includes("-f");
const jsonOutput = args.includes("--json");
const providerArgIndex = args.indexOf("--provider");
const targetProvider = providerArgIndex !== -1 ? args[providerArgIndex + 1] : undefined;
const proxyUrlArgIndex = args.indexOf("--url");
const proxyUrl = proxyUrlArgIndex !== -1 ? args[proxyUrlArgIndex + 1] : "http://127.0.0.1:10100/v1/responses";

const DEFAULT_MODELS: Record<string, string> = {
  "google-antigravity": "google-antigravity/gemini-3.7-flash",
  "google-aistudio": "google-aistudio/gemini-3.7-flash",
  "cursor": "cursor/composer-2.5",
  "command-code": "command-code/deepseek/deepseek-v4-flash",
  "openai": "gpt-5.6-luna",
};

export function smokeExitCode(results: Array<Pick<ProviderSmokeResult, "status">>): number {
  return results.some(result => result.status === "failed") ? 1 : 0;
}

async function main() {
  const config = loadConfig();
  const configuredProviders = Object.keys(config.providers ?? {}).filter(
    p => !config.providers[p]?.disabled,
  );

  const providersToTest = targetProvider
    ? [targetProvider]
    : configuredProviders.filter(p => ["google-antigravity", "google-aistudio", "cursor", "command-code", "openai"].includes(p));

  if (!jsonOutput) {
    console.log("🔥 OpenCodex Live Inference Smoke Test Runner");
    console.log(`   Target providers: ${providersToTest.join(", ")}`);
    console.log(`   Fingerprint cache: ${defaultSmokeCachePath()}`);
    console.log(`   Force rerun: ${force ? "yes" : "no (skips unchanged passing code)"}\n`);
  }

  const results: ProviderSmokeResult[] = [];

  for (const provider of providersToTest) {
    const regEntry = PROVIDER_REGISTRY.find(r => r.id === provider);
    const defaultModel = DEFAULT_MODELS[provider] ?? regEntry?.defaultModel ?? `${provider}/default`;

    if (!jsonOutput) {
      process.stdout.write(`• Testing ${provider} (${defaultModel})... `);
    }

    try {
      const res = await runProviderSmoke({
        provider,
        modelId: defaultModel,
        proxyUrl,
        force,
      });
      results.push(res);

      if (!jsonOutput) {
        if (res.status === "passed") {
          console.log(`✅ PASSED (${res.durationMs}ms) [L1: ✓, L2: ✓, L3: ✓]`);
        } else if (res.status === "skipped") {
          console.log(`⏭️  SKIPPED (${res.reason ?? "no reason given"})`);
        } else {
          console.log(`❌ FAILED: ${res.error ?? "unknown error"}`);
        }
      }
    } catch (err) {
      const failedResult: ProviderSmokeResult = {
        provider,
        modelId: defaultModel,
        status: "failed",
        level1Passed: false,
        level2Passed: false,
        level3Passed: false,
        durationMs: 0,
        error: String(err),
      };
      results.push(failedResult);
      if (!jsonOutput) {
        console.log(`❌ FAILED (exception): ${String(err)}`);
      }
    }
  }

  if (jsonOutput) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    const passedCount = results.filter(r => r.status === "passed").length;
    const skippedCount = results.filter(r => r.status === "skipped").length;
    const failedCount = results.filter(r => r.status === "failed").length;
    console.log(`\nSummary: ${passedCount} passed, ${skippedCount} skipped, ${failedCount} failed.`);
  }
  process.exitCode = smokeExitCode(results);
}

if (import.meta.main) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
