'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Plus, Upload, Search, RefreshCw,
  Copy, Check, Pencil, Trash2, RotateCcw,
  Save, X, AlertCircle, ChevronDown, ChevronUp,
  Users, CheckCircle, Clock, XCircle, Globe, Database, Key, Shield
} from 'lucide-react';
import { useApp } from '../AppContext';
import { fmtDateTimeVN, ConfirmModal, Spinner } from '../Views';
import { Button, Card, CardHeader, CardTitle, CardContent, Input, StatBox } from '../ui';
import { AlertTriangle } from 'lucide-react';

/* ── Helpers ── */
function parseBulk(raw: string) {
  return raw.split('\n').map(l => l.trim()).filter(Boolean).map(line => {
    const [email = '', password = '', twoFaSecret = ''] = line.replace(/\t/g, ':').replace(/\s*[|]\s*/g, ':').split(':').map(s => s.trim());
    return { email, password, twoFaSecret };
  }).filter(r => r.email.includes('@'));
}

function safePercentRemaining(used: any, total: any) {
  const u = Number(used || 0);
  const t = Number(total || 0);
  if (!Number.isFinite(u) || !Number.isFinite(t) || t <= 0) return null;
  const remaining = Math.max(0, Math.min(100, 100 - (u / t) * 100));
  return Math.round(remaining);
}

function normalizeQuotas(raw: any): Array<{ name: string; used: number; total: number }> {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!parsed) return [];

    if (Array.isArray(parsed)) {
      return parsed
        .map((q: any) => ({
          name: String(q?.name || q?.key || q?.model || q?.type || 'quota'),
          used: Number(q?.used || q?.current || q?.usage || 0),
          total: Number(q?.total || q?.limit || q?.max || 0),
        }))
        .filter(q => Number.isFinite(q.total) && q.total > 0);
    }

    if (typeof parsed === 'object') {
      const candidates: Array<{ name: string; used: number; total: number }> = [];
      for (const [name, v] of Object.entries(parsed as Record<string, any>)) {
        if (!v || typeof v !== 'object') continue;
        const used = Number((v as any).used ?? (v as any).current ?? (v as any).usage ?? 0);
        const total = Number((v as any).total ?? (v as any).limit ?? (v as any).max ?? 0);
        if (Number.isFinite(total) && total > 0) {
          candidates.push({ name, used, total });
        }
      }
      return candidates;
    }
  } catch { }
  return [];
}

/* ── Tiny Copy Button ── */
function CopyBtn({ text }: { text?: string }) {
  const [ok, setOk] = useState(false);
  if (!text) return null;
  return (
    <button onClick={e => { e.stopPropagation(); navigator.clipboard?.writeText(text); setOk(true); setTimeout(() => setOk(false), 1400); }}
      className={`shrink-0 p-0.5 inline-flex transition-colors ${ok ? 'text-emerald-500' : 'text-slate-500 hover:text-slate-300'}`}>
      {ok ? <Check size={12} /> : <Copy size={12} />}
    </button>
  );
}

/* ── Mono Cell (for pass/2fa) ── */
function MonoCell({ value, icon: Icon, colorClass = 'text-slate-400' }: { value?: string, icon?: any, colorClass?: string }) {
  const [copied, setCopied] = useState(false);
  if (!value) return <span className="text-slate-500">—</span>;

  const onCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div
      onClick={onCopy}
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-black/20 border border-white/5 cursor-pointer transition-all hover:border-indigo-400/50 hover:bg-black/40 group select-none"
    >
      {Icon && <Icon size={11} className={colorClass} />}
      <code className="text-xs font-mono text-slate-300 max-w-[120px] overflow-hidden text-ellipsis whitespace-nowrap">
        {value}
      </code>
      {copied ? <Check size={11} className="text-emerald-500" /> : <Copy size={11} className="opacity-50 group-hover:opacity-100 transition-opacity text-slate-400" />}
    </div>
  );
}

const ERROR_TYPE_LABELS: Record<string, string> = {
  runtime_error: 'Runtime',
  upstream_auth_error: 'Upstream Auth',
  auth_missing: 'Missing Credential',
  token_refresh_failed: 'Refresh Failed',
  token_expired: 'Token Expired',
  upstream_rate_limited: 'Rate Limited',
  upstream_unavailable: 'Upstream Unavailable',
  network_error: 'Network Error',
  unsupported: 'Test Unsupported',
  upstream_error: 'Upstream Error',
};

