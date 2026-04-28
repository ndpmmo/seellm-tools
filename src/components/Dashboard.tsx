'use client';
import React from 'react';
import {
  Users, Globe, Link2, LayoutDashboard, FileImage, Terminal,
  FileText, Play, Settings, Zap, Bot, ExternalLink,
  CheckCircle2, XCircle, Clock, Wifi, WifiOff, History as HistoryIcon, Mail
} from 'lucide-react';
import { AppProvider, useApp } from './AppContext';
import { ToastContainer } from './Views';
import { DashboardView } from './views/DashboardView';
import { ScreenshotsView } from './views/ScreenshotsView';
import { TerminalView } from './views/TerminalView';
import { ScriptsView } from './views/ScriptsView';
import { SettingsView } from './views/SettingsView';
import { LogFilesView } from './views/LogFilesView';
import { ServicesView } from './views/ServicesView';
import { ProxiesView } from './views/ProxiesView';
import { ConnectionsView } from './views/ConnectionsView';
import { ChangelogView } from './views/ChangelogView';
import { CamofoxDocsView } from './views/CamofoxDocsView';

// --- Vault Views ---
import { VaultAccountsView } from './views/vault/VaultAccountsView';
import { VaultProxiesView } from './views/vault/VaultProxiesView';
import { VaultWorkshopView } from './views/vault/VaultWorkshopView';

// ── Nav Item ─────────────────────────────────────────────
function NavItem({
  id, icon: Icon, label, badge, badgeColor = 'blue',
}: {
  id: string; icon: React.ElementType; label: string; badge?: number; badgeColor?: string;
}) {
  const { view, setView } = useApp();
  const isActive = view === id;

  const bgColors: Record<string, string> = {
    green: 'bg-emerald-500/10 text-emerald-500',
    red: 'bg-rose-500/10 text-rose-500',
    blue: 'bg-cyan-500/10 text-cyan-500',
    violet: 'bg-violet-500/10 text-violet-500'
  };

  return (
    <div
      className={`relative flex items-center gap-2.5 px-2.5 py-2 rounded-md cursor-pointer transition-all duration-150 select-none text-[13px] font-medium border ${isActive
          ? 'bg-gradient-to-br from-indigo-500/10 to-violet-500/5 text-indigo-400 border-indigo-500/20'
          : 'border-transparent text-slate-400 hover:bg-white/5 hover:text-slate-200 hover:border-white/10'
        }`}
      onClick={() => setView(id)}
    >
      {isActive && (
        <div className="absolute left-0 top-1/5 bottom-1/5 w-[2.5px] bg-gradient-to-b from-indigo-500 to-violet-500 rounded-r-full" />
      )}
      <Icon size={15} className="shrink-0 text-center w-[18px]" />
      <span>{label}</span>
      {badge != null && badge > 0 && (
        <span className={`ml-auto text-[10px] font-bold px-[7px] py-[1px] rounded-full min-w-[20px] text-center tracking-[0.2px] ${bgColors[badgeColor] || bgColors.blue}`}>
          {badge}
        </span>
      )}
    </div>
  );
}

