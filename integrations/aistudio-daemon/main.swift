import Foundation
import WebKit
import AppKit

let fileManager = FileManager.default
let sessionFile = fileManager.homeDirectoryForCurrentUser
    .appendingPathComponent(".opencodex", isDirectory: true)
    .appendingPathComponent("aistudio-session.json")

func writeSecureSession(_ data: Data, to url: URL) throws {
    try fileManager.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try data.write(to: url, options: [.atomic])
    try fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
}

private let allowedNavigationHosts = [
    "aistudio.google.com",
    "accounts.google.com",
    "clients6.google.com",
    "alkalimakersuite-pa.clients6.google.com",
]

func isAllowedNavigationHost(_ host: String?) -> Bool {
    guard let host else { return false }
    return allowedNavigationHosts.contains { allowed in
        host == allowed || host.hasSuffix(".\(allowed)")
    }
}

final class LoginAppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var finished = false

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
        window.delegate = self

        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.applicationNameForUserAgent = "Version/18.3 Safari/605.1.15"
        webView = WKWebView(frame: window.contentView!.bounds, configuration: configuration)
        webView.customUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Safari/605.1.15"
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        window.contentView?.addSubview(webView)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        webView.load(URLRequest(url: URL(string: "https://aistudio.google.com/prompts/new_chat")!))
    }

    func windowWillClose(_ notification: Notification) {
        if !finished { exit(2) }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let host = navigationAction.request.url?.host, isAllowedNavigationHost(host) else {
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        if !finished { exit(1) }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if !finished { exit(1) }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard !finished, let url = webView.url,
              url.host == "aistudio.google.com" || url.host?.hasSuffix(".aistudio.google.com") == true,
              !url.absoluteString.contains("signin") else { return }

        let extract = """
        ({
          selectedProject: localStorage.getItem('selectedProject') || '',
          windowId: sessionStorage.getItem('maker_suite_browser_window_id') || ''
        })
        """
        webView.callAsyncJavaScript(extract, arguments: [:], in: nil, in: .page) { [weak self] result in
            guard let self, !self.finished,
                  case .success(let value) = result,
                  let values = value as? [String: Any] else { return }
            let selectedProject = values["selectedProject"] as? String ?? ""
            let windowId = values["windowId"] as? String ?? ""
            webView.configuration.websiteDataStore.httpCookieStore.getAllCookies { [weak self] cookies in
                guard let self, !self.finished else { return }
                let googleCookies = cookies.filter { $0.domain == "google.com" || $0.domain.hasSuffix(".google.com") }
                guard googleCookies.contains(where: { $0.name == "SAPISID" }) else { return }
                let cookieMaps: [[String: String]] = googleCookies.map { cMap in
                    ["name": cMap.name, "value": cMap.value, "domain": cMap.domain, "path": cMap.path]
                }
                let session: [String: Any] = [
                    "selectedProject": selectedProject,
                    "windowId": windowId,
                    "cookies": cookieMaps
                ]
                do {
                    let data = try JSONSerialization.data(withJSONObject: session, options: [.prettyPrinted])
                    try writeSecureSession(data, to: sessionFile)
                    self.finished = true
                    exit(0)
                } catch {
                    exit(1)
                }
            }
        }
    }
}

let args = CommandLine.arguments
guard args.contains("--login") else {
    fputs("Usage: aistudio-login --login\n", stderr)
    exit(1)
}

let app = NSApplication.shared
let delegate = LoginAppDelegate()
app.delegate = delegate
app.run()
