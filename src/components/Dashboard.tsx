'use client';
import React from 'react';
import {
  Users, Globe, Link2, LayoutDashboard, FileImage, Terminal,
  FileText, Play, Settings, Zap, Bot, ExternalLink,
  CheckCircle2, XCircle, Clock, Wifi, WifiOff, History as HistoryIcon
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
import { ChangelogView }   from './views/ChangelogView';
import { CamofoxDocsView } from './views/CamofoxDocsView';

// --- Vault Views ---
import { VaultAccountsView } from './views/vault/VaultAccountsView';
import { VaultProxiesView }  from './views/vault/VaultProxiesView';

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
          <div className="brand-ver">v3.0 · Vault Beta</div>
        </div>
      </div>

      {/* Nav */}
      <nav className="sidebar-nav">
        <div className="nav-section-label">Tổng quan</div>
        <NavItem id="dashboard"   icon={LayoutDashboard} label="Dashboard"    badge={running} badgeColor="g" />
        <NavItem id="terminal"    icon={Terminal}        label="Terminal Logs" badge={errors}  badgeColor="r" />
        <NavItem id="logfiles"    icon={FileText}        label="Log Files" />
        <NavItem id="screenshots" icon={FileImage}       label="Screenshots" />

        <div className="nav-section-label">Vault (Local)</div>
        <NavItem id="vault-accounts" icon={Users} label="Accounts" />
        <NavItem id="vault-proxies"  icon={Globe} label="Proxies" />
        <NavItem id="vault-keys"     icon={Zap}   label="API Keys" />

        <div className="nav-section-label">D1 Cloud (D1)</div>
        <NavItem id="accounts"    icon={Bot}    label="Codex Accts" />
        <NavItem id="proxies"     icon={Globe}  label="Proxy Pool" />
        <NavItem id="connections" icon={Link2}  label="Connections" />

        <div className="nav-section-label">Công cụ</div>
        <NavItem id="scripts"   icon={Play}        label="Scripts" />
        <NavItem id="settings"  icon={Settings}    label="Cài đặt" />
        <NavItem id="changelog" icon={HistoryIcon} label="Change Logs" />

        <div className="nav-section-label">Tài nguyên</div>
        <NavItem id="camofox-docs" icon={FileText} label="Camofox Docs" />
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
  'vault-accounts': { title: 'Vault Accounts', desc: 'Quản lý tài khoản cá nhân đa nhà cung cấp · Local Vault' },
  'vault-proxies':  { title: 'Vault Proxies',  desc: 'Danh sách Proxy cá nhân được bảo mật · Local Vault' },
  'vault-keys':     { title: 'Vault API Keys', desc: 'Quản lý API Keys cá nhân · Local Vault' },
  accounts:    { title: 'Codex Accounts', desc: 'Quản lý tài khoản Managed · D1 Cloud Edge' },
  proxies:     { title: 'Proxy Pool',   desc: 'Quản lý Proxy Pool Automation · D1 Cloud Edge' },
  connections: { title: 'Connections',  desc: 'Danh sách token đã xác thực · D1 Cloud Edge' },
  screenshots: { title: 'Screenshots',  desc: 'Ảnh chụp màn hình từ các phiên login' },
  terminal:    { title: 'Terminal Logs', desc: 'Output realtime từ các processes' },
  logfiles:    { title: 'Log Files',    desc: 'Danh sách file log đã được lưu' },
  scripts:     { title: 'Scripts',      desc: 'Các scripts tích hợp sẵn' },
  settings:    { title: 'Cài đặt',      desc: 'Cấu hình hệ thống · Tools & Gateway' },
  changelog:   { title: 'Change Logs',   desc: 'Lịch sử cập nhật hệ thống SeeLLM Tools' },
  'camofox-docs': { title: 'Camofox Docs', desc: 'Tài liệu hướng dẫn custom Camofox API' },
};

const PAGE_ICONS: Record<string, React.ElementType> = {
  dashboard: LayoutDashboard, accounts: Users, proxies: Globe,
  connections: Link2, screenshots: FileImage, terminal: Terminal,
  logfiles: FileText, scripts: Play, settings: Settings,
  changelog: HistoryIcon, 'camofox-docs': FileText,
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
      {view === 'dashboard'      && <DashboardView />}
      
      {/* Vault */}
      {view === 'vault-accounts' && <VaultAccountsView />}
      {view === 'vault-proxies'  && <VaultProxiesView />}
      {view === 'vault-keys'     && <div className="content">Coming Soon (M1 Backend done, UI Pending)</div>}
      
      {/* D1 */}
      {view === 'accounts'    && <AccountsView />}
      {view === 'proxies'     && <ProxiesView />}
      {view === 'connections' && <ConnectionsView />}
      
      {view === 'screenshots' && <ScreenshotsView />}
      {view === 'terminal'    && <TerminalView />}
      {view === 'logfiles'    && <LogFilesView />}
      {view === 'scripts'     && <ScriptsView />}
      {view === 'settings'    && <SettingsView />}
      {view === 'changelog'   && <ChangelogView />}
      {view === 'camofox-docs' && <CamofoxDocsView />}
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
