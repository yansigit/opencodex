import { createHash } from "node:crypto";
import type { OcxProviderConfig } from "../types";
import {
  cookieHeaderFromSession,
  loadAiStudioSession,
  type AiStudioSessionData,
} from "./aistudio-session-sync";
import { parseGoogleCookieJar, validateAiStudioCookies } from "./google-aistudio-auth";

export type AiStudioCredentialResolution =
  | {
      kind: "ready";
      cookieHeader: string;
      source: "provider-api-key" | "provider-header" | "session";
      fingerprint: string;
    }
  | { kind: "missing"; reason: string }
  | { kind: "invalid"; reason: string };

type AiStudioCredentialSource = "provider-api-key" | "provider-header" | "session";

const MISSING_REASON = "AI Studio credentials are missing.";
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function resolveCookie(value: unknown, source: AiStudioCredentialSource):
  | Extract<AiStudioCredentialResolution, { kind: "ready" }>
  | Extract<AiStudioCredentialResolution, { kind: "invalid" }>
  | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  if (CONTROL_CHARACTERS.test(value)) {
    return { kind: "invalid", reason: "Google AI Studio cookie credentials contain prohibited control characters." };
  }
  const jar = parseGoogleCookieJar(value);
  const cookieHeader = jar.cookieHeader;
  const validation = validateAiStudioCookies(jar);
  if (!validation.valid) return { kind: "invalid", reason: validation.error ?? "Invalid Google AI Studio cookies." };
  return {
    kind: "ready",
    cookieHeader,
    source,
    fingerprint: createHash("sha256").update(cookieHeader, "utf8").digest("hex"),
  };
}

function configuredCookieHeader(provider: OcxProviderConfig): string | undefined {
  const header = Object.entries(provider.headers ?? {}).find(([name]) => name.toLowerCase() === "cookie");
  return header?.[1];
}

/** Resolve one usable AI Studio Web cookie source in priority order. */
export function resolveAiStudioCredentials(
  provider: OcxProviderConfig,
  session?: AiStudioSessionData | null,
): AiStudioCredentialResolution {
  const invalidReasons: string[] = [];
  for (const [value, source] of [
    [provider.apiKey, "provider-api-key"],
    [configuredCookieHeader(provider), "provider-header"],
    [cookieHeaderFromSession(session === undefined ? loadAiStudioSession() : session), "session"],
  ] as const) {
    const result = resolveCookie(value, source);
    if (!result) continue;
    if (result.kind === "ready") return result;
    invalidReasons.push(result.reason);
  }
  return invalidReasons.length > 0
    ? { kind: "invalid", reason: invalidReasons[0]! }
    : { kind: "missing", reason: MISSING_REASON };
}
