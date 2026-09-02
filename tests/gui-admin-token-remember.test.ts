import { describe, expect, test } from "bun:test";
import { initializeManagementAuthState, issueGuiSession } from "../src/server/management-auth";
import type { OcxConfig } from "../src/types";

function cfg(): OcxConfig {
  return { port: 10100, defaultProvider: "openai", providers: {} } as OcxConfig;
}

describe("gui admin token remember + polish", () => {
  test("GUI session TTL is 30 minutes", () => {
    const config = cfg();
    const state = initializeManagementAuthState(config, "test-admin-token-12345678901234567890");
    expect(state.available).toBe(true);
    if (!state.available) return;
    const req = new Request("http://127.0.0.1:10100/", { headers: { host: "127.0.0.1:10100", origin: "http://127.0.0.1:10100" } });
    const session = issueGuiSession(req, config, state);
    expect(session).not.toBeNull();
    if (!session) return;
    const ttl = session.expiresAt - Date.now();
    expect(ttl).toBeGreaterThan(29 * 60_000);
    expect(ttl).toBeLessThan(31 * 60_000);
  });
});