// ── Sidebar ───────────────────────────────────────────────
function Sidebar() {
  const { view, setView, connected, processes, startCamofox, startWorker, startConnectWorker } = useApp();
  const procs = Object.values(processes);
  const running = procs.filter(p => p.status === 'running').length;
  const errors = procs.filter(p => p.status === 'error').length;

  const isCamofox = processes['camofox']?.status === 'running';
  const isWorker = processes['worker']?.status === 'running';
  const isConnectWorker = processes['connect-worker']?.status === 'running';

  return (
    <aside className="w-[248px] min-w-[248px] h-screen flex flex-col bg-[#090c16]/85 border-r border-white/5 backdrop-blur-2xl relative z-10">
      <div className="absolute top-0 left-0 right-0 h-[1px] bg-gradient-to-r from-transparent via-indigo-500/50 to-transparent pointer-events-none" />

      {/* Brand */}
      <div className="px-4 pt-[18px] pb-3.5 border-b border-white/5 flex items-center gap-3 shrink-0">
        <div className="w-9 h-9 bg-gradient-to-br from-indigo-500 to-violet-500 rounded-xl flex items-center justify-center text-lg shrink-0 shadow-[0_0_20px_rgba(99,102,241,0.22),_0_4px_8px_rgba(0,0,0,0.3)]">
          🛠️
        </div>
        <div>
          <div className="text-[14px] font-bold text-slate-100 tracking-[-0.4px]">SeeLLM Tools</div>
          <div className="text-[10.5px] text-slate-400 mt-[1px] tracking-[0.2px]">v3.0 · Vault Beta</div>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-2 py-2.5 overflow-y-auto flex flex-col gap-[1px] scrollbar-thin scrollbar-thumb-white/10 scrollbar-track-transparent">
        <div className="text-[9.5px] font-bold text-slate-500 uppercase tracking-[1px] px-2.5 pt-3 pb-1.5 flex items-center gap-1.5 after:content-[''] after:flex-1 after:h-[1px] after:bg-white/5">Tổng quan</div>
        <NavItem id="dashboard" icon={LayoutDashboard} label="Dashboard" badge={running} badgeColor="green" />
        <NavItem id="terminal" icon={Terminal} label="Terminal Logs" badge={errors} badgeColor="red" />
        <NavItem id="logfiles" icon={FileText} label="Log Files" />
        <NavItem id="screenshots" icon={FileImage} label="Screenshots" />

        <div className="text-[9.5px] font-bold text-slate-500 uppercase tracking-[1px] px-2.5 pt-3 pb-1.5 flex items-center gap-1.5 after:content-[''] after:flex-1 after:h-[1px] after:bg-white/5">Vault (Local)</div>
        <NavItem id="vault-accounts" icon={Users} label="Account Vault" />
        <NavItem id="vault-workshop" icon={Zap} label="Vault Workshop" />
        <NavItem id="vault-proxies" icon={Globe} label="Proxy Manager" />
        <NavItem id="vault-keys" icon={Zap} label="API Keys" />

        <div className="text-[9.5px] font-bold text-slate-500 uppercase tracking-[1px] px-2.5 pt-3 pb-1.5 flex items-center gap-1.5 after:content-[''] after:flex-1 after:h-[1px] after:bg-white/5">Cloud (D1 Edge)</div>
        <NavItem id="services" icon={Bot} label="Managed Services" />
        <NavItem id="proxies" icon={Globe} label="Gateway Proxies" />
        <NavItem id="connections" icon={Link2} label="Connections" />

        <div className="text-[9.5px] font-bold text-slate-500 uppercase tracking-[1px] px-2.5 pt-3 pb-1.5 flex items-center gap-1.5 after:content-[''] after:flex-1 after:h-[1px] after:bg-white/5">Công cụ</div>
        <NavItem id="scripts" icon={Play} label="Scripts" />
        <NavItem id="settings" icon={Settings} label="Cài đặt" />
        <NavItem id="changelog" icon={HistoryIcon} label="Change Logs" />

        <div className="text-[9.5px] font-bold text-slate-500 uppercase tracking-[1px] px-2.5 pt-3 pb-1.5 flex items-center gap-1.5 after:content-[''] after:flex-1 after:h-[1px] after:bg-white/5">Tài nguyên</div>
        <NavItem id="camofox-docs" icon={FileText} label="Camofox Docs" />
      </nav>

      {/* Footer */}
      <div className="px-2 pt-2.5 pb-3.5 border-t border-white/5 flex flex-col gap-2 shrink-0">
        <div className="flex gap-1.5">
          <button
            className={`flex-1 flex items-center justify-center gap-1.5 px-1.5 py-1.5 rounded-md text-[11.5px] font-semibold border transition-all duration-130 whitespace-nowrap ${isCamofox ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20' : 'bg-emerald-500/5 text-emerald-400 border-emerald-500/10 hover:bg-emerald-500/20 hover:shadow-[0_0_12px_rgba(16,185,129,0.18)]'}`}
            onClick={startCamofox} disabled={isCamofox}
          >
            🦊 {isCamofox ? 'Running' : 'Start'}
          </button>
          <button
            className={`flex-1 flex items-center justify-center gap-1.5 px-1.5 py-1.5 rounded-md text-[11.5px] font-semibold border transition-all duration-130 whitespace-nowrap ${isWorker ? 'bg-indigo-500/15 text-indigo-400 border-indigo-500/25' : 'bg-indigo-500/10 text-indigo-300 border-indigo-500/20 hover:bg-indigo-500/20 hover:shadow-[0_0_12px_rgba(99,102,241,0.22)]'}`}
            onClick={startWorker} disabled={isWorker}
          >
            🤖 {isWorker ? 'Running' : 'Start'}
          </button>
        </div>
        <div className="flex gap-1.5 mt-1.5">
          <button
            className={`flex-1 rounded-lg text-[11px] font-bold py-2 border transition-all duration-200 ${isConnectWorker ? 'bg-indigo-500/25 text-indigo-400 border-indigo-500/25 cursor-not-allowed' : 'bg-indigo-500/10 text-indigo-300 border-indigo-500/25 hover:bg-indigo-500/20'}`}
            onClick={startConnectWorker}
            disabled={isConnectWorker}
          >
            🔌 {isConnectWorker ? 'Connect Running' : 'Start Connect v2'}
          </button>
        </div>
        <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-md bg-white/5 border border-white/5 text-[11.5px] text-slate-400">
          <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${connected ? 'bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.18)] animate-pulse' : 'bg-slate-600'}`} />
          <span>{connected ? 'Realtime connected' : 'Disconnected'}</span>
        </div>
      </div>
    </aside>
  );
}

// ── Topbar ────────────────────────────────────────────────
const PAGE_META: Record<string, { title: string; desc: string }> = {
  dashboard: { title: 'Dashboard', desc: 'Tổng quan hệ thống và trạng thái realtime' },
  'vault-accounts': { title: 'Account Vault', desc: 'Kho tài khoản cá nhân đa nhà cung cấp · Local SQLite' },
  'vault-workshop': { title: 'Vault Workshop', desc: 'Hệ thống quản lý và dập account tự động tập trung' },
  'vault-proxies': { title: 'Proxy Manager', desc: 'Kho proxy tổng hợp — lưu, kiểm tra, phân loại · Local Vault' },
  'vault-keys': { title: 'Vault API Keys', desc: 'Quản lý API Keys cá nhân · Local Vault' },
  services: { title: 'Managed Services', desc: 'Tài khoản cloud đa dịch vụ: ChatGPT · Claude · Gemini · Cursor · D1 Edge' },
  proxies: { title: 'Gateway Proxies', desc: 'Proxy Pool cho ChatGPT/Codex Automation · D1 Cloud Edge (Gateway)' },
  connections: { title: 'Connections', desc: 'Danh sách token đã xác thực · D1 Cloud Edge' },
  screenshots: { title: 'Screenshots', desc: 'Ảnh chụp màn hình từ các phiên login' },
  terminal: { title: 'Terminal Logs', desc: 'Output realtime từ các processes' },
  logfiles: { title: 'Log Files', desc: 'Danh sách file log đã được lưu' },
  scripts: { title: 'Scripts', desc: 'Các scripts tích hợp sẵn' },
  settings: { title: 'Cài đặt', desc: 'Cấu hình hệ thống · Tools & Gateway' },
  changelog: { title: 'Change Logs', desc: 'Lịch sử cập nhật hệ thống SeeLLM Tools' },
  'camofox-docs': { title: 'Camofox Docs', desc: 'Tài liệu hướng dẫn custom Camofox API' },
};

const PAGE_ICONS: Record<string, React.ElementType> = {
  dashboard: LayoutDashboard, services: Bot, proxies: Globe,
  'vault-workshop': Zap,
  connections: Link2, screenshots: FileImage, terminal: Terminal,
  logfiles: FileText, scripts: Play, settings: Settings,
  changelog: HistoryIcon, 'camofox-docs': FileText,
};

function Topbar() {
  const { view, connected } = useApp();
  const meta = PAGE_META[view] || PAGE_META.dashboard;
  const Icon = PAGE_ICONS[view] || LayoutDashboard;
  return (
    <header className="h-[52px] shrink-0 flex items-center px-[22px] border-b border-white/5 bg-[#090c16]/60 backdrop-blur-xl gap-3.5 relative z-[5] after:content-[''] after:absolute after:bottom-0 after:left-0 after:right-0 after:h-[1px] after:bg-gradient-to-r after:from-transparent after:via-white/5 after:to-transparent">
      <div className="flex items-center gap-2.5">
        <div className="w-8 h-8 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center text-indigo-400">
          <Icon size={16} />
        </div>
        <div className="flex-1 min-w-0">
          <h1 className="text-[15px] font-bold text-slate-100">{meta.title}</h1>
          <p className="text-[11px] text-slate-400 mt-[1px]">{meta.desc}</p>
        </div>
      </div>

      <div className="ml-auto flex items-center gap-2">
        <div className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-semibold border ${connected
            ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-500'
            : 'bg-rose-500/10 border-rose-500/25 text-rose-500'
          }`}>
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
      {view === 'dashboard' && <DashboardView />}

      {/* Vault */}
      {view === 'vault-accounts' && <VaultAccountsView />}
      {view === 'vault-workshop' && <VaultWorkshopView />}
      {view === 'vault-proxies' && <VaultProxiesView />}
      {view === 'vault-keys' && <div className="content">Coming Soon (M1 Backend done, UI Pending)</div>}

      {/* D1 */}
      {view === 'services' && <ServicesView />}
      {view === 'proxies' && <ProxiesView />}
      {view === 'connections' && <ConnectionsView />}

      {view === 'screenshots' && <ScreenshotsView />}
      {view === 'terminal' && <TerminalView />}
      {view === 'logfiles' && <LogFilesView />}
      {view === 'scripts' && <ScriptsView />}
      {view === 'settings' && <SettingsView />}
      {view === 'changelog' && <ChangelogView />}
      {view === 'camofox-docs' && <CamofoxDocsView />}
    </>
  );
}

export default function Dashboard() {
  return (
    <AppProvider>
      <div className="flex h-screen w-full overflow-hidden bg-[radial-gradient(ellipse_80%_60%_at_5%_-10%,_rgba(99,102,241,0.12)_0%,_transparent_60%),_radial-gradient(ellipse_60%_50%_at_95%_105%,_rgba(34,211,238,0.07)_0%,_transparent_55%),_#07090f] text-slate-100 font-sans antialiased selection:bg-indigo-500/30">
        <Sidebar />
        <main className="flex-1 flex flex-col min-w-0 h-screen overflow-hidden">
          <Topbar />
          <div className="flex-1 min-h-0 relative h-full">
            <ContentRouter />
          </div>
        </main>
        <ToastContainer />
      </div>
    </AppProvider>
  );
}
