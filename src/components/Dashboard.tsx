'use client';
import React from 'react';
import {
  Users, Globe, Link2, LayoutDashboard, FileImage, Terminal,
  FileText, Play, Settings, Zap, Bot, ExternalLink,
  CheckCircle2, XCircle, Clock, Wifi, WifiOff
} from 'lucide-react';
import { AppProvider, useApp } from './AppContext';
import { ToastContainer } from './Views';
import { DashboardView }   from './views/DashboardView';
import { ScreenshotsView } from './views/ScreenshotsView';
import { TerminalView }    from './views/TerminalView';
import { ScriptsView }     from './views/ScriptsView';
import { SettingsView }    from './views/SettingsView';
import { LogFilesView }    from './views/LogFilesView';
import { AccountsView }    from './views/AccountsView';
import { ProxiesView }     from './views/ProxiesView';
import { ConnectionsView } from './views/ConnectionsView';

// ── Nav Item ─────────────────────────────────────────────
function NavItem({
  id, icon: Icon, label, badge, badgeColor = 'b',
}: {
  id: string; icon: React.ElementType; label: string; badge?: number; badgeColor?: string;
}) {
  const { view, setView } = useApp();
  return (
    <div className={`nav-btn${view === id ? ' active' : ''}`} onClick={() => setView(id)}>
      <Icon size={15} className="nav-ico" style={{ flexShrink: 0 }} />
      <span>{label}</span>
      {badge != null && badge > 0 && (
        <span className={`nav-badge ${badgeColor}`}>{badge}</span>
      )}
    </div>
  );
}

// ── Sidebar ───────────────────────────────────────────────
function Sidebar() {
  const { view, setView, connected, processes, startCamofox, startWorker } = useApp();
  const procs   = Object.values(processes);
  const running = procs.filter(p => p.status === 'running').length;
  const errors  = procs.filter(p => p.status === 'error').length;

  const isCamofox = processes['camofox']?.status === 'running';
  const isWorker  = processes['worker']?.status  === 'running';

  return (
    <aside className="sidebar">
      {/* Brand */}
      <div className="sidebar-brand">
        <div className="brand-icon">🛠️</div>
        <div>
          <div className="brand-name">SeeLLM Tools</div>
          <div className="brand-ver">v2.0 · D1 Hub</div>
        </div>
      </div>

      {/* Nav */}
      <nav className="sidebar-nav">
        <div className="nav-section-label">Tổng quan</div>
        <NavItem id="dashboard"   icon={LayoutDashboard} label="Dashboard"    badge={running} badgeColor="g" />
        <NavItem id="screenshots" icon={FileImage}       label="Screenshots" />
        <NavItem id="terminal"    icon={Terminal}        label="Terminal Logs" badge={errors}  badgeColor="r" />
        <NavItem id="logfiles"    icon={FileText}        label="Log Files" />

        <div className="nav-section-label">Quản lý Cloud (D1)</div>
        <NavItem id="accounts"    icon={Users}  label="Accounts" />
        <NavItem id="proxies"     icon={Globe}  label="Proxy Pool" />
        <NavItem id="connections" icon={Link2}  label="Connections" />

        <div className="nav-section-label">Công cụ</div>
        <NavItem id="scripts"  icon={Play}     label="Scripts" />
        <NavItem id="settings" icon={Settings} label="Cài đặt" />

        <div className="nav-section-label">Tài nguyên</div>
        <div className="nav-btn" onClick={() => window.open('https://github.com/jo-inc/camofox-browser', '_blank')}>
          <span className="nav-ico">🦊</span>
          <span>Camofox Docs</span>
          <ExternalLink size={11} style={{ marginLeft: 'auto', color: 'var(--text-3)' }} />
        </div>
      </nav>

      {/* Footer */}
      <div className="sidebar-foot">
        <div className="launch-row">
          <button className="launch-btn camofox" onClick={startCamofox} disabled={isCamofox}>
            🦊 {isCamofox ? 'Running' : 'Start'}
          </button>
          <button className="launch-btn worker" onClick={startWorker} disabled={isWorker}>
            🤖 {isWorker ? 'Running' : 'Start'}
          </button>
        </div>
        <div className="conn-status">
          <div className={`dot ${connected ? 'on' : 'off'}`} />
          <span>{connected ? 'Realtime connected' : 'Disconnected'}</span>
        </div>
      </div>
    </aside>
  );
}