function inferErrorType(it: any, isCooldown: boolean): string | null {
  if (isCooldown) return 'upstream_rate_limited';

  const direct = String(it?.last_error_type || it?.lastErrorType || '').trim();
  if (direct) return direct;

  const code = Number(it?.error_code ?? it?.errorCode ?? NaN);
  if (Number.isFinite(code)) {
    if (code === 401 || code === 403) return 'upstream_auth_error';
    if (code === 429) return 'upstream_rate_limited';
    if (code >= 500) return 'upstream_unavailable';
  }

  const msg = String(it?.last_error || it?.lastError || '').toLowerCase();
  if (!msg) return null;
  if (msg.includes('runtime') || msg.includes('not runnable') || msg.includes('not installed') || msg.includes('healthcheck')) return 'runtime_error';
  if (msg.includes('refresh failed')) return 'token_refresh_failed';
  if (msg.includes('token expired') || msg.includes('expired')) return 'token_expired';
  if (msg.includes('invalid api key') || msg.includes('token invalid') || msg.includes('revoked') || msg.includes('access denied') || msg.includes('unauthorized')) return 'upstream_auth_error';
  if (msg.includes('rate limit') || msg.includes('quota') || msg.includes('too many requests') || msg.includes('429')) return 'upstream_rate_limited';
  if (msg.includes('fetch failed') || msg.includes('network') || msg.includes('timeout') || msg.includes('econn') || msg.includes('enotfound')) return 'network_error';
  if (msg.includes('not supported')) return 'unsupported';
  return 'upstream_error';
}

function getStatusPresentation(it: any) {
  const isActive = it?.is_active !== 0 && it?.isActive !== false;
  const rateLimitedUntil = it?.rate_limited_until || it?.rateLimitedUntil || '';
  const isCooldown = !!rateLimitedUntil && Number.isFinite(new Date(rateLimitedUntil).getTime()) && new Date(rateLimitedUntil).getTime() > Date.now();
  const errorType = inferErrorType(it, isCooldown);
  const testStatus = String(it?.test_status || it?.testStatus || it?.status || '').toLowerCase();
  const effectiveStatus = testStatus === 'unavailable' && !isCooldown ? '' : testStatus;

  if (!isActive) {
    if (errorType === 'upstream_auth_error' || errorType === 'auth_missing' || errorType === 'token_refresh_failed' || errorType === 'token_expired') {
      return { label: 'Auth Failed', colorClass: 'text-rose-400', bgClass: 'bg-rose-500/10', borderClass: 'border-rose-500/20', errorType };
    }
    if (errorType === 'upstream_rate_limited') {
      return { label: 'Rate Limited', colorClass: 'text-amber-400', bgClass: 'bg-amber-500/10', borderClass: 'border-amber-500/20', errorType };
    }
    return { label: 'Disabled', colorClass: 'text-slate-400', bgClass: 'bg-slate-500/10', borderClass: 'border-slate-500/20', errorType: null };
  }

  if (effectiveStatus === 'active' || effectiveStatus === 'success' || effectiveStatus === 'ready') {
    return { label: 'Connected', colorClass: 'text-emerald-400', bgClass: 'bg-emerald-500/10', borderClass: 'border-emerald-500/20', errorType: null };
  }
  if (effectiveStatus === 'pending' || effectiveStatus === 'processing') {
    return { label: 'Pending', colorClass: 'text-amber-400', bgClass: 'bg-amber-500/10', borderClass: 'border-amber-500/20', errorType: null };
  }
  if (errorType === 'runtime_error') {
    return { label: 'Runtime Issue', colorClass: 'text-amber-400', bgClass: 'bg-amber-500/10', borderClass: 'border-amber-500/20', errorType };
  }
  if (errorType === 'upstream_auth_error' || errorType === 'auth_missing' || errorType === 'token_refresh_failed' || errorType === 'token_expired') {
    return { label: 'Auth Failed', colorClass: 'text-rose-400', bgClass: 'bg-rose-500/10', borderClass: 'border-rose-500/20', errorType };
  }
  if (errorType === 'upstream_rate_limited') {
    return { label: 'Rate Limited', colorClass: 'text-amber-400', bgClass: 'bg-amber-500/10', borderClass: 'border-amber-500/20', errorType };
  }
  if (errorType === 'network_error') {
    return { label: 'Network Issue', colorClass: 'text-amber-400', bgClass: 'bg-amber-500/10', borderClass: 'border-amber-500/20', errorType };
  }
  if (errorType === 'unsupported') {
    return { label: 'Test Unsupported', colorClass: 'text-slate-400', bgClass: 'bg-slate-500/10', borderClass: 'border-slate-500/20', errorType };
  }

  const fallback: Record<string, string> = {
    unavailable: 'Unavailable',
    failed: 'Failed',
    error: 'Error',
    idle: 'Idle',
  };
  return {
    label: fallback[effectiveStatus] || (effectiveStatus ? effectiveStatus.toUpperCase() : 'Error'),
    colorClass: 'text-rose-400', bgClass: 'bg-rose-500/10', borderClass: 'border-rose-500/20',
    errorType,
  };
}

function getStatusBucket(it: any): 'ready' | 'pending' | 'error' {
  const p = getStatusPresentation(it);
  if (p.label === 'Connected') return 'ready';
  if (p.label === 'Pending') return 'pending';
  return 'error';
}

