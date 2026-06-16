'use client';
import React, { useCallback, useEffect, useState, useMemo } from 'react';
import {
  Plus, Upload, Search, RefreshCw, Trash2, Globe, Activity,
  ChevronDown, ChevronUp, Check, X, Pencil, Save, Copy,
  Zap, MapPin, Server, Clock, AlertCircle, Database, CheckSquare, Square, Lock, Settings
} from 'lucide-react';
import { useApp } from '../../AppContext';
import { fmtDateTimeVN, useConfirm } from '../../Views';
import { Button, Card, CardHeader, CardTitle, CardContent, Input, StatBox } from '../../ui';

// ── Helpers ────────────────────────────────────────────────────────────────
function detectType(url: string): string {
  if (!url) return 'http';
  const u = url.toLowerCase();
  if (u.startsWith('socks5://')) return 'socks5';
  if (u.startsWith('socks4://')) return 'socks4';
  if (u.startsWith('https://')) return 'https';
  return 'http';
}

function formatProxyUrl(rawUrl: string, defaultType = 'http') {
  let val = rawUrl.trim();
  let type = defaultType;

  // Extract type if provided explicitly
  const typeMatch = val.match(/^(http|https|socks4|socks5):\/\/(.*)$/i);
  if (typeMatch) {
    type = typeMatch[1].toLowerCase();
    val = typeMatch[2];
  }

  const parts = val.split(':');
  // Handle host:port:user:pass
  if (parts.length === 4 && !val.includes('@')) {
    val = `${parts[2]}:${parts[3]}@${parts[0]}:${parts[1]}`;
  } 
  
  return `${type}://${val}`;
}

function parseBulk(raw: string) {
  return raw.split('\n').map(l => l.trim()).filter(Boolean).map(line => {
    const cols = line.replace(/\t/g, '|').split('|').map(s => s.trim());
    let rawUrl = cols[0] || '';
    const label = cols[1] || '';
    const country = cols[2] || '';

    // Handle string format like host:port:user:pass with no delimiter
    if (cols.length === 1 && line.split(':').length === 4 && !line.includes('@')) {
       rawUrl = line;
    }

    const type = detectType(rawUrl);
    const finalUrl = formatProxyUrl(rawUrl, type);

    return { url: finalUrl, label, country, type: type === 'http' && finalUrl.startsWith('socks') ? detectType(finalUrl) : type };
  }).filter(r => r.url.length > 4);
}

function isLocalRelay(url: string): boolean {
  if (!url) return false;
  try {
    const u = new URL(url.includes('://') ? url : `http://${url}`);
    const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h.startsWith('127.');
  } catch { return false; }
}

async function runWithConcurrencyLimit<T, R>(
  limit: number,
  items: T[],
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  const queue = [...items];

  const runNext = async (): Promise<void> => {
    if (queue.length === 0) return;
    const item = queue.shift()!;
    try {
      const res = await fn(item);
      results.push(res);
    } catch (_) {}
    await runNext();
  };

  const pool = Array.from({ length: Math.min(limit, items.length) }, () => runNext());
  await Promise.all(pool);
  return results;
}

function TypeBadge({ type }: { type: string }) {
  const s: Record<string, string> = {
    http:   'bg-blue-500/10 text-blue-400 border-blue-500/20',
    https:  'bg-teal-500/10 text-teal-400 border-teal-500/20',
    socks5: 'bg-violet-500/10 text-violet-400 border-violet-500/20',
    socks4: 'bg-purple-500/10 text-purple-400 border-purple-500/20',
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider border ${s[type?.toLowerCase()] || s.http}`}>
      {type?.toUpperCase() || 'HTTP'}
    </span>
  );
}

function LocalRelayBadge() {
  return (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold tracking-wider border bg-purple-500/10 text-purple-400 border-purple-500/20">
      🔒 LOCAL
    </span>
  );
}

function StatusBadge({ item, testing }: { item: any; testing: boolean }) {
  if (testing) return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold border bg-indigo-500/10 text-indigo-400 border-indigo-500/20">
      <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-ping" /> Testing…
    </span>
  );
  const active = item.is_active === 1 || item.is_active === true;
  const tested = !!item.last_tested;
  if (!tested) return <span className="text-slate-500 text-xs">—</span>;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold border ${active ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-rose-500/10 text-rose-400 border-rose-500/20'}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${active ? 'bg-emerald-500' : 'bg-rose-500'}`} />
      {active ? 'Active' : 'Down'}
    </span>
  );
}

