import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DIRECTIVE_KEY_FILE, getDirectiveKeyPath, getOrCreateDirectiveSigningKey } from "../../src/claude/directive-key";
import { canonicalDirectivePayload, signDirective, verifyDirectiveSignature } from "../../src/claude/directive-sign";
import { buildClaudeAgentDefs, syncClaudeAgentDefs } from "../../src/claude/agents-inject";
import { AnthropicRequestError, extractSignedDirective, verifyAndExtractDirectives } from "../../src/claude/inbound";
import { handleClaudeMessages, handleClaudeCountTokens } from "../../src/server/claude-messages";
import type { OcxConfig, RequestLogContext } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import * as windowsAcl from "../../src/lib/windows-secret-acl";

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "ocx-dir-auth-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) removeTreeWithRetry(d);
});

function cfg(extra?: Partial<OcxConfig>): OcxConfig {
  return { port: 10100, defaultProvider: "mock", providers: {}, ...extra } as OcxConfig;
}

describe("directive signing key management (src/claude/directive-key.ts)", () => {
  test("creates a dedicated 64-hex-char key file with 0600 owner-only permissions", () => {
    const dir = tempDir();
    const key = getOrCreateDirectiveSigningKey(dir);
    expect(key).toMatch(/^[0-9a-f]{64}$/);

    const keyPath = getDirectiveKeyPath(dir);
    expect(keyPath).toBe(join(dir, DIRECTIVE_KEY_FILE));
    const stat = lstatSync(keyPath);
    expect(stat.isFile()).toBe(true);
    expect(stat.isSymbolicLink()).toBe(false);
    if (process.platform !== "win32") {
      expect(stat.mode & 0o777).toBe(0o600);
    }
    const onDisk = readFileSync(keyPath, "utf8").trim();
    expect(onDisk).toBe(key);

    // Subsequent calls return the same key without re-generating
    const reloaded = getOrCreateDirectiveSigningKey(dir);
    expect(reloaded).toBe(key);
  });

  test("fixes permissive permissions to 0600 on non-Windows", () => {
    if (process.platform === "win32") return;
    const dir = tempDir();
    const key = getOrCreateDirectiveSigningKey(dir);
    const keyPath = getDirectiveKeyPath(dir);
    chmodSync(keyPath, 0o644);
    expect(lstatSync(keyPath).mode & 0o777).toBe(0o644);

    const readKey = getOrCreateDirectiveSigningKey(dir);
    expect(readKey).toBe(key);
    expect(lstatSync(keyPath).mode & 0o777).toBe(0o600);
  });

  test("fails closed when an existing Windows key ACL cannot be verified", () => {
    const dir = tempDir();
    const key = getOrCreateDirectiveSigningKey(dir);
    const originalPlatform = process.platform;
    const hardenSpy = spyOn(windowsAcl, "hardenSecretPath").mockReturnValue({
      ok: false,
      diagnostics: "ACL unavailable",
    });
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      expect(() => getOrCreateDirectiveSigningKey(dir)).toThrow(/ACL hardening could not be verified/);
      expect(hardenSpy).toHaveBeenCalledWith(getDirectiveKeyPath(dir), { required: false });
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
      hardenSpy.mockRestore();
    }
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  test("refuses symlinked key files", () => {
    const dir = tempDir();
    const realKeyFile = join(dir, "other-key");
    writeFileSync(realKeyFile, "a".repeat(64) + "\n");
    const symlinkPath = getDirectiveKeyPath(dir);
    try {
      symlinkSync(realKeyFile, symlinkPath);
    } catch {
      return; // Windows without symlink privileges
    }
    expect(() => getOrCreateDirectiveSigningKey(dir)).toThrow(/refusing to follow symlinked/);
  });
});

describe("directive signing and verification (src/claude/directive-sign.ts)", () => {
  const key = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

  test("canonical payload serializes version, route, and optional effort", () => {
    expect(canonicalDirectivePayload("mock/model")).toBe("v1:mock/model:");
    expect(canonicalDirectivePayload(" mock/model ", "high")).toBe("v1:mock/model:high");
    expect(canonicalDirectivePayload("mock/model", null)).toBe("v1:mock/model:");
  });

  test("computes HMAC-SHA256 and verifies successfully with timingSafeEqual", () => {
    const sig = signDirective("mock/model", "max", key);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyDirectiveSignature("mock/model", "max", sig, key)).toBe(true);
    expect(verifyDirectiveSignature("mock/model", "low", sig, key)).toBe(false);
    expect(verifyDirectiveSignature("other/model", "max", sig, key)).toBe(false);
    expect(verifyDirectiveSignature("mock/model", "max", "invalid-sig", key)).toBe(false);
  });
});

