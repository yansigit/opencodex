import MemoryObservabilityCard from "../components/MemoryObservabilityCard";
import { useState } from "react";
import { useCopyFeedback } from "../components/use-copy-feedback";
import { openAiBaseUrlConfig, sshForwardCommand } from "../lib/server-access-commands";
import type { useDashboardData } from "./use-dashboard-data";
import {
  DashboardEffortCapPanel,
  DashboardInjectionPanel,
  DashboardMaintenancePanel,
  DashboardSidecarPanels,
} from "./dashboard-overview-sections";

type Dash = ReturnType<typeof useDashboardData>;
type ServerConfig = NonNullable<NonNullable<Dash["settings"]>["server"]>["configured"];
type ServerTls = NonNullable<ServerConfig["tls"]>;
const LOCAL_FORWARD_PORT = 20100;

function isLoopbackHostname(hostname: string): boolean {
  const n = hostname.trim().toLowerCase().replace(/\.$/, "");
  return n === "" || n === "localhost" || n === "127.0.0.1" || n === "::1" || n === "[::1]";
}

function remoteHost(tls: ServerTls | null): string {
  try {
    const hostname = tls ? new URL(tls.publicOrigin).hostname : "";
    if (hostname && !isLoopbackHostname(hostname) && hostname !== "0.0.0.0") return hostname;
  } catch {
    // An unfinished draft should render a useful placeholder, not fail the form.
  }
  return "<proxy-host>";
}

