'use client';
import React, { useCallback, useEffect, useState } from 'react';
import {
  Plus, Search, RefreshCw, Pencil, Trash2, Save, X,
  ChevronRight, Users, Tag, Filter,
  Database, Shield, Globe, Key, CopyPlus, FileUp, RotateCcw, Copy, Check, Square, CheckSquare,
  Bot, PhoneOff, Skull, Lock, Unlock, HelpCircle, Mail, XCircle, Briefcase, Flame, AlertTriangle, Clock
} from 'lucide-react';
import { useApp } from '../../AppContext';
import { fmtDateTimeVN, useConfirm } from '../../Views';
import { Button, Card, CardHeader, CardTitle, CardContent, Input, GatewayBadge } from '../../ui';

/* ── Helpers ── */
function getRelativeTimeShort(isoString?: string) {
  if (!isoString) return '';
  const date = new Date(isoString);
  const diffMs = Date.now() - date.getTime();
  if (diffMs < 0) return 'vừa xong';
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'vừa xong';
  if (mins < 60) return `${mins}p`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}g`;
  const days = Math.floor(hours / 24);
  return `${days}n`;
}

function StatusBadge({ status, notes, tags = [] }: { status: string; notes?: string; tags?: string[] }) {
  // 1. Trường hợp đặc biệt cao nhất: tài khoản bị Vô hiệu hóa (Dead / Deactivated)
  if (tags.includes('account_deactivated') || status === 'dead') {
    return (
      <span title={notes} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-rose-500/10 text-rose-500 font-bold border border-rose-500/20">
        <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />
        💀 Dead
      </span>
    );
  }

  // 2. Trường hợp đặc biệt tiếp theo: lỗi yêu cầu số điện thoại (Need Phone)
  // Dùng tags.includes('need_phone') để bền vững kể cả khi status đã bị chuyển thành 'idle' hoặc 'error' khác.
  if (tags.includes('need_phone') || (status === 'error' && notes && notes.includes('NEED_PHONE'))) {
    return (
      <span title={notes} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-orange-500/10 text-orange-500 border border-orange-500/20">
        <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />
        📵 Cần SĐT
      </span>
    );
  }

  const m: Record<string, { color: string; bg: string; border: string; label: string }> = {
    ready: { color: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/20', label: 'Ready' },
    idle: { color: 'text-slate-400', bg: 'bg-white/5', border: 'border-white/5', label: 'Idle' },
    error: { color: 'text-rose-400', bg: 'bg-rose-500/10', border: 'border-rose-500/20', label: 'Error' },
    pending: { color: 'text-amber-400', bg: 'bg-amber-500/10', border: 'border-amber-500/20', label: 'Pending' },
    processing: { color: 'text-indigo-400', bg: 'bg-indigo-500/10', border: 'border-indigo-500/20', label: 'Processing' },
    relogin: { color: 'text-purple-400', bg: 'bg-purple-500/10', border: 'border-purple-500/20', label: 'Re-login' },
  };

  const s = m[status] || { color: 'text-slate-400', bg: 'bg-white/5', border: 'border-white/5', label: status.toUpperCase() };
  const isPulsing = status === 'pending' || status === 'processing';
  return (
    <span title={notes} className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold whitespace-nowrap ${s.bg} ${s.color} border ${s.border}`}>
      <span className={`w-1.5 h-1.5 rounded-full bg-current ${isPulsing ? 'animate-pulse' : ''}`} />
      {s.label}
    </span>
  );
}

function PlanBadge({ plan }: { plan?: string }) {
  if (!plan) return null;
  const p = plan.toLowerCase();

  let styles = { bg: 'bg-slate-500/10', color: 'text-slate-400', border: 'border-slate-500/20', label: 'Free' };

  if (p.includes('plus')) styles = { bg: 'bg-emerald-500/10', color: 'text-emerald-400', border: 'border-emerald-500/20', label: 'Plus' };
  else if (p.includes('pro')) styles = { bg: 'bg-indigo-500/10', color: 'text-indigo-400', border: 'border-indigo-500/20', label: 'Pro' };
  else if (p.includes('team') || p.includes('business')) styles = { bg: 'bg-amber-500/10', color: 'text-amber-400', border: 'border-amber-500/20', label: 'Team' };
  else if (p.includes('go')) styles = { bg: 'bg-blue-500/10', color: 'text-blue-400', border: 'border-blue-500/20', label: 'Go' };

  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wide ${styles.bg} ${styles.color} border ${styles.border}`}>
      {styles.label}
    </span>
  );
}

/* ── Compact Copy Component ── */
function CopyBadge({ text, label, icon: Icon, colorClass = 'text-slate-400', hoverBorderClass = 'hover:border-slate-400' }: { text?: string; label?: string; icon: any; colorClass?: string; hoverBorderClass?: string }) {
  const [copied, setCopied] = useState(false);
  if (!text) return null;

  const onCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div
      onClick={onCopy}
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-white/5 border border-white/10 cursor-pointer transition-all select-none ${hoverBorderClass}`}
    >
      <Icon size={11} className={colorClass} />
      <span className="text-[11px] font-mono text-slate-300 max-w-[80px] overflow-hidden text-ellipsis whitespace-nowrap">
        {text}
      </span>
      {copied ? <Check size={10} className="text-emerald-500" /> : <Copy size={10} className="opacity-50" />}
    </div>
  );
}

