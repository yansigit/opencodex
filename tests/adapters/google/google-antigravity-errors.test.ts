import { describe, expect, test } from "bun:test";
import {
  isAntigravityGeoBlockedBody,
  isQuotaExhaustedBody,
  retryableGoogleStatus,
  safeAntigravityHttpErrorMessage,
} from "../../../src/adapters/google-errors";

const GEO_BLOCKED_DETAIL = "User location is not supported for the API use";

describe("Antigravity Google error classification", () => {
  test("detects geo-blocked 403 responses without overriding permission precedence", () => {
    const leakedToken = "geo-access-token-value-123456";
    const payload = JSON.stringify({
      error: {
        status: "PERMISSION_DENIED",
        message: `${GEO_BLOCKED_DETAIL}; accessToken=${leakedToken}`,
      },
    });

    expect(isAntigravityGeoBlockedBody(payload)).toBe(true);
    const message = safeAntigravityHttpErrorMessage(403, payload);
    expect(message).toContain("Antigravity access denied");
    expect(message).not.toContain(leakedToken);
  });

  test("shares upstream location wording with the cooldown detector", () => {
    for (const phrase of [
      "unsupported location for this API",
      "The region is not supported",
      "This model is not supported in your country",
    ]) {
      expect(isAntigravityGeoBlockedBody(phrase)).toBe(true);
    }
  });

  test("keeps ordinary permission-denied 403 responses as access denied", () => {
    const payload = JSON.stringify({
      error: {
        status: "PERMISSION_DENIED",
        message: "The caller does not have permission to use this resource",
      },
    });

    expect(isAntigravityGeoBlockedBody(payload)).toBe(false);
    expect(safeAntigravityHttpErrorMessage(403, payload)).toContain("Antigravity access denied");
  });

  test("normalizes a data-prefixed SSE error envelope", () => {
    const payload = `data: ${JSON.stringify({
      error: { status: "FAILED_PRECONDITION", message: GEO_BLOCKED_DETAIL },
    })}`;
    expect(safeAntigravityHttpErrorMessage(400, payload)).toContain("Antigravity location not supported");
  });

  test("preserves quota and rate-limit classification for 429 responses", () => {
    const quotaPayload = JSON.stringify({
      error: {
        status: "RESOURCE_EXHAUSTED",
        message: "Quota exceeded for this project",
      },
    });
    const rateLimitPayload = JSON.stringify({
      error: {
        status: "RESOURCE_EXHAUSTED",
        message: "Rate limit exceeded",
      },
    });

    expect(safeAntigravityHttpErrorMessage(429, quotaPayload)).toContain("Antigravity quota exhausted");
    expect(safeAntigravityHttpErrorMessage(429, rateLimitPayload)).toContain("Antigravity rate limit exceeded");
    expect(isQuotaExhaustedBody(quotaPayload)).toBe(true);
    expect(isQuotaExhaustedBody(rateLimitPayload)).toBe(false);
    expect(retryableGoogleStatus(403)).toBe(false);
  });
});
