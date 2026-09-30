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

const SAFE_TEXT_TAGS = new Set([
  'article', 'aside', 'blockquote', 'code', 'dd', 'div', 'dl', 'dt',
  'em', 'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'header', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'small',
  'span', 'strong', 'sub', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th',
  'thead', 'tr', 'u', 'ul', 'br', 'hr',
]);

const BLOCKED_TAGS = new Set([
  'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed',
  'form', 'input', 'button', 'textarea', 'select', 'option', 'video',
  'audio', 'canvas', 'svg', 'math', 'link', 'meta', 'base', 'template',
]);

function renderSafeDocumentNode(
  node: Node,
  key: string,
  onNavigate: (href: string) => void,
  navigationPending: boolean,
): React.ReactNode {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent;
  }

  if (node.nodeType !== Node.ELEMENT_NODE) {
    return null;
  }

  const element = node as Element;
  const tag = element.tagName.toLowerCase();

  if (BLOCKED_TAGS.has(tag)) {
    return null;
  }

  if (tag === 'a') {
    const href = element.getAttribute('href');
    const children = Array.from(element.childNodes).map((child, index) =>
      renderSafeDocumentNode(child, `${key}-${index}`, onNavigate, navigationPending),
    );

    if (!href) return <span key={key}>{children}</span>;

    return (
      <button
        key={key}
        type="button"
        className="web-link"
        disabled={navigationPending}
        onClick={() => onNavigate(href)}
      >
        {children}
      </button>
    );
  }

  if (!SAFE_TEXT_TAGS.has(tag)) {
    return Array.from(node.childNodes).map((child, index) =>
      renderSafeDocumentNode(child, `${key}-${index}`, onNavigate, navigationPending),
    );
  }

  const children = Array.from(node.childNodes).map((child, index) =>
    renderSafeDocumentNode(child, `${key}-${index}`, onNavigate, navigationPending),
  );

  switch (tag) {
    case 'h1': return <h1 key={key}>{children}</h1>;
    case 'h2': return <h2 key={key}>{children}</h2>;
    case 'h3': return <h3 key={key}>{children}</h3>;
    case 'h4': return <h4 key={key}>{children}</h4>;
    case 'h5': return <h5 key={key}>{children}</h5>;
    case 'h6': return <h6 key={key}>{children}</h6>;
    case 'p': return <p key={key}>{children}</p>;
    case 'a': return <span key={key}>{children}</span>;
    case 'ul': return <ul key={key}>{children}</ul>;
    case 'ol': return <ol key={key}>{children}</ol>;
    case 'li': return <li key={key}>{children}</li>;
    case 'blockquote': return <blockquote key={key}>{children}</blockquote>;
    case 'pre': return <pre key={key}>{children}</pre>;
    case 'code': return <code key={key}>{children}</code>;
    case 'strong': return <strong key={key}>{children}</strong>;
    case 'em': return <em key={key}>{children}</em>;
    case 'small': return <small key={key}>{children}</small>;
    case 'br': return <br key={key} />;
    case 'hr': return <hr key={key} />;
    case 'table': return <table key={key}>{children}</table>;
    case 'thead': return <thead key={key}>{children}</thead>;
    case 'tbody': return <tbody key={key}>{children}</tbody>;
    case 'tfoot': return <tfoot key={key}>{children}</tfoot>;
    case 'tr': return <tr key={key}>{children}</tr>;
    case 'th': return <th key={key}>{children}</th>;
    case 'td': return <td key={key}>{children}</td>;
    default: return <div key={key}>{children}</div>;
  }
}

