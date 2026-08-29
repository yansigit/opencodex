import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateConfigCandidate } from "../src/config";
import { canonicalServerOrigin, serverTlsConfigError } from "../src/lib/server-tls";
import { assertServerAuthConfig } from "../src/server/auth-cors";
import type { OcxConfig } from "../src/types";

let dir = "";
afterEach(() => {
  delete process.env.OPENCODEX_API_AUTH_TOKEN;
  if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

function remoteConfig(): OcxConfig {
  return {
    port: 10443,
    hostname: "0.0.0.0",
    defaultProvider: "openai",
    providers: { openai: { adapter: "openai-chat", baseUrl: "https://api.openai.com/v1" } },
  };
}

describe("native server TLS", () => {
  test.each([
    [{ certFile: "cert", keyFile: "key", publicOrigin: "http://proxy.example.com" }],
    [{ certFile: "cert", keyFile: "key", publicOrigin: "https://user@127.0.0.1" }],
    [{ certFile: "cert", keyFile: "key", publicOrigin: "https://proxy.example.com/path" }],
    [{ certFile: "", keyFile: "key", publicOrigin: "https://proxy.example.com" }],
    [{ certFile: "cert", keyFile: "key", publicOrigin: "https://proxy.example.com", extra: true }],
  ])("rejects malformed TLS config %#", tls => {
    expect(serverTlsConfigError(tls)).not.toBeNull();
    expect(validateConfigCandidate({ ...remoteConfig(), tls }).ok).toBe(false);
  });

  test("accepts readable files and uses the exact public origin", () => {
    dir = mkdtempSync(join(tmpdir(), "ocx-server-tls-"));
    const certFile = join(dir, "cert.pem");
    const keyFile = join(dir, "key.pem");
    writeFileSync(certFile, "test certificate");
    writeFileSync(keyFile, "test key");
    const config = {
      ...remoteConfig(),
      tls: { certFile, keyFile, publicOrigin: "https://proxy.example.com" },
    };
    process.env.OPENCODEX_API_AUTH_TOKEN = "remote-secret";
    expect(() => assertServerAuthConfig(config)).not.toThrow();
    expect(canonicalServerOrigin(config, 10443)).toBe("https://proxy.example.com");
  });

  test("legacy loopback remains HTTP", () => {
    expect(canonicalServerOrigin({ hostname: "127.0.0.1" }, 10100)).toBe("http://127.0.0.1:10100");
  });
});
