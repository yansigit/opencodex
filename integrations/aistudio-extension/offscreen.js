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
  } catch {}
}

async function getPort() {
  try {
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      const data = await chrome.storage.local.get(["proxyPort"]);
      if (data?.proxyPort) return Number(data.proxyPort);
    }
  } catch {}
  return DEFAULT_PORT;
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
    } catch {
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

      try {
        const res = await fetch(payload.url, {
          method: payload.method,
          headers: payload.headers,
          body: payload.body,
          credentials: "include",
          signal: controller.signal
        });

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
    try { ws.close(); } catch {}
  };
}

// Start connection
connect();

