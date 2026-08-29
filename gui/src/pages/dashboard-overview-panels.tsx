import MemoryObservabilityCard from "../components/MemoryObservabilityCard";
import { useEffect, useRef, useState } from "react";
import type { useDashboardData } from "./use-dashboard-data";
import {
  DashboardEffortCapPanel,
  DashboardInjectionPanel,
  DashboardMaintenancePanel,
  DashboardSidecarPanels,
} from "./dashboard-overview-sections";

type Dash = ReturnType<typeof useDashboardData>;

export function DashboardOverviewPanels(props: Dash) {
  const server = props.settings?.server;
  const [view, setView] = useState(server);
  const [draft, setDraft] = useState(server?.configured);
  const committedDraftRef = useRef(server?.configured);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!server) return;
    setView(server);
    setDraft(previous => {
      if (!previous || JSON.stringify(previous) === JSON.stringify(committedDraftRef.current)) {
        committedDraftRef.current = server.configured;
        return server.configured;
      }
      return previous;
    });
  }, [server]);
  return (
    <>
      {server && (
        <section className="panel" aria-labelledby="dashboard-server-settings-title">
          <h3 id="dashboard-server-settings-title" className="panel-title">{props.t("dash.serverSettingsTitle")}</h3>
          {draft && <form className="server-settings-form" onSubmit={async event => {
            event.preventDefault(); setSaving(true); setError(null);
            try {
              const res = await fetch(`${props.apiBase}/api/settings`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ server: draft }) });
              const data = await res.json() as { server?: typeof server; error?: string };
              if (!res.ok || !data.server) throw new Error(data.error ?? props.t("dash.serverSaveFailed"));
              committedDraftRef.current = data.server.configured;
              setDraft(data.server.configured); setView(data.server);
            } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
            finally { setSaving(false); }
          }}>
            <label className="server-settings-field"><code>hostname</code><input className="input" value={draft.hostname} onChange={e => setDraft({ ...draft, hostname: e.target.value })} /></label>
            <label className="server-settings-field"><code>port</code><input className="input" type="number" min="0" max="65535" value={draft.port} onChange={e => setDraft({ ...draft, port: Number(e.target.value) })} /></label>
            <label className="server-settings-checkbox"><input type="checkbox" checked={!!draft.tls} onChange={e => setDraft({ ...draft, tls: e.target.checked ? (draft.tls ?? { certFile: "", keyFile: "", publicOrigin: "" }) : null })} /> <code>TLS</code></label>
            {draft.tls && <>
              <label className="server-settings-field"><code>certFile</code><input className="input" value={draft.tls.certFile} onChange={e => setDraft({ ...draft, tls: { ...draft.tls!, certFile: e.target.value } })} /></label>
              <label className="server-settings-field"><code>keyFile</code><input className="input" value={draft.tls.keyFile} onChange={e => setDraft({ ...draft, tls: { ...draft.tls!, keyFile: e.target.value } })} /></label>
              <label className="server-settings-field"><code>publicOrigin</code><input className="input" value={draft.tls.publicOrigin} onChange={e => setDraft({ ...draft, tls: { ...draft.tls!, publicOrigin: e.target.value } })} /></label>
            </>}
            <label className="server-settings-field"><code>aiStudioOrigin</code><input className="input" value={draft.aiStudioOrigin ?? ""} onChange={e => setDraft({ ...draft, aiStudioOrigin: e.target.value || null })} /></label>
            <button className="btn btn-primary" type="submit" disabled={saving}>{props.t("common.save")}</button>
            {error && <div role="alert">{error}</div>}
          </form>}
          {view && <dl className="provider-health-facts">
            <div><dt><code>activeOrigin</code></dt><dd><code>{view.activeOrigin}</code></dd></div>
            <div><dt><code>hostname</code></dt><dd><code>{view.configured.hostname}:{view.configured.port}</code></dd></div>
            <div><dt><code>TLS</code></dt><dd><code>{view.configured.tls ? view.configured.tls.publicOrigin : props.t("dash.serverTlsOff")}</code></dd></div>
            <div><dt><code>credential</code></dt><dd><code>{view.credentialConfigured ? props.t("dash.serverCredentialConfigured") : props.t("dash.serverCredentialMissing")}</code></dd></div>
            {view.restartRequired && <div><dt><code>restartRequired</code></dt><dd><code>{props.t("dash.serverRestartRequired")}</code></dd></div>}
          </dl>}
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
