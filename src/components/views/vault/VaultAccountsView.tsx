'use client';
import React, { useCallback, useEffect, useState } from 'react';
import {
  Plus, Search, RefreshCw, Pencil, Trash2, Save, X,
  AlertCircle, ChevronDown, ChevronUp, Users, Tag,
  Database, Shield, Globe, Key, FileText, Layout, CopyPlus, FileUp, RotateCcw, Copy, Check
} from 'lucide-react';
import { useApp } from '../../AppContext';
import { fmtDateTimeVN } from '../../Views';
import { Button, Card, CardHeader, CardTitle, CardContent, Input } from '../../ui';

/* ── Helpers ── */
function StatusBadge({ status, notes }: { status: string; notes?: string }) {
  // Trường hợp đặc biệt: lỗi yêu cầu số điện thoại
  if (status === 'error' && notes && notes.startsWith('NEED_PHONE')) {
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
  const { addToast } = useApp();
  const [items, setItems] = useState<any[]>([]);
  const [proxies, setProxies] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [providerFilter, setProviderFilter] = useState('all');
  const [assigningId, setAssigningId] = useState<string | null>(null);
  const [autoAssigning, setAutoAssigning] = useState(false);
  const [syncingAll, setSyncingAll] = useState(false);

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
  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetch('/api/vault/accounts');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json(); if (d.error) throw new Error(d.error);
      setItems(d.items || []);

      const pr = await fetch('/api/d1/inspect/proxies').catch(() => null as any);
      if (pr?.ok) {
        const pd = await pr.json().catch(() => ({}));
        setProxies(Array.isArray(pd?.proxies) ? pd.proxies : []);
      } else {
        setProxies([]);
      }
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const filtered = items.filter(it => {
    const providerMatch =
      providerFilter === 'all'
        ? true
        : providerFilter === 'openai'
          ? isOpenAI(it.provider)  // nhóm openai + codex cùng bucket
          : it.provider === providerFilter;
    const searchMatch = !search || it.email.toLowerCase().includes(search.toLowerCase()) || it.label?.toLowerCase().includes(search.toLowerCase());
    return providerMatch && searchMatch;
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
      load();
    } catch (e: any) { addToast(e.message, 'error'); }
  };

  const del = async (id: string) => {
    if (!confirm('Xóa tài khoản này khỏi Vault?')) return;
    await fetch(`/api/vault/accounts/${id}`, { method: 'DELETE' });
    addToast('Đã xoá', 'info');
    load();
  };

  const retry = async (id: string, email: string) => {
    try {
      const r = await fetch(`/api/vault/accounts/${id}/retry`, { method: 'POST' });
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      addToast(`🚀 Đã gửi lệnh Deploy/Retry cho ${email}`, 'success');
      load();
    } catch (e: any) { addToast(e.message, 'error'); }
  };

  const deployConnect = async (id: string, email: string) => {
    try {
      const r = await fetch(`/api/vault/accounts/${id}/retry-connect`, { method: 'POST' });
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      // Khởi động connect-worker nếu chưa chạy
      fetch('/api/processes/connect-worker/start', { method: 'POST' }).catch(() => { });
      addToast(`🔌 Deploy v2: Đã xếp hàng Auto-Connect cho ${email}`, 'success');
      load();
    } catch (e: any) { addToast(e.message, 'error'); }
  };

  const stopAccount = async (id: string, email: string) => {
    try {
      const r = await fetch(`/api/vault/accounts/${id}/stop`, { method: 'POST' });
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      addToast(`🛑 Đã thu hồi ${email} về trạng thái Idle`, 'info');
      load();
    } catch (e: any) { addToast(e.message, 'error'); }
  };

  const syncNow = async (id: string, email: string) => {
    try {
      const r = await fetch(`/api/vault/accounts/${id}/sync`, { method: 'POST' });
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      addToast(`☁️ Đã ép đồng bộ ${email} lên D1 thành công`, 'success');
      load();
    } catch (e: any) { addToast(e.message, 'error'); }
  };

  const syncAll = async () => {
    if (!filtered.length) return;
    if (!confirm(`Đồng bộ toàn bộ ${filtered.length} tài khoản trong danh sách này lên D1?`)) return;

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
    load();
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
      addToast('✅ Đã gán proxy từ pool', 'success');
      load();
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
      load();
    } catch (e: any) {
      addToast(e.message || 'Auto-assign thất bại', 'error');
    } finally {
      setAutoAssigning(false);
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
      load();
    } catch (e: any) {
      addToast(e.message, 'error');
    } finally {
      setLoading(false);
    }
  };

  const startEdit = (it: any) => {
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
      tags: Array.isArray(it.tags) ? it.tags : (it.tags ? JSON.parse(it.tags) : []),
      notes: it.notes || '',
    }));
    // Scroll to form
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <div className="absolute inset-0 overflow-y-auto px-6 pb-10 pt-2 flex flex-col gap-5 custom-scrollbar">

      {/* ═══ ACTIONS ═══ */}
      <div className="flex gap-3 mb-6 mt-2 relative z-10">
        <div className="flex-1 relative flex items-center">
          <Search size={15} className="absolute left-3 text-slate-500" />
          <Input className="pl-9" placeholder="Tìm trong Vault (Email, Label...)" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => setUiState(s => ({ ...s, isBulk: !s.isBulk, isAdding: false, editId: null }))}>
            {uiState.isBulk ? <X size={16} /> : <FileUp size={16} />} Nhập hàng loạt
          </Button>
          <Button variant="primary" onClick={() => setUiState(s => ({ ...s, isAdding: !s.isAdding, isBulk: false, editId: null, email: '', password: '', twoFaSecret: '', label: '' }))}>
            {uiState.isAdding ? <X size={16} /> : <Plus size={16} />} {uiState.isAdding ? 'Hủy bỏ' : 'Thêm Tài Khoản'}
          </Button>
        </div>
      </div>

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

      {/* ═══ TABLE ═══ */}
      <Card>
        <CardHeader>
          <CardTitle>
            <Shield size={14} className="text-indigo-400" /> Tài Khoản Vault
            <span className="ml-2 px-2 py-0.5 rounded-full text-[10px] bg-indigo-500/20 text-indigo-400 font-bold">{filtered.length}</span>
          </CardTitle>
          <div className="flex gap-2 ml-auto shrink-0">
            <Button
              size="sm"
              variant="secondary"
              onClick={syncAll}
              disabled={syncingAll || filtered.length === 0}
              className="!text-indigo-400 !border-indigo-500/30 hover:!bg-indigo-500/10"
            >
              {syncingAll ? <RefreshCw size={12} className="animate-spin" /> : <Database size={12} />}
              Sync All to D1
            </Button>
            <Button size="sm" variant={providerFilter === 'all' ? 'primary' : 'secondary'} onClick={() => setProviderFilter('all')}>All</Button>
            {PROVIDERS.map(p => (
              <Button size="sm" key={p.id} variant={providerFilter === p.id ? 'primary' : 'secondary'} onClick={() => setProviderFilter(p.id)}>{p.name}</Button>
            ))}
            <Button size="sm" variant="secondary" onClick={autoAssignFromPool} disabled={autoAssigning} className="border-white/10 text-cyan-400 hover:bg-cyan-500/10 hover:border-cyan-500/30">
              <Globe size={12} className="mr-1.5" /> {autoAssigning ? 'Đang gán…' : 'Auto Assign Proxy'}
            </Button>
            <Button size="icon-sm" variant="secondary" onClick={load}>
              <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
            </Button>
          </div>
        </CardHeader>

        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="bg-white/5 border-b border-white/5">
                <th className="px-5 py-3 text-[11px] font-bold text-slate-400 uppercase tracking-wider">Tài khoản / Label</th>
                <th className="px-5 py-3 text-[11px] font-bold text-slate-400 uppercase tracking-wider">Provider</th>
                <th className="px-5 py-3 text-[11px] font-bold text-slate-400 uppercase tracking-wider">Status</th>
                <th className="px-5 py-3 text-[11px] font-bold text-slate-400 uppercase tracking-wider">Thời gian</th>
                <th className="px-5 py-3 text-[11px] font-bold text-slate-400 uppercase tracking-wider">Exported</th>
                <th className="px-5 py-3 text-[11px] font-bold text-slate-400 uppercase tracking-wider text-right">Thao tác</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {filtered.map(it => {
                const allowRun = isOpenAI(it.provider) && (it.status === 'idle' || it.status === 'stopped');
                const allowDeploy = isOpenAI(it.provider) && (it.status === 'idle' || it.status === 'stopped');
                return (
                  <tr key={it.id} className="hover:bg-white/[0.02] transition-colors group">
                    <td className="px-5 py-3.5">
                      <div className="flex items-center gap-2 mb-1.5">
                        <div className="font-semibold text-[13px] text-slate-200">{it.email || 'No email'}</div>
                        <PlanBadge plan={it.plan} />
                        {(Array.isArray(it.tags) ? it.tags : (it.tags ? JSON.parse(it.tags) : [])).includes('auto-register') && (
                          <span className="text-[10px] font-bold px-2 py-0.5 rounded-md bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">AUTO</span>
                        )}
                        {it.two_fa_secret && (
                          <span className="text-[10px] font-bold px-2 py-0.5 rounded-md bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">2FA</span>
                        )}
                      </div>
                      <div className="flex gap-1.5 flex-wrap">
                        <CopyBadge text={it.password} icon={Key} colorClass="text-amber-400" hoverBorderClass="hover:border-amber-400/50" />
                        <CopyBadge text={it.two_fa_secret} icon={Shield} colorClass="text-emerald-400" hoverBorderClass="hover:border-emerald-400/50" />
                        {it.label && <span className="inline-flex items-center px-2 py-0.5 bg-indigo-500/10 text-indigo-300 rounded-md border border-indigo-500/20 text-[11px]">{it.label}</span>}
                        {it.proxy_url && <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-white/5 text-slate-400 rounded-md border border-white/10 text-[11px]"><Globe size={10} /> <span className="max-w-[120px] truncate">{it.proxy_url}</span></span>}
                      </div>
                    </td>
                    <td className="px-5 py-3.5">
                      <div className="flex items-center gap-1.5">
                        <div className="w-2 h-2 rounded-full" style={{ background: isOpenAI(it.provider) ? '#10a37f' : (PROVIDERS.find(p => p.id === it.provider)?.color || '#999') }} />
                        <span className="text-[12.5px] text-slate-300">{getProviderName(it.provider)}</span>
                      </div>
                    </td>
                    <td className="px-5 py-3.5"><StatusBadge status={it.status} notes={it.notes} /></td>
                    <td className="px-5 py-3.5 text-[11px] text-slate-400 whitespace-nowrap">
                      <div>Tạo: {fmtDateTimeVN(it.created_at || it.createdAt || it.updated_at)}</div>
                      <div className="mt-0.5">Cập: {fmtDateTimeVN(it.updated_at || it.updatedAt)}</div>
                    </td>
                    <td className="px-5 py-3.5">
                      {it.exported_to ? (
                        <div>
                          <div className="flex items-center gap-1 text-[11px] text-emerald-400 font-semibold mb-0.5">
                            <Database size={10} /> {it.exported_to.toUpperCase()}
                          </div>
                          <div className="text-[10px] text-slate-500">
                            {fmtDateTimeVN(it.exported_at)}
                          </div>
                        </div>
                      ) : <span className="text-slate-500 text-[11px] italic">Chưa export</span>}
                    </td>
                    <td className="px-5 py-3.5 text-right">
                      <div className="flex gap-1 justify-end opacity-0 group-hover:opacity-100 transition-opacity">
                        {allowRun && (
                          <Button size="icon-sm" title="Deploy to Codex (PKCE OAuth)" onClick={() => retry(it.id, it.email)} className="!text-emerald-400 border-emerald-500/20 hover:bg-emerald-500/10"><Globe size={13} /></Button>
                        )}
                        {allowDeploy && (
                          <Button size="icon-sm" title="Deploy v2 – Auto-Connect trực tiếp" onClick={() => deployConnect(it.id, it.email)} className="!text-indigo-400 border-indigo-500/20 hover:bg-indigo-500/10"><Globe size={13} /></Button>
                        )}
                        {(it.status !== 'idle') && isOpenAI(it.provider) && (
                          <Button size="icon-sm" variant="ghost" title="Thu hồi về kho lạnh" onClick={() => stopAccount(it.id, it.email)}><X size={13} /></Button>
                        )}
                        {(it.status === 'error') && isOpenAI(it.provider) && (
                          <Button size="icon-sm" variant="ghost" title="Thử login lại" onClick={() => retry(it.id, it.email)}><RotateCcw size={13} /></Button>
                        )}
                        {isOpenAI(it.provider) && (
                          <Button size="icon-sm" variant="ghost" title="Gán proxy từ pool" onClick={() => assignFromPool(it.id)} disabled={assigningId === it.id} className="!text-cyan-400"><Globe size={13} /></Button>
                        )}
                        <Button size="icon-sm" variant="ghost" title="Đẩy lên D1" onClick={() => syncNow(it.id, it.email)} className="!text-indigo-400"><Database size={13} /></Button>
                        <Button size="icon-sm" variant="ghost" title="Sửa" onClick={() => startEdit(it)}><Pencil size={13} /></Button>
                        <Button size="icon-sm" variant="danger" title="Xóa" onClick={() => del(it.id)}><Trash2 size={13} /></Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {filtered.length === 0 && !loading && (
                <tr><td colSpan={6} className="py-16 text-center text-slate-500 text-[13px]">Vault trống hoặc không khớp từ khóa tìm kiếm.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
