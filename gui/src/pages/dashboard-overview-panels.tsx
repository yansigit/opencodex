import MemoryObservabilityCard from "../components/MemoryObservabilityCard";
import { useEffect, useState } from "react";
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
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (server) { setDraft(server.configured); setView(server); } }, [server]);
  return (
    <>
      {server && (
        <section className="panel" aria-label={props.t("nav.api")}>
          <div className="font-semibold">{props.t("nav.api")}</div>
          {draft && <form onSubmit={async event => {
            event.preventDefault(); setSaving(true); setError(null);
            try {
              const res = await fetch(`${props.apiBase}/api/settings`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ server: draft }) });
              const data = await res.json() as { server?: typeof server; error?: string };
              if (!res.ok || !data.server) throw new Error(data.error ?? props.t("dash.sidecarSaveFailed"));
              setDraft(data.server.configured); setView(data.server);
            } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
            finally { setSaving(false); }
          }}>
            <label><code>hostname</code><input value={draft.hostname} onChange={e => setDraft({ ...draft, hostname: e.target.value })} /></label>
            <label><code>port</code><input type="number" min="0" max="65535" value={draft.port} onChange={e => setDraft({ ...draft, port: Number(e.target.value) })} /></label>
            <label><input type="checkbox" checked={!!draft.tls} onChange={e => setDraft({ ...draft, tls: e.target.checked ? (draft.tls ?? { certFile: "", keyFile: "", publicOrigin: "" }) : null })} /> <code>TLS</code></label>
            {draft.tls && <>
              <label><code>certFile</code><input value={draft.tls.certFile} onChange={e => setDraft({ ...draft, tls: { ...draft.tls!, certFile: e.target.value } })} /></label>
              <label><code>keyFile</code><input value={draft.tls.keyFile} onChange={e => setDraft({ ...draft, tls: { ...draft.tls!, keyFile: e.target.value } })} /></label>
              <label><code>publicOrigin</code><input value={draft.tls.publicOrigin} onChange={e => setDraft({ ...draft, tls: { ...draft.tls!, publicOrigin: e.target.value } })} /></label>
            </>}
            <label><code>aiStudioOrigin</code><input value={draft.aiStudioOrigin ?? ""} onChange={e => setDraft({ ...draft, aiStudioOrigin: e.target.value || null })} /></label>
            <button className="btn btn-primary" type="submit" disabled={saving}>{props.t("common.save")}</button>
            {error && <div role="alert">{error}</div>}
          </form>}
          {view && <dl className="provider-health-facts">
            <div><dt><code>activeOrigin</code></dt><dd><code>{view.activeOrigin}</code></dd></div>
            <div><dt><code>hostname</code></dt><dd><code>{view.configured.hostname}:{view.configured.port}</code></dd></div>
            <div><dt><code>TLS</code></dt><dd><code>{view.configured.tls ? view.configured.tls.publicOrigin : "off"}</code></dd></div>
            <div><dt><code>credential</code></dt><dd><code>{view.credentialConfigured ? "configured" : "missing"}</code></dd></div>
            {view.restartRequired && <div><dt><code>restartRequired</code></dt><dd><code>true</code></dd></div>}
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
