/**
 * In-process WebSocket Relay Hub for Google AI Studio Web / Build sessions.
 */

export interface WsRelayRequest {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface WsRelayStreamResult {
  chunks: AsyncIterable<string>;
  status?: number;
  headers?: Record<string, string>;
}

export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

interface PendingStream {
  pushChunk(chunk: string): void;
  finish(): void;
  fail(err: Error): void;
}

export interface AiStudioRelayHub {
  hasActiveSessions(): boolean;
  getActiveSessionCount(): number;
  registerSession(id: string, ws: WebSocketLike): void;
  unregisterSession(id: string): void;
  dispatchStream(req: WsRelayRequest, signal?: AbortSignal): Promise<WsRelayStreamResult>;
  handleClientMessage(sessionId: string, raw: string): void;
}

export function createAiStudioRelayHub(): AiStudioRelayHub {
  const sessions = new Map<string, WebSocketLike>();
  const pendingRequests = new Map<string, PendingStream>();
  const pendingBySession = new Map<string, Set<string>>();
  let sessionRoundRobin = 0;

  function getNextSession(): { id: string; ws: WebSocketLike } | undefined {
    const arr = Array.from(sessions.values());
    if (arr.length === 0) return undefined;
    const id = Array.from(sessions.keys())[sessionRoundRobin % arr.length]!;
    const ws = sessions.get(id)!;
    sessionRoundRobin = (sessionRoundRobin + 1) % arr.length;
    return { id, ws };
  }

  return {
    hasActiveSessions() {
      return sessions.size > 0;
    },

    getActiveSessionCount() {
      return sessions.size;
    },

    registerSession(id: string, ws: WebSocketLike) {
      sessions.set(id, ws);
      console.log(`[AIStudioHub] registered session: ${id}, total: ${sessions.size}`);
    },

    unregisterSession(id: string) {
      sessions.delete(id);
      console.log(`[AIStudioHub] unregistered session: ${id}, remaining: ${sessions.size}`);
      const requestIds = pendingBySession.get(id);
      if (!requestIds) return;
      for (const requestId of requestIds) {
        pendingRequests.get(requestId)?.fail(new Error("Google AI Studio browser session disconnected"));
      }
      pendingBySession.delete(id);
    },

    async dispatchStream(req: WsRelayRequest, signal?: AbortSignal): Promise<WsRelayStreamResult> {
      const session = getNextSession();
      if (!session) {
        throw new Error("No active Google AI Studio browser session connected. Open the AI Studio bridge in your browser to start.");
      }
      const { id: sessionId, ws } = session;

      const reqId = `req_${crypto.randomUUID()}`;
      const chunkQueue: string[] = [];
      let resolveNextChunk: ((value: IteratorResult<string>) => void) | null = null;
      let rejectNextChunk: ((err: Error) => void) | null = null;
      let isFinished = false;
      let finishError: Error | null = null;

      const pending: PendingStream = {
        pushChunk(chunk: string) {
          if (isFinished) return;
          if (resolveNextChunk) {
            const r = resolveNextChunk;
            resolveNextChunk = null;
            rejectNextChunk = null;
            r({ value: chunk, done: false });
          } else {
            chunkQueue.push(chunk);
          }
        },
        finish() {
          if (isFinished) return;
          isFinished = true;
          pendingRequests.delete(reqId);
          pendingBySession.get(sessionId)?.delete(reqId);
          if (resolveNextChunk) {
            const r = resolveNextChunk;
            resolveNextChunk = null;
            rejectNextChunk = null;
            r({ value: undefined as any, done: true });
          }
        },
        fail(err: Error) {
          if (isFinished) return;
          isFinished = true;
          finishError = err;
          pendingRequests.delete(reqId);
          pendingBySession.get(sessionId)?.delete(reqId);
          if (rejectNextChunk) {
            const r = rejectNextChunk;
            resolveNextChunk = null;
            rejectNextChunk = null;
            r(err);
          }
        },
      };

      pendingRequests.set(reqId, pending);
      const requestIds = pendingBySession.get(sessionId) ?? new Set<string>();
      requestIds.add(reqId);
      pendingBySession.set(sessionId, requestIds);

      if (signal) {
        signal.addEventListener("abort", () => {
          try {
            ws.send(JSON.stringify({ id: reqId, type: "abort" }));
          } catch (err) {
            void err;
          }
          pending.fail(new Error("Request aborted by client"));
        });
      }

      const msg = {
        id: reqId,
        type: "http_request",
        payload: {
          url: req.url,
          method: req.method,
          headers: req.headers ?? {},
          body: req.body ?? "",
        },
      };

      ws.send(JSON.stringify(msg));

      const asyncIterable: AsyncIterable<string> = {
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<string>> {
              if (chunkQueue.length > 0) {
                return { value: chunkQueue.shift()!, done: false };
              }
              if (isFinished) {
                if (finishError) throw finishError;
                return { value: undefined as any, done: true };
              }
              return new Promise<IteratorResult<string>>((resolve, reject) => {
                resolveNextChunk = resolve;
                rejectNextChunk = reject;
              });
            },
          };
        },
      };

      return { chunks: asyncIterable };
    },

