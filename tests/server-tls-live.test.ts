import { expect, test } from "bun:test";
import { request } from "node:https";
import { checkServerIdentity } from "node:tls";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome } from "./helpers/isolated-codex-home";

const certFile = new URL("./fixtures/network-tls-test-cert.pem", import.meta.url);
const keyFile = new URL("./fixtures/network-tls-test-key.pem", import.meta.url);

test("test-only certificate serves real HTTPS with verified localhost SNI", async () => {
  const cert = await Bun.file(certFile).text();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { cert: Bun.file(certFile), key: Bun.file(keyFile) },
    fetch: () => new Response("tls-ok"),
  });
  try {
    let verifiedHost = "";
    let verifiedCommonName: string | undefined;
    const body = await new Promise<string>((resolve, reject) => {
      const req = request({
        hostname: "127.0.0.1",
        port: server.port,
        path: "/",
        ca: cert,
        servername: "localhost",
        checkServerIdentity: (host, peer) => {
          verifiedHost = host;
          verifiedCommonName = peer.subject.CN;
          return checkServerIdentity(host, peer);
        },
      }, response => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", chunk => { body += chunk; });
        response.on("end", () => resolve(body));
      });
      req.on("error", reject);
      req.end();
    });
    expect({ body, verifiedHost, verifiedCommonName }).toEqual({
      body: "tls-ok",
      verifiedHost: "localhost",
      verifiedCommonName: "localhost",
    });
  } finally {
    server.stop(true);
  }
});

test("startServer applies native TLS to the configured listener and serves healthz", async () => {
  const previousOpenCodexHome = process.env.OPENCODEX_HOME;
  const isolatedCodexHome = installIsolatedCodexHome("ocx-server-tls-live-codex-");
  const testDir = mkdtempSync(join(tmpdir(), "ocx-server-tls-live-"));
  process.env.OPENCODEX_HOME = testDir;
  const config: OcxConfig = {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "mock",
    providers: {
      mock: {
        adapter: "openai-chat",
        baseUrl: "https://api.openai.com/v1",
        authMode: "key",
        apiKey: "test-key",
      },
    },
    tls: {
      certFile: fileURLToPath(certFile),
      keyFile: fileURLToPath(keyFile),
      publicOrigin: "https://localhost",
    },
  };
  saveConfig(config);
  const server = startServer(0);
  try {
    expect(server.url.protocol).toBe("https:");
    const cert = await Bun.file(certFile).text();
    const result = await new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
      const req = request({
        hostname: "127.0.0.1",
        port: server.port,
        path: "/healthz",
        ca: cert,
        servername: "localhost",
      }, response => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", chunk => { body += chunk; });
        response.on("end", () => resolve({ status: response.statusCode, body }));
      });
      req.on("error", reject);
      req.end();
    });
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({ service: "opencodex" });
  } finally {
    await server.stop(true);
    if (previousOpenCodexHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousOpenCodexHome;
    isolatedCodexHome.restore();
    rmSync(testDir, { recursive: true, force: true });
  }
});
