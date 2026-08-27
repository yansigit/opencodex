import Foundation
import WebKit
import AppKit

var proxyPort = 10100
var isLoginMode = false

for (index, arg) in CommandLine.arguments.enumerated() {
    if arg == "--port", index + 1 < CommandLine.arguments.count, let p = Int(CommandLine.arguments[index + 1]) {
        proxyPort = p
    }
    if arg == "--login" {
        isLoginMode = true
    }
}

let fileManager = FileManager.default
let homeDir = fileManager.homeDirectoryForCurrentUser
let opencodexDir = homeDir.appendingPathComponent(".opencodex")
try? fileManager.createDirectory(at: opencodexDir, withIntermediateDirectories: true)
let sessionFile = opencodexDir.appendingPathComponent("aistudio-session.json")

func writeSecureSession(_ data: Data, to url: URL) throws {
    try data.write(to: url, options: [.atomic])
    try fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
}

// -------------------------------------------------------------
// Interactive Login Mode: Pops up native window for Google login
// -------------------------------------------------------------
if isLoginMode {
    class LoginAppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate {
        var window: NSWindow!
        var webView: WKWebView!
        let sessionFile: URL

        init(sessionFile: URL) {
            self.sessionFile = sessionFile
            super.init()
        }

        func applicationDidFinishLaunching(_ notification: Notification) {
            NSApp.setActivationPolicy(.regular)
            let rect = NSRect(x: 150, y: 150, width: 960, height: 720)
            window = NSWindow(
                contentRect: rect,
                styleMask: [.titled, .closable, .resizable, .miniaturizable],
                backing: .buffered,
                defer: false
            )
            window.title = "Google AI Studio Sign-In — opencodex"
            window.isReleasedWhenClosed = false

            let config = WKWebViewConfiguration()
            config.websiteDataStore = .default()
            config.applicationNameForUserAgent = "Version/18.3 Safari/605.1.15"

            webView = WKWebView(frame: window.contentView!.bounds, configuration: config)
            webView.customUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Safari/605.1.15"
            webView.autoresizingMask = [.width, .height]
            webView.navigationDelegate = self

            window.contentView?.addSubview(webView)
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)

            print("🚀 Opening native Google AI Studio login window...")
            fflush(stdout)

            let target = URL(string: "https://aistudio.google.com/prompts/new_chat")!
            webView.load(URLRequest(url: target))
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            let urlStr = webView.url?.absoluteString ?? ""
            if urlStr.contains("aistudio.google.com") && !urlStr.contains("signin") {
                let extractJs = """
                return {
                    selectedProject: localStorage.getItem('selectedProject') || '',
                    windowId: sessionStorage.getItem('maker_suite_browser_window_id') || ''
                };
                """
                webView.callAsyncJavaScript(extractJs, arguments: [:], in: nil, in: .page) { res in
                    if case .success(let val) = res, let dict = val as? [String: Any] {
                        let proj = dict["selectedProject"] as? String ?? ""
                        let winId = dict["windowId"] as? String ?? ""

                        webView.configuration.websiteDataStore.httpCookieStore.getAllCookies { cookies in
                            let googleCookies = cookies.filter { $0.domain.contains("google.com") }
                            if googleCookies.contains(where: { $0.name == "SAPISID" }) {
                                let cookieMaps: [[String: String]] = googleCookies.map { [
                                    "name": $0.name,
                                    "value": $0.value,
                                    "domain": $0.domain,
                                    "path": $0.path
                                ] }
                                let sessionObj: [String: Any] = [
                                    "selectedProject": proj,
                                    "windowId": winId,
                                    "cookies": cookieMaps
                                ]
                                if let data = try? JSONSerialization.data(withJSONObject: sessionObj, options: [.prettyPrinted]) {
                                    try? writeSecureSession(data, to: self.sessionFile)
                                    print("✅ Successfully harvested Google AI Studio session to \(self.sessionFile.path)")
                                    fflush(stdout)
                                    exit(0)
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    let delegate = LoginAppDelegate(sessionFile: sessionFile)
    NSApplication.shared.delegate = delegate
    NSApplication.shared.run()
}

// -------------------------------------------------------------
// Headless Background Relay Daemon Mode
// -------------------------------------------------------------
let app = NSApplication.shared
app.setActivationPolicy(.prohibited)

guard let sessionData = try? Data(contentsOf: sessionFile),
      let json = try? JSONSerialization.jsonObject(with: sessionData) as? [String: Any] else {
    print("Error: ~/.opencodex/aistudio-session.json not found or invalid.")
    print("Please run: ocx login google-aistudio")
    fflush(stdout)
    exit(1)
}

let selectedProject = json["selectedProject"] as? String ?? ""
let windowId = json["windowId"] as? String ?? ""
let rawCookies = json["cookies"] as? [[String: String]] ?? []
let jsSelectedProject = String(data: try! JSONSerialization.data(withJSONObject: selectedProject, options: [.fragmentsAllowed]), encoding: .utf8)!
let jsWindowId = String(data: try! JSONSerialization.data(withJSONObject: windowId, options: [.fragmentsAllowed]), encoding: .utf8)!

let headlessConfig = WKWebViewConfiguration()
let headlessStore = WKWebsiteDataStore.nonPersistent()
headlessConfig.websiteDataStore = headlessStore
headlessConfig.applicationNameForUserAgent = "Version/18.3 Safari/605.1.15"

// Client UserScript running in MAIN world of aistudio.google.com
let injectionJs = """
(function() {
  const WS_URL = "ws://127.0.0.1:\(proxyPort)/v1/ws/aistudio";
  let ws = null;
  let retryTimer = null;
  let activeXhr = null;

  const origOpen = window.XMLHttpRequest.prototype.open;
  const origSend = window.XMLHttpRequest.prototype.send;

  window.XMLHttpRequest.prototype.open = function(method, url, ...rest) {
      this._url = url;
      return origOpen.apply(this, [method, url, ...rest]);
  };

  window.XMLHttpRequest.prototype.send = function(...args) {
      if (this._url && String(this._url).includes("GenerateContent")) {
          activeXhr = this;
      }
      return origSend.apply(this, args);
  };

  function dismissModals() {
      document.querySelectorAll('button').forEach(b => {
          const t = (b.textContent || '').trim().toLowerCase();
          if (['dismiss', 'close', 'accept', 'ok', 'agree', 'got it'].includes(t)) b.click();
      });
      document.querySelectorAll('.cdk-overlay-backdrop, .cdk-overlay-container').forEach(n => n.remove());
  }

  function connect() {
      if (retryTimer) clearTimeout(retryTimer);
      try {
          ws = new WebSocket(WS_URL);
      } catch (e) {
          retryTimer = setTimeout(connect, 3000);
          return;
      }

      ws.onopen = () => {
          console.log("[WK-Relay] Connected to opencodex proxy on port \(proxyPort)");
      };

      ws.onmessage = async (e) => {
          let msg;
          try { msg = JSON.parse(e.data); } catch(err) { void err; return; }
          const { id, type, payload } = msg || {};
          if (!id || type !== "http_request") return;

          dismissModals();

          if (payload.url.includes("GenerateContent") || payload.url.includes("streamGenerateContent")) {
              let promptText = "";
              try {
                  const bodyParsed = JSON.parse(payload.body);
                  const contents = bodyParsed.contents || [];
                  const lastUser = contents.filter(c => c.role === "user").pop();
                  if (lastUser && lastUser.parts) {
                      promptText = lastUser.parts.map(p => p.text || "").join("\\n");
                  }
              } catch(err) { void err; }

              if (!promptText) promptText = payload.body || "Hello";

              const ta = document.querySelector('textarea[aria-label*="prompt"]') || document.querySelector("textarea");
              if (!ta) {
                  ws.send(JSON.stringify({ id, type: "error", payload: { error: "No prompt textarea found in AI Studio UI" } }));
                  return;
              }

              ta.focus();
              document.execCommand('selectAll', false, null);
              document.execCommand('insertText', false, promptText);

              setTimeout(() => {
                  const submitBtn = document.querySelector("run-button button") || Array.from(document.querySelectorAll("button")).find(b => (b.innerText || "").includes("Run"));
                  if (!submitBtn) {
                      ws.send(JSON.stringify({ id, type: "error", payload: { error: "No Run button found in AI Studio UI" } }));
                      return;
                  }

                  let lastLength = 0;
                  const checkInterval = setInterval(() => {
                      if (activeXhr) {
                          const text = activeXhr.responseText || "";
                          if (text.length > lastLength) {
                              const chunk = text.slice(lastLength);
                              lastLength = text.length;
                              ws.send(JSON.stringify({ id, type: "stream_chunk", payload: { data: chunk } }));
                          }
                          if (activeXhr.readyState === 4) {
                              clearInterval(checkInterval);
                              activeXhr = null;
                              ws.send(JSON.stringify({ id, type: "stream_end", payload: {} }));
                          }
                      }
                  }, 50);

                  submitBtn.click();
              }, 1200);

          } else {
              try {
                  const res = await fetch(payload.url, {
                      method: payload.method,
                      headers: payload.headers,
                      body: payload.body,
                      credentials: "include"
                  });
                  const text = await res.text();
                  ws.send(JSON.stringify({ id, type: "http_response", payload: { body: text, status: res.status } }));
              } catch(err) {
                  ws.send(JSON.stringify({ id, type: "error", payload: { error: String(err) } }));
              }
          }
      };

      ws.onclose = () => {
          retryTimer = setTimeout(connect, 3000);
      };
  }

  try {
      sessionStorage.setItem('maker_suite_browser_window_id', \(jsWindowId));
      localStorage.setItem('selectedProject', \(jsSelectedProject));
      localStorage.setItem('ais_glcr', '{"timestamp":1787783491975,"result":"true"}');
  } catch(err) { void err; }

  connect();
})();
"""

let userScript = WKUserScript(source: injectionJs, injectionTime: .atDocumentStart, forMainFrameOnly: false, in: .page)
headlessConfig.userContentController.addUserScript(userScript)

let cookieStore = headlessStore.httpCookieStore
var injected = 0
let validCookies = rawCookies.filter { cMap in
    guard cMap["name"] != nil, cMap["value"] != nil else { return false }
    let domain = (cMap["domain"] ?? ".google.com").lowercased()
    return domain == "google.com" || domain.hasSuffix(".google.com")
}

for cMap in validCookies {
    guard let name = cMap["name"], let value = cMap["value"] else { continue }
    let rawDomain = (cMap["domain"] ?? ".google.com").lowercased()
    guard rawDomain == "google.com" || rawDomain.hasSuffix(".google.com") else { continue }
    let cookiePath = cMap["path"]?.hasPrefix("/") == true ? cMap["path"]! : "/"
    let cookie = HTTPCookie(properties: [
        .domain: rawDomain,
        .path: cookiePath,
        .name: name,
        .value: value,
        .secure: "TRUE",
        .expires: NSDate(timeIntervalSinceNow: 3600*24*365)
    ])!
    cookieStore.setCookie(cookie) {
        injected += 1
        if injected == validCookies.count {
            print("All cookies injected. Loading AI Studio workspace...")
            fflush(stdout)
            
            let webView = WKWebView(frame: .init(x: 0, y: 0, width: 1024, height: 768), configuration: headlessConfig)
            webView.customUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Safari/605.1.15"
            objc_setAssociatedObject(app, "wv", webView, .OBJC_ASSOCIATION_RETAIN)
            
            class Nav: NSObject, WKNavigationDelegate {
                func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
                    guard let url = navigationAction.request.url, let host = url.host else {
                        decisionHandler(.cancel)
                        return
                    }
                    let allowed = ["aistudio.google.com", "accounts.google.com", "clients6.google.com", "alkalimakersuite-pa.clients6.google.com"]
                    let ok = allowed.contains(where: { host == $0 || host.hasSuffix("." + $0) })
                    decisionHandler(ok ? .allow : .cancel)
                }

                func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
                    print("AI Studio loaded: \(webView.url?.absoluteString ?? "")")
                    fflush(stdout)
                }
            }
            let nav = Nav()
            webView.navigationDelegate = nav
            objc_setAssociatedObject(webView, "nav", nav, .OBJC_ASSOCIATION_RETAIN)
            
            webView.load(URLRequest(url: URL(string: "https://aistudio.google.com/prompts/new_chat")!))
        }
    }
}

print("OpenCodex Native Hardened WebKit Relay started on port \(proxyPort)")
fflush(stdout)
RunLoop.main.run()
