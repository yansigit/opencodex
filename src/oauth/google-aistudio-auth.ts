/**
 * Google AI Studio Web-UI (SAPISIDHASH) authorization & header builder.
 */

export interface GoogleCookieJar {
  sapisid?: string;
  psid?: string;
  ssid?: string;
  hsid?: string;
  sid?: string;
  cookieHeader: string;
}

const DEFAULT_ORIGIN = "https://aistudio.google.com";

/**
 * Generate the Google internal SAPISIDHASH Authorization header value.
 * Formula uses Unix seconds: "SAPISIDHASH <timestamp>_<sha1(timestamp + " " + SAPISID + " " + origin)>".
 */
export async function generateSapisidHash(
  sapisid: string,
  origin: string = DEFAULT_ORIGIN,
  timestamp: number = Date.now()
): Promise<string> {
  // Callers historically passed Date.now() (milliseconds); Google expects Unix seconds.
  const seconds = Math.floor(timestamp > 10_000_000_000 ? timestamp / 1000 : timestamp);
  const raw = `${seconds} ${sapisid} ${origin}`;
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(raw));
  const hexHash = Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `SAPISIDHASH ${seconds}_${hexHash}`;
}

/**
 * Parse a raw cookie string (from browser export, header, or config) into tokens and a normalized string.
 */
export function parseGoogleCookieJar(cookieInput: string): GoogleCookieJar {
  const cleanInput = (cookieInput || "").trim();
  const jar: GoogleCookieJar = { cookieHeader: cleanInput };
  if (!cleanInput) return jar;
  if (/[\r\n\u0000]/.test(cleanInput)) return { cookieHeader: "" };

  const parts = cleanInput.split(";").map((p) => p.trim());
  for (const part of parts) {
    const eqIdx = part.indexOf("=");
    if (eqIdx === -1) continue;
    const name = part.slice(0, eqIdx).trim();
    const value = part.slice(eqIdx + 1).trim();

    if (name === "SAPISID" || name === "__Secure-3PAPISID") {
      jar.sapisid = value;
    } else if (name === "__Secure-1PSID" || name === "__Secure-3PSID") {
      jar.psid = value;
    } else if (name === "SSID") {
      jar.ssid = value;
    } else if (name === "HSID") {
      jar.hsid = value;
    } else if (name === "SID") {
      jar.sid = value;
    }
  }

  return jar;
}

/**
 * Validate whether a cookie jar contains sufficient authentication credentials.
 */
export function validateAiStudioCookies(jar: GoogleCookieJar): { valid: boolean; error?: string } {
  if (!jar.sapisid || !jar.cookieHeader) {
    return {
      valid: false,
      error: "Missing SAPISID cookie required for Google AI Studio authorization.",
    };
  }
  return { valid: true };
}

/**
 * Build the HTTP headers required for alkalimakersuite-pa.clients6.google.com calls.
 */
export async function buildAiStudioHeaders(
  jar: GoogleCookieJar,
  origin: string = DEFAULT_ORIGIN
): Promise<Record<string, string>> {
  const sapisid = jar.sapisid || "";
  const authHeader = await generateSapisidHash(sapisid, origin);

  return {
    "Authorization": authHeader,
    "Cookie": jar.cookieHeader,
    "X-Goog-AuthUser": "0",
    "Origin": origin,
    "Referer": origin.endsWith("/") ? origin : `${origin}/`,
    "Content-Type": "application/json",
  };
}
