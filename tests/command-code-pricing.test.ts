import { describe, expect, test } from "bun:test";
import {
  parseCommandCodeModelsData,
  fetchCommandCodeModelPricing,
  commandCodePricingToExpectedOverlays,
  COMMAND_CODE_MODELS_DATA_URL,
} from "../src/usage/command-code-manifest";
import { resolveMatchedPrice, estimateRequestCost } from "../src/usage/cost";
import { summarizeUsage } from "../src/usage/summary";
import type { PersistedUsageEntry } from "../src/usage/log";

describe("command-code pricing and manifest parser", () => {
  test("parseCommandCodeModelsData extracts models and rates from Turbo-stream payload", () => {
    const structuredMock = new Array(100).fill(null);
    structuredMock[9] = [10, 11];
    structuredMock[70] = "slug";
    structuredMock[72] = "id";
    structuredMock[74] = "name";
    structuredMock[82] = "contextWindow";
    structuredMock[87] = "inputCost";
    structuredMock[89] = "outputCost";
    structuredMock[91] = "cacheReadCost";
    structuredMock[93] = "cacheWriteCost";

    structuredMock[10] = { _70: 12, _72: 13, _74: 14, _82: 15, _87: 16, _89: 17, _91: 18, _93: -7 };
    structuredMock[11] = { _70: 19, _72: 20, _74: 21, _82: 15, _87: 22, _89: 23, _91: 24, _93: -7 };

    structuredMock[12] = "glm-5-3";
    structuredMock[13] = "zai-org/GLM-5.3";
    structuredMock[14] = "GLM-5.3";
    structuredMock[15] = 1000000;
    structuredMock[16] = 1.40;
    structuredMock[17] = 4.40;
    structuredMock[18] = 0.26;

    structuredMock[19] = "muse-spark-1-2-contributor";
    structuredMock[20] = "meta/muse-spark-1.2-contributor";
    structuredMock[21] = "Muse Spark 1.2 Contributor";
    structuredMock[22] = 0.10;
    structuredMock[23] = 0.20;
    structuredMock[24] = 0.002;

    const parsed = parseCommandCodeModelsData(structuredMock);
    expect(parsed.length).toBe(2);
    expect(parsed[0]).toEqual({
      id: "zai-org/GLM-5.3",
      name: "GLM-5.3",
      slug: "glm-5-3",
      contextWindow: 1000000,
      cost4: {
        input: 1.40,
        output: 4.40,
        cacheRead: 0.26,
        cacheWrite: 0,
      },
    });
    expect(parsed[1]).toEqual({
      id: "meta/muse-spark-1.2-contributor",
      name: "Muse Spark 1.2 Contributor",
      slug: "muse-spark-1-2-contributor",
      contextWindow: 1000000,
      cost4: {
        input: 0.10,
        output: 0.20,
        cacheRead: 0.002,
        cacheWrite: 0,
      },
    });
  });

  test("parseCommandCodeModelsData handles malformed data safely", () => {
    expect(parseCommandCodeModelsData(null)).toEqual([]);
    expect(parseCommandCodeModelsData(undefined)).toEqual([]);
    expect(parseCommandCodeModelsData({})).toEqual([]);
    expect(parseCommandCodeModelsData([])).toEqual([]);
    expect(parseCommandCodeModelsData(["not", "enough"])).toEqual([]);
    expect(parseCommandCodeModelsData([0, 1, 2, 3, 4, 5, 6, 7, 8, "not an array"])).toEqual([]);
  });

  test("commandCodePricingToExpectedOverlays filters zero-cost models and formats overlays", () => {
    const overlays = commandCodePricingToExpectedOverlays([
      {
        id: "free/model",
        name: "Free Model",
        cost4: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      {
        id: "paid/model",
        name: "Paid Model",
        cost4: { input: 1.5, output: 3.0, cacheRead: 0.1, cacheWrite: 0 },
      },
    ]);

    expect(overlays.length).toBe(1);
    expect(overlays[0]).toEqual({
      provider: "command-code",
      modelId: "paid/model",
      cost4: { input: 1.5, output: 3.0, cacheRead: 0.1, cacheWrite: 0 },
      source: "https://commandcode.ai/models + https://commandcode.ai/models.data",
      verifiedAt: "2026-08-26",
      status: "verified",
    });
  });

  test("fetchCommandCodeModelPricing uses custom fetchFn", async () => {
    const mockPayload = new Array(100).fill(null);
    mockPayload[9] = [10];
    mockPayload[72] = "id";
    mockPayload[74] = "name";
    mockPayload[87] = "inputCost";
    mockPayload[89] = "outputCost";
    mockPayload[91] = "cacheReadCost";
    mockPayload[93] = "cacheWriteCost";

    mockPayload[10] = { _72: 11, _74: 12, _87: 13, _89: 14, _91: 15, _93: -7 };
    mockPayload[11] = "test-provider/test-model";
    mockPayload[12] = "Test Model";
    mockPayload[13] = 1.0;
    mockPayload[14] = 2.0;
    mockPayload[15] = 0.5;

    let requestedUrl = "";
    const fakeFetch: typeof fetch = async (input) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify(mockPayload), { status: 200 });
    };

    const models = await fetchCommandCodeModelPricing({ fetchFn: fakeFetch });
    expect(requestedUrl).toBe(COMMAND_CODE_MODELS_DATA_URL);
    expect(models.length).toBe(1);
    expect(models[0].id).toBe("test-provider/test-model");
    expect(models[0].cost4).toEqual({ input: 1.0, output: 2.0, cacheRead: 0.5, cacheWrite: 0 });
  });

  test("fetchCommandCodeModelPricing throws on HTTP error", async () => {
    const fakeFetch: typeof fetch = async () => new Response("Not Found", { status: 404 });
    expect(fetchCommandCodeModelPricing({ fetchFn: fakeFetch })).rejects.toThrow("404");
  });

  test("resolveMatchedPrice resolves Command Code verified expected prices", () => {
    const glm = resolveMatchedPrice("command-code", "zai-org/GLM-5.3");
    expect(glm).not.toBeNull();
    expect(glm?.provider).toBe("command-code");
    expect(glm?.modelId).toBe("zai-org/GLM-5.3");
    expect(glm?.cost4).toEqual({
      input: 1.40,
      output: 4.40,
      cacheRead: 0.26,
      cacheWrite: 0,
    });
    expect(glm?.status).toBe("verified");

    const muse = resolveMatchedPrice("command-code", "meta/muse-spark-1.2-contributor");
    expect(muse).not.toBeNull();
    expect(muse?.cost4).toEqual({
      input: 0.10,
      output: 0.20,
      cacheRead: 0.002,
      cacheWrite: 0,
    });

    const gemini = resolveMatchedPrice("command-code", "google/gemini-3.7-flash");
    expect(gemini).not.toBeNull();
    expect(gemini?.cost4.input).toBe(0.75);
    expect(gemini?.cost4.output).toBe(3.75);

    const ds = resolveMatchedPrice("command-code", "deepseek/deepseek-v4-pro");
    expect(ds).not.toBeNull();
    expect(ds?.cost4).toEqual({
      input: 0.66,
      output: 1.98,
      cacheRead: 0.022,
      cacheWrite: 0,
    });

    const qwen = resolveMatchedPrice("command-code", "Qwen/Qwen3.8-Max");
    expect(qwen).not.toBeNull();
    expect(qwen?.cost4.input).toBe(2);
    expect(qwen?.cost4.output).toBe(6);
  });

  test("case variations for GLM models resolve as verified-derived", () => {
    const lower = resolveMatchedPrice("command-code", "zai-org/glm-5.3");
    expect(lower).not.toBeNull();
    expect(lower?.cost4.input).toBe(1.40);
    expect(lower?.status).toBe("verified-derived");
  });

  test("account-suffixed command-code log entries inherit command-code pricing", () => {
    const pooled = resolveMatchedPrice("command-code-main", "zai-org/GLM-5.3");
    expect(pooled).not.toBeNull();
    expect(pooled?.cost4.input).toBe(1.40);
  });

  test("estimateRequestCost calculates accurate cost for Command Code requests", () => {
    const est = estimateRequestCost({
      provider: "command-code",
      model: "zai-org/GLM-5.3",
      usageStatus: "reported",
      usage: {
        inputTokens: 1000000,
        outputTokens: 500000,
        totalTokens: 1500000,
        cachedInputTokens: 200000,
        cacheReadInputTokens: 200000,
        cacheCreationInputTokens: 0,
      },
    });

    expect(est).not.toBeNull();
    // uncached input = 1M - 200k = 800k -> 0.8M * 1.40 = 1.12
    // output = 500k -> 0.5M * 4.40 = 2.20
    // cacheRead = 200k -> 0.2M * 0.26 = 0.052
    // total = 1.12 + 2.20 + 0.052 = 3.372
    expect(est?.cost.input).toBeCloseTo(1.12, 5);
    expect(est?.cost.output).toBeCloseTo(2.20, 5);
    expect(est?.cost.cacheRead).toBeCloseTo(0.052, 5);
    expect(est?.cost.total).toBeCloseTo(3.372, 5);
  });

  test("summarizeUsage computes estimatedCostUsd for command-code entries", () => {
    const now = Date.now();
    const entries: PersistedUsageEntry[] = [
      {
        requestId: "req-1",
        timestamp: now - 1000,
        provider: "command-code",
        model: "zai-org/GLM-5.3",
        usageStatus: "reported",
        usage: {
          inputTokens: 1000000,
          outputTokens: 500000,
          totalTokens: 1500000,
          cachedInputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      },
      {
        requestId: "req-2",
        timestamp: now - 500,
        provider: "command-code",
        model: "meta/muse-spark-1.2-contributor",
        usageStatus: "reported",
        usage: {
          inputTokens: 1000000,
          outputTokens: 1000000,
          totalTokens: 2000000,
          cachedInputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      },
    ];

    const summary = summarizeUsage(entries, "30d", now, "all");
    expect(summary.summary.requests).toBe(2);
    expect(summary.summary.pricedRequests).toBe(2);

    // req 1: 1M * 1.40 + 0.5M * 4.40 = 1.40 + 2.20 = 3.60
    // req 2: 1M * 0.10 + 1M * 0.20 = 0.10 + 0.20 = 0.30
    // total = 3.90
    expect(summary.summary.estimatedCostUsd).toBeCloseTo(3.90, 4);

    const ccProvider = summary.providers.find(p => p.provider === "command-code");
    expect(ccProvider).toBeDefined();
    expect(ccProvider?.estimatedCostUsd).toBeCloseTo(3.90, 4);

    const glmModel = summary.models.find(m => m.model === "zai-org/GLM-5.3");
    expect(glmModel).toBeDefined();
    expect(glmModel?.estimatedCostUsd).toBeCloseTo(3.60, 4);

    const museModel = summary.models.find(m => m.model === "meta/muse-spark-1.2-contributor");
    expect(museModel).toBeDefined();
    expect(museModel?.estimatedCostUsd).toBeCloseTo(0.30, 4);
  });
});

