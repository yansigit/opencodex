import { createHash } from "node:crypto";
import type { OcxProviderConfig } from "../types";
import {
  parseGoogleCookieJar,
  validateAiStudioCookies,
} from "./google-aistudio-auth";
import {
  cookieHeaderFromSession,
  loadAiStudioSession,
  type AiStudioSessionData,
} from "./aistudio-session-sync";

export type AiStudioCredentialResolution =
  | { kind: "ready"; cookieHeader: string; source: "provider-api-key" | "provider-header" | "session"; fingerprint: string }
  | { kind: "missing"; reason: string }
  | { kind: "invalid"; reason: string };

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function validCookieHeader(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cookieHeader = value.trim();
  if (!cookieHeader || CONTROL_CHARACTERS.test(cookieHeader)) return undefined;
  const jar = parseGoogleCookieJar(cookieHeader);
  return validateAiStudioCookies(jar).valid ? jar.cookieHeader : undefined;
}

function ready(cookieHeader: string, source: "provider-api-key" | "provider-header" | "session"): AiStudioCredentialResolution {
  return {
    kind: "ready",
    cookieHeader,
    source,
    fingerprint: createHash("sha256").update(cookieHeader).digest("hex"),
  };
}

export function resolveAiStudioCredentials(
  provider: OcxProviderConfig,
  session?: AiStudioSessionData | null,
): AiStudioCredentialResolution {
  const invalidSources: string[] = [];
  const apiKey = validCookieHeader(provider.apiKey);
  if (apiKey) return ready(apiKey, "provider-api-key");
  if (provider.apiKey?.trim()) invalidSources.push("provider apiKey");

  const cookieEntry = Object.entries(provider.headers ?? {}).find(([name]) => name.toLowerCase() === "cookie");
  const headerCookie = validCookieHeader(cookieEntry?.[1]);
  if (headerCookie) return ready(headerCookie, "provider-header");
  if (cookieEntry?.[1]?.trim()) invalidSources.push("provider Cookie header");

  const savedSession = session === undefined ? loadAiStudioSession() : session;
  const sessionCookie = validCookieHeader(cookieHeaderFromSession(savedSession));
  if (sessionCookie) return ready(sessionCookie, "session");
  if (savedSession) invalidSources.push("saved session");

  return invalidSources.length > 0
    ? { kind: "invalid", reason: "AI Studio credentials are malformed or missing SAPISID." }
    : { kind: "missing", reason: "AI Studio credentials are missing." };
}
