import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { validateRegistry, validateRegistryTransition, loadRegistry, registryHash, registryPath, resolvedRegistryPath } from "../../scripts/fork/sync/preservation";
import { repoPath } from "../helpers/repo-root";

describe("preservation registry", () => {
  test("validates correct registry", async () => {
    const mod = await import("../../docs/fork/PRESERVATION.json");
    const registry = (mod as unknown as { default: unknown }).default ?? mod;
    expect(() => validateRegistry(registry as never)).not.toThrow();
  });

  test("baseline required tests resolve to repository files", async () => {
    const mod = await import("../../docs/fork/PRESERVATION.json");
    const registry = ((mod as unknown as { default: unknown }).default ?? mod) as {
      baseline: { features: Record<string, { requiredTests: string[] }> };
    };
    const missing = Object.entries(registry.baseline.features).flatMap(([feature, entry]) =>
      entry.requiredTests
        .filter(requiredTest => !existsSync(repoPath(requiredTest)))
        .map(requiredTest => `${feature}: ${requiredTest}`));

    expect(missing).toEqual([]);
  });

  test("registryPath is docs/fork/PRESERVATION.json", () => {
    expect(registryPath()).toBe("docs/fork/PRESERVATION.json");
    expect(resolvedRegistryPath({ FORK_SYNC_TRUSTED_REGISTRY: "/trusted/PRESERVATION.json" }))
      .toBe("/trusted/PRESERVATION.json");
  });

  test("registryHash is a full SHA-256 or missing", () => {
    const h = registryHash();
    expect(h === "missing" || /^[0-9a-f]{64}$/.test(h)).toBe(true);
  });

  test("rejects intentional-drop not in baseline", () => {
    const bad = {
      version: 2,
      baseline: { features: {
        tls: {
          decisionSource: "maintainer decision",
          ownedBehavior: "TLS stays",
          integrationPaths: ["src/lib/server-tls.ts"],
          requiredTests: ["tests/server/server-tls-config.test.ts"],
        },
      } },
      releases: {
        "v2.40.0": {
          tag: "v2.40.0",
          tagSha: "a".repeat(40),
          baseSha: "b".repeat(40),
          decisions: {
            "src/lib/server-tls.ts": {
              disposition: "intentional-drop",
              upstreamIntent: "remove TLS",
              forkInvariant: "TLS stays",
              equivalentOrBetter: false,
              implementationEvidence: "none",
              exactTests: ["tests/server/server-tls-config.test.ts"],
            },
          },
        },
      },
    };
    expect(() => validateRegistry(bad as never)).toThrow(/pre-approved baseline/);
  });

  test("accepts upstream equivalence only with evidence and exact tests", () => {
    const decision = {
      disposition: "upstream-equivalent",
      upstreamIntent: "provide the same behavior in the upstream control flow",
      forkInvariant: "the user-visible behavior remains available",
      equivalentOrBetter: true,
      implementationEvidence: "upstream commit deadbeef, src/example.ts",
      exactTests: ["tests/example.test.ts"],
    };
    const registry = {
      version: 2,
      baseline: { features: {
        example: {
          decisionSource: "maintainer questionnaire",
          ownedBehavior: "example behavior",
          integrationPaths: ["src/example.ts"],
          requiredTests: ["tests/example.test.ts"],
        },
      } },
      releases: {
        "v2.40.0": {
          tag: "v2.40.0",
          tagSha: "a".repeat(40),
          baseSha: "b".repeat(40),
          decisions: { "src/example.ts": decision },
        },
      },
    };
    expect(() => validateRegistry(registry as never)).not.toThrow();
    expect(() => validateRegistry({
      ...registry,
      releases: {
        "v2.40.0": {
          ...registry.releases["v2.40.0"],
          decisions: { "src/example.ts": { ...decision, equivalentOrBetter: false } },
        },
      },
    } as never)).toThrow(/requires equivalentOrBetter=true/);
  });

  test("registry contains preserve entries for known lost fork files", async () => {
    const mod = await import("../../docs/fork/PRESERVATION.json");
    const registry = ((mod as unknown as { default: unknown }).default ?? mod) as {
      baseline: { features: Record<string, unknown> };
      releases: Record<string, { decisions: Record<string, { disposition: string }> }>;
    };
    const decisions = registry.releases["v2.40.0"]?.decisions ?? {};
    for (const p of ["src/config.ts", "src/types/config.ts", "src/lib/errors.ts", "src/oauth/index.ts", "src/config/provider-validation.ts"]) {
      expect(decisions[p]?.disposition).toBe("preserve");
    }
    // No false intentional TLS drop
    expect(decisions["src/lib/server-tls.ts"]?.disposition).not.toBe("intentional-drop");
    for (const feature of [
      "logs-rich-client-filters", "cursor-account-pool", "antigravity-failover-only",
      "combo-catalog-provenance", "claude-code-always-sse", "cursor-composer-fast-false",
      "quota-capacity-aggregation", "provider-request-pacing", "subscription-credit-accounting",
      "hosted-tool-handling", "cursor-schema-contracts", "cursor-replay-remint",
      "cursor-affinity-thread-ownership", "cursor-runtime-normalization", "cursor-blob-integrity",
      "subagent-fallback", "oauth-snapshot-compatibility", "native-tls", "provider-validation",
      "atomic-api-key-rotation",
    ]) expect(registry.baseline.features[feature]).toBeDefined();
  });

  test("validateRegistryTransition accepts valid new release addition", () => {
    const trustedBase = {
      version: 2,
      auditStart: "2026-08-01",
      baseline: {
        features: {
          tls: {
            decisionSource: "policy",
            ownedBehavior: "TLS",
            integrationPaths: ["src/lib/server-tls.ts"],
            requiredTests: ["tests/server/server-tls-config.test.ts"],
          },
        },
      },
      releases: {
        "v2.40.0": {
          tag: "v2.40.0",
          tagSha: "a".repeat(40),
          baseSha: "b".repeat(40),
          decisions: {
            "src/lib/server-tls.ts": {
              disposition: "preserve",
              upstreamIntent: "keep",
              forkInvariant: "keep",
              equivalentOrBetter: false,
              implementationEvidence: "evidence",
              exactTests: ["tests/server/server-tls-config.test.ts"],
            },
          },
        },
      },
    };

    const candidate = {
      ...trustedBase,
      releases: {
        ...trustedBase.releases,
        "v2.41.0": {
          tag: "v2.41.0",
          tagSha: "c".repeat(40),
          baseSha: "d".repeat(40),
          decisions: {
            "src/lib/server-tls.ts": {
              disposition: "preserve",
              upstreamIntent: "v2.41 keep",
              forkInvariant: "keep",
              equivalentOrBetter: false,
              implementationEvidence: "evidence",
              exactTests: ["tests/server/server-tls-config.test.ts"],
            },
          },
        },
      },
    };

    expect(() => validateRegistryTransition(trustedBase as never, candidate as never, "v2.41.0")).not.toThrow();
  });

  test("validateRegistryTransition rejects modified or dropped baseline features", () => {
    const trustedBase = {
      version: 2,
      baseline: {
        features: {
          f1: { decisionSource: "s", ownedBehavior: "b", integrationPaths: ["p1"], requiredTests: ["t1"] },
        },
      },
      releases: {
        "v2.40.0": { tag: "v2.40.0", tagSha: "a".repeat(40), baseSha: "b".repeat(40), decisions: {} },
      },
    };

    const droppedBaseline = {
      ...trustedBase,
      baseline: { features: {} },
    };
    expect(() => validateRegistryTransition(trustedBase as never, droppedBaseline as never))
      .toThrow(/baseline features do not match trusted base/);

    const modifiedBaseline = {
      ...trustedBase,
      baseline: {
        features: {
          f1: { decisionSource: "tampered", ownedBehavior: "b", integrationPaths: ["p1"], requiredTests: ["t1"] },
        },
      },
    };
    expect(() => validateRegistryTransition(trustedBase as never, modifiedBaseline as never))
      .toThrow(/modified trusted baseline feature/);
  });

  test("validateRegistryTransition rejects modified historical releases or multiple new releases", () => {
    const trustedBase = {
      version: 2,
      baseline: {
        features: {
          f1: { decisionSource: "s", ownedBehavior: "b", integrationPaths: ["p1"], requiredTests: ["t1"] },
        },
      },
      releases: {
        "v2.40.0": { tag: "v2.40.0", tagSha: "a".repeat(40), baseSha: "b".repeat(40), decisions: {} },
      },
    };

    const modifiedHistorical = {
      ...trustedBase,
      releases: {
        "v2.40.0": { tag: "v2.40.0", tagSha: "f".repeat(40), baseSha: "b".repeat(40), decisions: {} },
      },
    };
    expect(() => validateRegistryTransition(trustedBase as never, modifiedHistorical as never))
      .toThrow(/modified historical release/);

    const multipleNew = {
      ...trustedBase,
      releases: {
        ...trustedBase.releases,
        "v2.41.0": { tag: "v2.41.0", tagSha: "c".repeat(40), baseSha: "d".repeat(40), decisions: {} },
        "v2.42.0": { tag: "v2.42.0", tagSha: "e".repeat(40), baseSha: "f".repeat(40), decisions: {} },
      },
    };
    expect(() => validateRegistryTransition(trustedBase as never, multipleNew as never))
      .toThrow(/introduces multiple new releases/);
  });
});
