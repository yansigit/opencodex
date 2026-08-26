function render() {
  chrome.storage.local.get(["relayStatus", "relayDetails", "proxyPort"], (data) => {
    const statusEl = document.getElementById("status");
    const detailsEl = document.getElementById("details");
    const isConnected = data.relayStatus === "connected";

    statusEl.textContent = isConnected ? "🟢 Connected" : "🔴 Disconnected";
    statusEl.className = "badge " + (isConnected ? "connected" : "disconnected");
    detailsEl.textContent = data.relayDetails || (isConnected ? "Relay active" : "Not connected to local opencodex");
  });
}

document.addEventListener("DOMContentLoaded", render);
chrome.storage.onChanged.addListener(render);