    handleClientMessage(sessionId: string, raw: string) {
      let data: any;
      try {
        data = JSON.parse(raw);
      } catch (err) {
        void err;
        return;
      }

      const { id, type, payload } = data || {};
      if (!id) return;

      const pending = pendingRequests.get(id);
      if (!pending || !pendingBySession.get(sessionId)?.has(id)) return;

      if (type === "stream_chunk") {
        if (payload?.data) {
          pending.pushChunk(payload.data);
        }
      } else if (type === "stream_end" || type === "http_response") {
        if (payload?.body) {
          pending.pushChunk(payload.body);
        }
        pending.finish();
      } else if (type === "error") {
        console.log(`[AIStudioHub] client error from ${sessionId}:`, payload?.error);
        pending.fail(new Error(payload?.error || "Upstream AI Studio error"));
      }
    },
  };
}

export const globalAiStudioRelayHub = createAiStudioRelayHub();

export function getAiStudioUserScript(listenPort: number): string {
  return `// ==UserScript==
// @name         OpenCodex AI Studio Relay Bridge
// @namespace    https://opencodex.dev/
// @version      1.0.0
// @description  Relays requests from opencodex to Google AI Studio session
// @match        https://aistudio.google.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function() {
  'use strict';
  const WS_URL = "ws://127.0.0.1:${listenPort}/v1/ws/aistudio";
  let ws;
  function connect() {
    try { ws = new WebSocket(WS_URL); } catch { setTimeout(connect, 3000); return; }
    ws.onmessage = async (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === "http_request") {
          const { id, payload } = msg;
          try {
            const res = await fetch(payload.url, { method: payload.method, headers: payload.headers, body: payload.body, credentials: "include" });
            if (payload.url.includes("streamGenerateContent") && res.body) {
              const reader = res.body.getReader();
              const decoder = new TextDecoder();
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                ws.send(JSON.stringify({ id, type: "stream_chunk", payload: { data: decoder.decode(value, { stream: true }) } }));
              }
              ws.send(JSON.stringify({ id, type: "stream_end", payload: {} }));
            } else {
              const text = await res.text();
              ws.send(JSON.stringify({ id, type: "http_response", payload: { body: text, status: res.status } }));
            }
          } catch (err) {
            ws.send(JSON.stringify({ id, type: "error", payload: { error: String(err) } }));
          }
        }
      } catch (err) {
        void err;
      }
    };
    ws.onclose = () => setTimeout(connect, 3000);
  }
  connect();
})();
`;
}

