import { chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteFile, getConfigDir, hardenConfigDir } from "../config";
import { assertNotRealHomeUnderTest } from "../lib/test-home-guard";
import { hardenSecretDir, hardenSecretPath } from "../lib/windows-secret-acl";

export interface AiStudioCookieItem {
  name: string;
  value: string;
  domain?: string;
  path?: string;
}

export interface AiStudioSessionData {
  selectedProject: string;
  windowId: string;
  cookies: AiStudioCookieItem[];
}

const MAX_SESSION_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SESSION_TOKEN_CHARS = 3 * 1024 * 1024;
const MAX_SESSION_COOKIES = 256;
const COOKIE_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,256}$/;
const COOKIE_VALUE_PATTERN = /^[\x21-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]{0,4096}$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const AI_STUDIO_COOKIE_TARGET_HOST = "alkalimakersuite-pa.clients6.google.com";
const AI_STUDIO_COOKIE_TARGET_PATHS = [
  "/v1internal:generateContent",
  "/v1internal:streamGenerateContent",
] as const;

function boundedMetadataString(value: unknown, field: string): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string" || value.length > 4096 || CONTROL_CHARACTER_PATTERN.test(value)) {
    throw new Error(`Invalid AI Studio session ${field}`);
  }
  return value;
}

function normalizedCookie(value: unknown): AiStudioCookieItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid AI Studio session cookie");
  }
  const cookie = value as Record<string, unknown>;
  if (typeof cookie.name !== "string" || !COOKIE_NAME_PATTERN.test(cookie.name)) {
    throw new Error("Invalid AI Studio session cookie name");
  }
  if (typeof cookie.value !== "string" || !COOKIE_VALUE_PATTERN.test(cookie.value)) {
    throw new Error("Invalid AI Studio session cookie value");
  }
  let domain: string | undefined;
  if (cookie.domain !== undefined) {
    if (typeof cookie.domain !== "string" || cookie.domain.length > 253 || CONTROL_CHARACTER_PATTERN.test(cookie.domain)) {
      throw new Error("Invalid AI Studio session cookie domain");
    }
    const host = cookie.domain.toLowerCase().replace(/^\./, "");
    if (host !== "google.com" && !host.endsWith(".google.com")) {
      throw new Error("Invalid AI Studio session cookie domain");
    }
    domain = cookie.domain;
  }
  let path: string | undefined;
  if (cookie.path !== undefined) {
    if (
      typeof cookie.path !== "string"
      || cookie.path.length === 0
      || cookie.path.length > 4096
      || !cookie.path.startsWith("/")
      || CONTROL_CHARACTER_PATTERN.test(cookie.path)
      || cookie.path.includes(";")
    ) {
      throw new Error("Invalid AI Studio session cookie path");
    }
    path = cookie.path;
  }
  return { name: cookie.name, value: cookie.value, ...(domain ? { domain } : {}), ...(path ? { path } : {}) };
}

export function validateAiStudioSessionData(value: unknown): AiStudioSessionData {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid AI Studio session bundle schema");
  }
  const data = value as Record<string, unknown>;
  if (!Array.isArray(data.cookies) || data.cookies.length === 0 || data.cookies.length > MAX_SESSION_COOKIES) {
    throw new Error("Invalid AI Studio session bundle schema: bounded cookies array required");
  }
  // Imported bundles may originate in a browser-wide Google cookie query. Keep
  // only cookies the canonical AI Studio transport could actually send.
  const cookies = data.cookies.map(normalizedCookie).filter(cookie =>
    cookieDomainMatches(AI_STUDIO_COOKIE_TARGET_HOST, cookie.domain)
    && AI_STUDIO_COOKIE_TARGET_PATHS.some(path => cookiePathMatches(path, cookie.path)));
  if (!cookies.some(cookie => cookie.name === "SAPISID" && cookie.value.length > 0)) {
    throw new Error("Invalid AI Studio session bundle schema: valid SAPISID cookie required");
  }
  return {
    selectedProject: boundedMetadataString(data.selectedProject, "selectedProject"),
    windowId: boundedMetadataString(data.windowId, "windowId"),
    cookies,
  };
}

