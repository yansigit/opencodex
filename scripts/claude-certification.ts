#!/usr/bin/env bun
/** Conservative Claude Code certification runner.
 * Hermetic mode is local-only and never uses the operator's credentials. Live mode is
 * intentionally a fail-closed scaffold until a reviewed billing-safe harness exists.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";

const MODEL = "claude-cert-hermetic";
const MAX_OUTPUT = 256 * 1024;
const TIMEOUT_MS = 45_000;
const CREDENTIAL = /(?:API_KEY|API_TOKEN|AUTH_TOKEN|ACCESS_TOKEN|SECRET|PASSWORD|TOKEN)/i;
const PROXY = /^(?:HTTP|HTTPS|ALL)_PROXY$/i;

export type CertificationStatus = "live_pass" | "live_fail" | "skipped" | "hermetic_pass" | "hermetic_fail";
export interface CertificationReport {
  mode: "hermetic" | "live";
  status: CertificationStatus;
  cliPresent: boolean;
  streaming: boolean;
  toolContinuation: boolean;
  requests: number;
  reason?: string;
}

export function sanitizedChildEnv(base: Record<string, string | undefined>, dirs: { home: string; claude: string; ocx: string }): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && !CREDENTIAL.test(key) && !PROXY.test(key) && key !== "OPENCODEX_HOME" && key !== "CLAUDE_CONFIG_DIR") out[key] = value;
  }
  out.HOME = dirs.home;
  out.CLAUDE_CONFIG_DIR = dirs.claude;
  out.OPENCODEX_HOME = dirs.ocx;
  out.NO_PROXY = "127.0.0.1,localhost,::1";
  out.ANTHROPIC_API_KEY = "hermetic-cert-key";
  out.ANTHROPIC_AUTH_TOKEN = "hermetic-cert-key";
  out.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  return out;
}

async function readBounded(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  try { while (true) { const n = await reader.read(); if (n.done) break; total += n.value.byteLength; if (total > MAX_OUTPUT) throw new Error("output limit exceeded"); chunks.push(n.value); } }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total); let offset = 0; for (const c of chunks) { bytes.set(c, offset); offset += c.byteLength; }
  return new TextDecoder().decode(bytes);
}

async function command(exe: string, args: string[], cwd: string, env: Record<string, string>): Promise<{ code: number; out: string; err: string }> {
  let child: ReturnType<typeof Bun.spawn>;
  try { child = Bun.spawn([exe, ...args], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" }); }
  catch { throw new Error("Claude Code CLI is not installed"); }
  let timedOut = false; const timer = setTimeout(() => { timedOut = true; child.kill(); }, TIMEOUT_MS);
  try { const [code, out, err] = await Promise.all([child.exited, readBounded(child.stdout), readBounded(child.stderr)]); if (timedOut) throw new Error("Claude Code CLI timed out"); return { code, out, err }; }
  finally { clearTimeout(timer); }
}

function config(baseUrl: string): OcxConfig {
  return { port: 0, hostname: "127.0.0.1", defaultProvider: "claude-cert", providers: { "claude-cert": { adapter: "anthropic", baseUrl, authMode: "key", apiKey: "hermetic-cert-key", allowPrivateNetwork: true, liveModels: false, models: [MODEL], retry: { maxAttempts: 1 } } } } as OcxConfig;
}

function sse(events: unknown[]): Response { return new Response(events.map(e => `event: message_start\ndata: ${JSON.stringify(e)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } }); }

export async function runHermetic(cli = process.env.CLAUDE_BIN?.trim() || "claude"): Promise<CertificationReport> {
  const root = mkdtempSync(join(tmpdir(), "ocx-claude-cert-")); const dirs = { home: join(root, "home"), claude: join(root, "claude"), ocx: join(root, "ocx") };
  Object.values(dirs).forEach(d => mkdirSync(d, { recursive: true, mode: 0o700 }));
  const requests: unknown[] = []; let upstream: ReturnType<typeof Bun.serve> | undefined; let proxy: ReturnType<typeof startServer> | undefined;
  const previousOcxHome = process.env.OPENCODEX_HOME;
  try {
    upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) { if (new URL(req.url).pathname !== "/v1/messages") return new Response("not found", { status: 404 }); requests.push(await req.json()); const first = requests.length === 1; return sse(first ? [{ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "cert_tool", name: "cert_marker", input: {} } }, { type: "content_block_stop", index: 0 }, { type: "message_stop", stop_reason: "tool_use" }] : [{ type: "content_block_start", index: 0, content_block: { type: "text", text: "CLAUDE_CERT_OK" } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "CLAUDE_CERT_OK" } }, { type: "content_block_stop", index: 0 }, { type: "message_stop", stop_reason: "end_turn" }]); } });
    process.env.OPENCODEX_HOME = dirs.ocx; saveConfig(config(new URL("/v1", upstream.url).toString())); proxy = startServer(0);
    const env = sanitizedChildEnv(process.env, dirs); env.ANTHROPIC_BASE_URL = new URL("/v1", proxy.url).toString(); env.ANTHROPIC_MODEL = MODEL;
    let result; try { result = await command(cli, ["-p", "Use cert_marker, then print the marker.", "--output-format", "text"], root, env); } catch (error) { return { mode: "hermetic", status: "skipped", cliPresent: false, streaming: false, toolContinuation: false, requests: 0, reason: error instanceof Error ? error.message : "Claude Code CLI unavailable" }; }
    const text = `${result.out}\n${result.err}`; const streaming = requests.length > 0; const toolContinuation = requests.length >= 2;
    return { mode: "hermetic", status: result.code === 0 && text.includes("CLAUDE_CERT_OK") && streaming && toolContinuation ? "hermetic_pass" : "hermetic_fail", cliPresent: true, streaming, toolContinuation, requests: requests.length, reason: result.code === 0 ? undefined : "Claude Code exited non-zero" };
  } finally { if (proxy) await proxy.stop(true); upstream?.stop(true); if (previousOcxHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previousOcxHome; rmSync(root, { recursive: true, force: true }); }
}

export function evaluateLivePolicy(args: { confirmFlag: boolean; allowEnv: boolean }): CertificationReport {
  if (!args.confirmFlag || !args.allowEnv) return { mode: "live", status: "skipped", cliPresent: false, streaming: false, toolContinuation: false, requests: 0, reason: "live certification requires --confirm-live-provider-charges and OCX_ALLOW_CLAUDE_LIVE_CERT=1" };
  return { mode: "live", status: "live_fail", cliPresent: false, streaming: false, toolContinuation: false, requests: 0, reason: "live inference harness is not enabled; no provider call was attempted" };
}

async function main() {
  const args = process.argv.slice(2); const live = args.includes("--live"); const json = args.includes("--json");
  const report = live ? evaluateLivePolicy({ confirmFlag: args.includes("--confirm-live-provider-charges"), allowEnv: process.env.OCX_ALLOW_CLAUDE_LIVE_CERT === "1" }) : await runHermetic();
  console.log(json ? JSON.stringify(report) : `${report.status}: ${report.reason ?? "ok"}`); process.exitCode = report.status.endsWith("fail") ? 1 : 0;
}
if (import.meta.main) await main();
