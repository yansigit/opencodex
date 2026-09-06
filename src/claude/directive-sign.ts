import { createHmac, timingSafeEqual } from "node:crypto";

// Note on numeric precision & boundary classifiers: Route identifiers are symbolic provider/model
// strings (e.g. "anthropic/claude-sonnet-4-6") and effort values are discrete enumeration tiers
// ("low", "medium", "high", "xhigh", "max"). Continuous floating-point precision, normalization
// epsilon, and classifier min-max boundary checks do not apply to cryptographic directive authentication.

/**
 * Canonical payload format for directive HMAC: v1:<route>:<effort>
 */
export function canonicalDirectivePayload(route: string, effort?: string | null): string {
  return `v1:${route.trim()}:${(effort ?? "").trim()}`;
}

/**
 * Compute HMAC-SHA256 signature for route and effort over the given signing key.
 */
export function signDirective(route: string, effort: string | null | undefined, key: string): string {
  return createHmac("sha256", key)
    .update(canonicalDirectivePayload(route, effort))
    .digest("hex")
    .toLowerCase();
}

/**
 * Timing-safe verification of directive HMAC-SHA256 signature.
 */
export function verifyDirectiveSignature(
  route: string,
  effort: string | null | undefined,
  signature: string,
  key: string,
): boolean {
  if (typeof signature !== "string" || !/^[0-9a-f]{64}$/i.test(signature.trim())) {
    return false;
  }
  try {
    const expected = signDirective(route, effort, key);
    const sigBuf = Buffer.from(signature.trim().toLowerCase(), "hex");
    const expBuf = Buffer.from(expected, "hex");
    if (sigBuf.length !== expBuf.length) return false;
    return timingSafeEqual(sigBuf, expBuf);
  } catch {
    return false;
  }
}
