import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, ArrowUpRight, CheckCircle2, Clock3, EyeOff, Globe2, LockKeyhole, RefreshCw, Search, ShieldCheck, Zap } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import {
  getGetDashboardSummaryQueryKey,
  getGetGatewayStatusQueryKey,
  getListGatewayRequestsQueryKey,
  useCreateGatewaySession,
  useFetchThroughGateway,
  useGetDashboardSummary,
  useGetGatewayStatus,
  useHealthCheck,
  useListGatewayRequests,
} from '@workspace/api-client-react';
import type { GatewayFetchResponse, GatewayRequestSummary } from '@workspace/api-client-react';
import { formatBytes, formatDuration, formatTime, humanError } from '@/lib/format';

function MetricCard({ label, value, note, icon: Icon }: { label: string; value: string; note: string; icon: typeof Zap }) {
  return <div className="metric-card" data-testid={`metric-${label.toLowerCase().replaceAll(' ', '-')}`}>
    <div className="metric-label"><span>{label}</span><Icon size={14} /></div>
    <div className="metric-value">{value}</div>
    <div className="metric-note">{note}</div>
  </div>;
}

function RequestTable({ requests, loading }: { requests: GatewayRequestSummary[]; loading: boolean }) {
  if (loading) return <div className="empty-state"><div className="loading-bar" /><p>Loading request ledger…</p></div>;
  if (!requests.length) return <div className="empty-state" data-testid="empty-requests"><div className="empty-icon"><Search size={17} /></div><p>No gateway requests yet. Your first inspection will appear here.</p></div>;
  return <div className="table-wrap">
    <table className="request-table">
      <thead><tr><th>Destination</th><th>Result</th><th>Code</th><th>Duration</th><th>At</th></tr></thead>
      <tbody>
        {requests.slice(0, 8).map((request) => (
          <tr key={request.id} data-testid={`row-request-${request.id}`}>
            <td><div className="host-cell">{request.hostname}</div><div className="mono muted">{request.id.slice(0, 8)}</div></td>
            <td><span className={`status-badge status-${request.status}`}><span>•</span>{request.status}</span></td>
            <td className="mono">{request.statusCode ?? '—'}</td>
            <td className="mono">{formatDuration(request.durationMs)}</td>
            <td className="mono muted">{formatTime(request.timestamp)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>;
}

export default function Dashboard() {
  const queryClient = useQueryClient();
  const [url, setUrl] = useState('');
  const [formError, setFormError] = useState('');
  const [preview, setPreview] = useState<GatewayFetchResponse | null>(null);
  const sessionRequested = useRef(false);

  const summaryQuery = useGetDashboardSummary({ query: { queryKey: getGetDashboardSummaryQueryKey(), refetchInterval: 30000 } });
  const statusQuery = useGetGatewayStatus({ query: { queryKey: getGetGatewayStatusQueryKey(), staleTime: 30000 } });
  const healthQuery = useHealthCheck({ query: { queryKey: ['healthz-dashboard'], staleTime: 30000 } });
  const requestsQuery = useListGatewayRequests({ query: { queryKey: getListGatewayRequestsQueryKey(), refetchInterval: 30000 } });
  const sessionMutation = useCreateGatewaySession();
  const fetchMutation = useFetchThroughGateway();

  const summary = summaryQuery.data;
  const requests = requestsQuery.data ?? summary?.recentRequests ?? [];
  const isLoading = summaryQuery.isLoading || statusQuery.isLoading;

  useEffect(() => {
    if (
      statusQuery.data?.mode !== 'development' ||
      sessionRequested.current ||
      sessionMutation.isPending
    ) {
      return;
    }
    sessionRequested.current = true;
    sessionMutation.mutate(undefined, {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: getGetGatewayStatusQueryKey() });
        void queryClient.invalidateQueries({ queryKey: getListGatewayRequestsQueryKey() });
      },
    });
  }, [queryClient, sessionMutation, statusQuery.data?.mode]);

  const submitFetch = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError('');
    setPreview(null);
    let parsed: URL;
    try {
      parsed = new URL(url.trim());
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only public HTTP and HTTPS URLs are accepted.');
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Enter a valid public URL, including https://.');
      return;
    }
    fetchMutation.mutate({ data: { url: parsed.toString() } }, {
      onSuccess: (result) => {
        setPreview(result);
        void queryClient.invalidateQueries({ queryKey: getListGatewayRequestsQueryKey() });
        void queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
      },
      onError: (error) => setFormError(humanError(error)),
    });
  };

  const createSession = () => {
    sessionMutation.mutate(undefined, { onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: getGetGatewayStatusQueryKey() });
      void queryClient.invalidateQueries({ queryKey: getListGatewayRequestsQueryKey() });
    } });
  };

  return <main className="page">
    <div className="title-row">
      <div>
        <div className="eyebrow">Protected web workspace</div>
        <h1 className="page-title">Inspect the open web.<br /><span style={{ color: 'hsl(var(--primary))' }}>Keep the edges closed.</span></h1>
        <p className="page-intro">Send a public URL through the server-side gateway. Policy, DNS, redirects, and response limits are checked before anything returns to this workspace.</p>
      </div>
      <button className="button button-secondary" onClick={createSession} disabled={sessionMutation.isPending} type="button" data-testid="button-refresh-session">
        <RefreshCw size={14} className={sessionMutation.isPending ? 'animate-spin' : ''} /> {sessionMutation.isPending ? 'Starting…' : 'Refresh session'}
      </button>
    </div>

    {(summaryQuery.isError || statusQuery.isError || requestsQuery.isError) && <div className="error-box" role="alert" data-testid="error-dashboard">
      <span><AlertTriangle size={14} style={{ verticalAlign: 'middle', marginRight: 7 }} /> Live gateway data is temporarily unavailable.</span>
      <button className="button button-secondary" onClick={() => { void summaryQuery.refetch(); void statusQuery.refetch(); void requestsQuery.refetch(); }} type="button" data-testid="button-retry-dashboard">Retry</button>
    </div>}

    <section className="metrics-grid" aria-label="Workspace summary">
      <MetricCard label="Active sessions" value={isLoading ? '—' : String(summary?.activeSessions ?? 0)} note="Current development scope" icon={LockKeyhole} />
      <MetricCard label="Requests today" value={isLoading ? '—' : String(summary?.requestsToday ?? 0)} note="Policy-checked attempts" icon={ArrowUpRight} />
      <MetricCard label="Blocked requests" value={isLoading ? '—' : String(summary?.blockedRequests ?? 0)} note="Stopped before fetch" icon={ShieldCheck} />
      <MetricCard label="Bandwidth" value={isLoading ? '—' : formatBytes(summary?.bandwidthBytes ?? 0)} note="Response bytes returned" icon={Zap} />
    </section>

    <section className="dashboard-grid">
      <div>
        <div className="panel fetch-panel">
          <div className="panel-head">
            <div><h2 className="panel-title">New gateway inspection</h2><p className="panel-kicker">One public URL per request · no browser execution</p></div>
            <span className="status-badge status-allowed"><CheckCircle2 size={12} /> {statusQuery.data?.policy ?? 'policy enforced'}</span>
          </div>
          <form className="fetch-form" onSubmit={submitFetch}>
            <div className="url-input-wrap">
              <input className="url-input" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.org" aria-label="Public URL to inspect" data-testid="input-gateway-url" />
              <button className="button button-accent" disabled={fetchMutation.isPending || !url.trim()} type="submit" data-testid="button-inspect-url">
                {fetchMutation.isPending ? <><RefreshCw size={14} className="animate-spin" /> Inspecting…</> : <><Globe2 size={14} /> Inspect URL</>}
              </button>
            </div>
            <div className="helper-line"><EyeOff size={13} /> Returns a bounded plain-text preview. Third-party HTML is never rendered in this app.</div>
            {formError && <div className="helper-line" style={{ color: 'hsl(var(--destructive))' }} role="alert" data-testid="error-fetch">{formError}</div>}
          </form>
          {preview && <div className="preview" data-testid="panel-response-preview">
            <div className="preview-head"><span className="preview-title">Safe response preview</span><div className="preview-meta"><span>{preview.statusCode}</span><span>{formatDuration(preview.responseTimeMs)}</span><span>{formatBytes(preview.responseSize)}</span></div></div>
            <pre>{preview.preview || 'The gateway returned an empty preview.'}</pre>
            <div className="safe-note"><LockKeyhole size={13} /> {preview.hostname} · {preview.contentType} · {preview.truncated ? 'Preview truncated at policy limit.' : 'Preview bounded by gateway policy.'}</div>
          </div>}
        </div>
        <div className="panel">
          <div className="panel-head"><div><h2 className="panel-title">Request ledger</h2><p className="panel-kicker">Safe metadata from this development session</p></div><Clock3 size={16} className="muted" /></div>
          <RequestTable requests={requests} loading={requestsQuery.isLoading} />
        </div>
      </div>
      <aside className="settings-stack">
        <div className="panel">
          <div className="panel-head"><div><h2 className="panel-title">Protection status</h2><p className="panel-kicker">What is active right now</p></div><div className="live-dot" /></div>
          <div className="info-list">
            <div className="info-row"><span className="info-label">Gateway</span><span className="info-value value-good" data-testid="status-gateway">{statusQuery.data?.gateway ?? 'checking'}</span></div>
            <div className="info-row"><span className="info-label">Network boundary</span><span className="info-value">{statusQuery.data?.network ?? 'checking'}</span></div>
            <div className="info-row"><span className="info-label">Session mode</span><span className="info-value">{statusQuery.data?.mode ?? 'development'}</span></div>
            <div className="info-row"><span className="info-label">Health probe</span><span className="info-value value-good">{healthQuery.data?.status ?? 'checking'}</span></div>
          </div>
        </div>
        <div className="protection-card">
          <div className="protection-icon"><ShieldCheck size={19} /></div>
          <h2>Your request meets the gateway first.</h2>
          <p>Destinations are validated before the server connects. The browser never becomes a network bridge.</p>
        </div>
      </aside>
    </section>
  </main>;
}