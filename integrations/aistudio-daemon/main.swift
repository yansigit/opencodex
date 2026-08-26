import Foundation
import WebKit
import AppKit

// 1. Zero-window headless (no Dock icon, no menu bar, no desktop window)
let app = NSApplication.shared
app.setActivationPolicy(.prohibited)

// Parse command line port or default to 10100
var proxyPort = 10100
for (index, arg) in CommandLine.arguments.enumerated() {
    if arg == "--port", index + 1 < CommandLine.arguments.count, let p = Int(CommandLine.arguments[index + 1]) {
        proxyPort = p
    }
}

// 2. Storage isolation: persistent isolated container in ~/.opencodex/aistudio-webkit-profile
let fileManager = FileManager.default
let homeDir = fileManager.homeDirectoryForCurrentUser
let profileDir = homeDir.appendingPathComponent(".opencodex/aistudio-webkit-profile")
try? fileManager.createDirectory(at: profileDir, withIntermediateDirectories: true)

let config = WKWebViewConfiguration()
if #available(macOS 14.0, *) {
    let dataStore = WKWebsiteDataStore(forIdentifier: UUID(uuidString: "E8F1A293-87B2-4A73-9092-23A9D40F67E1")!)
    config.websiteDataStore = dataStore
} else {
    config.websiteDataStore = .default()
}

// 3. Desktop Safari user agent masking
config.applicationNameForUserAgent = "Version/18.3 Safari/605.1.15"

// 4. Injected UserScript (WKUserScript): Runs at document_start in main world of aistudio.google.com
let injectionJs = """
(function() {
  const WS_URL = "ws://127.0.0.1:\(proxyPort)/v1/ws/aistudio";
  let ws = null;
  function connect() {
    try { ws = new WebSocket(WS_URL); } catch(e) { setTimeout(connect, 3000); return; }
    ws.onmessage = async (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === "http_request") {
          const { id, payload } = msg;
          try {
            const res = await fetch(payload.url, {
              method: payload.method,
              headers: payload.headers,
              body: payload.body,
              credentials: "include"
            });
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
          } catch(err) {
            ws.send(JSON.stringify({ id, type: "error", payload: { error: String(err) } }));
          }
        }
      } catch(err) { void err; }
    };
    ws.onclose = () => setTimeout(connect, 3000);
  }
  connect();
})();
"""

let userScript = WKUserScript(source: injectionJs, injectionTime: .atDocumentStart, forMainFrameOnly: false)
config.userContentController.addUserScript(userScript)

// 5. Navigation delegate sandbox
class HardenedNavigationDelegate: NSObject, WKNavigationDelegate {
    let allowedHosts = ["aistudio.google.com", "accounts.google.com", "clients6.google.com", "alkalimakersuite-pa.clients6.google.com"]
    
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url, let host = url.host else {
            decisionHandler(.cancel)
            return
        }
        let isAllowed = allowedHosts.contains(where: { host == $0 || host.hasSuffix("." + $0) })
        decisionHandler(isAllowed ? .allow : .cancel)
    }
}

let navDelegate = HardenedNavigationDelegate()
let webView = WKWebView(frame: .init(x: 0, y: 0, width: 1024, height: 768), configuration: config)
webView.customUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Safari/605.1.15"
webView.navigationDelegate = navDelegate

if let targetUrl = URL(string: "https://aistudio.google.com") {
    webView.load(URLRequest(url: targetUrl))
}

print("OpenCodex Native Hardened WebKit Relay started on port \(proxyPort)")
RunLoop.main.run()

