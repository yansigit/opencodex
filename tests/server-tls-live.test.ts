import { expect, test } from "bun:test";
import { request } from "node:https";
import { checkServerIdentity } from "node:tls";

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
