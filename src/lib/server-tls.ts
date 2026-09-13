import { accessSync, constants, statSync } from "node:fs";
import type { OcxConfig, OcxServerTlsConfig } from "../types";

export function serverTlsConfigError(value: unknown): string | null {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return "tls must be an object or omitted";
  const tls = value as Record<string, unknown>;
  const fields = ["certFile", "keyFile", "publicOrigin"] as const;
  const unknown = Object.keys(tls).find(field => !(fields as readonly string[]).includes(field));
  if (unknown) return `tls.${unknown} is not a supported field`;
  for (const field of fields) {
    if (typeof tls[field] !== "string" || tls[field].trim() !== tls[field] || !tls[field]) {
      return `tls.${field} must be a non-empty trimmed string`;
    }
  }
  try {
    const url = new URL(tls.publicOrigin as string);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash || url.origin !== tls.publicOrigin) {
      return "tls.publicOrigin must be an exact HTTPS origin without credentials, path, query, or fragment";
    }
  } catch {
    return "tls.publicOrigin must be an exact HTTPS origin without credentials, path, query, or fragment";
  }
  return null;
}

export function assertServerTlsFiles(tls: OcxServerTlsConfig): void {
  for (const [label, path] of [["certificate", tls.certFile], ["private key", tls.keyFile]] as const) {
    try {
      accessSync(path, constants.R_OK);
      if (!statSync(path).isFile()) throw new Error("not a regular file");
    } catch {
      throw new Error(`TLS ${label} is not a readable regular file: ${path}`);
    }
  }
}

function clientHost(hostname: string | undefined): string {
  const host = hostname?.trim() || "127.0.0.1";
  if (host === "0.0.0.0" || host === "::" || host === "[::]") return "127.0.0.1";
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

export function canonicalServerOrigin(config: Pick<OcxConfig, "hostname" | "tls">, port: number): string {
  if (config.tls) return config.tls.publicOrigin;
  return `http://${clientHost(config.hostname)}:${port}`;
}
