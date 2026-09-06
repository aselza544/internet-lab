import { AlertTriangle, Check, Clock3, Database, Gauge, ShieldCheck, Wifi } from 'lucide-react';
import { getGetGatewayStatusQueryKey, getHealthCheckQueryKey, useGetGatewayStatus, useHealthCheck } from '@workspace/api-client-react';
import { formatBytes } from '@/lib/format';

export default function Settings() {
  const statusQuery = useGetGatewayStatus({ query: { queryKey: getGetGatewayStatusQueryKey(), staleTime: 30000 } });
  const healthQuery = useHealthCheck({ query: { queryKey: getHealthCheckQueryKey(), staleTime: 30000 } });
  const status = statusQuery.data;
  const limits = status?.limits;

  return <main className="page">
    <div className="title-row">
      <div><div className="eyebrow">Configuration & protection</div><h1 className="page-title">Know the boundary.</h1><p className="page-intro">A readable view of the controls around every Internet Lab request. These values are served by the gateway, not guessed by the client.</p></div>
    </div>
    {(statusQuery.isError || healthQuery.isError) && <div className="error-box" role="alert" data-testid="error-settings"><span><AlertTriangle size={14} style={{ verticalAlign: 'middle', marginRight: 7 }} /> Configuration could not be refreshed.</span><button className="button button-secondary" onClick={() => { void statusQuery.refetch(); void healthQuery.refetch(); }} type="button" data-testid="button-retry-settings">Retry</button></div>}
    <section className="settings-grid">
      <div className="settings-stack">
        <div className="panel">
          <div className="panel-head"><div><h2 className="panel-title">Gateway configuration</h2><p className="panel-kicker">Reported by the protected server layer</p></div><ShieldCheck size={16} className="muted" /></div>
          <div className="info-list">
            <div className="info-row"><span className="info-label">Gateway connection</span><span className="info-value value-good">{status?.gateway ?? 'loading'}</span></div>
            <div className="info-row"><span className="info-label">Network classification</span><span className="info-value">{status?.network ?? 'loading'}</span></div>
            <div className="info-row"><span className="info-label">Policy state</span><span className="info-value value-good">{status?.policy ?? 'loading'}</span></div>
            <div className="info-row"><span className="info-label">Authentication state</span><span className="info-value">{status?.mode ?? 'development'}</span></div>
            <div className="info-row"><span className="info-label">Gateway health</span><span className="info-value value-good"><Check size={13} style={{ verticalAlign: 'middle' }} /> {healthQuery.data?.status ?? 'checking'}</span></div>
          </div>
        </div>
        <div className="panel">
          <div className="panel-head"><div><h2 className="panel-title">Resource limits</h2><p className="panel-kicker">Hard ceilings applied to public fetches</p></div><Gauge size={16} className="muted" /></div>
          {limits ? <div className="limit-grid">
            <div className="limit"><span>Request timeout</span><strong>{limits.timeoutMs.toLocaleString()} ms</strong></div>
            <div className="limit"><span>Max response</span><strong>{formatBytes(limits.maxResponseBytes)}</strong></div>
            <div className="limit"><span>Redirects</span><strong>{limits.maxRedirects}</strong></div>
            <div className="limit"><span>Concurrent sessions</span><strong>{limits.maxConcurrentSessions}</strong></div>
          </div> : <div className="empty-state"><p>Reading current limits…</p></div>}
        </div>
      </div>
      <aside className="settings-stack">
        <div className="protection-card"><div className="protection-icon"><ShieldCheck size={19} /></div><h2>Protected by design.</h2><p>Internet Lab is a controlled inspection surface, not a general-purpose browser or unrestricted proxy.</p></div>
        <div className="panel">
          <div className="panel-head"><div><h2 className="panel-title">What the gateway does</h2><p className="panel-kicker">Every request follows the same path</p></div></div>
          <div className="info-list">
            <div className="info-row"><Wifi size={15} className="muted" /><span className="info-label" style={{ flex: 1 }}>Validates destination and DNS</span></div>
            <div className="info-row"><Clock3 size={15} className="muted" /><span className="info-label" style={{ flex: 1 }}>Enforces time and redirect limits</span></div>
            <div className="info-row"><Database size={15} className="muted" /><span className="info-label" style={{ flex: 1 }}>Bounds and plain-text previews</span></div>
          </div>
        </div>
      </aside>
    </section>
  </main>;
}