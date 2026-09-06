import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const coreSource = readFileSync(
  new URL("../../src/server/responses/core.ts", import.meta.url),
  "utf8",
);

describe("fork Responses core preservation", () => {
  test("Antigravity exhausts its 429 recovery before opaque-blob recovery", () => {
    const start = coreSource.indexOf("// Antigravity-specific recovery");
    const antigravityRetry = coreSource.indexOf("retryableAntigravity429DelayMs(", start);
    const accountRotation = coreSource.indexOf("rotateGenericOAuthAccountOn429(", start);
    const opaqueRecovery = coreSource.indexOf(
      "const opaqueBlobRecovery = await attemptOpaqueBlobRecovery",
      start,
    );

    expect(start).toBeGreaterThanOrEqual(0);
    expect(antigravityRetry).toBeGreaterThan(start);
    expect(accountRotation).toBeGreaterThan(antigravityRetry);
    expect(opaqueRecovery).toBeGreaterThan(accountRotation);
  });

  test("one failover helper preserves Kiro continuation and Antigravity identity pairing", () => {
    const start = coreSource.indexOf("const applyFailoverSnapshot =");
    const end = coreSource.indexOf("\n  };", start);
    const helper = coreSource.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(helper).toContain("retryParsed._kiroAuthContext");
    expect(helper).toContain("antigravityAccountId = snapshot.accountId");
    expect(helper).toContain("bindAntigravitySessionAffinity(");
    expect(helper.match(/apiKey: snapshot\.accessToken/g)).toHaveLength(1);
  });

  test("passive quota remains event-time attributed and precedes terminal guard exits", () => {
    const start = coreSource.indexOf("const noteInspectedPayload =");
    const servingAccount = coreSource.indexOf(
      "const servingAccountId = genericFailoverAccountId",
      start,
    );
    const quotaWrite = coreSource.indexOf("recordPassiveAccountQuota(", servingAccount);
    const guardExit = coreSource.indexOf(
      "if (!undeclaredToolGuardActive || inspectionSawUndeclaredTool) return",
      start,
    );

    expect(start).toBeGreaterThanOrEqual(0);
    expect(servingAccount).toBeGreaterThan(start);
    expect(quotaWrite).toBeGreaterThan(servingAccount);
    expect(guardExit).toBeGreaterThan(quotaWrite);
  });

  test("web-search planning receives both trusted Reserve context and media precedence", () => {
    const mediaPlan = coreSource.indexOf("const mediaMayInject = mediaBridgeWillRun(");
    const webPlan = coreSource.indexOf("? planWebSearch(", mediaPlan);
    const admission = coreSource.indexOf("admission: options.admission", webPlan);
    const policy = coreSource.indexOf("codexAuthPolicy: options.codexAuthPolicy", webPlan);
    const media = coreSource.indexOf("hasMediaBridge: mediaMayInject", webPlan);

    expect(mediaPlan).toBeGreaterThanOrEqual(0);
    expect(webPlan).toBeGreaterThan(mediaPlan);
    expect(admission).toBeGreaterThan(webPlan);
    expect(policy).toBeGreaterThan(admission);
    expect(media).toBeGreaterThan(policy);
  });

  test("wrapped quota retries retain live Reserve admission and native WS quota observation", () => {
    const start = coreSource.indexOf("// Wrapped quota in 5xx");
    const end = coreSource.indexOf("if (poolRetryOutcome !== undefined)", start);
    const retry = coreSource.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(retry).toContain("onCodexWsQuota: codexWsQuotaObserver(authCtx, route.provider)");
    expect(retry).toContain("createCodexReserveDispatchGuard(authCtx, options.codexAuthPolicy ?? config");
  });

  test("terminal continuations retain Cursor recovery before generic OAuth rotation", () => {
    const start = coreSource.indexOf("const fetchTerminalGuardContinuation =");
    const cursorBilling = coreSource.indexOf("recordCursorAccountBillingCooldown(", start);
    const cursorAuth = coreSource.indexOf("rotateCursorAccountOnAuth(", cursorBilling);
    const cursorQuota = coreSource.indexOf("rotateCursorAccountOn429(", cursorAuth);
    const genericQuota = coreSource.indexOf("rotateGenericOAuthAccountOn429(", cursorQuota);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(cursorBilling).toBeGreaterThan(start);
    expect(cursorAuth).toBeGreaterThan(cursorBilling);
    expect(cursorQuota).toBeGreaterThan(cursorAuth);
    expect(genericQuota).toBeGreaterThan(cursorQuota);
  });
});