/* ── Status Badge ── */
function StatusBadge({ item }: { item: any }) {
  const p = getStatusPresentation(item);
  const errorTypeLabel = p.errorType ? (ERROR_TYPE_LABELS[p.errorType] || p.errorType) : null;
  return (
    <div className="flex flex-col gap-1.5 items-start">
      <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-bold tracking-wide border ${p.bgClass} ${p.colorClass} ${p.borderClass}`}>
        <span className="w-1.5 h-1.5 rounded-full bg-current" />
        {p.label}
      </span>
      {errorTypeLabel && item?.is_active !== 0 && item?.isActive !== false && (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-white/5 text-slate-400 border border-white/10 uppercase tracking-wider">
          {errorTypeLabel}
        </span>
      )}
    </div>
  );
}

const PAGE_SIZE = 100;

/* ══════════════════════════════════════════════════════════ */
export function AccountsView() {
  const { refreshAccounts, accounts, connected, addToast } = useApp();
  const itemsRef = useRef<any[]>([]);
  const connectionsCacheRef = useRef<any[]>([]);
  const [items, setItems] = useState<any[]>([]);
  const [proxies, setProxies] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');

  const [confirmModal, setConfirmModal] = useState<{ title: string; message: string; onConfirm: () => Promise<void> } | null>(null);

  const [newEmail, setNewEmail] = useState('');
  const [newPass, setNewPass] = useState('');
  const [new2fa, setNew2fa] = useState('');
  const [adding, setAdding] = useState(false);

  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkText, setBulkText] = useState('');
  const [bulkRows, setBulkRows] = useState<ReturnType<typeof parseBulk>>([]);
  const [bulkBusy, setBulkBusy] = useState(false);

  const [editId, setEditId] = useState<string | null>(null);
  const [editPass, setEditPass] = useState('');
  const [edit2fa, setEdit2fa] = useState('');
  const [editProxy, setEditProxy] = useState('');
  const [editSaving, setEditSaving] = useState(false);
  const [assigningId, setAssigningId] = useState<string | null>(null);
  const [autoAssigning, setAutoAssigning] = useState(false);
  const [syncingAll, setSyncingAll] = useState(false);

  useEffect(() => { itemsRef.current = items; }, [items]);

  const loadProxies = useCallback(async () => {
    try {
      const proxiesRes = await fetch('/api/d1/inspect/proxies').catch(() => null as any);
      if (!proxiesRes?.ok) return;
      const pd = await proxiesRes.json().catch(() => ({}));
      setProxies(Array.isArray(pd?.proxies) ? pd.proxies : []);
    } catch { }
  }, []);

  /* ── Load ── */
  const load = useCallback(async (opts?: { append?: boolean }) => {
    const append = !!opts?.append;
    if (append) setLoadingMore(true);
    else setLoading(true);
    setError(null);
    try {
      const offset = append ? itemsRef.current.length : 0;
      const accountsRes = await fetch(`/api/d1/inspect/accounts?limit=${PAGE_SIZE}&offset=${offset}`);

      if (!accountsRes.ok) throw new Error(`HTTP ${accountsRes.status}`);
      const accountsData = await accountsRes.json();
      if (accountsData.error) throw new Error(accountsData.error);

      let nextConnections = connectionsCacheRef.current;
      if (!append || nextConnections.length === 0) {
        const connectionsRes = await fetch('/api/d1/inspect/connections?limit=300').catch(() => null as any);
        if (connectionsRes?.ok) {
          const cd = await connectionsRes.json().catch(() => ({}));
          nextConnections = Array.isArray(cd?.items) ? cd.items : [];
          connectionsCacheRef.current = nextConnections;
        }
      }

      const connById = new Map<string, any>();
      const connByEmail = new Map<string, any>();
      for (const c of nextConnections) {
        if (c?.id) connById.set(String(c.id), c);
        if (c?.email) connByEmail.set(String(c.email).toLowerCase(), c);
      }

      const merged = (accountsData.items || []).map((a: any) => {
        const byIdConn = a?.id ? connById.get(String(a.id)) : null;
        const byEmailConn = a?.email ? connByEmail.get(String(a.email).toLowerCase()) : null;
        const conn = byIdConn || byEmailConn || null;

        return {
          ...a,
          status: a.status ?? conn?.status ?? 'pending',
          is_active: a.is_active ?? conn?.is_active ?? 1,
          test_status: a.test_status ?? conn?.test_status ?? conn?.testStatus ?? null,
          error_code: a.error_code ?? conn?.error_code ?? conn?.errorCode ?? null,
          last_error_type: a.last_error_type ?? conn?.last_error_type ?? conn?.lastErrorType ?? null,
          rate_limited_until: a.rate_limited_until ?? conn?.rate_limited_until ?? conn?.rateLimitedUntil ?? null,
          last_error: a.last_error ?? conn?.last_error ?? conn?.lastError ?? null,
          discovered_limit: a.discovered_limit ?? conn?.discovered_limit ?? null,
          current_tokens_in: a.current_tokens_in ?? conn?.current_tokens_in ?? 0,
          current_tokens_out: a.current_tokens_out ?? conn?.current_tokens_out ?? 0,
          quotas_json: a.quotas_json ?? conn?.quotas_json ?? null,
          quota_json: a.quota_json ?? null,
          created_at: a.created_at ?? conn?.created_at ?? null,
          updated_at: a.updated_at ?? conn?.updated_at ?? null,
        };
      });

      if (append) {
        setItems((prev) => {
          const map = new Map<string, any>();
          for (const row of prev) map.set(String(row.id), row);
          for (const row of merged) map.set(String(row.id), row);
          return Array.from(map.values());
        });
      } else {
        setItems(merged);
      }
      setHasMore((accountsData.items || []).length >= PAGE_SIZE);
    } catch (e: any) { setError(e.message); }
    if (append) setLoadingMore(false);
    else setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const patchItemLocal = useCallback((id: string, patchData: Record<string, any>) => {
    setItems(prev => prev.map(it => (it.id === id ? { ...it, ...patchData } : it)));
  }, []);

  const cnt = {
    total: items.length,
    ready: items.filter(i => getStatusBucket(i) === 'ready').length,
    pending: items.filter(i => getStatusBucket(i) === 'pending').length,
    error: items.filter(i => getStatusBucket(i) === 'error').length,
  };

  const filtered = items.filter(it => (statusFilter === 'all' || getStatusBucket(it) === statusFilter) && (!search || it.email.toLowerCase().includes(search.toLowerCase())));

  /* ── API ── */
  const post = async (url: string, b: object) => (await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).json();
  const patch = async (url: string, b: object) => (await fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).json();

  const add = async () => { if (!newEmail) return; setAdding(true); const d = await post('/api/d1/accounts/add', { email: newEmail, password: newPass, twoFaSecret: new2fa }); if (d.error) addToast(d.error, 'error'); else { addToast('✅ Đã thêm', 'success'); setNewEmail(''); setNewPass(''); setNew2fa(''); load(); } setAdding(false); };
  const del = async (id: string) => {
    setConfirmModal({
      title: 'Xóa Tài Khoản',
      message: `Bạn có chắc muốn xóa tài khoản này? Thao tác này sẽ xóa toàn bộ dữ liệu liên quan.`,
      onConfirm: async () => {
        await fetch(`/api/d1/accounts/${id}`, { method: 'DELETE' });
        setItems(prev => prev.filter(it => it.id !== id));
        addToast('Đã xoá tài khoản', 'info');
        setConfirmModal(null);
      }
    });
  };
  const reset = async (id: string) => {
    await patch(`/api/d1/accounts/${id}`, { status: 'pending' });
    patchItemLocal(id, { status: 'pending', test_status: 'pending', last_error: null, last_error_type: null, error_code: null });
    addToast('→ pending', 'info');
  };
  const toggleActive = async (id: string, currentStatus: any) => {
    try {
      // currentStatus = 0 (tắt) hoặc 1 (bật) hoặc undefined
      const isActive = currentStatus !== 0;
      const r = await fetch(`/api/automation/accounts/codex/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'TOGGLE_ACTIVE', isActive: !isActive })
      });
      if (!r.ok) throw new Error('Cập nhật trạng thái thất bại');
      patchItemLocal(id, { is_active: !isActive ? 1 : 0 });
      addToast(!isActive ? '✅ Đã bật tài khoản' : '🛑 Đã tắt tài khoản', 'info');
    } catch (e: any) { addToast(e.message, 'error'); }
  };
  const openEdit = async (it: any) => {
    if (proxies.length === 0) await loadProxies();
    setEditId(it.id);
    setEditPass(it.password || '');
    setEdit2fa(it.two_fa_secret || '');
    setEditProxy(it.proxy_url || '');
  };
  const saveEdit = async () => {
    if (!editId) return;
    setEditSaving(true);

    const payload: any = {
      proxyUrl: editProxy,
      proxy_url: editProxy
    };

    if (editPass && !editPass.includes('***')) payload.password = editPass;
    if (edit2fa && !edit2fa.includes('***')) {
      payload.twoFaSecret = edit2fa;
      payload.two_fa_secret = edit2fa;
    }

    await patch(`/api/d1/accounts/${editId}`, payload);
    patchItemLocal(editId, {
      proxy_url: editProxy,
      proxyUrl: editProxy,
      ...(payload.password ? { password: payload.password } : {}),
      ...(payload.twoFaSecret ? { two_fa_secret: payload.twoFaSecret } : {}),
    });
    addToast('✅ Đã lưu', 'success');
    setEditId(null);
    setEditSaving(false);
  };
  const cancelEdit = () => setEditId(null);
  const assignFromPool = async (id: string, selectedProxyId?: string) => {
    setAssigningId(id);
    try {
      const r = await fetch('/api/proxy-assign/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: id, proxyId: selectedProxyId || null }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d.error) throw new Error(d.error || `HTTP ${r.status}`);
      patchItemLocal(id, {
        proxy_id: d?.proxy?.id ?? null,
        proxy_url: d?.proxy?.url ?? '',
        proxy_label: d?.proxy?.label ?? null,
      });
      addToast('✅ Đã gán proxy từ pool', 'success');
    } catch (e: any) {
      addToast(e.message || 'Gán proxy thất bại', 'error');
    } finally {
      setAssigningId(null);
    }
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
      load();
    } catch (e: any) {
      addToast(e.message || 'Auto-assign thất bại', 'error');
    } finally {
      setAutoAssigning(false);
    }
  };
  const bypassSync = async (id: string, email: string) => {
    try {
      const r = await fetch(`/api/vault/accounts/${id}/sync`, { method: 'POST' });
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      addToast(`☁️ Đã ép đồng bộ ${email} lên D1`, 'success');
      load();
    } catch (e: any) { addToast(e.message, 'error'); }
  };

  const syncAll = async () => {
    if (!filtered.length) return;
    if (!confirm(`Đồng bộ tất cả ${filtered.length} tài khoản đang hiển thị lên D1?`)) return;

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

    addToast(`☁️ Kết quả đồng bộ: ${success} thành công, ${fail} thất bại`, success > 0 ? 'success' : 'error');
    setSyncingAll(false);
    load();
  };

  const bulkImport = async () => { if (!bulkRows.length) return; setBulkBusy(true); let ok = 0; for (const r of bulkRows) { try { const d = await post('/api/d1/accounts/add', r); if (d.ok) ok++; } catch { } } setBulkBusy(false); setBulkText(''); setBulkRows([]); setBulkOpen(false); addToast(`✅ Imported ${ok}/${bulkRows.length}`, 'success'); load(); };

  return (
    <div className="absolute inset-0 overflow-y-auto px-6 pb-10 pt-2 flex flex-col gap-5 custom-scrollbar">
      <Card className="flex flex-col shrink-0">
        <CardHeader>
          <CardTitle><Plus size={14} className="text-indigo-400" /> Thêm Tài Khoản</CardTitle>
          <Button
            size="sm"
            variant={bulkOpen ? 'primary' : 'ghost'}
            onClick={() => setBulkOpen(v => !v)}
            className="ml-auto"
          >
            <Upload size={12} /> Import hàng loạt {bulkOpen ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
          </Button>
        </CardHeader>
        <CardContent>
          {!bulkOpen ? (
            <div className="flex gap-3 flex-wrap items-center">
              <Input className="flex-[2_1_200px]" placeholder="Email *" value={newEmail} onChange={e => setNewEmail(e.target.value)} onKeyDown={e => e.key === 'Enter' && add()} />
              <Input className="flex-[1_1_150px]" placeholder="Password" value={newPass} onChange={e => setNewPass(e.target.value)} />
              <Input className="flex-[1_1_150px]" placeholder="2FA Secret" value={new2fa} onChange={e => setNew2fa(e.target.value)} />
              <Button variant="primary" disabled={adding || !newEmail} onClick={add} className="shrink-0 whitespace-nowrap">
                {adding ? <span className="w-3.5 h-3.5 border-2 border-white/20 border-t-white rounded-full animate-spin" /> : <Plus size={14} />} Tạo mới
              </Button>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="p-3 bg-white/5 border border-white/10 rounded-lg text-xs text-slate-400 leading-relaxed">
                <strong className="text-slate-200">Định dạng:</strong>{' '}
                <code className="text-[11px] text-cyan-400 bg-cyan-500/10 px-1 rounded">email:password:2fa</code> hoặc <code className="text-[11px] text-cyan-400 bg-cyan-500/10 px-1 rounded">email|pass|2fa</code> hoặc <code className="text-[11px] text-cyan-400 bg-cyan-500/10 px-1 rounded">Tab-separated</code>
              </div>
              <textarea className="w-full bg-black/40 border border-white/10 rounded-md p-3 text-[11px] font-mono text-slate-300 resize-y focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/20" rows={5} placeholder={`chatgpt@mail.com:password123:JBSWY3DP\nuser2@mail.com:pass2`}
                value={bulkText} onChange={e => { setBulkText(e.target.value); setBulkRows(parseBulk(e.target.value)); }}
              />
              <div className="flex items-center justify-between gap-3 text-xs">
                <span className={bulkRows.length ? 'text-emerald-400 font-medium' : 'text-slate-500'}>
                  {bulkRows.length ? `✅ ${bulkRows.length} tài khoản hợp lệ` : 'Dán danh sách vào ô trên…'}
                </span>
                <div className="flex gap-2">
                  <Button variant="ghost" size="sm" onClick={() => { setBulkOpen(false); setBulkText(''); setBulkRows([]); }}><X size={12} /> Hủy</Button>
                  <Button variant="primary" size="sm" disabled={bulkBusy || !bulkRows.length} onClick={bulkImport}>
                    {bulkBusy ? <span className="w-3 h-3 border-2 border-white/20 border-t-white rounded-full animate-spin" /> : <Upload size={12} />} Import {bulkRows.length || ''}
                  </Button>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ═══ TABLE ═══ */}
      <Card className="flex flex-col flex-1 min-h-[400px]">
        {/* Header bar */}
        <CardHeader className="bg-black/10 border-b border-white/5 py-3 px-5 flex-wrap gap-y-3">
          <CardTitle>Managed Accounts <span className="ml-2 px-2 py-0.5 rounded-full text-[10px] bg-indigo-500/20 text-indigo-400 font-bold">{filtered.length}</span></CardTitle>
          <div className="flex flex-wrap gap-2 items-center ml-auto">
            <Button
              size="sm"
              variant="secondary"
              onClick={syncAll}
              disabled={syncingAll || filtered.length === 0}
              className="text-indigo-400 border-indigo-500/30 hover:bg-indigo-500/10"
            >
              {syncingAll ? <span className="w-3 h-3 border-2 border-indigo-500/20 border-t-indigo-400 rounded-full animate-spin mr-1.5" /> : <Database size={12} />}
              Sync All to D1
            </Button>
            <div className="relative flex items-center">
              <Search size={13} className="absolute left-2.5 text-slate-500 pointer-events-none" />
              <Input className="pl-7 w-[180px] h-8 text-xs bg-white/5 border-white/10" placeholder="Tìm email…" value={search} onChange={e => setSearch(e.target.value)} />
              {search && <button onClick={() => setSearch('')} className="absolute right-2 text-slate-500 hover:text-slate-300"><X size={11} /></button>}
            </div>
            <div className="flex gap-1 bg-black/40 p-1 rounded-lg border border-white/10">
              {['all', 'ready', 'pending', 'error'].map(f => (
                <button key={f} onClick={() => setStatusFilter(f)} className={`
                  px-2.5 py-1 text-[11px] font-bold rounded-md transition-all uppercase tracking-wider
                  ${statusFilter === f ? 'bg-indigo-500/20 text-indigo-400 shadow-[0_0_10px_rgba(99,102,241,0.2)]' : 'text-slate-500 hover:text-slate-300 hover:bg-white/5'}
                `}>{f}</button>
              ))}
            </div>
            <Button size="icon-sm" variant="secondary" title="Tự động gán proxy từ pool" onClick={autoAssignFromPool} disabled={autoAssigning} className="w-auto px-2 border-white/10 text-cyan-400 hover:bg-cyan-500/10 hover:border-cyan-500/30">
              <Globe size={12} className="mr-1.5" /> {autoAssigning ? 'Đang gán…' : 'Auto Proxy'}
            </Button>
            <Button size="icon-sm" variant="ghost" title="Refresh" onClick={() => load()} disabled={loading} className="border border-white/5 bg-white/5 hover:bg-white/10">
              <RefreshCw size={13} className={`${loading ? 'animate-spin' : ''} text-slate-300`} />
            </Button>
          </div>
        </CardHeader>

        {error && <div className="mx-5 mt-4 mb-1 flex items-center gap-2 p-3 bg-rose-500/10 text-rose-400 rounded-lg text-[13px] border border-rose-500/30"><AlertCircle size={14} /> {error}</div>}

        <div className="flex-1 min-h-0 overflow-auto custom-scrollbar">
          <table className="w-full min-w-[1000px] border-collapse text-left">
            <thead>
              <tr className="bg-white/5 border-y border-white/5">
                <th className="px-4 py-3 text-[11px] font-bold text-slate-400 uppercase tracking-wider whitespace-nowrap">Email</th>
                <th className="px-4 py-3 text-[11px] font-bold text-slate-400 uppercase tracking-wider whitespace-nowrap">Mật khẩu</th>
                <th className="px-4 py-3 text-[11px] font-bold text-slate-400 uppercase tracking-wider whitespace-nowrap">2FA</th>
                <th className="px-4 py-3 text-[11px] font-bold text-slate-400 uppercase tracking-wider whitespace-nowrap">Status</th>
                <th className="px-4 py-3 text-[11px] font-bold text-slate-400 uppercase tracking-wider whitespace-nowrap">Usage</th>
                <th className="px-4 py-3 text-[11px] font-bold text-slate-400 uppercase tracking-wider whitespace-nowrap">Proxy</th>
                <th className="px-4 py-3 text-[11px] font-bold text-slate-400 uppercase tracking-wider whitespace-nowrap">Thời gian</th>
                <th className="px-4 py-3 text-[11px] font-bold text-slate-400 uppercase tracking-wider whitespace-nowrap text-right min-w-[90px]"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {filtered.length === 0 && !loading && (
                <tr><td colSpan={8} className="text-center p-10 text-slate-500 text-[13px]">{search ? `Không tìm thấy "${search}"` : 'Chưa có tài khoản nào'}</td></tr>
              )}
              {filtered.map(it => {
                const ed = editId === it.id;
                return (
                  <tr key={it.id} className={`transition-colors group hover:bg-white/[0.02] ${ed ? 'bg-indigo-500/5' : ''}`}>

                    {/* Email & Activation Toggle */}
                    <td className="px-4 py-3.5 min-w-[240px] align-middle">
                      <div className="flex items-center gap-3">
                        <div
                          onClick={() => toggleActive(it.id, it.is_active)}
                          className={`w-3 h-3 rounded-full cursor-pointer shrink-0 transition-all border-2 ${it.is_active === 0 ? 'bg-slate-600 border-white/10 hover:border-slate-400' : 'bg-emerald-500 border-emerald-500/30 hover:border-emerald-400 shadow-[0_0_10px_rgba(16,185,129,0.3)]'
                            }`}
                          title={it.is_active === 0 ? "Đang tạm dừng (Nhấn để bật)" : "Đang hoạt động (Nhấn để tắt)"}
                        />
                        <div className={`font-semibold text-[13.5px] truncate max-w-[180px] ${it.is_active === 0 ? 'text-slate-500 line-through' : 'text-slate-200'
                          }`}>
                          {it.email}
                        </div>
                      </div>
                      {it.last_error && !ed && (
                        <div title={it.last_error} className="mt-1 text-[11px] text-rose-400 flex items-center gap-1 max-w-[240px] overflow-hidden text-ellipsis whitespace-nowrap">
                          <AlertCircle size={10} className="shrink-0" /> {it.last_error}
                        </div>
                      )}
                    </td>

                    {/* Pass */}
                    <td className="px-4 py-3.5 min-w-[160px] align-middle">
                      {ed ? <Input className="h-8 text-[11px] font-mono" value={editPass} onChange={e => setEditPass(e.target.value)} placeholder="Password" /> : <MonoCell value={it.password} icon={Key} colorClass="text-amber-400" />}
                    </td>

                    {/* 2FA */}
                    <td className="px-4 py-3.5 min-w-[160px] align-middle">
                      {ed ? <Input className="h-8 text-[11px] font-mono" value={edit2fa} onChange={e => setEdit2fa(e.target.value)} placeholder="2FA Secret" /> : <MonoCell value={it.two_fa_secret} icon={Shield} colorClass="text-emerald-400" />}
                    </td>

                    {/* Status */}
                    <td className="px-4 py-3.5 align-middle"><StatusBadge item={it} /></td>

                    {/* Usage */}
                    <td className="px-4 py-3.5 min-w-[140px] align-middle">
                      {(it.discovered_limit || it.quotas_json || it.quota_json) ? (
                        <div className="flex flex-col gap-1.5">
                          {it.discovered_limit ? (
                            <div>
                              <div className="flex justify-between text-[10px] font-bold text-slate-400 mb-1">
                                <span>{(((it.current_tokens_in || 0) + (it.current_tokens_out || 0)) / 1000).toFixed(1)}k tokens</span>
                                <span>{(it.discovered_limit / 1000).toFixed(0)}k limit</span>
                              </div>
                              <div className="h-1 bg-white/10 rounded-full overflow-hidden">
                                <div className={`h-full ${((it.current_tokens_in || 0) + (it.current_tokens_out || 0)) / it.discovered_limit > 0.8 ? 'bg-rose-500' : 'bg-indigo-500 shadow-[0_0_10px_rgba(99,102,241,0.8)]'
                                  }`} style={{
                                    width: `${Math.min(100, (((it.current_tokens_in || 0) + (it.current_tokens_out || 0)) / it.discovered_limit) * 100)}%`
                                  }} />
                              </div>
                            </div>
                          ) : null}

                          {/* Live Quotas (Session, Weekly, etc) */}
                          {(it.quotas_json || it.quota_json) && (() => {
                            const qRaw = it.quotas_json || it.quota_json;
                            const qs = normalizeQuotas(qRaw);
                            if (!qs.length) return null;
                            return (
                              <div className="flex flex-wrap gap-1 mt-1">
                                {qs.map((q: any, i: number) => {
                                  const pct = q.total > 0 ? (q.used / q.total) * 100 : 0;
                                  const base = pct > 80 ? 'rose' : (pct > 50 ? 'amber' : 'emerald');
                                  const remain = safePercentRemaining(q.used, q.total);
                                  return (
                                    <div key={i} title={`${q.name}: ${q.used}/${q.total}`}
                                      className={`text-[9px] px-1.5 py-px rounded border font-bold flex items-center gap-1 uppercase tracking-widest ${base === 'rose' ? 'bg-rose-500/10 text-rose-400 border-rose-500/20' :
                                          base === 'amber' ? 'bg-amber-500/10 text-amber-400 border-amber-500/20' :
                                            'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                                        }`}>
                                      <div className={`w-1 h-1 rounded-full ${base === 'rose' ? 'bg-rose-400' : base === 'amber' ? 'bg-amber-400' : 'bg-emerald-400'}`} />
                                      {q.name}: {remain ?? 0}%
                                    </div>
                                  );
                                })}
                              </div>
                            );
                          })()}
                        </div>
                      ) : (
                        <span className="text-slate-500 text-xs">—</span>
                      )}
                    </td>

                    {/* Proxy */}
                    <td className="px-4 py-3.5 min-w-[140px] align-middle">
                      {ed ? (
                        <div className="flex flex-col gap-1.5">
                          <select className="h-8 rounded-lg bg-black/40 border border-white/10 text-[11px] text-slate-300 px-2 outline-none focus:border-indigo-500/50" value={editProxy} onChange={e => setEditProxy(e.target.value)}>
                            <option value="">(Không dùng proxy)</option>
                            {proxies.map((p: any) => (
                              <option key={p.id} value={p.url}>
                                {p.label || p.url}
                              </option>
                            ))}
                          </select>
                          <Input className="h-8 text-[11px] font-mono" value={editProxy} onChange={e => setEditProxy(e.target.value)} placeholder="http://proxy:port" />
                        </div>
                      ) : it.proxy_url ? (
                        <div className="flex items-center gap-1.5 text-[11.5px] text-indigo-400 font-mono max-w-[150px] overflow-hidden text-ellipsis whitespace-nowrap select-none bg-indigo-500/10 px-2 py-0.5 rounded cursor-help" title={it.proxy_url}>
                          <Globe size={11} className="shrink-0" /> {it.proxy_url}
                        </div>
                      ) : <span className="text-slate-500 text-xs">—</span>}
                    </td>

                    {/* Time */}
                    <td className="px-4 py-3.5 text-slate-400 text-[11px] whitespace-nowrap align-middle">
                      <div>Tạo: {fmtDateTimeVN(it.created_at || it.createdAt || it.updated_at)}</div>
                      <div className="mt-0.5">Cập nhật: {fmtDateTimeVN(it.updated_at || it.updatedAt)}</div>
                    </td>

                    {/* Actions */}
                    <td className="px-4 py-3.5 text-right align-middle">
                      {ed ? (
                        <div className="flex gap-1.5 justify-end">
                          <Button variant="success" size="sm" disabled={editSaving} onClick={saveEdit}>
                            {editSaving ? <span className="w-3 h-3 border-2 border-emerald-500/20 border-t-emerald-400 rounded-full animate-spin" /> : <Save size={12} />} Lưu
                          </Button>
                          <Button variant="secondary" size="icon-sm" onClick={cancelEdit} title="Hủy" className="border-white/10 hover:bg-white/10"><X size={13} /></Button>
                        </div>
                      ) : (
                        <div className="flex gap-1 justify-end opacity-0 group-hover:opacity-100 transition-opacity">
                          <Button variant="secondary" size="icon-sm" title="Gán proxy từ pool" onClick={() => assignFromPool(it.id)} disabled={assigningId === it.id} className="text-cyan-400 border-white/10 hover:bg-cyan-500/10 hover:border-cyan-500/30">
                            <Globe size={13} />
                          </Button>
                          <Button variant="secondary" size="icon-sm" title="Ép đồng bộ lên D1" onClick={() => bypassSync(it.id, it.email)} className="text-indigo-400 border-white/10 hover:bg-indigo-500/10 hover:border-indigo-500/30">
                            <Database size={13} />
                          </Button>
                          <Button variant="secondary" size="icon-sm" title="Sửa" onClick={() => openEdit(it)} className="text-slate-400 border-white/10 hover:bg-white/10 hover:text-slate-200">
                            <Pencil size={13} />
                          </Button>
                          <Button variant="secondary" size="icon-sm" title="Re-run → pending" onClick={() => reset(it.id)} className="text-emerald-400 border-white/10 hover:bg-emerald-500/10 hover:border-emerald-500/30">
                            <RotateCcw size={13} />
                          </Button>
                          <Button variant="danger" size="icon-sm" title="Xóa" onClick={() => del(it.id)} className="border-white/10">
                            <Trash2 size={13} />
                          </Button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {hasMore && (
          <div className="p-4 flex justify-center border-t border-white/5 bg-black/10">
            <Button variant="secondary" size="sm" onClick={() => load({ append: true })} disabled={loadingMore} className="min-w-[120px] bg-white/5 border-white/10 hover:bg-white/10">
              {loadingMore ? 'Đang tải…' : `Tải thêm ${PAGE_SIZE}`}
            </Button>
          </div>
        )}
      </Card>

      {confirmModal && (
        <ConfirmModal
          title={confirmModal.title}
          message={confirmModal.message}
          onConfirm={confirmModal.onConfirm}
          onCancel={() => setConfirmModal(null)}
          isLoading={loading}
        />
      )}
    </div>
  );
}
