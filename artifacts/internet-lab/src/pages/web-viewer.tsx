import { FormEvent, useEffect, useRef, useState } from 'react';
import { Globe2, LockKeyhole, RefreshCw, ShieldCheck } from 'lucide-react';

const MAX_BRIDGE_BODY_BYTES = 2 * 1024 * 1024;

export default function WebViewer() {
  const [url, setUrl] = useState('https://example.com');
  const [frameUrl, setFrameUrl] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const frameRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const onMessage = async (event: MessageEvent) => {
      if (!frameRef.current?.contentWindow || event.source !== frameRef.current.contentWindow) return;
      const data = event.data;
      if (!data || data.__internetLab !== 1 || typeof data.id !== 'string') return;
      if (!['fetch', 'xhr'].includes(data.type)) return;
      if (typeof data.url !== 'string' || !data.url.startsWith('/api/web/resource?url=')) return;

      const method = String(data.method).toUpperCase();
      if (!['GET', 'POST', 'HEAD'].includes(method)) return;

      let body: BodyInit | undefined;
      if (method !== 'GET' && method !== 'HEAD' && data.body != null) {
        if (typeof data.body === 'string') {
          if (new TextEncoder().encode(data.body).byteLength > MAX_BRIDGE_BODY_BYTES) return;
          body = data.body;
        } else if (data.body instanceof ArrayBuffer) {
          if (data.body.byteLength > MAX_BRIDGE_BODY_BYTES) return;
          body = data.body;
        } else if (ArrayBuffer.isView(data.body)) {
          if (data.body.byteLength > MAX_BRIDGE_BODY_BYTES) return;
          body = new Uint8Array(data.body.buffer, data.body.byteOffset, data.body.byteLength);
        } else {
          return;
        }
      }

      try {
        const headers = new Headers();
        if (data.headers && typeof data.headers === 'object') {
          for (const [name, value] of Object.entries(data.headers as Record<string, unknown>)) {
            if (typeof value === 'string' && !['cookie', 'host', 'origin', 'referer', 'connection', 'content-length'].includes(name.toLowerCase())) headers.set(name, value);
          }
        }
        const response = await fetch(data.url, {
          method,
          headers,
          body,
          credentials: 'include',
        });
        const buffer = await response.arrayBuffer();
        const responseHeaders: Record<string, string> = {};
        response.headers.forEach((value, name) => { responseHeaders[name] = value; });
        frameRef.current?.contentWindow?.postMessage({
          __internetLab: 1,
          id: data.id,
          ok: true,
          status: response.status,
          headers: responseHeaders,
          body: buffer,
        }, '*', [buffer]);
      } catch (err) {
        frameRef.current?.contentWindow?.postMessage({
          __internetLab: 1,
          id: data.id,
          ok: false,
          name: 'TypeError',
          error: err instanceof Error ? err.message : 'Gateway request failed',
        }, '*');
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  async function ensureSession() {
    const response = await fetch('/api/gateway/sessions', { method: 'POST', credentials: 'include' });
    if (!response.ok && response.status !== 429) throw new Error('Gateway session could not be started.');
  }

  async function openSite(event: FormEvent) {
    event.preventDefault();
    setError('');
    setFrameUrl('');
    let parsed: URL;
    try {
      parsed = new URL(url.trim());
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only HTTP and HTTPS websites are supported.');
      if (parsed.username || parsed.password) throw new Error('URLs containing credentials are not allowed.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Enter a valid website URL.');
      return;
    }
    setLoading(true);
    try {
      await ensureSession();
      setFrameUrl(`/api/web/page?url=${encodeURIComponent(parsed.toString())}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The protected web gateway is unavailable.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <main style={{ height: '100%', minHeight: 0, padding: 24, boxSizing: 'border-box', display: 'flex', flexDirection: 'column' }}>
      <div style={{ width: '100%', minWidth: 0, minHeight: 0, flex: 1, display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 24, marginBottom: 18, flex: 'none' }}>
          <div>
            <div style={{ fontSize: 12, letterSpacing: '.08em', textTransform: 'uppercase', opacity: .65 }}>Protected web workspace</div>
            <h1 style={{ fontSize: 34, margin: '8px 0' }}>Open a website through Internet Lab</h1>
            <p style={{ maxWidth: 720, opacity: .72, margin: 0 }}>The server fetches the page and its public resources. The browser displays only the protected internal proxy URL.</p>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, opacity: .75 }}><ShieldCheck size={16} /> Gateway protected</div>
        </div>

        <section style={{ border: '1px solid hsl(var(--border))', borderRadius: 14, padding: 18, background: 'hsl(var(--card))', flex: 'none' }}>
          <form onSubmit={openSite} style={{ display: 'flex', gap: 10 }}>
            <div style={{ flex: 1, position: 'relative', minWidth: 0 }}>
              <Globe2 size={16} style={{ position: 'absolute', left: 13, top: 14, opacity: .55 }} />
              <input value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Website URL" placeholder="https://example.com" style={{ width: '100%', height: 44, boxSizing: 'border-box', padding: '0 14px 0 38px', borderRadius: 9, border: '1px solid hsl(var(--border))', background: 'hsl(var(--background))', color: 'inherit' }} />
            </div>
            <button type="submit" disabled={loading || !url.trim()} style={{ height: 44, padding: '0 18px', border: 0, borderRadius: 9, background: 'hsl(var(--primary))', color: 'hsl(var(--primary-foreground))', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              {loading ? <RefreshCw size={15} className="animate-spin" /> : <Globe2 size={15} />} Open
            </button>
          </form>
          {error && <div role="alert" style={{ marginTop: 10, color: 'hsl(var(--destructive))', fontSize: 13 }}>{error}</div>}
          <div style={{ marginTop: 12, display: 'flex', gap: 7, alignItems: 'center', fontSize: 12, opacity: .65 }}><LockKeyhole size={13} /> JavaScript is enabled inside an isolated sandbox; dynamic requests are routed through the protected gateway.</div>
        </section>

        <section style={{ marginTop: 18, border: '1px solid hsl(var(--border))', borderRadius: 14, overflow: 'hidden', background: 'white', flex: 1, minHeight: 0, minWidth: 0, display: 'flex' }} aria-label="Protected website viewer">
          {frameUrl ? (
            <iframe ref={frameRef} title="Protected website" src={frameUrl} sandbox="allow-scripts" referrerPolicy="no-referrer" style={{ width: '100%', height: '100%', minHeight: 0, minWidth: 0, border: 0, display: 'block', flex: 1 }} />
          ) : (
            <div style={{ width: '100%', minHeight: 0, display: 'grid', placeItems: 'center', padding: 32, boxSizing: 'border-box', textAlign: 'center', opacity: .65 }}>
              <div><ShieldCheck size={34} /><h2 style={{ margin: '12px 0 6px' }}>Ready</h2><p style={{ margin: 0 }}>Enter a public website above and press Open.</p></div>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
