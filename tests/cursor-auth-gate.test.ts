import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  forceRefreshOAuthAccessSnapshot,
  getValidAccessSnapshotForAccount,
  getValidAccessTokenForAccount,
  OAUTH_PROVIDERS,
} from "../src/oauth";
import type { OAuthCredentials } from "../src/oauth/types";
import { getAccountCredential, getAccountSet, saveCredential } from "../src/oauth/store";

setDefaultTimeout(30_000);

const REFRESH_SKEW_MS = 60_000;
const origHome = process.env.HOME;
const origOcxHome = process.env.OPENCODEX_HOME;
const origCursorRefresh = OAUTH_PROVIDERS.cursor!.refresh;
let tmp = "";

beforeEach(() => {
  tmp = join(tmpdir(), `cursor-auth-gate-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(tmp, { recursive: true });
  process.env.HOME = tmp;
  process.env.OPENCODEX_HOME = join(tmp, "ocx");
});

afterEach(() => {
  OAUTH_PROVIDERS.cursor!.refresh = origCursorRefresh;
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  if (origOcxHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = origOcxHome;
  rmSync(tmp, { recursive: true, force: true });
});

async function seedNearExpiryCursor(): Promise<string> {
  await saveCredential("cursor", {
    access: "cursor-access-old",
    refresh: "cursor-refresh-old",
    expires: Date.now() + REFRESH_SKEW_MS - 1_000,
    accountId: "cursor-account-0",
  });
  return getAccountSet("cursor")!.activeAccountId;
}

function stubCursorRefresh(
  handler: () => Promise<OAuthCredentials>,
): { calls: () => number } {
  let refreshCalls = 0;
  OAUTH_PROVIDERS.cursor!.refresh = async () => {
    refreshCalls += 1;
    return handler();
  };
  return { calls: () => refreshCalls };
}

describe("cursor auth gate", () => {
  test("ten concurrent near-expiry refreshes share one Cursor IdP call", async () => {
    const accountId = await seedNearExpiryCursor();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const tracker = stubCursorRefresh(async () => {
      await gate;
      return {
        access: "cursor-access-fresh",
        refresh: "cursor-refresh-rotated",
        expires: Date.now() + 3_600_000,
        accountId: "cursor-account-0",
      };
    });

    const pending = Array.from({ length: 10 }, () => getValidAccessTokenForAccount("cursor", accountId));
    while (tracker.calls() === 0) await Bun.sleep(1);
    release();

    const results = await Promise.all(pending);
    expect(new Set(results).size).toBe(1);
    expect(results[0]).toBe("cursor-access-fresh");
    expect(tracker.calls()).toBe(1);
    expect(getAccountCredential("cursor", accountId)?.refresh).toBe("cursor-refresh-rotated");
  });

  test("concurrent preflight-401 force refreshes join one Cursor IdP call", async () => {
    await saveCredential("cursor", {
      access: "cursor-access-rejected",
      refresh: "cursor-refresh-rejected",
      expires: Date.now() + 3_600_000,
      accountId: "cursor-account-0",
    });
    const accountId = getAccountSet("cursor")!.activeAccountId;
    const snapshot = await getValidAccessSnapshotForAccount("cursor", accountId);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const tracker = stubCursorRefresh(async () => {
      await gate;
      return {
        access: "cursor-access-forced",
        refresh: "cursor-refresh-forced",
        expires: Date.now() + 3_600_000,
        accountId: "cursor-account-0",
      };
    });
    const pending = Array.from({ length: 2 }, () => forceRefreshOAuthAccessSnapshot(snapshot));
    while (tracker.calls() === 0) await Bun.sleep(1);
    release();

    const refreshed = await Promise.all(pending);
    expect(tracker.calls()).toBe(1);
    expect(new Set(refreshed.map(row => row.accessToken)).size).toBe(1);
    expect(refreshed[0]?.accessToken).toBe("cursor-access-forced");
  });
});
