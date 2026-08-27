// Content script for OpenCodex AI Studio Relay
// Runs natively inside https://aistudio.google.com/*

(function() {
  'use strict';
  const WS_URL = "ws://127.0.0.1:10100/v1/ws/aistudio";
  let ws = null;
  let retryTimer = null;
  const activeAbortControllers = new Map();

  function log(...args) {
    console.log("[opencodex relay]", ...args);
  }

  function updateStatus(status) {
    try {
      if (typeof chrome !== "undefined" && chrome.storage?.local) {
        chrome.storage.local.set({ relayStatus: status, lastSeen: Date.now() });
      }
    } catch (err) {
      void err;
    }
  }

  function connect() {
    if (retryTimer) clearTimeout(retryTimer);
    try {
      ws = new WebSocket(WS_URL);
    } catch (e) {
      updateStatus("disconnected");
      retryTimer = setTimeout(connect, 3000);
      return;
    }

    ws.onopen = () => {
      log("AI Studio tab connected to local opencodex hub!");
      updateStatus("connected");
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
          const h = { ...payload.headers };
          delete h["cookie"]; delete h["Cookie"];
          delete h["origin"]; delete h["Origin"];
          delete h["referer"]; delete h["Referer"];
          fetchOpts.headers = h;
        }
        if (payload.method !== "GET" && payload.method !== "HEAD" && payload.body) {
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
            log("Relay fetch error:", err);
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
      updateStatus("disconnected");
      retryTimer = setTimeout(connect, 3000);
    };

    ws.onerror = () => {
      try { ws.close(); } catch (closeErr) { void closeErr; }
    };
  }

  connect();
})();
