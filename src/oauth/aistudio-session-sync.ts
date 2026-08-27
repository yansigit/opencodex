import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

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

export function serializeSessionBundle(data: AiStudioSessionData): string {
  const jsonStr = JSON.stringify(data);
  return Buffer.from(jsonStr, "utf-8").toString("base64");
}

export function parseSessionBundle(encoded: string): AiStudioSessionData {
  if (!encoded || typeof encoded !== "string") {
    throw new Error("Invalid session token");
  }

  const raw = Buffer.from(encoded.trim(), "base64").toString("utf-8");
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    void err;
    throw new Error("Failed to parse session token: invalid JSON");
  }

  if (!data || typeof data !== "object" || !Array.isArray(data.cookies)) {
    throw new Error("Invalid session bundle schema: cookies array required");
  }

  return {
    selectedProject: String(data.selectedProject || ""),
    windowId: String(data.windowId || ""),
    cookies: data.cookies.map((c: any) => ({
      name: String(c.name || ""),
      value: String(c.value || ""),
      domain: c.domain ? String(c.domain) : undefined,
      path: c.path ? String(c.path) : undefined,
    })),
  };
}

export function getAiStudioSessionPath(): string {
  return join(homedir(), ".opencodex", "aistudio-session.json");
}

export function saveAiStudioSession(data: AiStudioSessionData, dest = getAiStudioSessionPath()): string {
  mkdirSync(join(dest, ".."), { recursive: true });
  writeFileSync(dest, JSON.stringify(data, null, 2), "utf-8");
  return dest;
}

export function saveAiStudioSessionFromToken(tokenOrBase64: string, dest?: string): string {
  const session = parseSessionBundle(tokenOrBase64);
  return saveAiStudioSession(session, dest);
}

export function loadAiStudioSession(path = getAiStudioSessionPath()): AiStudioSessionData | null {
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, "utf-8"));
    if (!data || typeof data !== "object" || !Array.isArray(data.cookies)) return null;
    return {
      selectedProject: String(data.selectedProject || ""),
      windowId: String(data.windowId || ""),
      cookies: data.cookies.map((c: any) => ({
        name: String(c.name || ""),
        value: String(c.value || ""),
        domain: c.domain ? String(c.domain) : undefined,
        path: c.path ? String(c.path) : undefined,
      })),
    };
  } catch {
    return null;
  }
}

export function cookieHeaderFromSession(session: AiStudioSessionData | null | undefined): string {
  if (!session?.cookies?.length) return "";
  return session.cookies
    .filter((c) => c && c.name && c.value && !/[\r\n\u0000]/.test(c.name) && !/[\r\n\u0000]/.test(c.value))
    .map((c) => c.name.trim() + "=" + c.value.trim())
    .join("; ");
}