// ── Topbar ────────────────────────────────────────────────
const PAGE_META: Record<string, { title: string; desc: string }> = {
  dashboard:   { title: 'Dashboard',    desc: 'Tổng quan hệ thống và trạng thái realtime' },
  accounts:    { title: 'Accounts',     desc: 'Quản lý tài khoản Managed · D1 Cloud Edge' },
  proxies:     { title: 'Proxy Pool',   desc: 'Quản lý Proxy Pool Automation · D1 Cloud Edge' },
  connections: { title: 'Connections',  desc: 'Danh sách token đã xác thực · D1 Cloud Edge' },
  screenshots: { title: 'Screenshots',  desc: 'Ảnh chụp màn hình từ các phiên login' },
  terminal:    { title: 'Terminal Logs', desc: 'Output realtime từ các processes' },
  logfiles:    { title: 'Log Files',    desc: 'Danh sách file log đã được lưu' },
  scripts:     { title: 'Scripts',      desc: 'Các scripts tích hợp sẵn' },
  settings:    { title: 'Cài đặt',      desc: 'Cấu hình hệ thống · Tools & Gateway' },
};

const PAGE_ICONS: Record<string, React.ElementType> = {
  dashboard: LayoutDashboard, accounts: Users, proxies: Globe,
  connections: Link2, screenshots: FileImage, terminal: Terminal,
  logfiles: FileText, scripts: Play, settings: Settings,
};

function Topbar() {
  const { view, connected } = useApp();
  const meta = PAGE_META[view] || PAGE_META.dashboard;
  const Icon = PAGE_ICONS[view] || LayoutDashboard;
  return (
    <header className="topbar">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ width: 32, height: 32, borderRadius: 8, background: 'var(--glass-3)', border: '1px solid var(--border-2)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--indigo-2)' }}>
          <Icon size={16} />
        </div>
        <div className="topbar-title">
          <h1>{meta.title}</h1>
          <p>{meta.desc}</p>
        </div>
      </div>

      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '5px 12px', borderRadius: 99,
          background: connected ? 'var(--green-dim)' : 'var(--rose-dim)',
          border: `1px solid ${connected ? 'rgba(16,185,129,.25)' : 'rgba(244,63,94,.25)'}`,
          fontSize: 11, fontWeight: 600,
          color: connected ? 'var(--green)' : 'var(--rose)',
        }}>
          {connected ? <Wifi size={11} /> : <WifiOff size={11} />}
          {connected ? 'Live' : 'Offline'}
        </div>
      </div>
    </header>
  );
}

// ── Content router ────────────────────────────────────────
function ContentRouter() {
  const { view } = useApp();
  return (
    <>
      {view === 'dashboard'   && <DashboardView />}
      {view === 'accounts'    && <AccountsView />}
      {view === 'proxies'     && <ProxiesView />}
      {view === 'connections' && <ConnectionsView />}
      {view === 'screenshots' && <ScreenshotsView />}
      {view === 'terminal'    && <TerminalView />}
      {view === 'logfiles'    && <LogFilesView />}
      {view === 'scripts'     && <ScriptsView />}
      {view === 'settings'    && <SettingsView />}
    </>
  );
}

export default function Dashboard() {
  return (
    <AppProvider>
      <div className="shell">
        <Sidebar />
        <main className="main">
          <Topbar />
          <ContentRouter />
        </main>
      </div>
      <ToastContainer />
    </AppProvider>
  );
}