export function serializeSessionBundle(data: AiStudioSessionData): string {
  const jsonStr = JSON.stringify(validateAiStudioSessionData(data));
  return Buffer.from(jsonStr, "utf-8").toString("base64");
}

export function parseSessionBundle(encoded: string): AiStudioSessionData {
  if (!encoded || typeof encoded !== "string") {
    throw new Error("Invalid session token");
  }

  const token = encoded.trim();
  if (token.length > MAX_SESSION_TOKEN_CHARS) throw new Error("Invalid session token");
  const raw = Buffer.from(token, "base64").toString("utf-8");
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    void err;
    throw new Error("Failed to parse session token: invalid JSON");
  }

  return validateAiStudioSessionData(data);
}

export function getAiStudioSessionPath(): string {
  return join(getConfigDir(), "aistudio-session.json");
}

export function saveAiStudioSession(data: AiStudioSessionData, dest = getAiStudioSessionPath()): string {
  const session = validateAiStudioSessionData(data);
  const directory = dirname(dest);
  assertNotRealHomeUnderTest(directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { chmodSync(directory, 0o700); } catch { /* best-effort on platforms without POSIX modes */ }
  hardenSecretDir(directory, { required: true });
  if (directory === getConfigDir()) hardenConfigDir();
  atomicWriteFile(dest, `${JSON.stringify(session, null, 2)}\n`);
  return dest;
}

export function saveAiStudioSessionFromToken(tokenOrBase64: string, dest?: string): string {
  const session = parseSessionBundle(tokenOrBase64);
  return saveAiStudioSession(session, dest);
}

export function loadAiStudioSession(path = getAiStudioSessionPath()): AiStudioSessionData | null {
  if (!existsSync(path)) return null;
  let descriptor: number | undefined;
  try {
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_SESSION_FILE_BYTES) return null;
    hardenSecretDir(dirname(path), { required: true });
    try { chmodSync(path, 0o600); } catch { /* Windows authority is the required ACL below */ }
    hardenSecretPath(path, { required: true });
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(descriptor);
    const linked = lstatSync(path);
    if (
      !opened.isFile()
      || !linked.isFile()
      || linked.isSymbolicLink()
      || opened.size > MAX_SESSION_FILE_BYTES
      || before.dev !== opened.dev
      || before.ino !== opened.ino
      || opened.dev !== linked.dev
      || opened.ino !== linked.ino
    ) return null;
    if (process.platform !== "win32") {
      const uid = process.getuid?.();
      if ((opened.mode & 0o077) !== 0 || (uid !== undefined && opened.uid !== uid)) return null;
    }
    return validateAiStudioSessionData(JSON.parse(readFileSync(descriptor, "utf-8")));
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* read already failed closed */ }
    }
  }
}

function cookieDomainMatches(hostname: string, domain: unknown): boolean {
  if (domain === undefined) return true;
  if (typeof domain !== "string" || !domain) return false;
  const cookieDomain = domain.toLowerCase().replace(/^\./, "");
  return hostname === cookieDomain || hostname.endsWith(`.${cookieDomain}`);
}

function cookiePathMatches(requestPath: string, cookiePath: unknown): boolean {
  if (cookiePath === undefined) return true;
  if (typeof cookiePath !== "string" || !cookiePath) return false;
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith("/") || requestPath[cookiePath.length] === "/";
}

export function cookieHeaderFromSession(
  session: AiStudioSessionData | null | undefined,
  target: string | URL = "https://alkalimakersuite-pa.clients6.google.com/",
): string {
  if (!session?.cookies?.length) return "";
  let destination: URL;
  try {
    destination = target instanceof URL ? target : new URL(target);
  } catch {
    return "";
  }
  return session.cookies
    .filter((c) => c
      && c.name
      && c.value
      && !/[\r\n\u0000]/.test(c.name)
      && !/[\r\n\u0000]/.test(c.value)
      && cookieDomainMatches(destination.hostname.toLowerCase(), c.domain)
      && cookiePathMatches(destination.pathname || "/", c.path))
    .map((c) => c.name.trim() + "=" + c.value.trim())
    .join("; ");
}
