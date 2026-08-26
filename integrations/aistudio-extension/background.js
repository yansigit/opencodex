// Background service worker for OpenCodex AI Studio Relay

async function ensureAiStudioTab() {
  try {
    const tabs = await chrome.tabs.query({ url: "*://aistudio.google.com/*" });
    if (tabs.length === 0) {
      await chrome.tabs.create({
        url: "https://aistudio.google.com",
        pinned: true,
        active: false
      });
    }
  } catch (err) {
    console.debug("[opencodex relay] ensure tab error:", err);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  ensureAiStudioTab();
});

chrome.runtime.onStartup.addListener(() => {
  ensureAiStudioTab();
});

chrome.action.onClicked?.addListener(() => {
  ensureAiStudioTab();
});

ensureAiStudioTab();

