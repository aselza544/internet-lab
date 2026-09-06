import { useMemo, useState, type ReactNode } from 'react';
import { Activity, Boxes, FileCode2, FileText, Globe2, Menu, Network, Server, Settings, ShieldCheck, Video } from 'lucide-react';
import { Link, useLocation } from 'wouter';

const navItems = [
  { href: '/', label: 'Web workspace', icon: Globe2 },
  { href: '/messages', label: 'Messages', icon: FileText },
  { href: '/video', label: 'Video', icon: Video },
  { href: '/files', label: 'Files', icon: Boxes },
  { href: '/apis', label: 'APIs', icon: FileCode2 },
  { href: '/servers', label: 'Servers', icon: Server },
  { href: '/network', label: 'Network', icon: Network },
];

export function AppShell({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const currentLabel = useMemo(
    () => navItems.find((item) => item.href === location)?.label ?? (location === '/settings' ? 'Settings' : 'Workspace'),
    [location],
  );

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true"><ShieldCheck size={19} strokeWidth={2.5} /></div>
          <div>
            <div className="brand-name">Internet Lab</div>
            <div className="brand-subtitle">secure gateway</div>
          </div>
        </div>
        <div className="nav-label">Workspace</div>
        <nav className={`nav-list${mobileOpen ? ' mobile-open' : ''}`} aria-label="Main navigation">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = location === item.href;
            return (
              <Link key={item.href} href={item.href} onClick={() => setMobileOpen(false)} className={`nav-link${active ? ' active' : ''}`} data-testid={`link-${item.label.toLowerCase().replaceAll(' ', '-')}`}>
                <Icon className="nav-icon" strokeWidth={1.8} />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>
        <div className="sidebar-spacer" />
        <Link href="/settings" onClick={() => setMobileOpen(false)} className={`nav-link${location === '/settings' ? ' active' : ''}`} data-testid="link-settings">
          <Settings className="nav-icon" strokeWidth={1.8} />
          <span>Settings</span>
        </Link>
        <div className="session-chip" data-testid="status-session">
          <div className="session-chip-head"><span className="live-dot" /> Development session</div>
          <p>Auth is not configured. Requests remain policy-enforced and server-side.</p>
        </div>
        <button className="mobile-menu" aria-label="Navigation menu" aria-expanded={mobileOpen} onClick={() => setMobileOpen((open) => !open)} type="button" data-testid="button-mobile-menu"><Menu size={20} /></button>
      </aside>
      <div className="main-column">
        <header className="topbar">
          <div className="crumb"><strong>Internet Lab</strong><span> / </span>{currentLabel}</div>
          <div className="topbar-right">
            <div className="connection-pill"><Activity size={12} /> gateway protected</div>
            <div className="avatar" aria-label="Development session">DL</div>
          </div>
        </header>
        {children}
      </div>
    </div>
  );
}