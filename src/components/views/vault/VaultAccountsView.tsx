'use client';
import React, { useCallback, useEffect, useState } from 'react';
import {
  Plus, Search, RefreshCw, Pencil, Trash2, Save, X,
  ChevronRight, Users, Tag, Filter,
  Database, Shield, Globe, Key, CopyPlus, FileUp, RotateCcw, Copy, Check, Square, CheckSquare,
  Bot, PhoneOff, Skull, Lock, HelpCircle, Mail, XCircle, Briefcase, Flame
} from 'lucide-react';
import { useApp } from '../../AppContext';
import { fmtDateTimeVN, useConfirm } from '../../Views';
import { Button, Card, CardHeader, CardTitle, CardContent, Input } from '../../ui';

/* ── Helpers ── */
function StatusBadge({ status, notes }: { status: string; notes?: string }) {
  // Trường hợp đặc biệt: lỗi yêu cầu số điện thoại.
  // Dùng `includes` để bền vững với mọi prefix (vd: "Lỗi Worker: NEED_PHONE: ...",
  // "Exception: NEED_PHONE: ..." từ catch block của các worker đời cũ).
  if (status === 'error' && notes && notes.includes('NEED_PHONE')) {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-orange-500/10 text-orange-500 border border-orange-500/20">
        <span className="w-1.5 h-1.5 rounded-full bg-current" />
        📵 Cần SĐT
      </span>
    );
  }
  const m: Record<string, { color: string; bg: string; border: string; label: string }> = {
    ready: { color: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/20', label: 'Ready' },
    idle: { color: 'text-slate-400', bg: 'bg-white/5', border: 'border-white/5', label: 'Idle' },
    error: { color: 'text-rose-400', bg: 'bg-rose-500/10', border: 'border-rose-500/20', label: 'Error' },
    dead: { color: 'text-rose-500 font-bold', bg: 'bg-rose-950/40', border: 'border-rose-900/30', label: 'Dead' },
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
};

function TagIcons({ tags, twoFa }: { tags: string[]; twoFa?: string }) {
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
      {twoFa && (
        <span title="Có 2FA — xác thực hai yếu tố đã bật" className="inline-flex items-center justify-center w-[22px] h-[22px] rounded-md bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 cursor-help">
          <Lock size={12} />
        </span>
      )}
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
  const [bulkProxyId, setBulkProxyId] = useState('');
  const [bulkProxyRunning, setBulkProxyRunning] = useState(false);
  const [syncingDeadTags, setSyncingDeadTags] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [legendOpen, setLegendOpen] = useState(false);
  const [inboxModal, setInboxModal] = useState<{ open: boolean; email: string; messages: any[]; loading: boolean }>({ open: false, email: '', messages: [], loading: false });

  const [isBulkDeployFormOpen, setIsBulkDeployFormOpen] = useState(false);
  const [bulkDeployCount, setBulkDeployCount] = useState<number | ''>('');
  const [bulkDeployOrder, setBulkDeployOrder] = useState<'sequential' | 'random'>('sequential');
  const [isBulkDeployingAuto, setIsBulkDeployingAuto] = useState(false);

  // Custom Advanced Filter States
  const [filterWorkspace, setFilterWorkspace] = useState<'all' | 'workspace' | 'personal'>('all');
  const [filterPlan, setFilterPlan] = useState<'all' | 'free' | 'plus' | 'pro' | 'team'>('all');
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [filterTag, setFilterTag] = useState<string>('all');
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
      tags.includes(filterTag);

    return providerMatch && searchMatch && workspaceMatch && planMatch && statusMatch && tagMatch;
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

  const del = async (id: string) => {
    if (!await askConfirm('Xóa Tài Khoản', 'Bạn có chắc muốn xóa tài khoản này khỏi Vault?')) return;
    await fetch(`/api/vault/accounts/${id}`, { method: 'DELETE' });
    setItems(prev => prev.filter(it => it.id !== id));
    addToast('Đã xoá', 'info');
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

  const bulkDeleteSelected = async () => {
    if (!await askConfirm('Xóa Hàng Loạt', `Xác nhận XÓA ${selectedIds.size} tài khoản đã chọn khỏi Vault? Thao tác này không thể hoàn tác.`)) return;
    let success = 0;
    for (const id of Array.from(selectedIds)) {
      try {
        const r = await fetch(`/api/vault/accounts/${id}`, { method: 'DELETE' });
        if (r.ok) success++;
      } catch {}
    }
    addToast(`🗑️ Đã xóa ${success} tài khoản khỏi Vault`, 'info');
    setSelectedIds(new Set());
    loadAccounts();
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
      {/* ═══ ACTIONS ═══ */}
      <div className="flex gap-3 mb-4 mt-2 relative z-10">
        <div className="flex-1 relative flex items-center">
          <Search size={15} className="absolute left-3 text-slate-500" />
          <Input className="pl-9 pr-24" placeholder="Tìm theo email, nhãn, proxy hoặc ghi chú..." value={search} onChange={e => setSearch(e.target.value)} />
          <div className="absolute right-2 flex items-center">
            <Button 
              size="sm"
              variant="secondary" 
              onClick={() => { setIsAdvancedFilterOpen(!isAdvancedFilterOpen); setUiState(s => ({ ...s, isBulk: false, isAdding: false })); setIsBulkDeployFormOpen(false); }} 
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
          <Button variant="ghost" className="!text-emerald-400 hover:!bg-emerald-500/10" onClick={() => { setIsBulkDeployFormOpen(!isBulkDeployFormOpen); setUiState(s => ({ ...s, isBulk: false, isAdding: false })); setIsAdvancedFilterOpen(false); }}>
            {isBulkDeployFormOpen ? <X size={16} /> : <Bot size={16} />} Auto Deploy
          </Button>
          <Button variant="ghost" onClick={() => { setUiState(s => ({ ...s, isBulk: !s.isBulk, isAdding: false, editId: null })); setIsBulkDeployFormOpen(false); setIsAdvancedFilterOpen(false); }}>
            {uiState.isBulk ? <X size={16} /> : <FileUp size={16} />} Nhập hàng loạt
          </Button>
          <Button variant="primary" onClick={() => { setUiState(s => ({ ...s, isAdding: !s.isAdding, isBulk: false, editId: null, email: '', password: '', twoFaSecret: '', label: '' })); setIsBulkDeployFormOpen(false); setIsAdvancedFilterOpen(false); }}>
            {uiState.isAdding ? <X size={16} /> : <Plus size={16} />} {uiState.isAdding ? 'Hủy bỏ' : 'Thêm Tài Khoản'}
          </Button>
        </div>
      </div>

      {/* ═══ ADVANCED FILTER PANEL ═══ */}
      {isAdvancedFilterOpen && (
        <Card className="mb-2 border-indigo-500/20 bg-indigo-500/[0.01] animate-slideDown overflow-visible relative z-20">
          <CardContent className="py-4">
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4 items-end">
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
                    Nhãn: {filterTag}
                    <button onClick={() => setFilterTag('all')} className="hover:text-slate-200 ml-1"><X size={10} /></button>
                  </span>
                )}
                {providerFilter === 'all' && filterWorkspace === 'all' && filterPlan === 'all' && filterStatus === 'all' && filterTag === 'all' && (
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
                      if (selectedIds.size === filtered.length && filtered.length > 0) setSelectedIds(new Set());
                      else setSelectedIds(new Set(filtered.map(it => it.id)));
                    }}
                    className="text-slate-400 hover:text-indigo-400"
                    title="Chọn tất cả"
                  >
                    {selectedIds.size === filtered.length && filtered.length > 0 ? <CheckSquare size={14} /> : <Square size={14} />}
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
              {filtered.map(it => {
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
                          {it.label && <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 text-slate-500 border border-white/5 truncate max-w-[80px]">{it.label}</span>}
                          {isOpenAI(it.provider) && (() => {
                            const ps = it.provider_specific_data || {};
                            if (ps.warmupStatus === 'pending') {
                              return <span className="inline-flex items-center text-[10px] text-amber-400 font-medium bg-amber-500/10 px-1.5 py-0.5 rounded border border-amber-500/20"><RefreshCw size={9} className="animate-spin mr-0.5" /> Warming</span>;
                            }
                            if (ps.warmupStatus === 'success') {
                              return <span className="inline-flex items-center text-[10px] text-orange-400 font-semibold bg-orange-500/10 px-1.5 py-0.5 rounded border border-orange-500/20"><Flame size={9} className="mr-0.5 animate-pulse" /> Warmed</span>;
                            }
                            if (ps.warmupStatus === 'failed') {
                              return <span className="inline-flex items-center text-[10px] text-rose-400 font-medium bg-rose-500/10 px-1.5 py-0.5 rounded border border-rose-500/20">⚠️ Failed</span>;
                            }
                            return null;
                          })()}
                        </div>
                      </td>
                      <td className="px-4 py-2.5"><StatusBadge status={it.status} notes={it.notes} /></td>
                      <td className="px-4 py-2.5"><TagIcons tags={tags} twoFa={it.two_fa_secret} /></td>
                      <td className="px-4 py-2.5 text-right" onClick={e => e.stopPropagation()}>
                        <div className="flex gap-1 justify-end opacity-0 group-hover:opacity-100 transition-opacity">
                          {it.status === 'ready' && isOpenAI(it.provider) && (
                            <Button 
                              size="icon-sm" 
                              title="🔥 Warmup tài khoản" 
                              onClick={() => warmupAccount(it.id, it.email, it)} 
                              className="!text-orange-400 border-orange-500/20 hover:bg-orange-500/10"
                            >
                              <Flame size={13} />
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
            <div className="h-4 w-[1px] bg-white/10 shrink-0" />
            <select
              className="h-8 rounded-md bg-black/40 border border-white/10 text-[11px] text-slate-300 px-2 outline-none focus:border-indigo-500/50"
              value={bulkProxyId}
              onChange={e => setBulkProxyId(e.target.value)}
            >
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
