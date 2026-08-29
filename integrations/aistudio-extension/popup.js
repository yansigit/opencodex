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

function getValidatedPort() {
  const portInput = document.getElementById("proxyPort");
  const raw = parseInt(portInput?.value || "", 10);
  if (Number.isInteger(raw) && raw >= 1 && raw <= 65535) {
    return raw;
  }
  return 10100;
}

function savePort() {
  const port = getValidatedPort();
  chrome.storage?.local?.set({ proxyPort: port });
}

document.getElementById("btnCopyBundle")?.addEventListener("click", async () => {
  const statusEl = document.getElementById("exportStatus");
  try {
    savePort();
    const { base64Token } = await harvestSession();
    await navigator.clipboard.writeText(base64Token);
    statusEl.style.color = "#4ade80";
    statusEl.textContent = "w^~)u Session Token copied to clipboard!";
  } catch (err) {
    statusEl.style.color = "#f87171";
    statusEl.textContent = "w^~)t " + (err.message || String(err));
  }
});

document.getElementById("btnAutoSync")?.addEventListener("click", async () => {
  const statusEl = document.getElementById("exportStatus");
  try {
    savePort();
    const proxyApiKey = document.getElementById("proxyApiKey")?.value.trim();
    if (!proxyApiKey) throw new Error("Proxy API key is required for Auto-Sync");
    const { bundleObj, base64Token } = await harvestSession();
    statusEl.textContent = "Syncing with local OpenCodex proxy...";

    const headers = {
      "Content-Type": "application/json",
      "x-opencodex-api-key": proxyApiKey,
    };

    const port = getValidatedPort();
    const res = await fetch(`http://127.0.0.1:${port}/api/aistudio/session`, {
      method: "POST",
      headers,
      body: JSON.stringify({ token: base64Token, ...bundleObj })
    });

    if (!res.ok) {
      throw new Error("Proxy returned HTTP " + res.status);
    }
    statusEl.style.color = "#4ade80";
    statusEl.textContent = "yy Synced with OpenCodex successfully!";
  } catch (err) {
    statusEl.style.color = "#f87171";
    statusEl.textContent = "Sync failed: " + (err.message || String(err)) + ". Use Copy button instead.";
  }
});

document.getElementById("proxyPort")?.addEventListener("change", savePort);

document.addEventListener("DOMContentLoaded", () => {
  chrome.storage?.local?.get(["proxyPort"], (data) => {
    const portEl = document.getElementById("proxyPort");
    if (portEl) {
      portEl.value = (data && data.proxyPort) ? data.proxyPort : 10100;
    }
  });
  const extensionId = document.getElementById("extensionId");
  if (extensionId) extensionId.textContent = `chrome-extension://${chrome.runtime.id}`;
});