function SafeWebDocument({
  html,
  baseUrl,
  onNavigate,
  navigationPending,
}: {
  html: string;
  baseUrl: string;
  onNavigate: (href: string) => void;
  navigationPending: boolean;
}) {
  if (!html.trim()) {
    return <div className="empty-state">The gateway returned an empty HTML document.</div>;
  }

  const parser = new DOMParser();
  const document = parser.parseFromString(html, 'text/html');
  const root = document.body;

  const resolveHref = (href: string): string | null => {
    try {
      const resolved = new URL(href, baseUrl);
      if (resolved.protocol === 'http:' || resolved.protocol === 'https:') {
        return resolved.toString();
      }
    } catch {
      return null;
    }
    return null;
  };

  const renderNode = (node: Node, key: string): React.ReactNode => {
    if (node.nodeType === Node.ELEMENT_NODE && (node as Element).tagName.toLowerCase() === 'a') {
      const element = node as Element;
      const href = element.getAttribute('href');
      const absoluteHref = href ? resolveHref(href) : null;
      const children = Array.from(node.childNodes).map((child, index) =>
        renderNode(child, `${key}-${index}`),
      );
      if (!absoluteHref) return <span key={key}>{children}</span>;
      return (
        <button
          key={key}
          type="button"
          className="web-link"
          disabled={navigationPending}
          onClick={() => onNavigate(absoluteHref)}
        >
          {children}
        </button>
      );
    }

    return renderSafeDocumentNode(node, key, (href) => {
      const resolved = resolveHref(href);
      if (resolved) onNavigate(resolved);
    }, navigationPending);
  };

  return (
    <div className="web-document" data-testid="safe-web-document">
      {Array.from(root.childNodes).map((node, index) => renderNode(node, String(index)))}
    </div>
  );
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

  const navigateTo = (targetUrl: string) => {
    setFormError('');
    let parsed: URL;
    try {
      parsed = new URL(targetUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error('Only public HTTP and HTTPS links are accepted.');
      }
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'This link cannot be opened safely.');
      return;
    }

    setUrl(parsed.toString());
    fetchMutation.mutate({ data: { url: parsed.toString() } }, {
      onSuccess: (result) => {
        setPreview(result);
        void queryClient.invalidateQueries({ queryKey: getListGatewayRequestsQueryKey() });
        void queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
      },
      onError: (error) => setFormError(humanError(error)),
    });
  };

  const submitFetch = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    navigateTo(url.trim());
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
            <div><h2 className="panel-title">Web viewer</h2><p className="panel-kicker">Gateway-rendered HTML · links stay inside Internet Lab</p></div>
            <span className="status-badge status-allowed"><CheckCircle2 size={12} /> {statusQuery.data?.policy ?? 'policy enforced'}</span>
          </div>
          <form className="fetch-form" onSubmit={submitFetch}>
            <div className="url-input-wrap">
              <input className="url-input" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.org" aria-label="Public URL to open" data-testid="input-gateway-url" />
              <button className="button button-accent" disabled={fetchMutation.isPending || !url.trim()} type="submit" data-testid="button-inspect-url">
                {fetchMutation.isPending ? <><RefreshCw size={14} className="animate-spin" /> Loading…</> : <><Globe2 size={14} /> Open</>}
              </button>
            </div>
            <div className="helper-line"><LockKeyhole size={13} /> HTML is parsed into a restricted viewer. Scripts, forms, frames, media, and third-party event handlers are not executed.</div>
            {formError && <div className="helper-line" style={{ color: 'hsl(var(--destructive))' }} role="alert" data-testid="error-fetch">{formError}</div>}
          </form>
          {preview && <div className="preview" data-testid="panel-response-preview">
            <div className="preview-head"><span className="preview-title">{preview.hostname}</span><div className="preview-meta"><span>{preview.statusCode}</span><span>{formatDuration(preview.responseTimeMs)}</span><span>{formatBytes(preview.responseSize)}</span></div></div>
            {preview.contentType.includes('html') ? (
              <SafeWebDocument
                html={preview.preview}
                baseUrl={preview.url}
                onNavigate={navigateTo}
                navigationPending={fetchMutation.isPending}
              />
            ) : (
              <pre>{preview.preview || 'The gateway returned an empty preview.'}</pre>
            )}
            <div className="safe-note"><LockKeyhole size={13} /> {preview.url} · {preview.contentType} · {preview.truncated ? 'Preview truncated at policy limit.' : 'Response bounded by gateway policy.'}</div>
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