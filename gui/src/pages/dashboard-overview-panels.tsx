import MemoryObservabilityCard from "../components/MemoryObservabilityCard";
import { useState } from "react";
import type { useDashboardData } from "./use-dashboard-data";
import {
  DashboardEffortCapPanel,
  DashboardInjectionPanel,
  DashboardMaintenancePanel,
  DashboardSidecarPanels,
} from "./dashboard-overview-sections";

type Dash = ReturnType<typeof useDashboardData>;
type ServerConfig = NonNullable<NonNullable<Dash["settings"]>["server"]>["configured"];

export function DashboardOverviewPanels(props: Dash) {
  const server = props.settings?.server;
  const [draftOverride, setDraftOverride] = useState<ServerConfig | null>(null);
  const draft = draftOverride ?? server?.configured;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      {server && (
        <section className="panel" aria-labelledby="dashboard-server-settings-title">
          <h3 id="dashboard-server-settings-title" className="panel-title">{props.t("dash.serverSettingsTitle")}</h3>
          {draft && <form className="server-settings-form" onSubmit={async event => {
            event.preventDefault(); setSaving(true); setError(null);
            try {
              await props.saveServerSettings(draft);
              setDraftOverride(null);
            } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
            finally { setSaving(false); }
          }}>
            <label className="server-settings-field"><code>hostname</code><input className="input" value={draft.hostname} onChange={e => setDraftOverride({ ...draft, hostname: e.target.value })} /></label>
            <label className="server-settings-field"><code>port</code><input className="input" type="number" min="0" max="65535" value={draft.port} onChange={e => { const port = e.currentTarget.valueAsNumber; setDraftOverride({ ...draft, port: Number.isFinite(port) ? port : 0 }); }} /></label>
            <label className="server-settings-checkbox"><input type="checkbox" checked={!!draft.tls} onChange={e => setDraftOverride({ ...draft, tls: e.target.checked ? (draft.tls ?? { certFile: "", keyFile: "", publicOrigin: "" }) : null })} /> <code>TLS</code></label>
            {draft.tls && <>
              <label className="server-settings-field"><code>certFile</code><input className="input" value={draft.tls.certFile} onChange={e => setDraftOverride({ ...draft, tls: { ...draft.tls!, certFile: e.target.value } })} /></label>
              <label className="server-settings-field"><code>keyFile</code><input className="input" value={draft.tls.keyFile} onChange={e => setDraftOverride({ ...draft, tls: { ...draft.tls!, keyFile: e.target.value } })} /></label>
              <label className="server-settings-field"><code>publicOrigin</code><input className="input" value={draft.tls.publicOrigin} onChange={e => setDraftOverride({ ...draft, tls: { ...draft.tls!, publicOrigin: e.target.value } })} /></label>
            </>}
            <label className="server-settings-field"><code>aiStudioOrigin</code><input className="input" value={draft.aiStudioOrigin ?? ""} onChange={e => setDraftOverride({ ...draft, aiStudioOrigin: e.target.value || null })} /></label>
            <button className="btn btn-primary" type="submit" disabled={saving}>{props.t("common.save")}</button>
            {error && <div role="alert">{error}</div>}
          </form>}
          <dl className="provider-health-facts">
            <div><dt><code>activeOrigin</code></dt><dd><code>{server.activeOrigin}</code></dd></div>
            <div><dt><code>hostname</code></dt><dd><code>{server.configured.hostname}:{server.configured.port}</code></dd></div>
            <div><dt><code>TLS</code></dt><dd><code>{server.configured.tls ? server.configured.tls.publicOrigin : props.t("dash.serverTlsOff")}</code></dd></div>
            <div><dt><code>credential</code></dt><dd><code>{server.credentialConfigured ? props.t("dash.serverCredentialConfigured") : props.t("dash.serverCredentialMissing")}</code></dd></div>
            {server.restartRequired && <div><dt><code>restartRequired</code></dt><dd><code>{props.t("dash.serverRestartRequired")}</code></dd></div>}
          </dl>
        </section>
      )}
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