export function DashboardServerSettingsPanel(props: Dash) {
  const server = props.settings?.server;
  const [draftOverride, setDraftOverride] = useState<ServerConfig | null>(null);
  const draft = draftOverride ?? server?.configured;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stashedTls, setStashedTls] = useState<ServerTls | null>(null);
  const { outcomeFor: copyOutcomeFor, copy } = useCopyFeedback<string>();

  const mode: "loopback" | "remote" = draft?.tls ? "remote" : "loopback";
  const sshPort = draft?.port ?? 10100;
  const sshCmd = sshForwardCommand(sshPort, remoteHost(stashedTls ?? draft?.tls ?? null), LOCAL_FORWARD_PORT);
  const localConfig = openAiBaseUrlConfig(LOCAL_FORWARD_PORT);

  const switchMode = (next: "loopback" | "remote") => {
    if (!draft) return;
    setError(null);
    if (next === "loopback") {
      if (draft.tls) setStashedTls({ ...draft.tls });
      setDraftOverride({ ...draft, hostname: "127.0.0.1", tls: null });
    } else {
      const restored: ServerTls = { ...(stashedTls ?? draft.tls ?? { certFile: "", keyFile: "", publicOrigin: "" }) };
      const nextHostname = isLoopbackHostname(draft.hostname) ? "0.0.0.0" : draft.hostname;
      setDraftOverride({ ...draft, hostname: nextHostname, tls: restored });
    }
  };

  const copyLabel = (scope: string) => copyOutcomeFor(scope) === "copied"
    ? props.t("common.copied")
    : copyOutcomeFor(scope) === "unavailable" ? props.t("dash.serverCopyUnavailable") : props.t("common.copy");

  return server ? (
        <section className="panel" aria-labelledby="dashboard-server-settings-title">
          <h3 id="dashboard-server-settings-title" className="panel-title">{props.t("dash.serverSettingsTitle")}</h3>
          {draft && (
            <form className="server-settings-form" onSubmit={async event => {
              event.preventDefault(); setSaving(true); setError(null);
              try {
                await props.saveServerSettings(draft);
                setDraftOverride(null);
              } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
              finally { setSaving(false); }
            }}>
              <div className="server-mode-toggle" role="group" aria-label={props.t("dash.serverModeLabel")}>
                <button type="button" aria-pressed={mode === "loopback"} className={"usage-segmented-btn" + (mode === "loopback" ? " active" : "")} onClick={() => switchMode("loopback")}>{props.t("dash.serverModeLoopback")}</button>
                <button type="button" aria-pressed={mode === "remote"} className={"usage-segmented-btn" + (mode === "remote" ? " active" : "")} onClick={() => switchMode("remote")}>{props.t("dash.serverModeRemote")}</button>
              </div>
              <p className="server-mode-hint">{mode === "loopback" ? props.t("dash.serverModeLoopbackHint") : props.t("dash.serverModeRemoteHint")}</p>

              {mode === "loopback" ? (
                <div className="server-mode-card server-mode-card--loopback">
                  <div className="server-mode-card-title">{props.t("dash.serverLoopbackCardTitle")}</div>
                  <p className="server-mode-card-desc">{props.t("dash.serverLoopbackCardDesc")}</p>
                  <div className="server-ssh-block">
                    <code className="server-ssh-cmd">{sshCmd}</code>
                    <button type="button" className="btn btn-sm" onClick={() => copy(sshCmd, "ssh")}><span aria-live="polite">{copyLabel("ssh")}</span></button>
                  </div>
                  <div className="server-ssh-block">
                    <code className="server-ssh-cmd">{localConfig}</code>
                    <button type="button" className="btn btn-sm" onClick={() => copy(localConfig, "url")}><span aria-live="polite">{copyLabel("url")}</span></button>
                  </div>
                  <p className="server-mode-card-note">{props.t("dash.serverLoopbackCardNote")}</p>
                </div>
              ) : (
                <div className="server-mode-card server-mode-card--remote">
                  <div className="server-mode-card-title">{props.t("dash.serverRemoteCardTitle")}</div>
                  <p className="server-mode-card-desc">{props.t("dash.serverRemoteCardDesc")}</p>
                </div>
              )}

              <label className="server-settings-field"><code>port</code><input className="input" type="number" min="0" max="65535" value={draft.port} onChange={e => { const port = e.currentTarget.valueAsNumber; setDraftOverride({ ...draft, port: Number.isFinite(port) ? port : 0 }); }} /></label>

              {mode === "remote" ? (
                <>
                  <label className="server-settings-field"><code>hostname</code><input className="input" value={draft.hostname} onChange={e => setDraftOverride({ ...draft, hostname: e.target.value })} /></label>
                  <label className="server-settings-field"><code>certFile</code><input className="input" required value={draft.tls?.certFile ?? ""} onChange={e => setDraftOverride({ ...draft, tls: { ...(draft.tls ?? { certFile: "", keyFile: "", publicOrigin: "" }), certFile: e.target.value } })} placeholder="/path/to/cert.pem" /></label>
                  <label className="server-settings-field"><code>keyFile</code><input className="input" required value={draft.tls?.keyFile ?? ""} onChange={e => setDraftOverride({ ...draft, tls: { ...(draft.tls ?? { certFile: "", keyFile: "", publicOrigin: "" }), keyFile: e.target.value } })} placeholder="/path/to/key.pem" /></label>
                  <label className="server-settings-field"><code>publicOrigin</code><input className="input" required type="url" pattern="https://.*" value={draft.tls?.publicOrigin ?? ""} onChange={e => setDraftOverride({ ...draft, tls: { ...(draft.tls ?? { certFile: "", keyFile: "", publicOrigin: "" }), publicOrigin: e.target.value } })} placeholder="https://proxy.example.com:10100" /></label>
                  <p className="server-mode-card-note">{props.t("dash.serverRemoteSanHint")}</p>
                  {!server.credentialConfigured && <div className="notice notice-warn" role="alert">{props.t("dash.serverRemoteCredentialRequired")}</div>}
                </>
              ) : (
                <details className="server-advanced-details">
                  <summary>{props.t("dash.serverAdvanced")}</summary>
                  <label className="server-settings-field"><code>hostname</code><input className="input" value={draft.hostname} onChange={e => setDraftOverride({ ...draft, hostname: e.target.value })} /></label>
                </details>
              )}

              <label className="server-settings-field"><code>aiStudioOrigin</code><input className="input" value={draft.aiStudioOrigin ?? ""} onChange={e => setDraftOverride({ ...draft, aiStudioOrigin: e.target.value || null })} placeholder="chrome-extension://..." /></label>
              <button className="btn btn-primary" type="submit" disabled={saving || mode === "remote" && !server.credentialConfigured}>{props.t("common.save")}</button>
              {error && <div role="alert" className="server-settings-error">{error}</div>}
              {server.restartRequired && <div className="notice notice-warn" role="status">{props.t("dash.serverRestartNotice")}</div>}
            </form>
          )}
          <dl className="provider-health-facts">
            <div><dt><code>activeOrigin</code></dt><dd><code>{server.activeOrigin}</code></dd></div>
            <div><dt><code>hostname</code></dt><dd><code>{server.configured.hostname}:{server.configured.port}</code></dd></div>
            <div><dt><code>TLS</code></dt><dd><code>{server.configured.tls ? server.configured.tls.publicOrigin : props.t("dash.serverTlsOff")}</code></dd></div>
            <div><dt><code>credential</code></dt><dd><code>{server.credentialConfigured ? props.t("dash.serverCredentialConfigured") : props.t("dash.serverCredentialMissing")}</code></dd></div>
            {server.restartRequired && <div><dt><code>restartRequired</code></dt><dd><code>{props.t("dash.serverRestartRequired")}</code></dd></div>}
          </dl>
        </section>
  ) : null;
}

export function DashboardOverviewPanels(props: Dash) {
  return (
    <>
      <DashboardServerSettingsPanel {...props} />
      <DashboardEffortCapPanel apiBase={props.apiBase} d={props} />
      <div className="dash-overview-tools">
        <DashboardInjectionPanel apiBase={props.apiBase} d={props} />
        <DashboardMaintenancePanel d={props} />
      </div>
      <DashboardSidecarPanels d={props} />
      <MemoryObservabilityCard apiBase={props.apiBase} />
    </>
  );
}
