// Offscreen persistent relay worker for OpenCodex AI Studio Relay
const DEFAULT_PORT = 10100;
let ws = null;
let reconnectTimer = null;
const activeAbortControllers = new Map();

function updateStatus(status, details = "") {
  try {
      if (typeof chrome !== "undefined" && chrome.storage?.local) {
        chrome.storage.local.set({ relayStatus: status, relayDetails: details, lastSeen: Date.now() });
      }
    } catch (err) {
      void err;
    }
  }

  async function getPort() {
    try {
      if (typeof chrome !== "undefined" && chrome.storage?.local) {
        const data = await chrome.storage.local.get(["proxyPort"]);
        const port = Number(data?.proxyPort);
        if (Number.isInteger(port) && port > 0 && port < 65536) return port;
      }
    } catch (err) {
      void err;
    }
  return DEFAULT_PORT;
}

function stripForbiddenHeaders(headers) {
  const forbidden = new Set(["accept-charset", "accept-encoding", "access-control-request-headers", "access-control-request-method", "connection", "content-length", "cookie", "cookie2", "date", "dnt", "expect", "host", "keep-alive", "origin", "proxy-connection", "referer", "te", "trailer", "transfer-encoding", "upgrade", "via"]);
  return Object.fromEntries(Object.entries(headers || {}).filter(([name]) => !forbidden.has(name.toLowerCase()) && !name.toLowerCase().startsWith("sec-")));
}

async function connect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  const port = await getPort();
  const wsUrl = `ws://127.0.0.1:${port}/v1/ws/aistudio`;

  try {
    ws = new WebSocket(wsUrl);
  } catch (err) {
    updateStatus("disconnected", String(err));
    reconnectTimer = setTimeout(connect, 3000);
    return;
  }

  ws.onopen = () => {
    updateStatus("connected", `Connected to opencodex on port ${port}`);
  };

  ws.onmessage = async (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch (err) {
      void err;
      return;
    }

    const { id, type, payload } = msg || {};
    if (!id) return;

    if (type === "abort") {
      const controller = activeAbortControllers.get(id);
      if (controller) {
        controller.abort();
        activeAbortControllers.delete(id);
      }
      return;
    }

    if (type === "http_request") {
      const controller = new AbortController();
      activeAbortControllers.set(id, controller);

      const fetchOpts = {
        method: payload.method,
        credentials: "include",
        signal: controller.signal
        };
        if (payload.headers) {
        fetchOpts.headers = stripForbiddenHeaders(payload.headers);
        }
      if (payload.method !== "GET" && payload.method !== "HEAD" && payload.body !== undefined) {
        fetchOpts.body = payload.body;
      }
      try {
        const res = await fetch(payload.url, fetchOpts);

        if (payload.url.includes("streamGenerateContent") && res.body) {
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            ws.send(JSON.stringify({
              id,
              type: "stream_chunk",
              payload: { data: decoder.decode(value, { stream: true }) }
            }));
          }
          ws.send(JSON.stringify({ id, type: "stream_end", payload: {} }));
        } else {
          const text = await res.text();
          ws.send(JSON.stringify({
            id,
            type: "http_response",
            payload: { body: text, status: res.status }
          }));
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          ws.send(JSON.stringify({
            id,
            type: "error",
            payload: { error: String(err) }
          }));
        }
      } finally {
        activeAbortControllers.delete(id);
      }
    }
  };

  ws.onclose = () => {
    updateStatus("disconnected", "Connection lost, reconnecting...");
    reconnectTimer = setTimeout(connect, 3000);
  };

  ws.onerror = () => {
    try { ws.close(); } catch (closeErr) { void closeErr; }
  };
}

// Start connection
connect();