export function getAiStudioBridgeHtml(listenPort: number): string {
  const extensionPath = typeof process !== "undefined" ? process.cwd() + "/integrations/aistudio-extension" : "integrations/aistudio-extension";
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Google AI Studio Bridge</title><style>body{font-family:system-ui,-apple-system,sans-serif;background:#121316;color:#e1e3e6;padding:2rem;max-width:680px;margin:auto;line-height:1.5}.card{background:#1e1f23;border:1px solid #2d2f34;border-radius:8px;padding:1.5rem;margin-bottom:1.5rem}.status{display:inline-block;padding:0.25rem 0.75rem;border-radius:4px;font-weight:500}.connected{background:#163820;color:#4ade80}.disconnected{background:#3b1717;color:#f87171}code{background:#2a2c31;padding:0.2rem 0.4rem;border-radius:4px}.btn{display:inline-block;padding:0.5rem 1rem;background:#3b82f6;color:#fff;text-decoration:none;border-radius:6px;font-weight:500;margin-top:0.5rem}pre{background:#16171a;padding:1rem;border-radius:6px;overflow-x:auto;font-size:0.85rem}</style></head><body><div class="card"><h2>Google AI Studio Bridge</h2><p>Status: <span id="status" class="status disconnected">Connecting...</span></p><p>This bridge connects <code>opencodex</code> with your active Google AI Studio / Google AI Pro session.</p></div><div class="card"><h3>🧩 Option 1: Unpacked Extension for Brave / Chrome (Zero Tab Overhead)</h3><p>Run entirely in the background without needing an active browser tab:</p><ol style="padding-left:1.2rem;margin:0.5rem 0"><li>Open <code>brave://extensions</code> (or <code>chrome://extensions</code>) and toggle <strong>Developer mode</strong> in the top-right.</li><li>Click <strong>Load unpacked</strong> and select this directory:<br><code id="ext-path">${extensionPath}</code></li></ol><button class="btn" style="cursor:pointer" onclick="navigator.clipboard.writeText(document.getElementById('ext-path').textContent);this.textContent='Copied!'">📋 Copy Extension Directory Path</button></div><div class="card"><h3>🌐 Option 2: Userscript (Tampermonkey) or Console</h3><p>Install via Tampermonkey/Violentmonkey or paste in Developer Tools Console:</p><p><a class="btn" href="/aistudio/bridge.user.js">⚡ Install Userscript</a> <a class="btn" style="background:#374151;margin-left:0.5rem" href="https://aistudio.google.com" target="_blank">Open aistudio.google.com ↗</a></p><pre style="margin-top:1rem"><code>const ws=new WebSocket('ws://127.0.0.1:${listenPort}/v1/ws/aistudio');ws.onmessage=async(e)=>{const{id,payload,type}=JSON.parse(e.data);if(type==='http_request'){try{const res=await fetch(payload.url,{method:payload.method,headers:payload.headers,body:payload.body,credentials:'include'});if(payload.url.includes('streamGenerateContent')&&res.body){const r=res.body.getReader(),d=new TextDecoder();while(true){const{done,value}=await r.read();if(done)break;ws.send(JSON.stringify({id,type:'stream_chunk',payload:{data:d.decode(value,{stream:true})}}))}ws.send(JSON.stringify({id,type:'stream_end',payload:{}}))}else{const body=await res.text();ws.send(JSON.stringify({id,type:'http_response',payload:{body,status:res.status}}))}}catch(err){ws.send(JSON.stringify({id,type:'error',payload:{error:String(err)}}))}}};console.log('opencodex AI Studio relay active!');</code></pre></div><script>let ws;const statusEl=document.getElementById("status");function connect(){const proto=location.protocol==="https:"?"wss:":"ws:";ws=new WebSocket(proto+"//"+location.host+"/v1/ws/aistudio");ws.onopen=()=>{statusEl.textContent="🟢 Connected (Relay Active)";statusEl.className="status connected"};ws.onclose=()=>{statusEl.textContent="🔴 Disconnected (Retrying...)";statusEl.className="status disconnected";setTimeout(connect,2000)}};connect()</script></body></html>`;
}