/* ── Tag Helpers ── */
function safeParseTags(raw: any): string[] {
  if (Array.isArray(raw)) return raw;
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

// Tag → icon + color mapping. Each tag renders as a small icon-only badge with tooltip.
const TAG_META: Record<string, { icon: any; color: string; bg: string; border: string; tip: string }> = {
  'auto-register': { icon: Bot, color: 'text-indigo-400', bg: 'bg-indigo-500/10', border: 'border-indigo-500/20', tip: 'Auto-registered — tạo tự động qua worker' },
  'vault-register': { icon: Database, color: 'text-cyan-400', bg: 'bg-cyan-500/10', border: 'border-cyan-500/20', tip: 'Vault-registered — đăng ký qua vault UI' },
  'need_phone':    { icon: PhoneOff, color: 'text-rose-400', bg: 'bg-rose-500/10', border: 'border-rose-500/20', tip: 'Cần số điện thoại — yêu cầu xác thực SMS' },
  'email_dead':    { icon: Skull, color: 'text-rose-300', bg: 'bg-rose-500/10', border: 'border-rose-500/20', tip: 'Email đã chết — không thể truy cập hộp thư' },
  'workspace':     { icon: Briefcase, color: 'text-blue-400', bg: 'bg-blue-500/10', border: 'border-blue-500/20', tip: 'Tài khoản có Workspace — thuộc tổ chức/doanh nghiệp' },
  'account_deactivated': { icon: XCircle, color: 'text-rose-500 font-bold', bg: 'bg-rose-500/10', border: 'border-rose-500/20', tip: 'Tài khoản bị vô hiệu hóa — OpenAI Deactivated' },
  'email_pool_deleted': { icon: AlertTriangle, color: 'text-amber-400', bg: 'bg-amber-500/10', border: 'border-amber-500/20', tip: 'Email liên kết đã bị xóa khỏi Email Pool của Workshop' },
};

function TagIcons({ 
  tags, 
  twoFa, 
  provider,
  twoFaRegenStatus,
  twoFaRegenError
}: { 
  tags: string[]; 
  twoFa?: string; 
  provider?: string;
  twoFaRegenStatus?: string;
  twoFaRegenError?: string;
}) {
  const isOAI = !provider || provider === 'openai' || provider === 'codex';
  return (
    <span className="inline-flex items-center gap-1">
      {tags.map(t => {
        const meta = TAG_META[t];
        if (!meta) return null;
        const Icon = meta.icon;
        const isDead = t === 'email_dead';
        return (
          <span key={t} title={meta.tip} className={`inline-flex items-center justify-center w-[22px] h-[22px] rounded-md ${meta.bg} ${meta.color} border ${meta.border} cursor-help`}>
            <Icon size={12} className={isDead ? 'animate-pulse' : ''} />
          </span>
        );
      })}
      {isOAI && (() => {
        if (twoFaRegenStatus === 'pending') {
          return (
            <span title="Đang tái tạo 2FA/MFA..." className="inline-flex items-center justify-center w-[22px] h-[22px] rounded-md bg-teal-500/10 text-teal-400 border border-teal-500/20 cursor-help">
              <RefreshCw size={11} className="animate-spin" />
            </span>
          );
        }
        if (twoFaRegenStatus === 'failed') {
          return (
            <span title={`Tái tạo 2FA thất bại: ${twoFaRegenError || 'Lỗi không xác định'}`} className="inline-flex items-center justify-center w-[22px] h-[22px] rounded-md bg-rose-500/10 text-rose-400 border border-rose-500/20 cursor-help">
              <Lock size={12} />
            </span>
          );
        }
        if (twoFa) {
          return (
            <span title="Có 2FA — xác thực hai yếu tố đã bật" className="inline-flex items-center justify-center w-[22px] h-[22px] rounded-md bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 cursor-help">
              <Lock size={12} />
            </span>
          );
        }
        return (
          <span title="Chưa có 2FA — cần chạy Regenerate 2FA để tự động kích hoạt bảo mật" className="inline-flex items-center justify-center w-[22px] h-[22px] rounded-md bg-amber-500/10 text-amber-500/80 border border-amber-500/20 cursor-help">
            <Unlock size={12} />
          </span>
        );
      })()}
    </span>
  );
}

function TagLegend({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return (
    <div className="absolute right-0 top-full mt-1 z-50 w-72 bg-[#0d111c] border border-white/10 rounded-xl shadow-2xl p-4">
      <div className="flex items-center justify-between mb-3">
        <span className="text-[12px] font-bold text-slate-200">Giải thích biểu tượng</span>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-300"><X size={14} /></button>
      </div>
      <div className="flex flex-col gap-2">
        {Object.entries(TAG_META).map(([key, meta]) => {
          const Icon = meta.icon;
          return (
            <div key={key} className="flex items-center gap-2.5">
              <span className={`inline-flex items-center justify-center w-[22px] h-[22px] rounded-md ${meta.bg} ${meta.color} border ${meta.border} shrink-0`}>
                <Icon size={12} />
              </span>
              <div>
                <div className="text-[11px] font-semibold text-slate-200">{key}</div>
                <div className="text-[10px] text-slate-500">{meta.tip}</div>
              </div>
            </div>
          );
        })}
        <div className="flex items-center gap-2.5">
          <span className="inline-flex items-center justify-center w-[22px] h-[22px] rounded-md bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 shrink-0">
            <Lock size={12} />
          </span>
          <div>
            <div className="text-[11px] font-semibold text-slate-200">2FA</div>
            <div className="text-[10px] text-slate-500">Có 2FA — xác thực hai yếu tố đã bật</div>
          </div>
        </div>
      </div>
    </div>
  );
}

const PROVIDERS = [
  { id: 'openai', name: 'ChatGPT | Codex', color: '#10a37f' },
  { id: 'anthropic', name: 'Anthropic', color: '#da7756' },
  { id: 'gemini', name: 'Gemini', color: '#1a73e8' },
  { id: 'cursor', name: 'Cursor', color: '#ffffff' },
];

// ChatGPT và Codex là cùng 1 nền tảng OpenAI
const isOpenAI = (provider: string) =>
  provider === 'openai' || provider === 'codex';

const getProviderName = (provider: string) =>
  isOpenAI(provider) ? 'ChatGPT | Codex' : (PROVIDERS.find(p => p.id === provider)?.name ?? provider);

/* ══════════════════════════════════════════════════════════ */
export function VaultAccountsView() {
  const { addToast, setView } = useApp();
  const { confirm: askConfirm, modal: confirmModal } = useConfirm();
  const [items, setItems] = useState<any[]>([]);
  const [proxies, setProxies] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [providerFilter, _setProviderFilter] = useState('all');

  const setProviderFilter = useCallback((p: string) => {
    _setProviderFilter(p);
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.set('tab', p);
      window.history.replaceState({}, '', url.pathname + url.search + url.hash);
    }
  }, []);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const tab = params.get('tab');
      if (tab === 'all' || ['openai', 'anthropic', 'gemini', 'cursor'].includes(tab || '')) {
        _setProviderFilter(tab as string);
      }
    }
  }, []);

  const [assigningId, setAssigningId] = useState<string | null>(null);
  const [autoAssigning, setAutoAssigning] = useState(false);
  const [syncingAll, setSyncingAll] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkProxyId, setBulkProxyId] = useState('pool_proxy');
  const [bulkProxyRunning, setBulkProxyRunning] = useState(false);
  const [syncingDeadTags, setSyncingDeadTags] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [legendOpen, setLegendOpen] = useState(false);
  const [inboxModal, setInboxModal] = useState<{ open: boolean; email: string; messages: any[]; loading: boolean }>({ open: false, email: '', messages: [], loading: false });

  // Delete account confirmation options modal
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const [deleteTargetEmail, setDeleteTargetEmail] = useState<string | null>(null);
  const [deleteTargetIsBulk, setDeleteTargetIsBulk] = useState(false);
  const [deleteLinkedEmailChoice, setDeleteLinkedEmailChoice] = useState(false); // default: keep email (false)

  const [isBulkDeployFormOpen, setIsBulkDeployFormOpen] = useState(false);
  const [bulkDeployCount, setBulkDeployCount] = useState<number | ''>('');
  const [bulkDeployOrder, setBulkDeployOrder] = useState<'sequential' | 'random'>('sequential');
  const [isBulkDeployingAuto, setIsBulkDeployingAuto] = useState(false);

  const [isBulkWarmupFormOpen, setIsBulkWarmupFormOpen] = useState(false);
  const [bulkWarmupFilter, setBulkWarmupFilter] = useState<'all_ready' | 'no_warmup_today' | 'no_warmup_24h' | 'no_warmup_3d' | 'no_warmup_7d' | 'never_warmed'>('no_warmup_today');
  const [isBulkWarmingAuto, setIsBulkWarmingAuto] = useState(false);

  // Custom Advanced Filter States
  const [filterWorkspace, setFilterWorkspace] = useState<'all' | 'workspace' | 'personal'>('all');
  const [filterPlan, setFilterPlan] = useState<'all' | 'free' | 'plus' | 'pro' | 'team'>('all');
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [filterTag, setFilterTag] = useState<string>('all');
  const [filterTime, setFilterTime] = useState<'all' | 'recent' | 'today' | 'yesterday' | '3days' | '7days' | '30days'>('all');
  const [activePreset, setActivePreset] = useState<string>('all');
  const [isAdvancedFilterOpen, setIsAdvancedFilterOpen] = useState(false);

  const [uiState, setUiState] = useState({
    isAdding: false,
    isBulk: false,
    bulkText: '',
    editId: null as string | null,
    provider: 'openai',
    label: '',
    email: '',
    password: '',
    twoFaSecret: '',
    proxy: '',
    tags: [] as string[],
    notes: '',
  });

  /* ── Load ── */
  const loadAccounts = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch('/api/vault/accounts');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      setItems(d.items || []);
    } catch (e: any) {
      setError(e.message);
    }
    setLoading(false);
  }, []);

  const loadProxies = useCallback(async () => {
    try {
      const pr = await fetch('/api/proxy/state').catch(() => null as any);
      if (pr?.ok) {
        const pd = await pr.json().catch(() => ({}));
        setProxies(Array.isArray(pd?.proxies) ? pd.proxies : []);
      } else {
        setProxies([]);
      }
    } catch {
      setProxies([]);
    }
  }, []);

  useEffect(() => { void Promise.all([loadAccounts(), loadProxies()]); }, [loadAccounts, loadProxies]);

  useEffect(() => {
    const handleVaultUpdate = () => {
      loadAccounts();
    };
    window.addEventListener('seellm:vault-update', handleVaultUpdate);
    return () => window.removeEventListener('seellm:vault-update', handleVaultUpdate);
  }, [loadAccounts]);

  // Poll fallback to handle SSE latency / network drop when any task is pending
  useEffect(() => {
    let timer: any = null;
    
    const hasPending = items.some(it => {
      const ps = it.provider_specific_data || {};
      const statusPending = it.status === 'pending' || it.status === 'processing';
      const warmupPending = isOpenAI(it.provider) && ps.warmupStatus === 'pending';
      const twoFaPending = isOpenAI(it.provider) && ps.twoFaRegenStatus === 'pending';
      return statusPending || warmupPending || twoFaPending;
    });

    if (hasPending && !loading) {
      timer = setInterval(() => {
        void loadAccounts();
      }, 4000);
    }

    return () => {
      if (timer) clearInterval(timer);
    };
  }, [items, loading, loadAccounts]);

  const patchAccountLocal = useCallback((id: string, patchData: Record<string, any>) => {
    setItems(prev => prev.map(it => (it.id === id ? { ...it, ...patchData } : it)));
  }, []);

  const filtered = items.filter(it => {
    const providerMatch =
      providerFilter === 'all'
        ? true
        : providerFilter === 'openai'
          ? isOpenAI(it.provider)  // nhóm openai + codex cùng bucket
          : it.provider === providerFilter;
          
    const searchMatch = !search || 
      it.email.toLowerCase().includes(search.toLowerCase()) || 
      (it.label && it.label.toLowerCase().includes(search.toLowerCase())) ||
      (it.proxy_url && it.proxy_url.toLowerCase().includes(search.toLowerCase())) ||
      (it.notes && it.notes.toLowerCase().includes(search.toLowerCase()));

    // Custom advanced filter matching
    const tags = safeParseTags(it.tags);
    const hasWorkspaceTag = tags.includes('workspace');
    const workspaceMatch = 
      filterWorkspace === 'all' ? true :
      filterWorkspace === 'workspace' ? hasWorkspaceTag : !hasWorkspaceTag;

    const planLower = (it.plan || '').toLowerCase();
    const planMatch =
      filterPlan === 'all' ? true :
      filterPlan === 'free' ? (!planLower || planLower.includes('free')) :
      filterPlan === 'plus' ? planLower.includes('plus') :
      filterPlan === 'pro' ? planLower.includes('pro') :
      filterPlan === 'team' ? (planLower.includes('team') || planLower.includes('business')) : true;

    const statusMatch = filterStatus === 'all' ? true : it.status === filterStatus;

    const tagMatch =
      filterTag === 'all' ? true :
      filterTag === 'has_2fa' ? !!it.two_fa_secret :
      filterTag === 'no_2fa' ? !it.two_fa_secret :
      tags.includes(filterTag);

    const timeMatch = (() => {
      if (filterTime === 'all') return true;
      if (!it.created_at) return false;
      const createdDate = new Date(it.created_at);
      const diffMs = new Date().getTime() - createdDate.getTime();
      const diffDays = diffMs / (1000 * 60 * 60 * 24);
      if (filterTime === 'recent') {
        return diffMs <= 4 * 60 * 60 * 1000;
      }
      if (filterTime === 'today') {
        return new Date().toDateString() === createdDate.toDateString();
      }
      if (filterTime === 'yesterday') {
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        return yesterday.toDateString() === createdDate.toDateString();
      }
      if (filterTime === '3days') return diffDays <= 3;
      if (filterTime === '7days') return diffDays <= 7;
      if (filterTime === '30days') return diffDays <= 30;
      return true;
    })();

    // Custom Preset logic matching
    let presetMatch = true;
    if (activePreset === 'created_today') {
      if (!it.created_at) presetMatch = false;
      else {
        const createdDate = new Date(it.created_at);
        presetMatch = new Date().toDateString() === createdDate.toDateString();
      }
    } else if (activePreset === 'created_week') {
      if (!it.created_at) presetMatch = false;
      else {
        const createdDate = new Date(it.created_at);
        const diffDays = (new Date().getTime() - createdDate.getTime()) / (1000 * 60 * 60 * 24);
        presetMatch = diffDays <= 7;
      }
    } else if (activePreset === 'no_proxy') {
      presetMatch = !it.proxy_url;
    } else if (activePreset === 'has_proxy') {
      presetMatch = !!it.proxy_url;
    } else if (activePreset === 'action_required') {
      presetMatch = ['error', 'relogin'].includes(it.status) || tags.includes('need_phone');
    } else if (activePreset === 'no_2fa') {
      presetMatch = !it.two_fa_secret;
    } else if (activePreset === 'premium') {
      presetMatch = !!planLower && !planLower.includes('free');
    }

    return providerMatch && searchMatch && workspaceMatch && planMatch && statusMatch && tagMatch && timeMatch && presetMatch;
  });

  const sortedFiltered = [...filtered].sort((a, b) => {
    // 1. Prioritize active pending/processing actions (running warmup, 2fa, check-session, deploy)
    const aPending = a.status === 'pending' || a.status === 'processing' || a.provider_specific_data?.warmupStatus === 'pending' || a.provider_specific_data?.twoFaRegenStatus === 'pending';
    const bPending = b.status === 'pending' || b.status === 'processing' || b.provider_specific_data?.warmupStatus === 'pending' || b.provider_specific_data?.twoFaRegenStatus === 'pending';
    
    if (aPending && !bPending) return -1;
    if (!aPending && bPending) return 1;
    
    // 2. Sort by time from newest to oldest
    const aTime = Math.max(
      a.updated_at ? Date.parse(a.updated_at) : 0,
      a.created_at ? Date.parse(a.created_at) : 0
    );
    const bTime = Math.max(
      b.updated_at ? Date.parse(b.updated_at) : 0,
      b.created_at ? Date.parse(b.created_at) : 0
    );
    
    return bTime - aTime;
  });

  /* ── CRUD ── */
  const save = async () => {
    try {
      const r = await fetch('/api/vault/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: uiState.editId,
          provider: uiState.provider,
          label: uiState.label,
          email: uiState.email,
          password: uiState.password && uiState.password.includes('***') ? undefined : uiState.password,
          two_fa_secret: uiState.twoFaSecret && uiState.twoFaSecret.includes('***') ? undefined : uiState.twoFaSecret,
          proxy_url: uiState.proxy,
          notes: uiState.notes,
          tags: uiState.tags,
        })
      });
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      addToast(uiState.editId ? '✅ Đã cập nhật' : '✅ Đã thêm vào Vault', 'success');
      setUiState(s => ({ ...s, isAdding: false, isBulk: false, editId: null, email: '', password: '', twoFaSecret: '', label: '', notes: '', tags: [] }));
      loadAccounts();
    } catch (e: any) { addToast(e.message, 'error'); }
  };

  const del = (id: string) => {
    const item = items.find(it => it.id === id);
    setDeleteTargetId(id);
    setDeleteTargetEmail(item?.email || null);
    setDeleteTargetIsBulk(false);
    setDeleteLinkedEmailChoice(false); // default: keep email
    setDeleteModalOpen(true);
  };

  const deploy = async (id: string, email: string) => {
    try {
      const r = await fetch(`/api/vault/accounts/${id}/retry-connect`, { method: 'POST' });
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      fetch('/api/processes/worker/start', { method: 'POST' }).catch(() => { });
      addToast(`🤖 Unified Worker: Đã xếp hàng cho ${email}`, 'success');
      patchAccountLocal(id, { status: 'pending' });
    } catch (e: any) { addToast(e.message, 'error'); }
  };

  const stopAccount = async (id: string, email: string, account?: any) => {
    try {
      const r = await fetch(`/api/vault/accounts/${id}/stop`, { method: 'POST' });
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      addToast(`🛑 Đã thu hồi ${email} về trạng thái Idle`, 'info');
      const tags = safeParseTags(account?.tags);
      const shouldMarkNeedPhone = account?.status === 'need_phone' || String(account?.notes || '').includes('NEED_PHONE');
      patchAccountLocal(id, { status: 'idle', gateway_status: d.gateway_status ?? 'revoked', tags: shouldMarkNeedPhone && !tags.includes('need_phone') ? [...tags, 'need_phone'] : tags });
    } catch (e: any) { addToast(e.message, 'error'); }
  };

  const syncNow = async (id: string, email: string) => {
    try {
      const r = await fetch(`/api/vault/accounts/${id}/sync`, { method: 'POST' });
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      addToast(`☁️ Đã ép đồng bộ ${email} lên D1 thành công`, 'success');
      patchAccountLocal(id, { updated_at: new Date().toISOString() });
    } catch (e: any) { addToast(e.message, 'error'); }
  };

  const syncAll = async () => {
    if (!filtered.length) return;
    if (!await askConfirm('Đồng bộ D1', `Đồng bộ toàn bộ ${filtered.length} tài khoản trong danh sách này lên D1?`, { variant: 'warning', confirmLabel: 'Đồng bộ' })) return;

    setSyncingAll(true);
    let success = 0;
    let fail = 0;

    for (const it of filtered) {
      try {
        const r = await fetch(`/api/vault/accounts/${it.id}/sync`, { method: 'POST' });
        const d = await r.json();
        if (d.error) fail++;
        else success++;
      } catch {
        fail++;
      }
    }

    addToast(`☁️ Hoàn thành đồng bộ Vault -> D1: ${success} thành công, ${fail} thất bại`, success > 0 ? 'success' : 'error');
    setSyncingAll(false);
    loadAccounts();
  };

  const bulkSyncSelected = async () => {
    if (!await askConfirm('Đồng bộ đã chọn', `Đồng bộ ${selectedIds.size} tài khoản đã chọn lên D1?`, { variant: 'warning', confirmLabel: 'Đồng bộ' })) return;
    setSyncingAll(true);
    let success = 0;
    for (const id of Array.from(selectedIds)) {
      try {
        const r = await fetch(`/api/vault/accounts/${id}/sync`, { method: 'POST' });
        const d = await r.json();
        if (!d.error) success++;
      } catch {}
    }
    addToast(`☁️ Đã đồng bộ ${success} tài khoản lên D1`, 'success');
    setSyncingAll(false);
    setSelectedIds(new Set());
    loadAccounts();
  };

  const warmupAccount = async (id: string, email: string, account?: any) => {
    try {
      const r = await fetch(`/api/vault/accounts/${id}/warmup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ questionsCount: 0 })
      });
      const text = await r.text();
      let d;
      try {
        d = JSON.parse(text);
      } catch (err) {
        throw new Error(`⚠️ Backend Server.js cần được khởi động lại để nhận diện API Route mới. Vui lòng tắt server (Ctrl+C) và chạy lại 'pnpm dev' (hoặc 'npm run dev').`);
      }
      if (d.error) throw new Error(d.error);
      addToast(`🔥 Đã kích hoạt Warmup cho ${email}`, 'success');
      
      const psData = account?.provider_specific_data || {};
      patchAccountLocal(id, {
        provider_specific_data: {
          ...psData,
          warmupStatus: 'pending',
          lastWarmedAt: new Date().toISOString(),
          warmupError: null
        }
      });
    } catch (e: any) { addToast(e.message, 'error'); }
  };

  const checkSession = async (id: string, email: string) => {
    try {
      const r = await fetch(`/api/vault/accounts/${id}/check-session`, {
        method: 'POST'
      });
      const text = await r.text();
      let d;
      try {
        d = JSON.parse(text);
      } catch (err) {
        throw new Error(`⚠️ Backend Server.js cần được khởi động lại để nhận diện API Route mới. Vui lòng tắt server (Ctrl+C) và chạy lại 'pnpm dev' (hoặc 'npm run dev').`);
      }
      if (d.error) throw new Error(d.error);
      addToast(`🛡️ Đã bắt đầu kiểm tra Session cho ${email}`, 'success');
      
      patchAccountLocal(id, {
        status: 'pending',
        notes: 'Checking cookie/session...'
      });
    } catch (e: any) { addToast(e.message, 'error'); }
  };

  const bulkCheckSessionSelected = async () => {
    const checkableSelected = Array.from(selectedIds).filter(id => {
      const acc = items.find(it => it.id === id);
      return acc && isOpenAI(acc.provider) && acc.cookies;
    });

    if (checkableSelected.length === 0) {
      addToast('⚠️ Vui lòng chọn ít nhất một tài khoản OpenAI có sẵn Cookies để kiểm tra', 'warning');
      return;
    }

    if (!await askConfirm('Kiểm tra Session', `Kiểm tra Cookie/Session của ${checkableSelected.length} tài khoản đã chọn?`, { variant: 'warning', confirmLabel: 'Kiểm tra' })) return;
    
    let triggered = 0;
    for (const id of checkableSelected) {
      try {
        const r = await fetch(`/api/vault/accounts/${id}/check-session`, { method: 'POST' });
        const d = await r.json();
        if (!d.error) {
          triggered++;
          patchAccountLocal(id, {
            status: 'pending',
            notes: 'Checking cookie/session...'
          });
        }
      } catch {}
    }
    addToast(`🛡️ Đã kích hoạt kiểm tra Session cho ${triggered} tài khoản`, 'success');
    setSelectedIds(new Set());
  };

  const bulkWarmupSelected = async () => {
    const readySelected = Array.from(selectedIds).filter(id => {
      const acc = items.find(it => it.id === id);
      return acc && acc.status === 'ready';
    });
    
    if (readySelected.length === 0) {
      addToast('⚠️ Chỉ có thể Warmup tài khoản ở trạng thái Ready', 'warning');
      return;
    }
    
    if (!await askConfirm('Warmup Hàng Loạt', `Kích hoạt Warmup cho ${readySelected.length} tài khoản Ready đã chọn?`, { variant: 'info', confirmLabel: 'Bắt đầu' })) return;
    
    let success = 0;
    for (const id of readySelected) {
      try {
        const acc = items.find(it => it.id === id);
        const r = await fetch(`/api/vault/accounts/${id}/warmup`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ questionsCount: 0 })
        });
        const text = await r.text();
        let d;
        try {
          d = JSON.parse(text);
        } catch (err) {
          throw new Error(`⚠️ Backend Server.js cần được khởi động lại để nhận diện API Route mới. Vui lòng tắt server (Ctrl+C) và chạy lại 'pnpm dev' (hoặc 'npm run dev').`);
        }
        if (!d.error) {
          success++;
          const psData = acc?.provider_specific_data || {};
          patchAccountLocal(id, {
            provider_specific_data: {
              ...psData,
              warmupStatus: 'pending',
              lastWarmedAt: new Date().toISOString(),
              warmupError: null
            }
          });
        }
      } catch (e: any) {
        addToast(e.message, 'error');
        break; // Stop bulk loop if server is not updated
      }
    }
    
    if (success > 0) {
      addToast(`🔥 Đã kích hoạt Warmup cho ${success} tài khoản`, 'success');
    }
    setSelectedIds(new Set());
  };

  const regenerate2FA = async (id: string, email: string, account?: any) => {
    try {
      const r = await fetch(`/api/vault/accounts/${id}/regenerate-2fa`, {
        method: 'POST'
      });
      const text = await r.text();
      let d;
      try {
        d = JSON.parse(text);
      } catch (err) {
        throw new Error(`⚠️ Backend Server.js cần được khởi động lại để nhận diện API Route mới. Vui lòng tắt server (Ctrl+C) và chạy lại 'pnpm dev' (hoặc 'npm run dev').`);
      }
      if (d.error) throw new Error(d.error);
      addToast(`🛡️ Đã kích hoạt tái tạo 2FA cho ${email}`, 'success');
      
      const psData = account?.provider_specific_data || {};
      patchAccountLocal(id, {
        provider_specific_data: {
          ...psData,
          twoFaRegenStatus: 'pending',
          twoFaRegenError: null
        }
      });
    } catch (e: any) { addToast(e.message, 'error'); }
  };

  const bulkRegenerate2FASelected = async () => {
    const eligibleSelected = Array.from(selectedIds).filter(id => {
      const acc = items.find(it => it.id === id);
      return acc && acc.status !== 'dead';
    });
    
    if (eligibleSelected.length === 0) {
      addToast('⚠️ Chỉ có thể tái tạo 2FA cho tài khoản hoạt động (Khác trạng thái Dead)', 'warning');
      return;
    }
    
    if (!await askConfirm('Tái tạo 2FA Hàng Loạt', `Kích hoạt Tái tạo 2FA cho ${eligibleSelected.length} tài khoản hoạt động đã chọn? Quy trình này sẽ tự động thay đổi Secret Key của tài khoản.`, { variant: 'warning', confirmLabel: 'Bắt đầu' })) return;
    
    let success = 0;
    for (const id of eligibleSelected) {
      try {
        const acc = items.find(it => it.id === id);
        const r = await fetch(`/api/vault/accounts/${id}/regenerate-2fa`, {
          method: 'POST'
        });
        const text = await r.text();
        let d;
        try {
          d = JSON.parse(text);
        } catch (err) {
          throw new Error(`⚠️ Backend Server.js cần được khởi động lại để nhận diện API Route mới. Vui lòng tắt server (Ctrl+C) và chạy lại 'pnpm dev' (hoặc 'npm run dev').`);
        }
        if (!d.error) {
          success++;
          const psData = acc?.provider_specific_data || {};
          patchAccountLocal(id, {
            provider_specific_data: {
              ...psData,
              twoFaRegenStatus: 'pending',
              twoFaRegenError: null
            }
          });
        }
      } catch (e: any) {
        addToast(e.message, 'error');
        break; // Stop bulk loop if server is not updated
      }
    }
    
    if (success > 0) {
      addToast(`🛡️ Đã kích hoạt Tái tạo 2FA cho ${success} tài khoản`, 'success');
    }
    setSelectedIds(new Set());
  };

  const getAutoWarmupTargets = useCallback((filter: string) => {
    return items.filter(it => {
      const tags = safeParseTags(it.tags);
      // Only ChatGPT / Codex accounts
      if (!isOpenAI(it.provider)) return false;
      // Only Ready accounts
      if (it.status !== 'ready') return false;
      // Must not be deactivated
      if (tags.includes('account_deactivated')) return false;

      const ps = it.provider_specific_data || {};
      const lastWarmed = ps.lastWarmedAt;

      // If pending, don't trigger it again
      if (ps.warmupStatus === 'pending') return false;

      if (filter === 'all_ready') return true;
      if (filter === 'never_warmed') return !lastWarmed;

      if (!lastWarmed) {
        // If it has never been warmed up, it matches any "has not been warmed up in X" criteria
        return true; 
      }

      const nowVN = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh" }));
      const warmedVN = new Date(new Date(lastWarmed).toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh" }));

      if (filter === 'no_warmup_today') {
        // Compare calendar dates (Year, Month, Day) in VN timezone
        return nowVN.toDateString() !== warmedVN.toDateString();
      }

      const diffMs = nowVN.getTime() - warmedVN.getTime();
      const diffDays = diffMs / (1000 * 60 * 60 * 24);

      if (filter === 'no_warmup_24h') {
        return diffDays >= 1;
      }
      if (filter === 'no_warmup_3d') {
        return diffDays >= 3;
      }
      if (filter === 'no_warmup_7d') {
        return diffDays >= 7;
      }

      return false;
    });
  }, [items]);

  const startAutoWarmup = async () => {
    const targets = getAutoWarmupTargets(bulkWarmupFilter);
    if (targets.length === 0) {
      return addToast('Không tìm thấy tài khoản nào phù hợp với bộ lọc đã chọn', 'warning');
    }

    if (!await askConfirm(
      'Tự Động Warmup', 
      `Kích hoạt Warmup cho ${targets.length} tài khoản phù hợp với điều kiện đã chọn?`, 
      { variant: 'info', confirmLabel: 'Bắt đầu' }
    )) return;

    setIsBulkWarmingAuto(true);
    let success = 0;

    for (const it of targets) {
      try {
        const r = await fetch(`/api/vault/accounts/${it.id}/warmup`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ questionsCount: 0 })
        });
        const text = await r.text();
        let d;
        try {
          d = JSON.parse(text);
        } catch (err) {
          throw new Error(`⚠️ Backend Server.js cần được khởi động lại.`);
        }
        if (!d.error) {
          success++;
          const psData = it.provider_specific_data || {};
          patchAccountLocal(it.id, {
            provider_specific_data: {
              ...psData,
              warmupStatus: 'pending',
              lastWarmedAt: new Date().toISOString(),
              warmupError: null
            }
          });
        }
      } catch (e: any) {
        addToast(e.message, 'error');
        break;
      }
    }

    setIsBulkWarmingAuto(false);
    if (success > 0) {
      addToast(`🔥 Đã kích hoạt Warmup cho ${success}/${targets.length} tài khoản`, 'success');
      setIsBulkWarmupFormOpen(false);
      loadAccounts();
    }
  };

  const bulkDeleteSelected = () => {
    setDeleteTargetId(null);
    setDeleteTargetEmail(null);
    setDeleteTargetIsBulk(true);
    setDeleteLinkedEmailChoice(false); // default: keep email
    setDeleteModalOpen(true);
  };

  const executeDelete = async () => {
    setLoading(true);
    setDeleteModalOpen(false);
    
    const queryParam = `?deleteLinkedEmail=${deleteLinkedEmailChoice}`;
    
    try {
      if (deleteTargetIsBulk) {
        let success = 0;
        for (const id of Array.from(selectedIds)) {
          try {
            const r = await fetch(`/api/vault/accounts/${id}${queryParam}`, { method: 'DELETE' });
            if (r.ok) success++;
          } catch {}
        }
        setSelectedIds(new Set());
        loadAccounts();
        addToast(`🗑️ Đã xóa ${success} tài khoản khỏi Vault`, 'info');
      } else if (deleteTargetId) {
        const r = await fetch(`/api/vault/accounts/${deleteTargetId}${queryParam}`, { method: 'DELETE' });
        const d = await r.json();
        if (d.error) throw new Error(d.error);
        
        setItems(prev => prev.filter(it => it.id !== deleteTargetId));
        addToast('Đã xoá tài khoản khỏi Vault', 'success');
      }
    } catch (e: any) {
      addToast(e.message, 'error');
    } finally {
      setLoading(false);
      setDeleteTargetId(null);
      setDeleteTargetEmail(null);
      setDeleteTargetIsBulk(false);
    }
  };

  const syncDeadTags = async () => {
    setSyncingDeadTags(true);
    try {
      const r = await fetch('/api/vault/email-pool/sync-dead-tags', { method: 'POST' });
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      const { deadEmails, taggedEmails, taggedAccounts, cleanedAccounts } = d;
      let msg = `🏷️ Đồng bộ xong: ${taggedAccounts} account được gán EMAIL DEAD`;
      if (cleanedAccounts > 0) msg += `, ${cleanedAccounts} account được gỡ nhãn`;
      if (taggedAccounts === 0 && cleanedAccounts === 0) msg = `✅ Tất cả nhãn đã đồng bộ, không cần thay đổi`;
      addToast(msg, taggedAccounts > 0 ? 'success' : 'info');
      loadAccounts();
    } catch (e: any) {
      addToast(`Lỗi đồng bộ dead tags: ${e.message}`, 'error');
    }
    setSyncingDeadTags(false);
  };

  const assignFromPool = async (id: string, proxyId?: string) => {
    setAssigningId(id);
    try {
      const r = await fetch('/api/proxy-assign/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: id, proxyId: proxyId || null }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d.error) throw new Error(d.error || `HTTP ${r.status}`);
      patchAccountLocal(id, {
        proxy_id: d?.proxy?.id ?? null,
        proxy_url: d?.proxy?.url ?? '',
      });
      addToast('✅ Đã gán proxy từ pool', 'success');
    } catch (e: any) { addToast(e.message || 'Gán proxy thất bại', 'error'); }
    finally { setAssigningId(null); }
  };

  const autoAssignFromPool = async () => {
    setAutoAssigning(true);
    try {
      const r = await fetch('/api/proxy-assign/auto', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d.error) throw new Error(d.error || `HTTP ${r.status}`);
      addToast(`✅ Auto-assign ${d.assigned || 0}/${d.total || 0}`, 'success');
      loadAccounts();
    } catch (e: any) {
      addToast(e.message || 'Auto-assign thất bại', 'error');
    } finally {
      setAutoAssigning(false);
    }
  };

  const unassignProxy = async (id: string) => {
    setAssigningId(id);
    try {
      const r = await fetch('/api/proxy-assign/unassign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: id }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d.error) throw new Error(d.error || `HTTP ${r.status}`);
      patchAccountLocal(id, { proxy_id: null, proxy_url: '' });
      addToast('✅ Đã gỡ proxy khỏi tài khoản', 'success');
    } catch (e: any) {
      addToast(e.message || 'Gỡ proxy thất bại', 'error');
    } finally {
      setAssigningId(null);
    }
  };

  const bulkProxyAction = async (action: 'assign' | 'unassign') => {
    const accountIds = Array.from(selectedIds);
    if (!accountIds.length) return addToast('Hãy chọn ít nhất 1 tài khoản', 'error');
    setBulkProxyRunning(true);
    try {
      if (action === 'assign' && bulkProxyId === 'pool_proxy') {
        let workshopProxyMap = {};
        try {
          workshopProxyMap = JSON.parse(localStorage.getItem('workshopProxyMap_v1') || '{}');
        } catch (_) {}

        let done = 0;
        let errorsCount = 0;

        for (const id of accountIds) {
          const acc = items.find(it => it.id === id);
          if (!acc || !acc.email) {
            errorsCount++;
            continue;
          }

          const poolProxyUrl = (workshopProxyMap as any)[acc.email];
          if (!poolProxyUrl) {
            errorsCount++;
            continue;
          }

          const normPool = poolProxyUrl.trim().toLowerCase();
          const matchedProxy = proxies.find((p: any) => {
            const normP = (p.url || '').trim().toLowerCase();
            return normP === normPool || normP.includes(normPool) || normPool.includes(normP);
          });

          if (!matchedProxy) {
            errorsCount++;
            continue;
          }

          const r = await fetch('/api/proxy-assign/assign', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ accountId: id, proxyId: matchedProxy.id }),
          });

          if (r.ok) {
            done++;
            patchAccountLocal(id, {
              proxy_id: matchedProxy.id,
              proxy_url: matchedProxy.url,
            });
          } else {
            errorsCount++;
          }
        }

        addToast(`✅ Đã gán proxy từ pool theo account: Thành công ${done}, Thất bại/Thiếu ${errorsCount}`, done > 0 ? 'success' : 'warning');
        setSelectedIds(new Set());
        loadAccounts();
        return;
      }

      const r = await fetch('/api/proxy-assign/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, accountIds, proxyId: action === 'assign' && bulkProxyId ? bulkProxyId : null }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d.error) throw new Error(d.error || `HTTP ${r.status}`);
      addToast(`✅ Bulk ${action}: ${d.done || 0}/${d.total || accountIds.length}`, 'success');
      setSelectedIds(new Set());
      loadAccounts();
    } catch (e: any) {
      addToast(e.message || 'Bulk proxy thất bại', 'error');
    } finally {
      setBulkProxyRunning(false);
    }
  };

  const bulkDeploy = async () => {
    const accountIds = Array.from(selectedIds);
    if (!accountIds.length) return addToast('Hãy chọn ít nhất 1 tài khoản', 'error');
    
    let success = 0;
    for (const id of accountIds) {
      try {
        const it = items.find(a => a.id === id);
        if (!it) continue;
        
        const tags = safeParseTags(it.tags);
        const allowDeploy = isOpenAI(it.provider) && 
                            (it.status === 'idle' || it.status === 'stopped' || it.status === 'error' || it.status === 'relogin') && 
                            !tags.includes('account_deactivated');
        
        if (!allowDeploy) continue;
        
        const r = await fetch(`/api/vault/accounts/${id}/retry-connect`, { method: 'POST' });
        const d = await r.json();
        if (d.error) continue;
        
        patchAccountLocal(id, { status: 'pending' });
        success++;
      } catch (e: any) { }
    }
    
    if (success > 0) {
      fetch('/api/processes/worker/start', { method: 'POST' }).catch(() => { });
      addToast(`🤖 Đã xếp hàng Deploy ${success} tài khoản`, 'success');
      setSelectedIds(new Set());
    } else {
      addToast('Không có tài khoản nào hợp lệ để Deploy (Chỉ ChatGPT/Codex ở trạng thái Idle/Error)', 'error');
    }
  };

  const startAutoBulkDeploy = async () => {
    const pool = items.filter(it => {
      const tags = safeParseTags(it.tags);
      return isOpenAI(it.provider) && 
             (it.status === 'idle' || it.status === 'stopped' || it.status === 'error' || it.status === 'relogin') && 
             !tags.includes('account_deactivated');
    });

    if (pool.length === 0) {
      return addToast('Không tìm thấy tài khoản nào hợp lệ ở trạng thái Idle/Error/Stopped/Re-login', 'error');
    }

    let targetCount = pool.length;
    if (bulkDeployCount !== '') {
      targetCount = Math.min(Number(bulkDeployCount), pool.length);
    }
    if (targetCount <= 0) {
      return addToast('Số lượng deploy phải lớn hơn 0', 'error');
    }

    let targets = [...pool];
    if (bulkDeployOrder === 'random') {
      targets.sort(() => Math.random() - 0.5);
    }
    targets = targets.slice(0, targetCount);

    setIsBulkDeployingAuto(true);
    let success = 0;
    
    for (const it of targets) {
      try {
        const r = await fetch(`/api/vault/accounts/${it.id}/retry-connect`, { method: 'POST' });
        const d = await r.json();
        if (!d.error) {
          patchAccountLocal(it.id, { status: 'pending' });
          success++;
        }
      } catch (e) {}
    }

    setIsBulkDeployingAuto(false);
    if (success > 0) {
      fetch('/api/processes/worker/start', { method: 'POST' }).catch(() => { });
      addToast(`🤖 Đã tự động xếp hàng Deploy ${success}/${targets.length} tài khoản`, 'success');
      setIsBulkDeployFormOpen(false);
      setBulkDeployCount('');
      loadAccounts();
    } else {
      addToast('Deploy hàng loạt thất bại', 'error');
    }
  };

  const bulkSave = async () => {
    if (!uiState.bulkText.trim()) return;
    const lines = uiState.bulkText.split('\n').filter(l => l.trim().includes('|'));
    if (lines.length === 0) return addToast('Định dạng không đúng (email|pass|2fa)', 'error');

    setLoading(true);
    let count = 0;
    try {
      for (const line of lines) {
        const [email, pass, tfa] = line.trim().split('|');
        if (!email || !pass) continue;
        await fetch('/api/vault/accounts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            provider: uiState.provider,
            email: email.trim(),
            password: pass.trim(),
            two_fa_secret: tfa?.trim() || '',
            status: 'idle' // Lưu kho, không tự động login
          })
        });
        count++;
      }
      addToast(`✅ Đã nhập thành công ${count} tài khoản`, 'success');
      setUiState(s => ({ ...s, isAdding: false, isBulk: false, bulkText: '' }));
      loadAccounts();
    } catch (e: any) {
      addToast(e.message, 'error');
    } finally {
      setLoading(false);
    }
  };

  const readInbox = async (email: string) => {
    setInboxModal({ open: true, email, messages: [], loading: true });
    try {
      const r = await fetch(`/api/vault/inbox/${encodeURIComponent(email)}`);
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      setInboxModal(prev => ({ ...prev, messages: d.messages || [], loading: false }));
    } catch (e: any) {
      addToast(e.message, 'error');
      setInboxModal(prev => ({ ...prev, loading: false }));
    }
  };

  const startEdit = (it: any) => {
    setExpandedId(null); // collapse expanded row
    setUiState(s => ({
      ...s,
      isAdding: true,
      isBulk: false,
      editId: it.id,
      provider: it.provider || 'openai',
      label: it.label || '',
      email: it.email || '',
      password: it.password || '',
      twoFaSecret: it.two_fa_secret || '',
      proxy: it.proxy_url || '',
      tags: safeParseTags(it.tags),
      notes: it.notes || '',
    }));
    // Scroll to form — use the scrollable container, not window
    const scrollContainer = document.querySelector('.custom-scrollbar');
    if (scrollContainer) scrollContainer.scrollTo({ top: 0, behavior: 'smooth' });
    else window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <div className="absolute inset-0 overflow-y-auto px-6 pb-10 pt-2 flex flex-col gap-5 custom-scrollbar">
      {confirmModal}

      {/* ═══ CUSTOM DELETE MODAL WITH OPTIONS ═══ */}
      {deleteModalOpen && (
        <div className="fixed inset-0 bg-black/75 backdrop-blur-sm z-[999] flex items-center justify-center p-4">
          <div className="bg-[#0f1322]/95 border border-white/10 rounded-2xl shadow-2xl w-full max-w-md overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            {/* Header */}
            <div className="flex items-center gap-3 px-6 py-4 bg-white/[0.02] border-b border-white/5">
              <div className="w-9 h-9 rounded-lg bg-rose-500/10 text-rose-400 flex items-center justify-center">
                <Trash2 size={16} />
              </div>
              <div>
                <h3 className="text-[14px] font-bold text-slate-100 uppercase tracking-wider">Xác nhận Xóa Tài Khoản</h3>
                <p className="text-[11px] text-slate-400">Thiết lập tùy chọn xóa liên kết</p>
              </div>
            </div>

            {/* Content */}
            <div className="p-6 space-y-4">
              <p className="text-[13px] text-slate-300 leading-relaxed">
                Bạn có chắc chắn muốn xóa{' '}
                <span className="font-semibold text-rose-400">
                  {deleteTargetIsBulk ? `${selectedIds.size} tài khoản đã chọn` : deleteTargetEmail || 'tài khoản này'}
                </span>{' '}
                khỏi Vault? Hành động này không thể hoàn tác.
              </p>

              <div className="space-y-3 pt-2">
                <label className="flex items-start gap-3 p-3 rounded-xl border border-white/5 bg-white/[0.01] hover:bg-white/[0.03] cursor-pointer transition-all">
                  <input
                    type="radio"
                    name="deleteLinkedEmailChoice"
                    checked={!deleteLinkedEmailChoice}
                    onChange={() => setDeleteLinkedEmailChoice(false)}
                    className="mt-0.5 accent-indigo-500"
                  />
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[12px] font-bold text-slate-200">Chỉ xóa tài khoản ở Vault Accounts</span>
                    <span className="text-[11px] text-slate-500 leading-relaxed">
                      Giữ nguyên email ở Workshop Pool. Email sẽ được gán nhãn <span className="text-rose-400 font-semibold bg-rose-500/5 px-1 rounded">Acc đã xóa</span> để bạn dễ dàng nhận biết và tái tạo tài khoản mới.
                    </span>
                  </div>
                </label>

                <label className="flex items-start gap-3 p-3 rounded-xl border border-white/5 bg-white/[0.01] hover:bg-white/[0.03] cursor-pointer transition-all">
                  <input
                    type="radio"
                    name="deleteLinkedEmailChoice"
                    checked={deleteLinkedEmailChoice}
                    onChange={() => setDeleteLinkedEmailChoice(true)}
                    className="mt-0.5 accent-rose-500"
                  />
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[12px] font-bold text-rose-400">Xóa cả ở Vault lẫn Workshop (Email Pool)</span>
                    <span className="text-[11px] text-slate-500 leading-relaxed">
                      Xóa hoàn toàn tài khoản khỏi Vault, đồng thời gỡ bỏ vĩnh viễn email liên kết khỏi hệ thống Email Pool của Workshop.
                    </span>
                  </div>
                </label>
              </div>
            </div>

            {/* Footer */}
            <div className="px-6 py-4 bg-white/[0.02] border-t border-white/5 flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setDeleteModalOpen(false);
                  setDeleteTargetId(null);
                  setDeleteTargetEmail(null);
                  setDeleteTargetIsBulk(false);
                }}
              >
                Hủy bỏ
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={executeDelete}
                className="bg-rose-600 hover:bg-rose-500 shadow-lg shadow-rose-600/15"
              >
                Xác nhận Xóa
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ═══ ACTIONS ═══ */}
      <div className="flex gap-3 mb-4 mt-2 relative z-10">
        <div className="flex-1 relative flex items-center">
          <Search size={15} className="absolute left-3 text-slate-500" />
          <Input className="pl-9 pr-24" placeholder="Tìm theo email, nhãn, proxy hoặc ghi chú..." value={search} onChange={e => setSearch(e.target.value)} />
          <div className="absolute right-2 flex items-center">
            <Button 
              size="sm"
              variant="secondary" 
              onClick={() => { setIsAdvancedFilterOpen(!isAdvancedFilterOpen); setUiState(s => ({ ...s, isBulk: false, isAdding: false })); setIsBulkDeployFormOpen(false); setIsBulkWarmupFormOpen(false); }} 
              className={`h-7 px-2.5 border-white/10 ${isAdvancedFilterOpen ? 'bg-indigo-500/10 text-indigo-400 border-indigo-500/30' : 'text-slate-400 hover:bg-white/5'}`}
            >
              <Filter size={12} className="mr-1.5" />
              Bộ Lọc
              {((filterWorkspace !== 'all' ? 1 : 0) + (filterPlan !== 'all' ? 1 : 0) + (filterStatus !== 'all' ? 1 : 0) + (filterTag !== 'all' ? 1 : 0) + (providerFilter !== 'all' ? 1 : 0)) > 0 && (
                <span className="ml-1.5 px-1.5 py-0.2 rounded-full text-[10px] bg-indigo-500 text-white font-bold leading-none">
                  {(filterWorkspace !== 'all' ? 1 : 0) + (filterPlan !== 'all' ? 1 : 0) + (filterStatus !== 'all' ? 1 : 0) + (filterTag !== 'all' ? 1 : 0) + (providerFilter !== 'all' ? 1 : 0)}
                </span>
              )}
            </Button>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={syncDeadTags} disabled={syncingDeadTags}>
            {syncingDeadTags ? <RefreshCw size={16} className="animate-spin" /> : <Tag size={16} />} {syncingDeadTags ? 'Đang đồng bộ...' : 'Sync Dead Tags'}
          </Button>
          <Button variant="ghost" className="!text-emerald-400 hover:!bg-emerald-500/10" onClick={() => { setIsBulkDeployFormOpen(!isBulkDeployFormOpen); setIsBulkWarmupFormOpen(false); setUiState(s => ({ ...s, isBulk: false, isAdding: false })); setIsAdvancedFilterOpen(false); }}>
            {isBulkDeployFormOpen ? <X size={16} /> : <Bot size={16} />} Auto Deploy
          </Button>
          <Button variant="ghost" className="!text-orange-400 hover:!bg-orange-500/10" onClick={() => { setIsBulkWarmupFormOpen(!isBulkWarmupFormOpen); setIsBulkDeployFormOpen(false); setUiState(s => ({ ...s, isBulk: false, isAdding: false })); setIsAdvancedFilterOpen(false); }}>
            {isBulkWarmupFormOpen ? <X size={16} /> : <Flame size={16} />} Auto Warmup
          </Button>
          <Button variant="ghost" onClick={() => { setUiState(s => ({ ...s, isBulk: !s.isBulk, isAdding: false, editId: null })); setIsBulkDeployFormOpen(false); setIsBulkWarmupFormOpen(false); setIsAdvancedFilterOpen(false); }}>
            {uiState.isBulk ? <X size={16} /> : <FileUp size={16} />} Nhập hàng loạt
          </Button>
          <Button variant="primary" onClick={() => { setUiState(s => ({ ...s, isAdding: !s.isAdding, isBulk: false, editId: null, email: '', password: '', twoFaSecret: '', label: '' })); setIsBulkDeployFormOpen(false); setIsBulkWarmupFormOpen(false); setIsAdvancedFilterOpen(false); }}>
            {uiState.isAdding ? <X size={16} /> : <Plus size={16} />} {uiState.isAdding ? 'Hủy bỏ' : 'Thêm Tài Khoản'}
          </Button>
        </div>
      </div>

      {/* ═══ QUICK PRESET CHIPS ═══ */}
      <div className="flex gap-2 overflow-x-auto pb-1 relative z-10 scrollbar-none">
        {[
          { id: 'all', label: 'Tất cả', icon: Users, color: 'text-slate-400', activeClass: 'bg-white/10 text-white border-white/20' },
          { id: 'created_today', label: '✨ Mới tạo hôm nay', icon: Clock, color: 'text-emerald-400', activeClass: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' },
          { id: 'created_week', label: '📅 Mới tạo tuần này', icon: Clock, color: 'text-teal-400', activeClass: 'bg-teal-500/10 text-teal-400 border-teal-500/30' },
          { id: 'no_proxy', label: '🔌 Chưa gán Proxy', icon: Globe, color: 'text-rose-400', activeClass: 'bg-rose-500/10 text-rose-400 border-rose-500/30' },
          { id: 'has_proxy', label: '✅ Đã gán Proxy', icon: Globe, color: 'text-sky-400', activeClass: 'bg-sky-500/10 text-sky-400 border-sky-500/30' },
          { id: 'action_required', label: '⚠️ Lỗi & Cần SĐT', icon: AlertTriangle, color: 'text-amber-400', activeClass: 'bg-amber-500/10 text-amber-400 border-amber-500/30' },
          { id: 'no_2fa', label: '🔒 Chưa có 2FA', icon: Lock, color: 'text-purple-400', activeClass: 'bg-purple-500/10 text-purple-400 border-purple-500/30' },
          { id: 'premium', label: '💎 Premium', icon: Bot, color: 'text-indigo-400', activeClass: 'bg-indigo-500/10 text-indigo-400 border-indigo-500/30' },
        ].map(preset => {
          const PresetIcon = preset.icon;
          const isActive = activePreset === preset.id;
          return (
            <button
              key={preset.id}
              onClick={() => {
                setActivePreset(preset.id);
                if (preset.id === 'all') {
                  setFilterWorkspace('all');
                  setFilterPlan('all');
                  setFilterStatus('all');
                  setFilterTag('all');
                  setFilterTime('all');
                  setProviderFilter('all');
                  setSearch('');
                }
              }}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-semibold border transition-all shrink-0 cursor-pointer ${
                isActive 
                  ? preset.activeClass
                  : 'bg-white/5 text-slate-400 border-white/5 hover:border-white/10 hover:bg-white/10'
              }`}
            >
              <PresetIcon size={12} className={isActive ? '' : preset.color} />
              {preset.label}
            </button>
          );
        })}
      </div>

      {/* ═══ ADVANCED FILTER PANEL ═══ */}
      {isAdvancedFilterOpen && (
        <Card className="mb-2 border-indigo-500/20 bg-indigo-500/[0.01] animate-slideDown overflow-visible relative z-20">
          <CardContent className="py-4">
            <div className="grid grid-cols-2 md:grid-cols-6 gap-4 items-end">
              {/* Provider Selection */}
              <div>
                <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5">Nhà cung cấp</label>
                <select 
                  className="w-full bg-black/40 border border-white/10 rounded-md px-3 py-2 text-[12px] text-slate-200 outline-none focus:border-indigo-500/50"
                  value={providerFilter}
                  onChange={e => setProviderFilter(e.target.value)}
                >
                  <option value="all" className="bg-[#0f172a]">Tất cả Provider</option>
                  {PROVIDERS.map(p => <option key={p.id} value={p.id} className="bg-[#0f172a]">{p.name}</option>)}
                </select>
              </div>

              {/* Workspace Type */}
              <div>
                <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5">Loại tài khoản</label>
                <select 
                  className="w-full bg-black/40 border border-white/10 rounded-md px-3 py-2 text-[12px] text-slate-200 outline-none focus:border-indigo-500/50"
                  value={filterWorkspace}
                  onChange={e => setFilterWorkspace(e.target.value as any)}
                >
                  <option value="all" className="bg-[#0f172a]">Tất cả loại</option>
                  <option value="workspace" className="bg-[#0f172a]">Chỉ Workspace (💼)</option>
                  <option value="personal" className="bg-[#0f172a]">Chỉ cá nhân (Personal)</option>
                </select>
              </div>

              {/* Plan Type */}
              <div>
                <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5">Gói dịch vụ</label>
                <select 
                  className="w-full bg-black/40 border border-white/10 rounded-md px-3 py-2 text-[12px] text-slate-200 outline-none focus:border-indigo-500/50"
                  value={filterPlan}
                  onChange={e => setFilterPlan(e.target.value as any)}
                >
                  <option value="all" className="bg-[#0f172a]">Tất cả gói</option>
                  <option value="free" className="bg-[#0f172a]">Chỉ Gói Free</option>
                  <option value="plus" className="bg-[#0f172a]">Chỉ Gói Plus</option>
                  <option value="pro" className="bg-[#0f172a]">Chỉ Gói Pro</option>
                  <option value="team" className="bg-[#0f172a]">Chỉ Gói Team / Business</option>
                </select>
              </div>

              {/* Status */}
              <div>
                <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5">Trạng thái chạy</label>
                <select 
                  className="w-full bg-black/40 border border-white/10 rounded-md px-3 py-2 text-[12px] text-slate-200 outline-none focus:border-indigo-500/50"
                  value={filterStatus}
                  onChange={e => setFilterStatus(e.target.value)}
                >
                  <option value="all" className="bg-[#0f172a]">Tất cả trạng thái</option>
                  <option value="ready" className="bg-[#0f172a]">Ready</option>
                  <option value="idle" className="bg-[#0f172a]">Idle</option>
                  <option value="pending" className="bg-[#0f172a]">Pending</option>
                  <option value="processing" className="bg-[#0f172a]">Processing</option>
                  <option value="error" className="bg-[#0f172a]">Error (Gồm Cần SĐT)</option>
                  <option value="dead" className="bg-[#0f172a]">Dead (🔴)</option>
                  <option value="relogin" className="bg-[#0f172a]">Re-login</option>
                </select>
              </div>

              {/* System tags */}
              <div>
                <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5">Nhãn đặc biệt</label>
                <select 
                  className="w-full bg-black/40 border border-white/10 rounded-md px-3 py-2 text-[12px] text-slate-200 outline-none focus:border-indigo-500/50"
                  value={filterTag}
                  onChange={e => setFilterTag(e.target.value)}
                >
                  <option value="all" className="bg-[#0f172a]">Tất cả nhãn</option>
                  <option value="auto-register" className="bg-[#0f172a]">Tự động tạo (Bot)</option>
                  <option value="vault-register" className="bg-[#0f172a]">Tạo thủ công</option>
                  <option value="need_phone" className="bg-[#0f172a]">Cần Số điện thoại</option>
                  <option value="email_dead" className="bg-[#0f172a]">Email đã chết</option>
                  <option value="has_2fa" className="bg-[#0f172a]">Có bảo mật 2FA</option>
                  <option value="no_2fa" className="bg-[#0f172a]">Không có 2FA</option>
                </select>
              </div>

              {/* Creation Time */}
              <div>
                <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5">Thời gian tạo</label>
                <select 
                  className="w-full bg-black/40 border border-white/10 rounded-md px-3 py-2 text-[12px] text-slate-200 outline-none focus:border-indigo-500/50"
                  value={filterTime}
                  onChange={e => setFilterTime(e.target.value as any)}
                >
                  <option value="all" className="bg-[#0f172a]">Tất cả thời gian</option>
                  <option value="recent" className="bg-[#0f172a]">Mới đây (4 giờ qua)</option>
                  <option value="today" className="bg-[#0f172a]">Hôm nay</option>
                  <option value="yesterday" className="bg-[#0f172a]">Hôm qua</option>
                  <option value="3days" className="bg-[#0f172a]">3 ngày qua</option>
                  <option value="7days" className="bg-[#0f172a]">7 ngày qua</option>
                  <option value="30days" className="bg-[#0f172a]">30 ngày qua</option>
                </select>
              </div>
            </div>

            {/* Active Chips & Reset */}
            <div className="flex items-center justify-between mt-4 pt-3 border-t border-white/5">
              <div className="flex gap-2 flex-wrap items-center">
                <span className="text-[10px] text-slate-500 font-bold uppercase tracking-wider">Đang áp dụng:</span>
                {providerFilter !== 'all' && (
                  <span className="inline-flex items-center gap-1 text-[11px] bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 px-2 py-0.5 rounded">
                    Provider: {getProviderName(providerFilter)}
                    <button onClick={() => setProviderFilter('all')} className="hover:text-slate-200 ml-1"><X size={10} /></button>
                  </span>
                )}
                {filterWorkspace !== 'all' && (
                  <span className="inline-flex items-center gap-1 text-[11px] bg-blue-500/10 text-blue-400 border border-blue-500/20 px-2 py-0.5 rounded">
                    Loại: {filterWorkspace === 'workspace' ? 'Workspace' : 'Cá nhân'}
                    <button onClick={() => setFilterWorkspace('all')} className="hover:text-slate-200 ml-1"><X size={10} /></button>
                  </span>
                )}
                {filterPlan !== 'all' && (
                  <span className="inline-flex items-center gap-1 text-[11px] bg-amber-500/10 text-amber-400 border border-amber-500/20 px-2 py-0.5 rounded">
                    Gói: {filterPlan.toUpperCase()}
                    <button onClick={() => setFilterPlan('all')} className="hover:text-slate-200 ml-1"><X size={10} /></button>
                  </span>
                )}
                {filterStatus !== 'all' && (
                  <span className="inline-flex items-center gap-1 text-[11px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-2 py-0.5 rounded">
                    Trạng thái: {filterStatus.toUpperCase()}
                    <button onClick={() => setFilterStatus('all')} className="hover:text-slate-200 ml-1"><X size={10} /></button>
                  </span>
                )}
                {filterTag !== 'all' && (
                  <span className="inline-flex items-center gap-1 text-[11px] bg-purple-500/10 text-purple-400 border border-purple-500/20 px-2 py-0.5 rounded">
                    Nhãn: {
                      filterTag === 'auto-register' ? 'Tự động tạo (Bot)' :
                      filterTag === 'vault-register' ? 'Tạo thủ công' :
                      filterTag === 'need_phone' ? 'Cần Số điện thoại' :
                      filterTag === 'email_dead' ? 'Email đã chết' :
                      filterTag === 'has_2fa' ? 'Có bảo mật 2FA' :
                      filterTag === 'no_2fa' ? 'Không có 2FA' :
                      filterTag
                    }
                    <button onClick={() => setFilterTag('all')} className="hover:text-slate-200 ml-1"><X size={10} /></button>
                  </span>
                )}
                {filterTime !== 'all' && (
                  <span className="inline-flex items-center gap-1 text-[11px] bg-teal-500/10 text-teal-400 border border-teal-500/20 px-2 py-0.5 rounded">
                    Thời gian: {
                      filterTime === 'recent' ? 'Mới đây (4h)' :
                      filterTime === 'today' ? 'Hôm nay' :
                      filterTime === 'yesterday' ? 'Hôm qua' :
                      filterTime === '3days' ? '3 ngày qua' :
                      filterTime === '7days' ? '7 ngày qua' :
                      filterTime === '30days' ? '30 ngày qua' : filterTime
                    }
                    <button onClick={() => setFilterTime('all')} className="hover:text-slate-200 ml-1"><X size={10} /></button>
                  </span>
                )}
                {activePreset !== 'all' && (
                  <span className="inline-flex items-center gap-1 text-[11px] bg-rose-500/10 text-rose-400 border border-rose-500/20 px-2 py-0.5 rounded">
                    Preset: {
                      activePreset === 'created_today' ? 'Mới tạo hôm nay' :
                      activePreset === 'created_week' ? 'Mới tạo tuần này' :
                      activePreset === 'no_proxy' ? 'Chưa gán Proxy' :
                      activePreset === 'has_proxy' ? 'Đã gán Proxy' :
                      activePreset === 'action_required' ? 'Lỗi & Cần SĐT' :
                      activePreset === 'no_2fa' ? 'Chưa có 2FA' :
                      activePreset === 'premium' ? 'Premium' : activePreset
                    }
                    <button onClick={() => setActivePreset('all')} className="hover:text-slate-200 ml-1"><X size={10} /></button>
                  </span>
                )}
                {providerFilter === 'all' && filterWorkspace === 'all' && filterPlan === 'all' && filterStatus === 'all' && filterTag === 'all' && filterTime === 'all' && activePreset === 'all' && (
                  <span className="text-[11px] text-slate-500 italic">Chưa chọn bộ lọc nào</span>
                )}
              </div>
              
              <Button 
                size="sm" 
                variant="ghost" 
                onClick={() => {
                  setProviderFilter('all');
                  setFilterWorkspace('all');
                  setFilterPlan('all');
                  setFilterStatus('all');
                  setFilterTag('all');
                  setFilterTime('all');
                  setActivePreset('all');
                  setSearch('');
                }} 
                className="text-[11px] text-slate-500 hover:text-slate-300"
              >
                <RotateCcw size={11} className="mr-1" /> Đặt lại bộ lọc
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ═══ FORM ═══ */}
      {uiState.isAdding && (
        <Card className="mb-6 animate-slideDown">
          <CardHeader>
            <CardTitle>
              {uiState.editId ? <Pencil size={14} /> : <Plus size={14} />}
              {uiState.editId ? 'Chỉnh sửa tài khoản' : 'Thêm tài khoản mới vào Vault'}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1.5 mt-1">Nhà cung cấp (Provider)</label>
                <select className="w-full bg-white/5 border border-white/10 rounded-md px-3 py-2 text-[13px] text-slate-100 outline-none focus:border-indigo-500/50" value={uiState.provider} onChange={e => setUiState(s => ({ ...s, provider: e.target.value }))}>
                  {PROVIDERS.map(p => <option key={p.id} value={p.id} className="bg-[#0f172a]">{p.name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1.5 mt-1">Tên gợi nhớ (Label)</label>
                <Input placeholder="Ví dụ: Acc chính, VPS 1..." value={uiState.label} onChange={e => setUiState(s => ({ ...s, label: e.target.value }))} />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1.5 mt-1">Email / Username</label>
                <Input placeholder="email@example.com" value={uiState.email} onChange={e => setUiState(s => ({ ...s, email: e.target.value }))} />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1.5 mt-1">Mật khẩu</label>
                <Input placeholder="Mật khẩu tài khoản" value={uiState.password} onChange={e => setUiState(s => ({ ...s, password: e.target.value }))} />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1.5 mt-1">Hai yếu tố (2FA Secret)</label>
                <Input placeholder="Mã bí mật 2FA (Tùy chọn)" value={uiState.twoFaSecret} onChange={e => setUiState(s => ({ ...s, twoFaSecret: e.target.value }))} />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1.5 mt-1">Proxy URL (Tùy chọn)</label>
                <div className="flex flex-col gap-2">
                  <select className="w-full bg-white/5 border border-white/10 rounded-md px-3 py-2 text-[13px] text-slate-100 outline-none focus:border-indigo-500/50" value={uiState.proxy} onChange={e => setUiState(s => ({ ...s, proxy: e.target.value }))}>
                    <option value="" className="bg-[#0f172a]">(Không dùng proxy)</option>
                    {proxies.map((p: any) => (
                      <option key={p.id} value={p.url} className="bg-[#0f172a]">{p.label || p.url}</option>
                    ))}
                  </select>
                  <Input placeholder="http://user:pass@host:port" value={uiState.proxy} onChange={e => setUiState(s => ({ ...s, proxy: e.target.value }))} />
                </div>
              </div>
              <div className="flex items-end col-span-2 mt-4">
                <Button variant="primary" onClick={save} className="w-full py-2.5">
                  <Save size={16} /> Lưu vào Vault
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ═══ BULK FORM ═══ */}
      {uiState.isBulk && (
        <Card className="mb-6 animate-slideDown">
          <CardHeader>
            <CardTitle><CopyPlus size={14} /> Nhập tài khoản hàng loạt</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="mb-4">
              <label className="block text-xs font-semibold text-slate-400 mb-1.5">Nhà cung cấp (Provider) cho danh sách này</label>
              <select className="w-48 bg-white/5 border border-white/10 rounded-md px-3 py-2 text-[13px] text-slate-100 outline-none focus:border-indigo-500/50" value={uiState.provider} onChange={e => setUiState(s => ({ ...s, provider: e.target.value }))}>
                {PROVIDERS.map(p => <option key={p.id} value={p.id} className="bg-[#0f172a]">{p.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-400 mb-1.5">Danh sách tài khoản (Định dạng: email|pass hoặc email|pass|2fa)</label>
              <textarea
                className="w-full h-40 bg-black/30 border border-white/10 rounded-md p-3 text-[13px] font-mono text-slate-200 outline-none focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/20"
                placeholder="user1@gmail.com|pass123&#10;user2@gmail.com|pass456|2FASECRETXXX..."
                value={uiState.bulkText} onChange={e => setUiState(s => ({ ...s, bulkText: e.target.value }))}
              />
            </div>
            <div className="mt-4 flex justify-end">
              <Button variant="primary" onClick={bulkSave} disabled={loading}>
                <Save size={16} /> {loading ? 'Đang xử lý...' : 'Bắt đầu nhập vào Vault'}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ═══ AUTO BULK DEPLOY FORM ═══ */}
      {isBulkDeployFormOpen && (
        <Card className="mb-6 animate-slideDown border-emerald-500/20 bg-emerald-500/[0.02]">
          <CardHeader>
            <CardTitle className="text-emerald-400">
              <Bot size={14} className="text-emerald-400" /> Tự động Deploy Hàng Loạt
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 items-end">
              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1.5">Số lượng tài khoản cần Deploy</label>
                <div className="flex gap-2">
                  <Input 
                    type="number" 
                    min={1} 
                    className="flex-1" 
                    placeholder={`Tối đa ${items.filter(it => {
                      const tags = safeParseTags(it.tags);
                      return isOpenAI(it.provider) && 
                             (it.status === 'idle' || it.status === 'stopped' || it.status === 'error' || it.status === 'relogin') && 
                             !tags.includes('account_deactivated');
                    }).length} tài khoản`} 
                    value={bulkDeployCount} 
                    onChange={e => setBulkDeployCount(e.target.value === '' ? '' : Number(e.target.value))} 
                  />
                  <Button 
                    variant="secondary" 
                    size="sm" 
                    onClick={() => setBulkDeployCount(items.filter(it => {
                      const tags = safeParseTags(it.tags);
                      return isOpenAI(it.provider) && 
                             (it.status === 'idle' || it.status === 'stopped' || it.status === 'error' || it.status === 'relogin') && 
                             !tags.includes('account_deactivated');
                    }).length)}
                  >
                    Tất cả
                  </Button>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1.5">Thứ tự lựa chọn</label>
                <select 
                  className="w-full bg-white/5 border border-white/10 rounded-md px-3 py-2 text-[13px] text-slate-100 outline-none focus:border-indigo-500/50" 
                  value={bulkDeployOrder} 
                  onChange={e => setBulkDeployOrder(e.target.value as 'sequential' | 'random')}
                >
                  <option value="sequential" className="bg-[#0f172a]">Theo thứ tự (từ trên xuống)</option>
                  <option value="random" className="bg-[#0f172a]">Ngẫu nhiên (Random)</option>
                </select>
              </div>

              <div className="flex justify-end gap-2 text-right">
                <Button 
                  variant="primary" 
                  className="bg-emerald-600 hover:bg-emerald-500 border-emerald-500/30 text-white" 
                  onClick={startAutoBulkDeploy} 
                  disabled={isBulkDeployingAuto}
                >
                  {isBulkDeployingAuto ? <RefreshCw size={14} className="animate-spin mr-1.5" /> : <Bot size={14} className="mr-1.5" />} 
                  {isBulkDeployingAuto ? 'Đang kích hoạt...' : 'Bắt đầu Auto Deploy'}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ═══ AUTO BULK WARMUP FORM ═══ */}
      {isBulkWarmupFormOpen && (
        <Card className="mb-6 animate-slideDown border-orange-500/20 bg-orange-500/[0.02]">
          <CardHeader>
            <CardTitle className="text-orange-400">
              <Flame size={14} className="text-orange-400 mr-1.5 inline" /> Tự động Warmup Hàng Loạt
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 items-end">
              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1.5">Tiêu chí lựa chọn tài khoản</label>
                <select 
                  className="w-full bg-white/5 border border-white/10 rounded-md px-3 py-2 text-[13px] text-slate-100 outline-none focus:border-indigo-500/50" 
                  value={bulkWarmupFilter} 
                  onChange={e => setBulkWarmupFilter(e.target.value as any)}
                >
                  <option value="no_warmup_today" className="bg-[#0f172a]">Chưa warmup hôm nay (Múi giờ VN)</option>
                  <option value="no_warmup_24h" className="bg-[#0f172a]">Chưa warmup &gt; 24 giờ</option>
                  <option value="no_warmup_3d" className="bg-[#0f172a]">Chưa warmup &gt; 3 ngày</option>
                  <option value="no_warmup_7d" className="bg-[#0f172a]">Chưa warmup &gt; 7 ngày</option>
                  <option value="never_warmed" className="bg-[#0f172a]">Chưa từng warmup</option>
                  <option value="all_ready" className="bg-[#0f172a]">Tất cả tài khoản Ready</option>
                </select>
              </div>

              <div>
                <div className="text-[12px] text-slate-300 font-medium">
                  Có <span className="font-bold text-orange-400 text-[14px]">{getAutoWarmupTargets(bulkWarmupFilter).length}</span> tài khoản Ready phù hợp tiêu chí.
                </div>
                <div className="text-[10px] text-slate-500 mt-1.5 leading-relaxed">
                  Chỉ áp dụng cho tài khoản ChatGPT/Codex có trạng thái Ready và không bị khóa.
                </div>
              </div>

              <div className="flex justify-end gap-2 text-right">
                <Button 
                  variant="primary" 
                  className="bg-orange-600 hover:bg-orange-500 border-orange-500/30 text-white" 
                  onClick={startAutoWarmup} 
                  disabled={isBulkWarmingAuto}
                >
                  {isBulkWarmingAuto ? <RefreshCw size={14} className="animate-spin mr-1.5" /> : <Flame size={14} className="mr-1.5" />} 
                  {isBulkWarmingAuto ? 'Đang kích hoạt...' : 'Bắt đầu Auto Warmup'}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ═══ TABLE ═══ */}
      <Card className="flex-1 min-h-[320px] flex flex-col !overflow-visible">
        <CardHeader className="border-b border-white/5 py-4 flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Shield size={16} className="text-indigo-400" /> 
            <span>Tài Khoản Vault</span>
            <span className="px-2 py-0.5 rounded-full text-[10px] bg-indigo-500/20 text-indigo-400 font-bold">{filtered.length}</span>
          </CardTitle>
          <div className="flex items-center gap-2 shrink-0">
            <div className="relative">
              <Button size="sm" variant="secondary" onClick={() => setLegendOpen(v => !v)} className="border-white/10 text-slate-400 hover:bg-white/5">
                <HelpCircle size={12} className="mr-1" /> Chú thích nhãn
              </Button>
              <TagLegend open={legendOpen} onClose={() => setLegendOpen(false)} />
            </div>
            <Button
              size="sm"
              variant="secondary"
              onClick={syncAll}
              disabled={syncingAll || filtered.length === 0}
              className="!text-indigo-400 !border-indigo-500/30 hover:!bg-indigo-500/10"
            >
              {syncingAll ? <RefreshCw size={12} className="animate-spin mr-1" /> : <Database size={12} className="mr-1" />}
              Đẩy Tất cả lên D1
            </Button>
            <Button size="sm" variant="secondary" onClick={autoAssignFromPool} disabled={autoAssigning} className="border-white/10 text-cyan-400 hover:bg-cyan-500/10 hover:border-cyan-500/30">
              <Globe size={12} className="mr-1.5" /> {autoAssigning ? 'Đang gán…' : 'Tự Động Gán Proxy'}
            </Button>
            <Button size="icon-sm" variant="secondary" onClick={() => { loadAccounts(); loadProxies(); }} title="Làm mới">
              <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
            </Button>
          </div>
        </CardHeader>

        <div className="flex-1 min-h-0 overflow-auto custom-scrollbar">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="bg-white/5 border-b border-white/5 sticky top-0 z-10">
                <th className="px-4 py-2.5 text-[11px] font-bold text-slate-400 uppercase tracking-wider w-8">
                  <button
                    onClick={() => {
                      if (selectedIds.size === sortedFiltered.length && sortedFiltered.length > 0) setSelectedIds(new Set());
                      else setSelectedIds(new Set(sortedFiltered.map(it => it.id)));
                    }}
                    className="text-slate-400 hover:text-indigo-400"
                    title="Chọn tất cả"
                  >
                    {selectedIds.size === sortedFiltered.length && sortedFiltered.length > 0 ? <CheckSquare size={14} /> : <Square size={14} />}
                  </button>
                </th>
                <th className="px-2 py-2.5 w-7" />
                <th className="px-4 py-2.5 text-[11px] font-bold text-slate-400 uppercase tracking-wider">Tài khoản</th>
                <th className="px-4 py-2.5 text-[11px] font-bold text-slate-400 uppercase tracking-wider w-28">Trạng thái</th>
                <th className="px-4 py-2.5 text-[11px] font-bold text-slate-400 uppercase tracking-wider w-12">Nhãn</th>
                <th className="px-4 py-2.5 text-[11px] font-bold text-slate-400 uppercase tracking-wider text-right w-36">Thao tác</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {sortedFiltered.map(it => {
                const tags = safeParseTags(it.tags);
                const allowDeploy = isOpenAI(it.provider) && (it.status === 'idle' || it.status === 'stopped') && !tags.includes('account_deactivated');
                const isExpanded = expandedId === it.id;
                return (
                  <React.Fragment key={it.id}>
                    {/* ── Compact Row ── */}
                    <tr
                      className={`hover:bg-white/[0.02] transition-colors group cursor-pointer ${isExpanded ? 'bg-white/[0.02]' : ''}`}
                      onClick={() => setExpandedId(isExpanded ? null : it.id)}
                    >
                      <td className="px-4 py-2.5" onClick={e => e.stopPropagation()}>
                        <button
                          onClick={() => setSelectedIds(prev => {
                            const n = new Set(prev);
                            if (n.has(it.id)) n.delete(it.id); else n.add(it.id);
                            return n;
                          })}
                          className="text-slate-400 hover:text-indigo-400"
                          title="Chọn dòng"
                        >
                          {selectedIds.has(it.id) ? <CheckSquare size={14} /> : <Square size={14} />}
                        </button>
                      </td>
                      <td className="px-2 py-2.5">
                        <ChevronRight size={13} className={`text-slate-500 transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2">
                          <div className="w-2 h-2 rounded-full shrink-0" style={{ background: isOpenAI(it.provider) ? '#10a37f' : (PROVIDERS.find(p => p.id === it.provider)?.color || '#999') }} />
                          <span className="font-semibold text-[13px] text-slate-200 truncate max-w-[280px]">{it.email || 'No email'}</span>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              navigator.clipboard.writeText(it.email);
                              const btn = e.currentTarget;
                              const originalIcon = btn.innerHTML;
                              btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-emerald-400"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
                              btn.classList.add('text-emerald-400', 'border-emerald-400/50');
                              setTimeout(() => {
                                btn.innerHTML = originalIcon;
                                btn.classList.remove('text-emerald-400', 'border-emerald-400/50');
                              }, 1500);
                            }}
                            className="p-1.5 rounded-md bg-white/5 border border-white/10 text-slate-400 hover:text-slate-200 hover:border-slate-400/50 transition-all"
                            title="Copy email"
                          >
                            <Copy size={13} />
                          </button>
                          <PlanBadge plan={it.plan} />
                          {it.mail_status === 'dead' && (
                            <span className="inline-flex items-center gap-1 text-[10px] text-rose-400 font-bold bg-rose-500/10 px-1.5 py-0.5 rounded border border-rose-500/20 uppercase tracking-wider animate-pulse" title="Email liên kết trong Workshop đã bị DEAD/Vô hiệu hóa">
                              <AlertTriangle size={9} /> Mail Dead
                            </span>
                          )}
                          {it.mail_status === 'not_found' && (
                            <span className="inline-flex items-center gap-1 text-[10px] text-amber-400 font-medium bg-amber-500/10 px-1.5 py-0.5 rounded border border-amber-500/20 uppercase tracking-wider" title="Email không tồn tại trong Workshop Email Pool">
                              <AlertTriangle size={9} /> Thiếu Email Pool
                            </span>
                          )}
                          {it.label && <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 text-slate-500 border border-white/5 truncate max-w-[80px]">{it.label}</span>}
                          {isOpenAI(it.provider) && (() => {
                            const ps = it.provider_specific_data || {};
                            const badges = [];
                            
                            if (ps.warmupStatus === 'pending') {
                              badges.push(<span key="warm" className="inline-flex items-center text-[10px] text-amber-400 font-medium bg-amber-500/10 px-1.5 py-0.5 rounded border border-amber-500/20"><RefreshCw size={9} className="animate-spin mr-0.5" /> Warming</span>);
                            } else if (ps.warmupStatus === 'success') {
                              const relTime = getRelativeTimeShort(ps.lastWarmedAt);
                              badges.push(
                                <span 
                                  key="warm" 
                                  className="inline-flex items-center text-[10px] text-orange-400 font-semibold bg-orange-500/10 px-1.5 py-0.5 rounded border border-orange-500/20"
                                  title={ps.lastWarmedAt ? `Warmup lúc: ${fmtDateTimeVN(ps.lastWarmedAt)}` : undefined}
                                >
                                  <Flame size={9} className="mr-0.5 animate-pulse" /> Warmed {relTime ? `(${relTime})` : ''}
                                </span>
                              );
                            } else if (ps.warmupStatus === 'failed') {
                              badges.push(<span key="warm" className="inline-flex items-center text-[10px] text-rose-400 font-medium bg-rose-500/10 px-1.5 py-0.5 rounded border border-rose-500/20">⚠️ Failed</span>);
                            }
                            
                            return badges.length > 0 ? <div className="flex flex-col gap-1 mt-1">{badges}</div> : null;
                          })()}
                        </div>
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex flex-col gap-1 items-start">
                          <StatusBadge status={it.status} notes={it.notes} tags={tags} />
                          <GatewayBadge gatewayStatus={it.gateway_status || null} />
                          {it.provider_specific_data?.testStatus && it.provider_specific_data.testStatus !== 'active' && (
                            <span className="inline-flex items-center gap-1 text-[10px] text-rose-400 font-medium bg-rose-500/10 px-1.5 py-0.5 rounded border border-rose-500/20" title={it.provider_specific_data.lastError || it.notes || 'Authentication Failed'}>
                              <AlertTriangle size={10} /> Auth Failed
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-2.5">
                        <TagIcons 
                          tags={tags} 
                          twoFa={it.two_fa_secret} 
                          provider={it.provider} 
                          twoFaRegenStatus={it.provider_specific_data?.twoFaRegenStatus}
                          twoFaRegenError={it.provider_specific_data?.twoFaRegenError}
                        />
                      </td>
                      <td className="px-4 py-2.5 text-right" onClick={e => e.stopPropagation()}>
                        <div className="flex gap-1 justify-end opacity-0 group-hover:opacity-100 transition-opacity">
                          {it.status !== 'dead' && isOpenAI(it.provider) && (
                            <Button 
                              size="icon-sm" 
                              title="🔥 Warmup tài khoản" 
                              onClick={() => warmupAccount(it.id, it.email, it)} 
                              className="!text-orange-400 border-orange-500/20 hover:bg-orange-500/10"
                            >
                              <Flame size={13} />
                            </Button>
                          )}
                          {it.status !== 'dead' && isOpenAI(it.provider) && (
                            <Button 
                              size="icon-sm" 
                              title="🛡️ Tái tạo 2FA/MFA" 
                              onClick={() => regenerate2FA(it.id, it.email, it)} 
                              className="!text-teal-400 border-teal-500/20 hover:bg-teal-500/10"
                            >
                              <Lock size={13} />
                            </Button>
                          )}
                          {isOpenAI(it.provider) && it.cookies && (
                            <Button 
                              size="icon-sm" 
                              title="🛡️ Kiểm tra Session (Live/Dead)" 
                              onClick={() => checkSession(it.id, it.email)} 
                              className="!text-blue-400 border-blue-500/20 hover:bg-blue-500/10"
                            >
                              <Shield size={13} />
                            </Button>
                          )}
                          {allowDeploy && (
                            <Button size="icon-sm" title="🤖 Deploy qua Unified Worker" onClick={() => deploy(it.id, it.email)} className="!text-emerald-400 border-emerald-500/20 hover:bg-emerald-500/10"><Globe size={13} /></Button>
                          )}
                          {(it.status !== 'idle') && isOpenAI(it.provider) && (
                            <Button size="icon-sm" variant="ghost" title="Thu hồi về kho lạnh" onClick={() => stopAccount(it.id, it.email, it)}><X size={13} /></Button>
                          )}
                          {(it.status === 'error') && isOpenAI(it.provider) && !tags.includes('account_deactivated') && (
                            <Button size="icon-sm" variant="ghost" title="Thử lại" onClick={() => deploy(it.id, it.email)}><RotateCcw size={13} /></Button>
                          )}
                          {isOpenAI(it.provider) && (
                            <Button size="icon-sm" variant="ghost" title="Gán proxy từ pool" onClick={() => assignFromPool(it.id)} disabled={assigningId === it.id} className="!text-cyan-400"><Globe size={13} /></Button>
                          )}
                          {isOpenAI(it.provider) && it.proxy_url && (
                            <Button size="icon-sm" variant="ghost" title="Gỡ proxy" onClick={() => unassignProxy(it.id)} disabled={assigningId === it.id} className="!text-amber-400"><X size={13} /></Button>
                          )}
                          <Button size="icon-sm" variant="ghost" title="Đọc Inbox" onClick={() => readInbox(it.email)} className="!text-purple-400"><Mail size={13} /></Button>
                          <Button size="icon-sm" variant="ghost" title="Đẩy lên D1" onClick={() => syncNow(it.id, it.email)} className="!text-indigo-400"><Database size={13} /></Button>
                          <Button size="icon-sm" variant="ghost" title="Sửa" onClick={() => startEdit(it)}><Pencil size={13} /></Button>
                          <Button size="icon-sm" variant="danger" title="Xóa" onClick={() => del(it.id)}><Trash2 size={13} /></Button>
                        </div>
                      </td>
                    </tr>

                    {/* ── Expanded Detail Row ── */}
                    {isExpanded && (
                      <tr className="bg-white/[0.015]">
                        <td colSpan={6} className="px-4 py-3">
                          <div className="grid grid-cols-4 gap-x-6 gap-y-2 ml-7">
                            {/* Provider */}
                            <div>
                              <div className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-0.5">Provider</div>
                              <div className="flex items-center gap-1.5">
                                <div className="w-2 h-2 rounded-full" style={{ background: isOpenAI(it.provider) ? '#10a37f' : (PROVIDERS.find(p => p.id === it.provider)?.color || '#999') }} />
                                <span className="text-[12px] text-slate-300">{getProviderName(it.provider)}</span>
                              </div>
                            </div>
                            {/* Proxy */}
                            <div>
                              <div className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-0.5">Proxy</div>
                              {it.proxy_url ? (
                                <span className="inline-flex items-center gap-1 text-[11px] text-slate-400"><Globe size={10} /> <span className="font-mono truncate max-w-[180px]">{it.proxy_url}</span></span>
                              ) : <span className="text-[11px] text-slate-600 italic">Không có</span>}
                            </div>
                            {/* Exported */}
                            <div>
                              <div className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-0.5">Exported</div>
                              {it.exported_to ? (
                                <div>
                                  <span className="flex items-center gap-1 text-[11px] text-emerald-400 font-semibold"><Database size={10} /> {it.exported_to.toUpperCase()}</span>
                                  <span className="text-[10px] text-slate-500">{fmtDateTimeVN(it.exported_at)}</span>
                                </div>
                              ) : <span className="text-[11px] text-slate-600 italic">Chưa export</span>}
                            </div>
                            {/* Time */}
                            <div>
                              <div className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-0.5">Thời gian</div>
                              <div className="text-[11px] text-slate-400">
                                <div>Tạo: {fmtDateTimeVN(it.created_at || it.createdAt || it.updated_at)}</div>
                                <div>Cập: {fmtDateTimeVN(it.updated_at || it.updatedAt)}</div>
                              </div>
                            </div>
                            {/* Password */}
                            <div>
                              <div className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-0.5">Mật khẩu</div>
                              <CopyBadge text={it.password} icon={Key} colorClass="text-amber-400" hoverBorderClass="hover:border-amber-400/50" />
                            </div>
                            {/* 2FA */}
                            <div>
                              <div className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-0.5">2FA Secret</div>
                              <CopyBadge text={it.two_fa_secret} icon={Shield} colorClass="text-emerald-400" hoverBorderClass="hover:border-emerald-400/50" />
                            </div>
                            {/* Tags detail */}
                            <div>
                              <div className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-0.5">Tags</div>
                              <div className="flex gap-1.5 flex-wrap">
                                {tags.length === 0 && !it.two_fa_secret && <span className="text-[11px] text-slate-600 italic">Không có</span>}
                                {tags.map(t => {
                                  const meta = TAG_META[t];
                                  if (meta) {
                                    const Icon = meta.icon;
                                    return <span key={t} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-bold ${meta.bg} ${meta.color} border ${meta.border}`}><Icon size={10} /> {t}</span>;
                                  }
                                  return <span key={t} className="inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-bold bg-white/5 text-slate-400 border border-white/10">{t}</span>;
                                })}
                              </div>
                            </div>
                            {/* Notes */}
                            <div>
                              <div className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-0.5">Ghi chú</div>
                              <span className="text-[11px] text-slate-400 max-w-[200px] truncate block">{it.notes || <span className="italic text-slate-600">Không có</span>}</span>
                            </div>
                            {/* Warmup */}
                            {isOpenAI(it.provider) && (
                              <div>
                                <div className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-0.5">Trạng thái Warmup</div>
                                <div className="flex flex-col gap-1 text-[11px]">
                                  <div>
                                    {(() => {
                                      const ps = it.provider_specific_data || {};
                                      const lastWarmed = ps.lastWarmedAt;
                                      const status = ps.warmupStatus;
                                      const error = ps.warmupError;
                                      const qAsked = ps.warmupQuestionsAsked;
                                      
                                      if (status === 'pending') {
                                        return (
                                          <span className="inline-flex items-center gap-1 text-amber-400 font-medium">
                                            <RefreshCw size={10} className="animate-spin" /> Đang chạy...
                                          </span>
                                        );
                                      }
                                      if (status === 'success') {
                                        return (
                                          <div>
                                            <span className="inline-flex items-center gap-1 text-emerald-400 font-semibold">
                                              <Flame size={11} className="text-orange-400 animate-pulse" /> Đã Warm ({qAsked} câu)
                                            </span>
                                            <div className="text-[9px] text-slate-500 mt-0.5">{fmtDateTimeVN(lastWarmed)}</div>
                                          </div>
                                        );
                                      }
                                      if (status === 'failed') {
                                        return (
                                          <div title={error || 'Unknown error'}>
                                            <span className="inline-flex items-center gap-1 text-rose-400 font-medium">
                                              ⚠️ Warmup Lỗi
                                            </span>
                                            <div className="text-[9px] text-rose-500/80 truncate max-w-[150px]">{error || 'Unknown error'}</div>
                                            <div className="text-[9px] text-slate-500 mt-0.5">{fmtDateTimeVN(lastWarmed)}</div>
                                          </div>
                                        );
                                      }
                                      return <span className="text-slate-600 italic">Chưa Warmup</span>;
                                    })()}
                                  </div>
                                  {(() => {
                                    const ps = it.provider_specific_data || {};
                                    if (ps.warmupStatus && ps.warmupStatus !== 'idle') {
                                      return (
                                        <button
                                          type="button"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            setView('screenshots');
                                          }}
                                          className="mt-1.5 flex items-center gap-1 text-[10px] text-orange-400 hover:text-orange-300 font-medium transition-all"
                                        >
                                          📸 Xem ảnh logs
                                        </button>
                                      );
                                    }
                                    return null;
                                  })()}
                                </div>
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
              {filtered.length === 0 && !loading && (
                <tr><td colSpan={6} className="py-16 text-center text-slate-500 text-[13px]">Vault trống hoặc không khớp từ khóa tìm kiếm.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/* ═══ INBOX MODAL ═══ */}
      {inboxModal.open && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-[#0d111c] border border-white/10 rounded-2xl shadow-2xl w-full max-w-4xl max-h-[85vh] flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-purple-500/10 text-purple-400 flex items-center justify-center">
                  <Mail size={18} />
                </div>
                <div>
                  <h3 className="text-[15px] font-bold text-slate-100">Inbox Email</h3>
                  <p className="text-[11px] text-slate-400">{inboxModal.email}</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => readInbox(inboxModal.email)}
                  disabled={inboxModal.loading}
                  className="p-2 rounded-lg hover:bg-white/5 text-slate-400 hover:text-slate-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  title="Reload"
                >
                  <RefreshCw size={18} className={inboxModal.loading ? 'animate-spin' : ''} />
                </button>
                <button
                  onClick={() => setInboxModal({ open: false, email: '', messages: [], loading: false })}
                  className="p-2 rounded-lg hover:bg-white/5 text-slate-400 hover:text-slate-200 transition-colors"
                >
                  <XCircle size={18} />
                </button>
              </div>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-auto custom-scrollbar p-6">
              {inboxModal.loading ? (
                <div className="flex items-center justify-center h-64">
                  <div className="w-8 h-8 border-2 border-purple-500/30 border-t-purple-500 rounded-full animate-spin" />
                </div>
              ) : inboxModal.messages.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-64 text-slate-500">
                  <Mail size={48} className="opacity-20 mb-4" />
                  <p className="text-[13px]">Không có email nào</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {inboxModal.messages.map((msg: any) => (
                    <div
                      key={msg.id}
                      className={`p-4 rounded-xl border transition-all ${msg.direction === 'outgoing' ? 'bg-indigo-500/5 border-indigo-500/10' : 'bg-white/[0.02] border-white/5'} ${!msg.isRead ? 'border-l-2 border-l-purple-500' : ''}`}
                    >
                      <div className="flex items-start justify-between gap-3 mb-2">
                        <div className="flex items-center gap-2">
                          <span className={`text-[11px] font-semibold px-2 py-0.5 rounded ${msg.direction === 'outgoing' ? 'bg-indigo-500/10 text-indigo-400' : 'bg-slate-500/10 text-slate-400'}`}>
                            {msg.direction === 'outgoing' ? 'Đã gửi' : 'Đã nhận'}
                          </span>
                          {!msg.isRead && (
                            <span className="text-[10px] font-semibold px-2 py-0.5 rounded bg-purple-500/10 text-purple-400">Chưa đọc</span>
                          )}
                        </div>
                        <span className="text-[10px] text-slate-500">
                          {msg.receivedDateTime ? new Date(msg.receivedDateTime).toLocaleString('vi-VN') : ''}
                        </span>
                      </div>
                      <div className="text-[13px] font-semibold text-slate-200 mb-1">{msg.subject || '(Không tiêu đề)'}</div>
                      <div className="text-[11px] text-slate-400 mb-2">
                        Từ: {msg.from?.emailAddress?.address || 'Unknown'} {msg.from?.emailAddress?.name ? `(${msg.from.emailAddress.name})` : ''}
                      </div>
                      {msg.bodyPreview && (
                        <div className="text-[11px] text-slate-500 bg-black/20 p-2 rounded-lg">
                          {msg.bodyPreview.substring(0, 200)}{msg.bodyPreview.length > 200 ? '...' : ''}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="px-6 py-4 border-t border-white/10 flex justify-between items-center text-[11px] text-slate-500">
              <span>Tổng {inboxModal.messages.length} email</span>
              <span>Sắp xếp theo thời gian mới nhất</span>
            </div>
          </div>
        </div>
      )}
      {/* ═══ FLOATING BATCH ACTIONS BAR ═══ */}
      {selectedIds.size > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 bg-[#0d111c]/95 backdrop-blur-md border border-indigo-500/30 rounded-2xl shadow-[0_0_30px_rgba(99,102,241,0.25)] px-6 py-4 flex items-center gap-6 animate-slideUp transition-all duration-300">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-indigo-500 animate-pulse shrink-0" />
            <span className="text-xs font-bold text-slate-200 whitespace-nowrap">Đã chọn {selectedIds.size} tài khoản</span>
          </div>
          <div className="h-6 w-[1px] bg-white/10 shrink-0" />
          <div className="flex items-center gap-2 shrink-0">
            <Button size="sm" variant="secondary" onClick={bulkDeploy} className="border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10 h-8 text-[11px] font-semibold">
              <Globe size={11} className="mr-1" /> Deploy ({selectedIds.size})
            </Button>
            <Button size="sm" variant="secondary" onClick={bulkWarmupSelected} className="border-orange-500/30 text-orange-400 hover:bg-orange-500/10 h-8 text-[11px] font-semibold">
              <Flame size={11} className="mr-1 animate-pulse" /> Warmup
            </Button>
            <Button size="sm" variant="secondary" onClick={bulkRegenerate2FASelected} className="border-teal-500/30 text-teal-400 hover:bg-teal-500/10 h-8 text-[11px] font-semibold" title="Tái tạo 2FA hàng loạt">
              <Lock size={11} className="mr-1 animate-pulse" /> Regenerate 2FA
            </Button>
            <Button size="sm" variant="secondary" onClick={bulkCheckSessionSelected} className="border-blue-500/30 text-blue-400 hover:bg-blue-500/10 h-8 text-[11px] font-semibold" title="Kiểm tra Session mà không cần login">
              <Shield size={11} className="mr-1" /> Check Session
            </Button>
            <div className="h-4 w-[1px] bg-white/10 shrink-0" />
            <select
              className="h-8 rounded-md bg-black/40 border border-white/10 text-[11px] text-slate-300 px-2 outline-none focus:border-indigo-500/50"
              value={bulkProxyId}
              onChange={e => setBulkProxyId(e.target.value)}
            >
              <option value="pool_proxy">(Theo proxy gán ở Pool của Account nếu có)</option>
              <option value="account_proxy">(Theo proxy đã gán của Account)</option>
              <option value="">(Auto proxy tốt nhất)</option>
              {proxies.map((p: any) => <option key={p.id} value={p.id}>{p.label || p.url}</option>)}
            </select>
            <Button size="sm" variant="secondary" onClick={() => bulkProxyAction('assign')} disabled={bulkProxyRunning} className="border-cyan-500/30 text-cyan-400 hover:bg-cyan-500/10 h-8 text-[11px] font-semibold">
              Gán Proxy
            </Button>
            <Button size="sm" variant="secondary" onClick={() => bulkProxyAction('unassign')} disabled={bulkProxyRunning} className="border-amber-500/30 text-amber-400 hover:bg-amber-500/10 h-8 text-[11px] font-semibold">
              Gỡ Proxy
            </Button>
            <div className="h-4 w-[1px] bg-white/10 shrink-0" />
            <Button size="sm" variant="secondary" onClick={bulkSyncSelected} className="border-indigo-500/30 text-indigo-400 hover:bg-indigo-500/10 h-8 text-[11px] font-semibold">
              <Database size={11} className="mr-1" /> Đồng bộ D1
            </Button>
            <Button size="sm" variant="danger" onClick={bulkDeleteSelected} className="border-rose-500/30 text-rose-400 hover:bg-rose-500/10 h-8 text-[11px] font-semibold">
              <Trash2 size={11} className="mr-1" /> Xóa đã chọn
            </Button>
            <Button size="icon-sm" variant="ghost" onClick={() => setSelectedIds(new Set())} title="Hủy chọn" className="h-8 w-8 hover:bg-white/5">
              <X size={13} className="text-slate-400 hover:text-slate-200" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