describe("agent injection with ocx-sig (src/claude/agents-inject.ts)", () => {
  test("generated agent definition contains valid ocx-sig comment", () => {
    const ocxDir = tempDir();
    const claudeDir = tempDir();
    const key = getOrCreateDirectiveSigningKey(ocxDir);

    const config = cfg({
      subagentModels: ["gpt-5.6-sol"],
      claudeCode: { subagentEffort: "high" },
    });
    const defs = buildClaudeAgentDefs(config, {}, claudeDir);
    syncClaudeAgentDefs(defs, claudeDir, ocxDir);

    const agentBody = readFileSync(join(claudeDir, "agents", defs[0]!.file), "utf8");
    expect(agentBody).toContain("<!-- ocx-route: ");
    expect(agentBody).toContain("<!-- ocx-effort: high -->");
    expect(agentBody).toContain("<!-- ocx-sig: v1:");

    const extracted = extractSignedDirective({ system: agentBody });
    expect(extracted.route).toBe(defs[0]!.model);
    expect(extracted.effort).toBe("high");
    expect(extracted.version).toBe("v1");
    expect(extracted.signature).toBeTruthy();

    const verified = verifyAndExtractDirectives({ system: agentBody }, key);
    expect(verified.isSigned).toBe(true);
    expect(verified.route).toBe(defs[0]!.model);
    expect(verified.effort).toBe("high");
  });
});

