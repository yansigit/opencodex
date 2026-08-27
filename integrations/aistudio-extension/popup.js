function renderRelay() {
  chrome.storage.local.get(["relayStatus", "relayDetails", "proxyPort"], (data) => {
    const statusEl = document.getElementById("status");
    const detailsEl = document.getElementById("details");
    const isConnected = data.relayStatus === "connected";

    statusEl.textContent = isConnected ? "🟢 Connected" : "🔴 Disconnected";
    statusEl.className = "badge " + (isConnected ? "connected" : "disconnected");
    detailsEl.textContent = data.relayDetails || (isConnected ? "Relay active" : "Relay idle");
  });
}

async function harvestSession() {
  const statusEl = document.getElementById("exportStatus");
  statusEl.style.color = "#93c5fd";
  statusEl.textContent = "Extracting session cookies & storage...";

  // 1. Query Google cookies
  const allCookies = await chrome.cookies.getAll({ domain: "google.com" });
  const relevantCookies = allCookies.map(c => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path
  }));

  if (!relevantCookies.some(c => c.name === "SAPISID")) {
    throw new Error("SAPISID cookie not found. Please log in to aistudio.google.com in this browser.");
  }

  // 2. Query active AI Studio tab for localStorage & sessionStorage
  let selectedProject = "";
  let windowId = "";

  const tabs = await chrome.tabs.query({ url: "*://aistudio.google.com/*" });
  if (tabs.length > 0 && tabs[0]?.id) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tabs[0].id },
        func: () => ({
          selectedProject: localStorage.getItem("selectedProject") || "",
          windowId: sessionStorage.getItem("maker_suite_browser_window_id") || ""
        })
      });
      if (results?.[0]?.result) {
        selectedProject = results[0].result.selectedProject || "";
        windowId = results[0].result.windowId || "";
      }
    } catch (err) {
      void err;
    }
  }

  const bundleObj = {
    selectedProject,
    windowId,
    cookies: relevantCookies
  };

  const rawJson = JSON.stringify(bundleObj);
  const base64Token = btoa(unescape(encodeURIComponent(rawJson)));
  return { bundleObj, base64Token };
}

document.getElementById("btnCopyBundle")?.addEventListener("click", async () => {
  const statusEl = document.getElementById("exportStatus");
  try {
    const { base64Token } = await harvestSession();
    await navigator.clipboard.writeText(base64Token);
    statusEl.style.color = "#4ade80";
    statusEl.textContent = "✅ Session Token copied to clipboard!";
  } catch (err) {
    statusEl.style.color = "#f87171";
    statusEl.textContent = "❌ " + (err.message || String(err));
  }
});

document.getElementById("btnAutoSync")?.addEventListener("click", async () => {
  const statusEl = document.getElementById("exportStatus");
  try {
    const { bundleObj, base64Token } = await harvestSession();
    statusEl.textContent = "Syncing with local OpenCodex proxy...";

    const proxyApiKey = document.getElementById("proxyApiKey")?.value.trim();
    const headers = { "Content-Type": "application/json" };
    if (proxyApiKey) headers["x-opencodex-api-key"] = proxyApiKey;

    const { proxyPort } = await new Promise((resolve) => chrome.storage.local.get(["proxyPort"], resolve));
    const port = proxyPort || 10100;
    const res = await fetch(`http://127.0.0.1:${port}/api/aistudio/session`, {
      method: "POST",
      headers,
      body: JSON.stringify({ token: base64Token, ...bundleObj })
    });

    if (!res.ok) {
      throw new Error("Proxy returned HTTP " + res.status);
    }
    statusEl.style.color = "#4ade80";
    statusEl.textContent = "✅ Synced with OpenCodex successfully!";
  } catch (err) {
    statusEl.style.color = "#f87171";
    statusEl.textContent = "❌ Sync failed: " + (err.message || String(err)) + ". Use Copy button instead.";
  }
});

document.addEventListener("DOMContentLoaded", renderRelay);
chrome.storage?.onChanged?.addListener(renderRelay);
