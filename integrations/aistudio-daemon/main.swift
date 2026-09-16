import Foundation
import WebKit
import AppKit

var isLoginMode = false
for arg in CommandLine.arguments where arg == "--login" {
    isLoginMode = true
}

guard isLoginMode else {
    fputs("Error: native AI Studio helper requires --login\n", stderr)
    exit(1)
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

class LoginAppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    let sessionFile: URL
    var finished = false

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
        window.delegate = self

        let config = WKWebViewConfiguration()
        config.websiteDataStore = WKWebsiteDataStore.default()
        config.applicationNameForUserAgent = "Version/18.3 Safari/605.1.15"

        webView = WKWebView(frame: window.contentView!.bounds, configuration: config)
        webView.customUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Safari/605.1.15"
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self

        window.contentView?.addSubview(webView)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        print("Opening native Google AI Studio login window...")
        fflush(stdout)

        webView.load(URLRequest(url: URL(string: "https://aistudio.google.com/prompts/new_chat")!))
    }

    func windowWillClose(_ notification: Notification) {
        guard !finished else { return }
        exit(2)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        let urlStr = webView.url?.absoluteString ?? ""
        guard urlStr.contains("aistudio.google.com"), !urlStr.contains("signin") else { return }
        harvest()
    }

    func harvest() {
        let extractJs = """
        return {
            selectedProject: localStorage.getItem('selectedProject') || '',
            windowId: sessionStorage.getItem('maker_suite_browser_window_id') || ''
        };
        """
        webView.callAsyncJavaScript(extractJs, arguments: [:], in: nil, in: .page) { res in
            guard case .success(let val) = res, let dict = val as? [String: Any] else { return }
            let proj = dict["selectedProject"] as? String ?? ""
            let winId = dict["windowId"] as? String ?? ""
            self.webView.configuration.websiteDataStore.httpCookieStore.getAllCookies { cookies in
                let googleCookies = cookies.filter { $0.domain.contains("google.com") }
                guard googleCookies.contains(where: { $0.name == "SAPISID" }) else { return }
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
                do {
                    let data = try JSONSerialization.data(withJSONObject: sessionObj, options: [.prettyPrinted])
                    try writeSecureSession(data, to: self.sessionFile)
                    print("Successfully harvested Google AI Studio session to \(self.sessionFile.path)")
                    fflush(stdout)
                    self.finished = true
                    exit(0)
                } catch {
                    self.finished = true
                    exit(1)
                }
            }
        }
    }
}

let delegate = LoginAppDelegate(sessionFile: sessionFile)
NSApplication.shared.delegate = delegate
NSApplication.shared.run()