describe("fail-closed directive verification (src/claude/inbound.ts)", () => {
  const key = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

  test("valid signed directive passes verification", () => {
    const sig = signDirective("anthropic/claude-sonnet-4-6", "medium", key);
    const body = {
      system: [
        { type: "text", text: "<!-- ocx-route: anthropic/claude-sonnet-4-6 -->" },
        { type: "text", text: "<!-- ocx-effort: medium -->" },
        { type: "text", text: `<!-- ocx-sig: v1:${sig} -->` },
      ],
    };
    const res = verifyAndExtractDirectives(body, key);
    expect(res.isSigned).toBe(true);
    expect(res.route).toBe("anthropic/claude-sonnet-4-6");
    expect(res.effort).toBe("medium");
  });

  test("tampered route value fails closed with AnthropicRequestError", () => {
    const sig = signDirective("anthropic/claude-sonnet-4-6", "medium", key);
    const body = {
      system: `<!-- ocx-route: malicious/model -->\n<!-- ocx-effort: medium -->\n<!-- ocx-sig: v1:${sig} -->`,
    };
    expect(() => verifyAndExtractDirectives(body, key)).toThrow(AnthropicRequestError);
    expect(() => verifyAndExtractDirectives(body, key)).toThrow(/signature verification failed/);
  });

  test("tampered effort value fails closed with AnthropicRequestError", () => {
    const sig = signDirective("anthropic/claude-sonnet-4-6", "low", key);
    const body = {
      system: `<!-- ocx-route: anthropic/claude-sonnet-4-6 -->\n<!-- ocx-effort: max -->\n<!-- ocx-sig: v1:${sig} -->`,
    };
    expect(() => verifyAndExtractDirectives(body, key)).toThrow(AnthropicRequestError);
    expect(() => verifyAndExtractDirectives(body, key)).toThrow(/signature verification failed/);
  });

  test("corrupted signature fails closed with AnthropicRequestError", () => {
    const sig = signDirective("anthropic/claude-sonnet-4-6", "low", key);
    const corrupted = "0" + sig.slice(1);
    const body = {
      system: `<!-- ocx-route: anthropic/claude-sonnet-4-6 -->\n<!-- ocx-effort: low -->\n<!-- ocx-sig: v1:${corrupted} -->`,
    };
    expect(() => verifyAndExtractDirectives(body, key)).toThrow(AnthropicRequestError);
    expect(() => verifyAndExtractDirectives(body, key)).toThrow(/signature verification failed/);
  });

  test("unsupported version fails closed with AnthropicRequestError", () => {
    const sig = signDirective("anthropic/claude-sonnet-4-6", "low", key);
    const body = {
      system: `<!-- ocx-route: anthropic/claude-sonnet-4-6 -->\n<!-- ocx-effort: low -->\n<!-- ocx-sig: v99:${sig} -->`,
    };
    expect(() => verifyAndExtractDirectives(body, key)).toThrow(AnthropicRequestError);
    expect(() => verifyAndExtractDirectives(body, key)).toThrow(/unsupported signed subagent directive version/);
  });

  test("missing route with signature fails closed with AnthropicRequestError", () => {
    const sig = signDirective("anthropic/claude-sonnet-4-6", "low", key);
    const body = {
      system: `<!-- ocx-sig: v1:${sig} -->`,
    };
    expect(() => verifyAndExtractDirectives(body, key)).toThrow(AnthropicRequestError);
    expect(() => verifyAndExtractDirectives(body, key)).toThrow(/missing route/);
  });

  test("multiple or conflicting directives fail closed with AnthropicRequestError", () => {
    const sig = signDirective("anthropic/claude-sonnet-4-6", "low", key);
    const body = {
      system: [
        { type: "text", text: "<!-- ocx-route: model-a -->" },
        { type: "text", text: "<!-- ocx-route: model-b -->" },
        { type: "text", text: `<!-- ocx-sig: v1:${sig} -->` },
      ],
    };
    expect(() => verifyAndExtractDirectives(body, key)).toThrow(AnthropicRequestError);
    expect(() => verifyAndExtractDirectives(body, key)).toThrow(/conflicting subagent directives/);
  });

  test("unsigned ocx-effort without ocx-route is ignored", () => {
    const body = { system: "<!-- ocx-effort: max -->" };
    const res = verifyAndExtractDirectives(body, key);
    expect(res.route).toBeNull();
    expect(res.effort).toBeNull();
    expect(res.isSigned).toBe(false);
  });
});

describe("server endpoint fail-closed consistency (src/server/claude-messages.ts)", () => {
  test("/v1/messages/count_tokens rejects invalid signed directive with HTTP 400", async () => {
    const config = cfg();
    const req = new Request("http://localhost/v1/messages/count_tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        system: "<!-- ocx-route: evil/model -->\n<!-- ocx-sig: v1:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef -->",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    const res = await handleClaudeCountTokens(req, config);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { type: string; message: string } };
    expect(json.error.type).toBe("invalid_request_error");
    expect(json.error.message).toContain("signature verification failed");
  });

  test("/v1/messages rejects invalid signed directive with HTTP 400 before dispatch", async () => {
    const config = cfg();
    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "placeholder",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 16,
        system: "<!-- ocx-route: evil/model -->\n<!-- ocx-sig: v1:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef -->",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    const logCtx = { model: "unknown", provider: "unknown", inboundProtocol: "messages" } as RequestLogContext;
    const res = await handleClaudeMessages(req, config, logCtx);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { type: string; message: string } };
    expect(json.error.type).toBe("invalid_request_error");
    expect(json.error.message).toContain("signature verification failed");
  });
});
