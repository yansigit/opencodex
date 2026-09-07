import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import {
  clearAnthropicAccountPoolState,
  getEligibleAnthropicAccounts,
  rotateAnthropicAccountOn429,
} from "../../src/oauth/anthropic-routing";
import {
  clearGenericFailoverHealth,
  eligibleFailoverAccounts,
  rotateGenericOAuthAccountOn429,
} from "../../src/oauth/generic-account-failover";
import { getAccountSet, saveCredential } from "../../src/oauth/store";
import { setAsyncIcaclsRunnerForTests, setIcaclsRunnerForTests } from "../../src/lib/windows-secret-acl";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const previousHome = process.env.OPENCODEX_HOME;
const ICACLS_OK = { success: true, exitCode: 0, timedOut: false, stdout: "" };
let home = "";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-oauth-failover-optout-"));
  process.env.OPENCODEX_HOME = home;
  setIcaclsRunnerForTests(() => ICACLS_OK);
  setAsyncIcaclsRunnerForTests(async () => ICACLS_OK);
  clearGenericFailoverHealth();
  clearAnthropicAccountPoolState();
});

afterEach(async () => {
  clearGenericFailoverHealth();
  clearAnthropicAccountPoolState();
  try {
    await flushConfigDirHardeningForTests();
  } finally {
    setIcaclsRunnerForTests(null);
    setAsyncIcaclsRunnerForTests(null);
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    removeTreeWithRetry(home);
  }
});

async function seed(provider: string): Promise<string[]> {
  for (let index = 0; index < 2; index += 1) {
    await saveCredential(provider, {
      access: `${provider}-access-${index}`,
      refresh: `${provider}-refresh-${index}`,
      expires: Date.now() + 3_600_000,
      accountId: `${provider}-account-${index}`,
    } as never, { addAccount: true });
  }
  return getAccountSet(provider)?.accounts.map(account => account.id) ?? [];
}

function genericConfig(globalEnabled: boolean, providerEnabled?: boolean): OcxConfig {
  return {
    providers: {
      xai: {
        adapter: "openai-chat",
        baseUrl: "https://api.x.ai/v1",
        authMode: "oauth",
        ...(providerEnabled === undefined
          ? {}
          : { oauthAccountFailover: { enabled: providerEnabled } }),
      },
    },
    oauthAccountFailover: { enabled: globalEnabled },
  } as unknown as OcxConfig;
}

describe("OAuth failover opt-out security boundary", () => {
  test("global generic opt-out forbids reactive 429 account rotation", async () => {
    const ids = await seed("xai");

    expect(rotateGenericOAuthAccountOn429(genericConfig(false), "xai", ids[0]!, "60")).toBeNull();
    expect(eligibleFailoverAccounts("xai")).toEqual(ids);
  });

  test("provider generic opt-out overrides a global opt-in", async () => {
    const ids = await seed("xai");

    expect(rotateGenericOAuthAccountOn429(genericConfig(true, false), "xai", ids[0]!, "60")).toBeNull();
    expect(eligibleFailoverAccounts("xai")).toEqual(ids);
  });

  test("disabled Anthropic pool forbids reactive 429 account rotation", async () => {
    const ids = await seed("anthropic");
    const config = {
      providers: {},
      anthropicAccountPool: { enabled: false },
    } as unknown as OcxConfig;

    expect(rotateAnthropicAccountOn429(config, ids[0]!, "60")).toBeNull();
    expect(getEligibleAnthropicAccounts()).toEqual(ids);
  });
});
