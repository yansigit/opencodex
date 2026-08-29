import { describe, expect, mock, test } from "bun:test";
import { oauthFetch, OAuthTransportError } from "../src/oauth/transport";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

describe("OAuth transport boundary", () => {
  test("requires HTTPS before dispatch", async () => {
    const executor = mock(async () => new Response("unexpected")) as typeof fetch;
    await expect(oauthFetch("http://auth.example/token", {}, executor)).rejects.toThrow(OAuthTransportError);
    expect(executor).not.toHaveBeenCalled();
  });

  test("rejects malformed or credential-bearing endpoint URLs without echoing them", async () => {
    const executor = mock(async () => new Response("unexpected")) as typeof fetch;
    for (const url of ["not-a-url?token=secret", "https://user:secret@127.0.0.1/token"]) {
      const error = await oauthFetch(url, {}, executor).then(() => undefined, value => value as Error);
      expect(error).toBeInstanceOf(OAuthTransportError);
      expect(error?.message).not.toContain("secret");
    }
    expect(executor).not.toHaveBeenCalled();
  });

  test("uses a bounded deadline and refuses redirects without exposing Location", async () => {
    let init: RequestInit | undefined;
    const executor = (async (_input: string | URL | Request, candidate?: RequestInit) => {
      init = candidate;
      return new Response(null, {
        status: 302,
        headers: { location: "https://attacker.example/?code=secret" },
      });
    }) as typeof fetch;
    const error = await oauthFetch("https://auth.example/token", { method: "POST" }, executor)
      .then(() => undefined, value => value as Error);
    expect(init?.redirect).toBe("manual");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(error?.message).toBe("OAuth endpoint refused the request (HTTP 302)");
    expect(error?.message).not.toContain("attacker");
    expect(error?.message).not.toContain("secret");
  });

  test("caps response bodies at one MiB", async () => {
    const executor = (async () => new Response(new Uint8Array(1024 * 1024 + 1))) as typeof fetch;
    await expect(oauthFetch("https://auth.example/token", {}, executor)).rejects.toThrow("response exceeded 1 MiB");
  });

  test("propagates caller cancellation", async () => {
    const controller = new AbortController();
    const executor = (async (_input: string | URL | Request, init?: RequestInit) => {
      controller.abort(new DOMException("cancelled", "AbortError"));
      throw init?.signal?.reason;
    }) as typeof fetch;
    await expect(oauthFetch("https://auth.example/token", { signal: controller.signal }, executor)).rejects.toMatchObject({ name: "AbortError" });
  });

  test("OAuth protocol modules do not bypass the shared transport", () => {
    const oauthDir = join(import.meta.dir, "..", "src", "oauth");
    const allowed = new Set(["transport.ts"]);
    const offenders = readdirSync(oauthDir)
      .filter(name => name.endsWith(".ts") && !allowed.has(name))
      .filter(name => /\bfetch\s*\(/.test(readFileSync(join(oauthDir, name), "utf8")));
    expect(offenders).toEqual([]);
  });
});
