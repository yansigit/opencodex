/**
 * 429 credential failover is a safety net, not a routing policy.
 *
 * Three rotators existed with three different activation rules: `apiKeyPool` rotated on presence,
 * generic OAuth rotated on presence but could be switched off, and Anthropic rotated only behind
 * `anthropicAccountPool.enabled` -- which defaults absent. So an operator with two Claude accounts
 * logged in and a stock config got a hard 429 with the second account sitting idle.
 *
 * These tests pin the separation that resolves it: REACTIVE rotation (after upstream refused)
 * defaults on from presence only while the flag is absent, while an explicit false remains an
 * authority boundary and PROACTIVE routing stays behind the opt-in flag.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearAnthropicAccountPoolState,
  getEligibleAnthropicAccounts,
  hasAnthropicFailoverQuorum,
  isAnthropicAccountPoolEnabled,
  resolveAnthropicAccountForSession,
  rotateAnthropicAccountOn429,
} from "../../src/oauth/anthropic-routing";
import { clearPoolRotationState } from "../../src/codex/pool-rotation";
import { getAccountSet, saveCredential, setActiveAccount } from "../../src/oauth/store";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import { setAsyncIcaclsRunnerForTests, setIcaclsRunnerForTests } from "../../src/lib/windows-secret-acl";
import { clearAccountQuotaCache, setCachedProviderAccountQuotaForTests } from "../../src/providers/quota";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const originalHome = process.env.OPENCODEX_HOME;
let home: string;
const ICACLS_OK = { success: true, exitCode: 0, timedOut: false, stdout: "" };

beforeEach(() => {
  setIcaclsRunnerForTests(() => ICACLS_OK);
  setAsyncIcaclsRunnerForTests(async () => ICACLS_OK);
  home = mkdtempSync(join(tmpdir(), "ocx-always-on-429-"));
  process.env.OPENCODEX_HOME = home;
  clearAnthropicAccountPoolState();
  clearPoolRotationState();
  clearAccountQuotaCache("anthropic");
});

afterEach(async () => {
  try {
    clearAnthropicAccountPoolState();
    clearPoolRotationState();
    clearAccountQuotaCache("anthropic");
    await flushConfigDirHardeningForTests();
  } finally {
    setIcaclsRunnerForTests(null);
    setAsyncIcaclsRunnerForTests(null);
    if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = originalHome;
    removeTreeWithRetry(home);
  }
});

/** No `anthropicAccountPool` key at all: what a stock install that never opted in looks like. */
function poolAbsent(): OcxConfig {
  return {
    port: 0,
    defaultProvider: "anthropic",
    providers: {
      anthropic: { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "oauth" },
    },
  } as OcxConfig;
}

/** An operator who explicitly wrote `false` -- the strongest form of "I did not opt in". */
function poolDisabled(): OcxConfig {
  return { ...poolAbsent(), anthropicAccountPool: { enabled: false } } as OcxConfig;
}

async function seedAccounts(count: number): Promise<string[]> {
  for (let i = 0; i < count; i++) {
    await saveCredential("anthropic", {
      access: `access-${i}`,
      refresh: `refresh-${i}`,
      expires: Date.now() + 3_600_000,
      accountId: `uuid-${i}`,
      email: `user${i}@example.test`,
    } as never);
  }
  const set = getAccountSet("anthropic")!;
  const ids = set.accounts.map(account => account.id);
  // saveCredential activates the last account appended; pin the first for a predictable active.
  if (ids[0]) await setActiveAccount("anthropic", ids[0]);
  return ids;
}

