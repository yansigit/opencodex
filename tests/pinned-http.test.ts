import { createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, test } from "bun:test";
import {
  PinnedHttpError,
  pinnedHttpGet,
  pinnedHttpHostnameForTests,
} from "../src/lib/pinned-http";

let server: Server | undefined;
const sockets = new Set<Socket>();

function trackSocket(socket: Socket): void {
  sockets.add(socket);
  socket.on("error", () => { /* client timeout or cleanup can reset the peer */ });
  socket.on("close", () => sockets.delete(socket));
}

async function listen(handler: (socket: Socket) => void): Promise<number> {
  server = createServer((socket) => {
    trackSocket(socket);
    handler(socket);
  });
  return await new Promise<number>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(0, "127.0.0.1", () => {
      const address = server!.address();
      if (!address || typeof address === "string") {
        reject(new Error("test server did not expose a TCP port"));
        return;
      }
      resolve(address.port);
    });
  });
}

function request(port: number, idleTimeoutMs: number, signal?: AbortSignal): Promise<Response> {
  return pinnedHttpGet(
    `http://slow-header.invalid:${port}/`,
    { address: "127.0.0.1", family: 4 },
    signal,
    { idleTimeoutMs },
  );
}

afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  if (server) {
    const closing = server;
    server = undefined;
    await new Promise<void>((resolve) => closing.close(() => resolve()));
  }
});

describe("pinned HTTP timeouts", () => {
  test("legacy idle timeout is also an absolute response-header deadline", async () => {
    const port = await listen((socket) => {
      socket.write("HTTP/1.1 200 OK\r\nX-Slow: ");
      const drip = setInterval(() => socket.write("x"), 20);
      socket.on("close", () => clearInterval(drip));
    });

    const error = await request(port, 150).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PinnedHttpError);
    expect(error).toMatchObject({ code: "first_byte_timeout" });
  });

  test("pauses the Node response when the web-stream queue is full", async () => {
    const port = await listen((socket) => {
      socket.write("HTTP/1.1 200 OK\r\nConnection: close\r\n\r\na");
      const tail = setTimeout(() => socket.end("b"), 20);
      socket.on("close", () => clearTimeout(tail));
    });

    const response = await pinnedHttpGet(
      `http://backpressure.invalid:${port}/`,
      { address: "127.0.0.1", family: 4 },
      undefined,
      { maxBytes: 1 },
    );
    const reader = response.body!.getReader();
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("a");
    await expect(reader.read()).rejects.toMatchObject({ code: "output_byte_limit" });
  });

  test("legacy idleTimeoutMs zero still disables the header and socket timers", async () => {
    const port = await listen((socket) => {
      let bodyReply: ReturnType<typeof setTimeout> | undefined;
      const headersReply = setTimeout(() => {
        socket.write("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n");
        bodyReply = setTimeout(() => socket.end("ok"), 50);
      }, 50);
      socket.on("close", () => {
        clearTimeout(headersReply);
        if (bodyReply !== undefined) clearTimeout(bodyReply);
      });
    });

    const response = await request(port, 0);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });

  test("an abort between the initial check and listener installation is observed", async () => {
    const port = await listen(() => { /* hold the socket until cancellation */ });
    const reason = new Error("abort during listener installation");
    let aborted = false;
    const signal = {
      get aborted() { return aborted; },
      get reason() { return reason; },
      addEventListener() { aborted = true; },
      removeEventListener() { /* no-op test signal */ },
    } as unknown as AbortSignal;

    const error = await request(port, 100, signal).catch((caught: unknown) => caught);
    expect(error).toBe(reason);
  });
});

describe("pinned HTTP peer identity", () => {
  test("a later pin cannot reuse a pooled socket to an earlier address", async () => {
    const peer = (body: string) => createServer((socket) => {
      trackSocket(socket);
      socket.on("data", () => socket.write([
        "HTTP/1.1 200 OK",
        `Content-Length: ${Buffer.byteLength(body)}`,
        "Connection: keep-alive",
        "",
        body,
      ].join("\r\n")));
    });
    const first = peer("first");
    const second = peer("second");
    const listenPeer = (target: Server, address: string, port: number) => new Promise<number>((resolve, reject) => {
      target.once("error", reject);
      target.listen({ port, host: address, ipv6Only: address.includes(":") }, () => {
        const bound = target.address();
        if (!bound || typeof bound === "string") reject(new Error("peer did not expose a port"));
        else resolve(bound.port);
      });
    });
    const port = await listenPeer(first, "127.0.0.1", 0);
    await listenPeer(second, "::1", port);
    try {
      const url = `http://rebind.example.test:${port}/hook`;
      const firstResponse = await pinnedHttpGet(url, { address: "127.0.0.1", family: 4 });
      expect(await firstResponse.text()).toBe("first");

      const secondResponse = await pinnedHttpGet(url, { address: "::1", family: 6 });
      expect(await secondResponse.text()).toBe("second");
    } finally {
      for (const socket of sockets) socket.destroy();
      await Promise.all([
        new Promise<void>(resolve => first.close(() => resolve())),
        new Promise<void>(resolve => second.close(() => resolve())),
      ]);
    }
  });

  test("an IPv6 literal is unbracketed for connection and certificate identity", () => {
    expect(pinnedHttpHostnameForTests("https://[::1]:9443/hook")).toBe("::1");
  });
});