function LatencyBadge({ ms }: { ms?: number | null }) {
  if (!ms) return null;
  const c = ms < 300 ? 'text-emerald-400 bg-emerald-500/10' : ms < 800 ? 'text-amber-400 bg-amber-500/10' : 'text-rose-400 bg-rose-500/10';
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold ${c} ml-1`}>
      <Zap size={9} /> {ms}ms
    </span>
  );
}

// ── Main View ──────────────────────────────────────────────────────────────
export function VaultProxiesView() {
  const { config, saveConfig, addToast } = useApp();
  const { confirm: askConfirm, modal: confirmModal } = useConfirm();

  // All useState hooks
  const [items, setItems]       = useState<any[]>([]);
  const [loading, setLoading]   = useState(true);
  const [search, setSearch]     = useState('');
  const [typeFilter, _setTypeFilter] = useState('all');
  const [statusFilter, _setStatusFilter] = useState('all');
  const [sortBy, setSortBy]     = useState<'label-asc' | 'recent'>('label-asc');

  // Auto-Expand settings states
  const [showConfigPanel, setShowConfigPanel] = useState(false);
  const [cfgExpand, setCfgExpand] = useState(false);
  const [cfgStep, setCfgStep] = useState(1);
  const [cfgDefaultSlots, setCfgDefaultSlots] = useState(4);
  const [savingSettings, setSavingSettings] = useState(false);

  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [testingIds, setTestingIds] = useState<Set<string>>(new Set());
  const [testingAll, setTestingAll] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkText, setBulkText] = useState('');
  const [bulkRows, setBulkRows] = useState<ReturnType<typeof parseBulk>>([]);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [addingOpen, setAddingOpen] = useState(false);
  const [editId, setEditId]     = useState<string | null>(null);
  const [copied, setCopied]     = useState<string | null>(null);

  // Form state
  const [form, setForm] = useState({ label: '', url: '', type: 'http', country: '', notes: '' });
  const setFormField = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm(v => ({ ...v, [k]: e.target.value }));

  // Memoized/Callback/Effect hooks
  useEffect(() => {
    if (config) {
      setCfgExpand(config.autoExpandSlots ?? false);
      setCfgStep(config.autoExpandSlotStep ?? 1);
      setCfgDefaultSlots(config.defaultSlotsPerProxy ?? 4);
    }
  }, [config]);

  const handleSaveSettings = async () => {
    setSavingSettings(true);
    try {
      await saveConfig({
        autoExpandSlots: cfgExpand,
        autoExpandSlotStep: cfgStep,
        defaultSlotsPerProxy: cfgDefaultSlots
      });
      setShowConfigPanel(false);
    } catch (e: any) {
      addToast(`❌ Lỗi lưu cài đặt: ${e.message}`, 'error');
    } finally {
      setSavingSettings(false);
    }
  };

  const nextProxyLabelIndex = useMemo(() => {
    let max = 0;
    for (const p of items) {
      if (p.label) {
        const match = p.label.match(/^P(\d+)$/i);
        if (match) {
          const num = parseInt(match[1], 10);
          if (num > max) max = num;
        }
      }
    }
    return max + 1;
  }, [items]);

  const setTypeFilter = useCallback((t: string) => {
    _setTypeFilter(t);
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.set('tab', t);
      window.history.replaceState({}, '', url.pathname + url.search + url.hash);
    }
  }, []);

  const setStatusFilter = useCallback((s: string) => {
    _setStatusFilter(s);
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.set('status', s);
      window.history.replaceState({}, '', url.pathname + url.search + url.hash);
    }
  }, []);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const tab = params.get('tab');
      const status = params.get('status');
      if (tab === 'all' || ['http', 'https', 'socks5', 'socks4'].includes(tab || '')) {
        _setTypeFilter(tab as string);
      }
      if (status === 'all' || ['active', 'down', 'unknown'].includes(status || '')) {
        _setStatusFilter(status as string);
      }
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/vault/proxies');
      const d = await r.json();
      setItems(d.items?.filter((x: any) => !x.deleted_at) || []);
    } catch (e: any) { addToast(e.message, 'error'); }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const patchProxyLocal = useCallback((id: string, patchData: Record<string, any>) => {
    setItems(prev => prev.map(it => (it.id === id ? { ...it, ...patchData } : it)));
  }, []);

  // Derived stats
  const stats = useMemo(() => ({
    total: items.length,
    active: items.filter(i => i.is_active === 1 && i.last_tested).length,
    down: items.filter(i => i.is_active === 0 && i.last_tested).length,
    unknown: items.filter(i => !i.last_tested).length,
  }), [items]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return items.filter(it => {
      const matchSearch = !search || it.url?.toLowerCase().includes(q) || it.label?.toLowerCase().includes(q);
      const matchType = typeFilter === 'all' || (it.type || 'http').toLowerCase() === typeFilter;
      const matchStatus = statusFilter === 'all' ||
        (statusFilter === 'active' && it.is_active === 1 && it.last_tested) ||
        (statusFilter === 'down' && it.is_active === 0 && it.last_tested) ||
        (statusFilter === 'unknown' && !it.last_tested);
      return matchSearch && matchType && matchStatus;
    });
  }, [items, search, typeFilter, statusFilter]);

  const sorted = useMemo(() => {
    const parseLabelNumber = (label?: string) => {
      if (!label) return Infinity;
      const match = label.match(/^P(\d+)$/i);
      return match ? parseInt(match[1], 10) : Infinity;
    };

    return [...filtered].sort((a, b) => {
      if (sortBy === 'label-asc') {
        const numA = parseLabelNumber(a.label);
        const numB = parseLabelNumber(b.label);
        if (numA !== numB) return numA - numB;
        return (a.label || '').localeCompare(b.label || '');
      } else {
        const dateA = new Date(a.created_at || 0).getTime();
        const dateB = new Date(b.created_at || 0).getTime();
        if (dateA !== dateB) return dateB - dateA;
        const numA = parseLabelNumber(a.label);
        const numB = parseLabelNumber(b.label);
        if (numA !== numB) return numB - numA;
        return (b.label || '').localeCompare(a.label || '');
      }
    });
  }, [filtered, sortBy]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [currentPage, totalPages]);

  // Reset page when filters or sorting change
  useEffect(() => {
    setCurrentPage(1);
  }, [search, typeFilter, statusFilter, sortBy]);

  const paginated = useMemo(() => {
    return sorted.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  }, [sorted, currentPage, pageSize]);

  // ── Actions ────────────────────────────────────────────────────────────
  const save = async (editingId?: string) => {
    if (!form.url) return addToast('Nhập URL proxy', 'error');
    
    // Auto-format format
    const finalUrl = formatProxyUrl(form.url, form.type);
    const body = { ...form, url: finalUrl, id: editingId };

    const r = await fetch('/api/vault/proxies', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json();
    if (d.error) addToast(d.error, 'error');
    else { 
      addToast('✅ Đã lưu proxy', 'success'); 
      setAddingOpen(false); setEditId(null); setForm({ label: '', url: '', type: 'http', country: '', notes: '' }); 
      if (editingId) {
        patchProxyLocal(editingId, { ...body, id: editingId });
      } else {
        load();
      }
      if (d.id) testOne(d.id);
    }
  };

  const del = async (id: string) => {
    if (!await askConfirm('Xóa Proxy', 'Bạn có chắc muốn xóa proxy này không?')) return;
    const res = await fetch(`/api/vault/proxies/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      addToast('Xóa thất bại', 'error');
      return;
    }
    setItems(prev => prev.filter(it => it.id !== id));
    setSelected(prev => {
      const n = new Set(prev);
      n.delete(id);
      return n;
    });
    addToast('Đã xóa', 'info');
    // Re-fetch to ensure UI reflects DB state (guards against any
    // background sync race that might revive the record).
    load();
  };

  const delSelected = async () => {
    if (!await askConfirm('Xóa Hàng Loạt', `Xóa ${selected.size} proxy đã chọn khỏi Local Vault?`)) return;
    try {
      const res = await fetch('/api/vault/proxies/bulk-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: Array.from(selected) })
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        addToast(`✅ Đã xóa ${selected.size} proxy`, 'info');
        const deletedIds = new Set(selected);
        setItems(prev => prev.filter(it => !deletedIds.has(it.id)));
      } else {
        addToast(`❌ Lỗi xóa: ${data.error || 'Server error'}`, 'error');
      }
    } catch (e: any) {
      addToast(`❌ Lỗi kết nối: ${e.message}`, 'error');
    }
    setSelected(new Set());
    load();
  };

  const testOne = async (id: string, skipToast = false) => {
    setTestingIds(prev => new Set(prev).add(id));
    let success = false;
    try {
      const r = await fetch(`/api/vault/proxies/${id}/test`, { method: 'POST' });
      const d = await r.json();
      patchProxyLocal(id, {
        is_active: d.status === 'active' ? 1 : 0,
        latency_ms: d.latency ?? null,
        last_tested: new Date().toISOString(),
        notes: d.status === 'active' && d.exitIp ? `${d.networkType || (String(d.exitIp).includes(':') ? 'IPv6' : 'IPv4')} (${d.exitIp})` : undefined,
        country: d.country || undefined,
      });
      if (d.status === 'active') {
        success = true;
        if (!skipToast) addToast(`${d.isLocalRelay ? '🔒 ' : ''}✅ Active · ${d.latency}ms`, 'success');
      } else {
        if (!skipToast) addToast(`${d.isLocalRelay ? '🔒 ' : ''}❌ Down: ${d.error || 'unreachable'}`, 'error');
      }
    } catch (e: any) {
      if (!skipToast) addToast(e.message, 'error');
    }
    setTestingIds(prev => { const n = new Set(prev); n.delete(id); return n; });
    return success;
  };

  const testAll = async () => {
    if (!filtered.length) return;
    setTestingAll(true);
    addToast(`🔍 Đang test ${filtered.length} proxy… (Hàng chờ chạy song song: tối đa 10)`, 'info');
    let ok = 0, fail = 0;
    await runWithConcurrencyLimit(10, filtered, async (it) => {
      setTestingIds(prev => new Set(prev).add(it.id));
      try {
        const r = await fetch(`/api/vault/proxies/${it.id}/test`, { method: 'POST' });
        const d = await r.json();
        patchProxyLocal(it.id, {
          is_active: d.status === 'active' ? 1 : 0,
          latency_ms: d.latency ?? null,
          last_tested: new Date().toISOString(),
          notes: d.status === 'active' && d.exitIp ? `${d.networkType || (String(d.exitIp).includes(':') ? 'IPv6' : 'IPv4')} (${d.exitIp})` : it.notes,
          country: d.country || it.country,
        });
        if (d.status === 'active') ok++; else fail++;
      } catch { fail++; }
      setTestingIds(prev => { const n = new Set(prev); n.delete(it.id); return n; });
    });
    addToast(`✅ ${ok} active · ❌ ${fail} down`, ok > 0 ? 'success' : 'error');
    setTestingAll(false);
  };

  const syncToD1 = async () => {
    addToast('☁️ Đang sync vault proxies lên D1...', 'info');
    try {
      const r = await fetch('/api/vault/sync', { method: 'POST' });
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      addToast(`✅ Đã sync ${d.pushed || '?'} bản ghi lên D1`, 'success');
    } catch (e: any) { addToast(e.message, 'error'); }
  };

  const importBulk = async () => {
    if (!bulkRows.length) return;
    setBulkBusy(true);
    let newIds: string[] = [];
    try {
      const res = await fetch('/api/vault/proxies/bulk-add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: bulkRows })
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        newIds = data.items.map((x: any) => x.id);
        addToast(`✅ Import thành công ${data.count}/${bulkRows.length} proxy. Đang tự động kiểm tra... (Song song: tối đa 10)`, 'info');
      } else {
        addToast(`❌ Import lỗi: ${data.error || 'Server error'}`, 'error');
      }
    } catch (e: any) {
      addToast(`❌ Lỗi kết nối: ${e.message}`, 'error');
    }
    setBulkBusy(false); setBulkText(''); setBulkRows([]); setBulkOpen(false);
    await load();
    
    if (newIds.length > 0) {
      // Auto-test newly added proxies with concurrency limit of 10
      let testOk = 0;
      let testFail = 0;
      await runWithConcurrencyLimit(10, newIds, async (id) => {
        const isSuccess = await testOne(id, true);
        if (isSuccess) testOk++; else testFail++;
      });
      addToast(`⚡ Đã tự động kiểm tra xong: ${testOk} hoạt động, ${testFail} lỗi.`, testOk > 0 ? 'success' : 'error');
    }
  };

  const copyUrl = (url: string) => {
    navigator.clipboard.writeText(url);
    setCopied(url);
    addToast('Đã copy URL', 'success');
    setTimeout(() => setCopied(null), 1400);
  };

  const toggleSelect = (id: string) => setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleAll = () => {
    if (paginated.every(i => selected.has(i.id))) setSelected(prev => { const n = new Set(prev); paginated.forEach(i => n.delete(i.id)); return n; });
    else setSelected(prev => { const n = new Set(prev); paginated.forEach(i => n.add(i.id)); return n; });
  };

  const startEdit = (it: any) => { setEditId(it.id); setForm({ label: it.label || '', url: it.url, type: it.type || 'http', country: it.country || '', notes: it.notes || '' }); };

  const TYPE_FILTERS = ['all', 'http', 'https', 'socks5', 'socks4'];

  return (
    <div className="absolute inset-0 overflow-y-auto px-6 pb-10 pt-2 flex flex-col gap-5 custom-scrollbar">
      {confirmModal}
      
      {/* Stats */}
      <div className="grid grid-cols-4 gap-4 mt-2 shrink-0">
        <StatBox label="Tổng Proxy" value={stats.total} icon={Globe} colorClass="text-indigo-400" bgClass="bg-indigo-500/10" active={statusFilter === 'all'} onClick={() => setStatusFilter('all')} />
        <StatBox label="Active" value={stats.active} icon={Check} colorClass="text-emerald-400" bgClass="bg-emerald-500/10" active={statusFilter === 'active'} onClick={() => setStatusFilter('active')} />
        <StatBox label="Down" value={stats.down} icon={AlertCircle} colorClass="text-rose-400" bgClass="bg-rose-500/10" active={statusFilter === 'down'} onClick={() => setStatusFilter('down')} />
        <StatBox label="Chưa Test" value={stats.unknown} icon={Clock} colorClass="text-amber-400" bgClass="bg-amber-500/10" active={statusFilter === 'unknown'} onClick={() => setStatusFilter('unknown')} />
      </div>

      {/* Smart Allocation Banner */}
      <div className="relative overflow-hidden rounded-xl bg-gradient-to-r from-indigo-500/10 via-cyan-500/5 to-emerald-500/5 border border-white/10 flex flex-col gap-3 p-4 shrink-0">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-indigo-400 shrink-0">
              <Activity size={16} />
            </div>
            <div>
              <div className="text-[12.5px] font-semibold text-slate-200">Hệ thống Phân bổ Proxy & Slot Thông minh</div>
              <div className="text-[11px] text-slate-400 leading-relaxed mt-0.5">
                Tự động gán nhãn tuần tự <code className="text-cyan-400 font-mono bg-cyan-500/10 px-1 rounded">P1, P2...</code> khi import. Tự động tìm slot trống và giải phóng slot khi tài khoản/proxy bị xóa.
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <div className="px-2.5 py-1 rounded-md bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-[10px] font-semibold uppercase tracking-wider flex items-center gap-1.5 self-start sm:self-center">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              Auto Label: P{nextProxyLabelIndex}
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setShowConfigPanel(!showConfigPanel)}
              className={`flex items-center gap-1 text-[11px] px-2.5 py-1 ${showConfigPanel ? 'bg-indigo-500/20 text-indigo-300 border-indigo-500/40' : 'bg-white/5 text-slate-300 border-white/10 hover:bg-white/10'}`}
            >
              <Settings size={12} className={showConfigPanel ? 'animate-spin-slow' : ''} />
              Cấu hình
            </Button>
          </div>
        </div>

        {showConfigPanel && (
          <div className="mt-2 pt-3 border-t border-white/5 grid grid-cols-1 md:grid-cols-3 gap-4 animate-fadeIn">
            {/* Auto Expand Toggle */}
            <div className="flex flex-col gap-1.5">
              <label className="text-[11px] font-semibold text-slate-400 flex items-center gap-1.5">
                Tự động mở rộng Slot
              </label>
              <button
                type="button"
                onClick={() => setCfgExpand(!cfgExpand)}
                className={`relative inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border text-[11.5px] font-semibold transition-all ${
                  cfgExpand
                    ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/15'
                    : 'bg-white/5 border-white/10 text-slate-400 hover:bg-white/10'
                }`}
              >
                <span className={`w-7 h-4 rounded-full transition-colors ${cfgExpand ? 'bg-emerald-500' : 'bg-slate-600'} relative`}>
                  <span className={`absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-white transition-transform ${cfgExpand ? 'translate-x-3' : ''}`} />
                </span>
                {cfgExpand ? 'Đang Bật' : 'Đang Tắt'}
              </button>
            </div>

            {/* Auto Expand Step */}
            <div className="flex flex-col gap-1.5">
              <label className="text-[11px] font-semibold text-slate-400">
                Số slot tự động tăng (+K slots)
              </label>
              <Input
                type="number"
                min={1}
                max={50}
                value={cfgStep}
                disabled={!cfgExpand}
                onChange={e => setCfgStep(Math.max(1, parseInt(e.target.value, 10) || 1))}
                className={`bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-[11.5px] text-white focus:outline-none focus:border-indigo-500/50 w-full ${!cfgExpand ? 'opacity-50 cursor-not-allowed' : ''}`}
              />
            </div>

            {/* Default Slots Per Proxy */}
            <div className="flex flex-col gap-1.5">
              <label className="text-[11px] font-semibold text-slate-400">
                Số slot mặc định mỗi Proxy khi import
              </label>
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min={1}
                  max={100}
                  value={cfgDefaultSlots}
                  onChange={e => setCfgDefaultSlots(Math.max(1, parseInt(e.target.value, 10) || 4))}
                  className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-[11.5px] text-white focus:outline-none focus:border-indigo-500/50 w-full"
                />
                <Button
                  onClick={handleSaveSettings}
                  disabled={savingSettings}
                  className="bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-[11.5px] px-4 py-1.5 h-full whitespace-nowrap"
                >
                  {savingSettings ? 'Đang lưu...' : 'Lưu'}
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Toolbar */}
      <Card className="shrink-0">
        <CardContent className="py-3">
          <div className="flex flex-wrap gap-2 items-center">
            <Button variant="primary" size="sm" onClick={() => { setAddingOpen(v => !v); setEditId(null); setForm({ label: '', url: '', type: 'http', country: '', notes: '' }); }}>
              {addingOpen ? <X size={13} /> : <Plus size={13} />} {addingOpen ? 'Hủy' : 'Thêm Proxy'}
            </Button>
            <Button variant={bulkOpen ? 'primary' : 'ghost'} size="sm" onClick={() => setBulkOpen(v => !v)}>
              <Upload size={12} /> Import hàng loạt {bulkOpen ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
            </Button>
            <div className="w-px h-5 bg-white/10" />
            <Button variant="secondary" size="sm" onClick={testAll} disabled={testingAll || !filtered.length} className="text-indigo-400 border-indigo-500/30 hover:bg-indigo-500/10">
              {testingAll ? <span className="w-3 h-3 border-2 border-indigo-400/30 border-t-indigo-400 rounded-full animate-spin" /> : <Activity size={12} />} Test All ({filtered.length})
            </Button>
            <Button variant="secondary" size="sm" onClick={syncToD1} className="text-cyan-400 border-cyan-500/30 hover:bg-cyan-500/10">
              <Database size={12} /> Sync to D1
            </Button>
            {selected.size > 0 && (
              <Button variant="danger" size="sm" onClick={delSelected}>
                <Trash2 size={12} /> Xóa ({selected.size})
              </Button>
            )}
            <div className="flex-1" />
            <select
              value={sortBy}
              onChange={e => setSortBy(e.target.value as 'label-asc' | 'recent')}
              className="bg-white/5 border border-white/10 text-slate-200 text-xs rounded-md px-2 py-1.5 focus:outline-none focus:border-indigo-500/50 cursor-pointer h-8"
            >
              <option value="label-asc" className="bg-[#0b0f19] text-slate-200">Sắp xếp: P1 → PN</option>
              <option value="recent" className="bg-[#0b0f19] text-slate-200">Sắp xếp: Gần đây</option>
            </select>
            <div className="relative flex items-center">
              <Search size={12} className="absolute left-2.5 text-slate-500 pointer-events-none" />
              <Input className="pl-7 h-8 w-[180px] text-xs bg-white/5 border-white/10" placeholder="Tìm proxy…" value={search} onChange={e => setSearch(e.target.value)} />
              {search && <button onClick={() => setSearch('')} className="absolute right-2 text-slate-500 hover:text-slate-300"><X size={11} /></button>}
            </div>
            <Button variant="ghost" size="icon-sm" onClick={load} disabled={loading} className="border border-white/5 bg-white/5">
              <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
            </Button>
          </div>

          {/* Bulk Import panel */}
          {bulkOpen && (
            <div className="mt-4 flex flex-col gap-3 pt-4 border-t border-white/5">
              <div className="p-3 bg-white/5 border border-white/10 rounded-lg text-xs text-slate-400">
                <strong className="text-slate-200">Định dạng:</strong>{' '}
                <code className="text-cyan-400 bg-cyan-500/10 px-1.5 rounded">url|label|country</code>{' '}— mỗi proxy 1 dòng
              </div>
              <textarea className="w-full bg-black/40 border border-white/10 rounded-lg p-3 text-[11px] font-mono text-slate-300 resize-y focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/20" rows={5}
                placeholder="http://user:pass@1.2.3.4:8080|VPS US|US&#10;socks5://5.6.7.8:1080|Home Router|VN"
                value={bulkText} onChange={e => { setBulkText(e.target.value); setBulkRows(parseBulk(e.target.value)); }} />
              <div className="flex items-center justify-between">
                <span className={bulkRows.length ? 'text-emerald-400 text-xs font-medium' : 'text-slate-500 text-xs'}>
                  {bulkRows.length ? `✅ ${bulkRows.length} proxy hợp lệ` : 'Dán danh sách…'}
                </span>
                <div className="flex gap-2">
                  <Button variant="ghost" size="sm" onClick={() => { setBulkOpen(false); setBulkText(''); setBulkRows([]); }}><X size={12} /> Hủy</Button>
                  <Button variant="primary" size="sm" disabled={bulkBusy || !bulkRows.length} onClick={importBulk}>
                    {bulkBusy ? <span className="w-3 h-3 border-2 border-white/20 border-t-white rounded-full animate-spin" /> : <Upload size={12} />} Import {bulkRows.length || ''}
                  </Button>
                </div>
              </div>
            </div>
          )}

          {/* Add / Edit form panel */}
          {(addingOpen || editId) && (
            <div className="mt-4 pt-4 border-t border-white/5 flex flex-col gap-3">
              <div className="text-xs font-bold text-slate-400 uppercase tracking-wider">{editId ? '✏️ Chỉnh sửa proxy' : '➕ Thêm proxy mới'}</div>
              <div className="grid grid-cols-6 gap-3">
                <div className="col-span-3">
                  <label className="block text-[11px] font-semibold text-slate-400 mb-1.5">Proxy URL *</label>
                  <Input placeholder="http://user:pass@host:port" value={form.url} onChange={setFormField('url')} className="font-mono text-[12px]" />
                  {isLocalRelay(form.url) && (
                    <div className="mt-1.5 flex items-center gap-1.5 text-[10px] text-purple-300 bg-purple-500/5 border border-purple-500/10 rounded px-2 py-1">
                      <Lock size={9} className="text-purple-400" />
                      <span>Local relay proxy — sẽ skip kiểm tra IP thoát</span>
                    </div>
                  )}
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-400 mb-1.5">Label</label>
                  <Input placeholder="VPS US" value={form.label} onChange={setFormField('label')} />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-400 mb-1.5">Protocol</label>
                  <select className="w-full h-[38px] bg-white/5 border border-white/10 rounded-md px-2 text-[13px] text-slate-100 outline-none focus:border-indigo-500/50" value={form.type} onChange={setFormField('type')}>
                    {['http', 'https', 'socks5', 'socks4'].map(t => <option key={t} value={t} className="bg-[#0f172a]">{t.toUpperCase()}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-400 mb-1.5">Country</label>
                  <Input placeholder="US, VN, SG…" value={form.country} onChange={setFormField('country')} />
                </div>
              </div>
              <div className="flex gap-2 justify-end">
                <Button variant="ghost" size="sm" onClick={() => { setAddingOpen(false); setEditId(null); }}><X size={12} /> Hủy</Button>
                <Button variant="primary" size="sm" onClick={() => save(editId || undefined)}>
                  <Save size={12} /> {editId ? 'Lưu thay đổi' : 'Thêm Proxy'}
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Table */}
      <Card className="flex-1 min-h-[320px] flex flex-col">
        <CardHeader className="border-b border-white/5 bg-black/10 py-3 px-5">
          <CardTitle>
            <Globe size={14} className="text-indigo-400" /> Proxy Manager
            <span className="ml-2 px-2 py-0.5 rounded-full text-[10px] bg-indigo-500/20 text-indigo-400 font-bold">{filtered.length}</span>
          </CardTitle>
          {/* Type tabs */}
          <div className="ml-4 flex items-center gap-0 border border-white/5 rounded-lg bg-black/20 overflow-hidden">
            {TYPE_FILTERS.map(f => (
              <button key={f} onClick={() => setTypeFilter(f)} className={`px-3 py-1.5 text-[11px] font-bold uppercase tracking-wide transition-all ${typeFilter === f ? 'bg-indigo-500/20 text-indigo-400' : 'text-slate-500 hover:text-slate-300'}`}>
                {f === 'all' ? 'ALL' : f}
              </button>
            ))}
          </div>
        </CardHeader>

        <div className="flex-1 min-h-0 overflow-auto custom-scrollbar">
          <table className="w-full min-w-[1000px] border-collapse text-left">
            <thead>
              <tr className="bg-white/[0.03] border-b border-white/5">
                <th className="px-4 py-3 w-10">
                  <button onClick={toggleAll} className="text-slate-500 hover:text-slate-200">
                    {paginated.length > 0 && paginated.every(i => selected.has(i.id)) ? <CheckSquare size={14} className="text-indigo-400" /> : <Square size={14} />}
                  </button>
                </th>
                <th className="px-4 py-3 text-[11px] font-bold text-slate-400 uppercase tracking-wider">Proxy URL</th>
                <th className="px-4 py-3 text-[11px] font-bold text-slate-400 uppercase tracking-wider">Type / Net</th>
                <th className="px-4 py-3 text-[11px] font-bold text-slate-400 uppercase tracking-wider">Status</th>
                <th className="px-4 py-3 text-[11px] font-bold text-slate-400 uppercase tracking-wider">Country</th>
                <th className="px-4 py-3 text-[11px] font-bold text-slate-400 uppercase tracking-wider">Last Tested</th>
                <th className="px-4 py-3 text-[11px] font-bold text-slate-400 uppercase tracking-wider text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {filtered.length === 0 && !loading && (
                <tr><td colSpan={7} className="text-center py-12 text-slate-500 text-[13px]">{search ? `Không tìm thấy "${search}"` : 'Chưa có proxy nào. Thêm proxy mới hoặc import hàng loạt.'}</td></tr>
              )}
              {paginated.map(it => {
                const isTesting = testingIds.has(it.id);
                const isEditing = editId === it.id;
                return (
                  <tr key={it.id} className={`group transition-colors hover:bg-white/[0.02] ${selected.has(it.id) ? 'bg-indigo-500/5' : ''}`}>
                    <td className="px-4 py-3.5">
                      <button onClick={() => toggleSelect(it.id)} className="text-slate-500 hover:text-slate-200">
                        {selected.has(it.id) ? <CheckSquare size={14} className="text-indigo-400" /> : <Square size={14} />}
                      </button>
                    </td>
                    <td className="px-4 py-3.5 min-w-[280px]">
                      {it.label && <div className="text-[12px] font-semibold text-slate-200 mb-0.5">{it.label}</div>}
                      <div className="flex items-center gap-1.5">
                        <code className="text-[11.5px] text-indigo-300 font-mono truncate max-w-[280px]" title={it.url}>{it.url}</code>
                        <button onClick={() => copyUrl(it.url)} className="shrink-0 p-0.5 text-slate-600 hover:text-slate-300 opacity-0 group-hover:opacity-100 transition-all">
                          {copied === it.url ? <Check size={11} className="text-emerald-400" /> : <Copy size={11} />}
                        </button>
                      </div>
                    </td>
                    <td className="px-4 py-3.5">
                      <div className="flex flex-col gap-1.5 items-start">
                        <div className="flex items-center gap-1.5">
                          <TypeBadge type={it.type} />
                          {isLocalRelay(it.url) && <LocalRelayBadge />}
                        </div>
                        {it.notes && it.notes.includes('IPv') && (
                          <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold tracking-wider border ${it.notes.includes('IPv6') ? 'bg-purple-500/10 text-purple-400 border-purple-500/20' : 'bg-blue-500/10 text-blue-400 border-blue-500/20'}`}>
                            {it.notes.split(' ')[0]}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3.5">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <StatusBadge item={it} testing={isTesting} />
                        {!isTesting && it.latency_ms && <LatencyBadge ms={it.latency_ms} />}
                      </div>
                    </td>
                    <td className="px-4 py-3.5">
                      {it.country ? (
                        <span className="inline-flex items-center gap-1 text-[12px] text-slate-300">
                          <MapPin size={11} className="text-indigo-400" /> {it.country}
                        </span>
                      ) : <span className="text-slate-500">—</span>}
                    </td>
                    <td className="px-4 py-3.5 text-[11px] text-slate-500 whitespace-nowrap">
                      {it.last_tested ? fmtDateTimeVN(it.last_tested) : '—'}
                    </td>
                    <td className="px-4 py-3.5 text-right">
                      <div className="flex gap-1 justify-end opacity-0 group-hover:opacity-100 transition-opacity">
                        <Button variant="secondary" size="icon-sm" title="Test" onClick={() => testOne(it.id)} disabled={isTesting} className="text-indigo-400 border-white/10 hover:bg-indigo-500/10">
                          {isTesting ? <span className="w-3 h-3 border-2 border-indigo-400/20 border-t-indigo-400 rounded-full animate-spin" /> : <Activity size={13} />}
                        </Button>
                        <Button variant="secondary" size="icon-sm" title="Copy URL" onClick={() => copyUrl(it.url)} className="border-white/10 text-slate-400 hover:bg-white/10">
                          {copied === it.url ? <Check size={13} className="text-emerald-400" /> : <Copy size={13} />}
                        </Button>
                        <Button variant="secondary" size="icon-sm" title="Sửa" onClick={() => { startEdit(it); setAddingOpen(false); window.scrollTo({ top: 0 }); }} className="text-amber-400 border-white/10 hover:bg-amber-500/10">
                          <Pencil size={13} />
                        </Button>
                        <Button variant="danger" size="icon-sm" title="Xóa" onClick={() => del(it.id)} className="border-white/10">
                          <Trash2 size={13} />
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Pagination Controls */}
        {filtered.length > 0 && (
          <div className="flex flex-col sm:flex-row gap-3 items-center justify-between px-6 py-4 border-t border-white/5 shrink-0 bg-white/[0.01]">
            <div className="flex items-center gap-3 text-[12px] text-slate-400">
              <span>
                Hiển thị <span className="font-semibold text-slate-200">{((currentPage - 1) * pageSize) + 1}</span> -{' '}
                <span className="font-semibold text-slate-200">{Math.min(currentPage * pageSize, filtered.length)}</span> trên{' '}
                <span className="font-semibold text-indigo-400">{filtered.length}</span> proxy
              </span>
              <select
                value={pageSize}
                onChange={e => { setPageSize(Number(e.target.value)); setCurrentPage(1); }}
                className="bg-white/5 border border-white/10 rounded px-2 py-0.5 text-[11px] text-slate-300 focus:outline-none focus:border-indigo-500/50 cursor-pointer"
              >
                <option value={50} className="bg-[#0d111c] text-slate-300">50 / trang</option>
                <option value={100} className="bg-[#0d111c] text-slate-300">100 / trang</option>
                <option value={500} className="bg-[#0d111c] text-slate-300">500 / trang</option>
                <option value={1000} className="bg-[#0d111c] text-slate-300">1000 / trang</option>
              </select>
            </div>
            {totalPages > 1 && (
              <div className="flex items-center gap-1.5">
                <Button variant="secondary" size="sm" onClick={() => setCurrentPage(1)} disabled={currentPage === 1} className="h-8 px-2.5">Trang đầu</Button>
                <Button variant="secondary" size="sm" onClick={() => setCurrentPage(p => Math.max(1, p - 1))} disabled={currentPage === 1} className="h-8 px-2.5">Trước</Button>
                <div className="text-[12px] px-3 font-semibold text-slate-300">Trang {currentPage} / {totalPages}</div>
                <Button variant="secondary" size="sm" onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))} disabled={currentPage === totalPages} className="h-8 px-2.5">Sau</Button>
                <Button variant="secondary" size="sm" onClick={() => setCurrentPage(totalPages)} disabled={currentPage === totalPages} className="h-8 px-2.5">Trang cuối</Button>
              </div>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