describe("Anthropic reactive 429 failover without the pool flag", () => {
  test("a 429 rotates to the second account with the pool key absent", async () => {
    const ids = await seedAccounts(2);
    expect(isAnthropicAccountPoolEnabled(poolAbsent())).toBe(false);
    expect(hasAnthropicFailoverQuorum()).toBe(true);

    expect(rotateAnthropicAccountOn429(poolAbsent(), ids[0]!, null)).toBe(ids[1]);
    // The account that actually 429'd is the one cooled -- not whichever is active later.
    expect(getEligibleAnthropicAccounts()).toEqual([ids[1]!]);
  });

  test("an explicit enabled:false refuses reactive replay under another identity", async () => {
    // A stored secondary account can belong to another billing, retention, or policy domain.
    // The failed account must not be cooled when the operator refused cross-account recovery.
    const ids = await seedAccounts(2);
    expect(rotateAnthropicAccountOn429(poolDisabled(), ids[0]!, null)).toBeNull();
    expect(getEligibleAnthropicAccounts()).toEqual(ids);
  });

  test("an absent enable flag does not apply a dormant proactive strategy to recovery", async () => {
    // Presence still supplies the default when enabled is absent, but an unrelated retained
    // strategy is not an opt-in to proactive round-robin selection.
    const ids = await seedAccounts(3);
    setCachedProviderAccountQuotaForTests("anthropic", ids[1]!, { fiveHourPercent: 90 });
    setCachedProviderAccountQuotaForTests("anthropic", ids[2]!, { fiveHourPercent: 10 });
    const unconfiguredRoundRobin = {
      ...poolAbsent(),
      anthropicAccountPool: { strategy: "round-robin" },
    } as OcxConfig;

    // Round-robin would hand back ids[1] (the next account in order); quota ordering picks the
    // account with the most headroom instead.
    expect(rotateAnthropicAccountOn429(unconfiguredRoundRobin, ids[0]!, null)).toBe(ids[2]);
  });

  test("a single account is still a strict no-op", async () => {
    // Rotating to itself would replay the same 429 on the same credential, and cooling the only
    // account would take the provider out of service for nothing.
    const ids = await seedAccounts(1);
    expect(hasAnthropicFailoverQuorum()).toBe(false);
    expect(rotateAnthropicAccountOn429(poolAbsent(), ids[0]!, null)).toBeNull();
  });

  test("Retry-After from upstream still drives the cooldown", async () => {
    const ids = await seedAccounts(2);
    expect(rotateAnthropicAccountOn429(poolAbsent(), ids[0]!, "600")).toBe(ids[1]);
    expect(getEligibleAnthropicAccounts()).not.toContain(ids[0]!);
  });

  test("when every account is cooled the 429 is surfaced rather than looped", async () => {
    const ids = await seedAccounts(2);
    expect(rotateAnthropicAccountOn429(poolAbsent(), ids[0]!, null)).toBe(ids[1]);
    expect(rotateAnthropicAccountOn429(poolAbsent(), ids[1]!, null)).toBeNull();
  });
});

describe("proactive Anthropic routing stays opt-in", () => {
  test("with the pool off, selection still returns the active account and reports pool-disabled", async () => {
    // Presence-defaulted reactive rotation must not drag session affinity or quota-ranked
    // selection on with it. An operator who never configured the pool still gets exactly one
    // account per healthy session.
    const ids = await seedAccounts(2);
    const selection = resolveAnthropicAccountForSession("session-1", poolAbsent());
    expect(selection.accountId).toBe(ids[0]!);
    expect(selection.reason).toBe("pool-disabled");
  });

  test("repeated resolves never drift to the second account", async () => {
    const ids = await seedAccounts(2);
    const picks = Array.from(
      { length: 5 },
      () => resolveAnthropicAccountForSession(null, poolDisabled()).accountId,
    );
    expect(picks.every(id => id === ids[0]!)).toBe(true);
  });
  test("the rotator distinguishes an explicit false from an absent flag", async () => {
    const source = await Bun.file("src/oauth/anthropic-routing.ts").text();
    const start = source.indexOf("export function rotateAnthropicAccountOn429");
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf("\n}", start));
    expect(body).toContain("if (configured === false) return null");
    expect(body).toContain("configured !== true && !hasAnthropicFailoverQuorum(now)");
  });
});
