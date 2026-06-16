'use client';
import React, { useCallback, useEffect, useState, useMemo } from 'react';
import {
  Plus, Upload, Search, RefreshCw,
  Trash2, Globe, Server, Activity, ChevronUp, ChevronDown, Check, X,
  AlertCircle, Edit2, Save, CheckSquare, Square, Settings
} from 'lucide-react';
import { useApp } from '../AppContext';
import { ConfirmModal } from '../Views';
import { Card, CardHeader, CardTitle, CardContent, Button, Input, StatBox } from '../ui';

interface ProxyItem {
  id: string; url: string; source: string; label?: string;
  last_latency_ms?: number; created_at: string;
}
interface ProxySlot {
  id: string; proxy_id: string; slot_index: number; connection_id?: string; updated_at: string;
}
interface ProxyBinding {
  account_id: string;
  email: string;
  provider: string;
  proxy_id?: string | null;
  proxy_url?: string | null;
  proxy_label?: string;
  slot_id?: string | null;
  slot_index?: number | null;
}

function detectProxyType(url: string): string {
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

  const typeMatch = val.match(/^(http|https|socks4|socks5):\/\/(.*)$/i);
  if (typeMatch) {
    type = typeMatch[1].toLowerCase();
    val = typeMatch[2];
  }

  const parts = val.split(':');
  // host:port:user:pass
  if (parts.length === 4 && !val.includes('@')) {
    val = `${parts[2]}:${parts[3]}@${parts[0]}:${parts[1]}`;
  }

  return `${type}://${val}`;
}

function parseBulkProxies(raw: string) {
  return raw.split('\n')
    .map(l => l.trim()).filter(Boolean)
    .map(line => {
      // First check if line already has a protocol → treat as url:label:slots
      const hasProtocol = /^(http|https|socks4|socks5):\/\//i.test(line);
      if (hasProtocol) {
        const norm = line.replace(/\t/g, ':').replace(/\s*[|]\s*/g, ':');
        const [url = '', label = '', slots = '4'] = norm.split(':').map(s => s.trim());
        return { url, label, slotCount: parseInt(slots, 10) || 4 };
      }

      // Handle host:port:user:pass:label:slots or host:port:user:pass
      const parts = line.replace(/\t/g, ':').replace(/\s*[|]\s*/g, ':').split(':');
      if (parts.length >= 4) {
        const host = parts[0];
        const port = parts[1];
        const user = parts[2];
        const pass = parts[3];
        const label = parts[4] || '';
        const slots = parts[5] || '4';
        const url = formatProxyUrl(`${host}:${port}:${user}:${pass}`);
        return { url, label, slotCount: parseInt(slots, 10) || 4 };
      }

      // Fallback: url:label:slots
      const [url = '', label = '', slots = '4'] = parts.map(s => s.trim());
      return { url, label, slotCount: parseInt(slots, 10) || 4 };
    })
    .filter(r => r.url.startsWith('http://') || r.url.startsWith('https://') || r.url.startsWith('socks'));
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

export function ProxiesView() {
  const { config, saveConfig, addToast } = useApp();
  const [proxies, setProxies] = useState<ProxyItem[]>([]);
  const [slots, setSlots] = useState<ProxySlot[]>([]);
  const [bindings, setBindings] = useState<ProxyBinding[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [confirmModal, setConfirmModal] = useState<{ title: string; message: string; onConfirm: () => Promise<void> } | null>(null);
  const [sortBy, setSortBy] = useState<'label-asc' | 'recent'>('label-asc');

  // Auto-Expand settings states
  const [showConfigPanel, setShowConfigPanel] = useState(false);
  const [cfgExpand, setCfgExpand] = useState(false);
  const [cfgStep, setCfgStep] = useState(1);
  const [cfgDefaultSlots, setCfgDefaultSlots] = useState(4);
  const [savingSettings, setSavingSettings] = useState(false);

  const [newUrl, setNewUrl] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [newCount, setNewCount] = useState('4');
  const [adding, setAdding] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkText, setBulkText] = useState('');
  const [bulkRows, setBulkRows] = useState<ReturnType<typeof parseBulkProxies>>([]);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [editProxyId, setEditProxyId] = useState<string | null>(null);
  const [editValues, setEditValues] = useState({ url: '', label: '' });

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [testingIds, setTestingIds] = useState<Set<string>>(new Set());
  const [testingAll, setTestingAll] = useState(false);

  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

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

  const loadData = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const unified = await fetch('/api/proxy/state').catch(() => null as any);
      if (unified?.ok) {
        const data = await unified.json();
        if (data.error) throw new Error(data.error);
        setProxies(data.proxies || []);
        setSlots(data.proxySlots || []);
        setBindings(data.bindings || []);
      } else {
        const legacy = await fetch('/api/d1/inspect/proxies');
        if (!legacy.ok) throw new Error(`HTTP ${legacy.status}`);
        const data = await legacy.json();
        if (data.error) throw new Error(data.error);
        setProxies(data.proxies || []);
        setSlots(data.proxySlots || []);
        setBindings([]);
      }
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  useEffect(() => {
    const handleVaultUpdate = () => {
      loadData();
    };
    window.addEventListener('seellm:vault-update', handleVaultUpdate);
    return () => window.removeEventListener('seellm:vault-update', handleVaultUpdate);
  }, [loadData]);

  useEffect(() => {
    setCurrentPage(1);
    setSelected(new Set());
  }, [search, sortBy]);

  useEffect(() => {
    setSelected(new Set());
  }, [currentPage, pageSize]);

  // Group slots by proxy_id
  const slotsByProxyId = useMemo(() => {
    const map = new Map<string, ProxySlot[]>();
    for (const slot of slots) {
      if (!slot.proxy_id) continue;
      if (!map.has(slot.proxy_id)) map.set(slot.proxy_id, []);
      map.get(slot.proxy_id)!.push(slot);
    }
    return map;
  }, [slots]);

  // Group bindings by proxy_id or proxy_url
  const bindingsByProxy = useMemo(() => {
    const byId = new Map<string, ProxyBinding[]>();
    const byUrl = new Map<string, ProxyBinding[]>();
    for (const binding of bindings) {
      if (binding.proxy_id) {
        if (!byId.has(binding.proxy_id)) byId.set(binding.proxy_id, []);
        byId.get(binding.proxy_id)!.push(binding);
      }
      if (binding.proxy_url) {
        if (!byUrl.has(binding.proxy_url)) byUrl.set(binding.proxy_url, []);
        byUrl.get(binding.proxy_url)!.push(binding);
      }
    }
    return { byId, byUrl };
  }, [bindings]);

  const nextProxyLabelIndex = useMemo(() => {
    let max = 0;
    for (const p of proxies) {
      if (p.label) {
        const match = p.label.match(/^P(\d+)$/i);
        if (match) {
          const num = parseInt(match[1], 10);
          if (num > max) max = num;
        }
      }
    }
    return max + 1;
  }, [proxies]);

  const filtered = useMemo(() => {
    const query = search.toLowerCase();
    return proxies.filter(p => !search || p.url.toLowerCase().includes(query) || (p.label && p.label.toLowerCase().includes(query)));
  }, [proxies, search]);

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

  const totalPages = Math.ceil(filtered.length / pageSize);
  const paginated = useMemo(() => {
    return sorted.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  }, [sorted, currentPage, pageSize]);

  const toggleSelect = (id: string) => {
    setSelected(prev => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };

  const toggleAll = () => {
    const visibleIds = paginated.map(p => p.id);
    const allSelected = visibleIds.length > 0 && visibleIds.every(id => selected.has(id));
    setSelected(prev => {
      const n = new Set(prev);
      if (allSelected) {
        visibleIds.forEach(id => n.delete(id));
      } else {
        visibleIds.forEach(id => n.add(id));
      }
      return n;
    });
  };

  const deleteSelected = async () => {
    if (!selected.size) return;
    setConfirmModal({
      title: `Xóa ${selected.size} Proxy`,
      message: `Bạn có chắc chắn muốn xóa ${selected.size} proxy đã chọn? Toàn bộ các slot liên quan cũng sẽ bị xóa khỏi D1 Cloud.`,
      onConfirm: async () => {
        try {
          const res = await fetch('/api/d1/proxies/bulk-delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids: Array.from(selected) })
          });
          const data = await res.json();
          if (res.ok && data.ok) {
            addToast(`✅ Đã xóa thành công ${selected.size} proxy`, 'success');
          } else {
            addToast(`❌ Xóa lỗi: ${data.error || 'D1 Worker error'}`, 'error');
          }
        } catch (e: any) {
          addToast(`❌ Gặp lỗi kết nối: ${e.message}`, 'error');
        }
        setSelected(new Set());
        setConfirmModal(null);
        loadData();
      }
    });
  };

  const testSelected = async (targetIds?: Set<string>) => {
    const listToTest = targetIds || selected;
    if (!listToTest.size) return;
    const selectedList = filtered.filter(p => listToTest.has(p.id));
    if (!selectedList.length) return;
    setTestingAll(true);
    addToast(`🔍 Đang kiểm tra kết nối cho ${selectedList.length} proxy...`, 'info');
    let ok = 0, fail = 0;
    await runWithConcurrencyLimit(10, selectedList, async (p) => {
      setTestingIds(prev => { const n = new Set(prev); n.add(p.id); return n; });
      try {
        const res = await fetch(`/api/vault/proxies/${p.id}/test`, { method: 'POST' });
        const data = await res.json();
        if (data.ok && data.status === 'active') {
          ok++;
          setProxies(prev => prev.map(x => x.id === p.id ? { ...x, last_latency_ms: data.latency } : x));
        } else {
          fail++;
          setProxies(prev => prev.map(x => x.id === p.id ? { ...x, last_latency_ms: undefined } : x));
        }
      } catch {
        fail++;
      }
      setTestingIds(prev => { const n = new Set(prev); n.delete(p.id); return n; });
    });
    addToast(`✅ Đã test xong: ${ok} hoạt động, ${fail} lỗi`, ok > 0 ? 'success' : 'error');
    setTestingAll(false);
  };

  const activeProxyIds = useMemo(() => new Set(proxies.map(p => p.id)), [proxies]);
  const activeSlots = useMemo(() => slots.filter(s => s && activeProxyIds.has(s.proxy_id)), [slots, activeProxyIds]);
  const totalSlots = activeSlots.length;
  const busySlots = activeSlots.filter(s => s.connection_id).length;
  const freeSlots = totalSlots - busySlots;

  async function apiPost(url: string, body: object) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return r.json();
  }

  const addProxy = async () => {
    if (!newUrl) return; setAdding(true);
    const d = await apiPost('/api/d1/proxies/add', { url: formatProxyUrl(newUrl), label: newLabel, slotCount: parseInt(newCount, 10) || 4 });
    if (d.error) addToast(d.error, 'error');
    else { addToast('✅ Đã thêm proxy', 'success'); setNewUrl(''); setNewLabel(''); setNewCount('4'); await loadData(); }
    setAdding(false);
  };

  const deleteProxy = async (id: string) => {
    setConfirmModal({
      title: 'Xóa Proxy',
      message: 'Bạn có chắc muốn xóa proxy này? Tất cả các slot liên quan cũng sẽ bị xóa.',
      onConfirm: async () => {
        await fetch(`/api/d1/proxies/${id}`, { method: 'DELETE' });
        addToast('Đã xoá proxy', 'info'); loadData(); setConfirmModal(null);
      }
    });
  };

  const saveEdit = async () => {
    if (!editProxyId) return;
    const r = await fetch(`/api/d1/proxies/${editProxyId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(editValues) });
    if (!r.ok) addToast('Lỗi khi lưu proxy', 'error');
    else { addToast('Đã cập nhật proxy', 'success'); setEditProxyId(null); loadData(); }
  };

  const addSlot = async (proxyId: string) => {
    const r = await fetch(`/api/d1/proxies/${proxyId}/slots`, { method: 'POST' });
    if (r.ok) { addToast('Đã thêm slot', 'success'); loadData(); } else addToast('Lỗi thêm slot', 'error');
  };

  const removeSlot = async (slotId: string, isBusy: boolean) => {
    setConfirmModal({
      title: 'Xóa Slot',
      message: isBusy ? 'Slot này ĐANG ĐƯỢC DÙNG. Ngắt kết nối và xoá?' : 'Bạn có chắc muốn xoá slot trống này?',
      onConfirm: async () => {
        const r = await fetch(`/api/d1/slots/${slotId}`, { method: 'DELETE' });
        if (r.ok) { addToast('Đã xoá slot', 'info'); loadData(); }
        setConfirmModal(null);
      }
    });
  };

  const resetSlot = async (slotId: string) => {
    setConfirmModal({
      title: 'Giải phóng Slot',
      message: 'Bạn có chắc muốn giải phóng slot này (ngắt kết nối)?',
      onConfirm: async () => {
        const r = await fetch(`/api/d1/slots/${slotId}/reset`, { method: 'POST' });
        if (r.ok) { addToast('Đã giải phóng slot', 'success'); loadData(); }
        setConfirmModal(null);
      }
    });
  };

  const unassignAccount = async (accountId: string) => {
    const r = await fetch('/api/proxy-assign/unassign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.error) addToast(d.error || 'Gỡ proxy thất bại', 'error');
    else {
      addToast('✅ Đã gỡ proxy khỏi tài khoản', 'success');
      loadData();
    }
  };

  const importBulk = async () => {
    if (!bulkRows.length) return;
    setBulkBusy(true);
    try {
      const res = await fetch('/api/d1/proxies/bulk-add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: bulkRows.map(r => ({ url: r.url, label: r.label, slotCount: r.slotCount })) })
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        addToast(`✅ Đã import thành công ${data.count}/${bulkRows.length} proxy`, 'success');
      } else {
        addToast(`❌ Import lỗi: ${data.error || 'Server error'}`, 'error');
      }
    } catch (e: any) {
      addToast(`❌ Lỗi kết nối: ${e.message}`, 'error');
    }
    setBulkBusy(false); setBulkText(''); setBulkRows([]); setBulkOpen(false);
    await loadData();
  };

  return (
    <div className="absolute inset-0 overflow-y-auto px-6 pb-10 pt-2 flex flex-col gap-5 custom-scrollbar">
      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 shrink-0">
        <StatBox icon={Globe} value={proxies.length} label="Tổng Proxies" colorClass="text-indigo-400" bgClass="bg-indigo-500/10" borderClass="border-indigo-500/30" />
        <StatBox icon={Server} value={totalSlots} label="Tổng Slots" colorClass="text-cyan-400" bgClass="bg-cyan-500/10" borderClass="border-cyan-500/30" />
        <StatBox icon={Activity} value={busySlots} label="Slots Đang Dùng" colorClass="text-amber-400" bgClass="bg-amber-500/10" borderClass="border-amber-500/30" />
        <StatBox icon={Check} value={freeSlots} label="Slots Trống" colorClass="text-emerald-400" bgClass="bg-emerald-500/10" borderClass="border-emerald-500/30" />
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

      {/* Add / Bulk */}
      <Card>
        <CardHeader>
          <CardTitle><Plus size={14} className="text-indigo-400" /> Thêm Proxy</CardTitle>
          <Button variant={bulkOpen ? 'primary' : 'ghost'} size="sm" onClick={() => setBulkOpen(v => !v)} className="ml-auto">
            <Upload size={12} /> Import hàng loạt {bulkOpen ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
          </Button>
        </CardHeader>
        <CardContent>
          {!bulkOpen ? (
            <div className="flex gap-3 flex-wrap items-center">
              <Input className="flex-[3_1_200px]" placeholder="Proxy URL (http://...)" value={newUrl} onChange={e => setNewUrl(e.target.value)} onKeyDown={e => e.key === 'Enter' && addProxy()} />
              <Input className="flex-[2_1_140px]" placeholder="Label (VPS, Router...)" value={newLabel} onChange={e => setNewLabel(e.target.value)} />
              <Input type="number" className="w-20 shrink-0" placeholder="Slots" value={newCount} onChange={e => setNewCount(e.target.value)} />
              <Button variant="primary" disabled={adding || !newUrl} onClick={addProxy} className="shrink-0">
                {adding ? <span className="w-3 h-3 border-2 border-white/20 border-t-white rounded-full animate-spin" /> : <Plus size={14} />} Thêm
              </Button>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="p-3 bg-white/5 border border-white/10 rounded-lg text-xs text-slate-400 leading-relaxed">
                <strong className="text-slate-200">Định dạng:</strong>{' '}
                <code className="text-cyan-400 bg-cyan-500/10 px-1 rounded">url:label:slots</code>{' '}
                hoặc <code className="text-cyan-400 bg-cyan-500/10 px-1 rounded">host:port:user:pass:label:slots</code>
              </div>
              <textarea className="w-full bg-black/40 border border-white/10 rounded-md p-3 text-[11px] font-mono text-slate-300 resize-y focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/20" rows={5}
                placeholder={`http://user:pass@12.34.56.78:8080:VPS_US:4\n64.118.143.179:10000:usrx5B2c:passSGgM2:Router:2`}
                value={bulkText} onChange={e => { setBulkText(e.target.value); setBulkRows(parseBulkProxies(e.target.value)); }}
              />
              <div className="flex items-center justify-between gap-3 text-xs">
                <span className={bulkRows.length ? 'text-emerald-400 font-medium' : 'text-slate-500'}>
                  {bulkRows.length ? `✅ ${bulkRows.length} proxy hợp lệ` : 'Dán danh sách vào ô trên…'}
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
        </CardContent>
      </Card>

      {/* Table */}
      <Card className="!overflow-visible">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <button onClick={toggleAll} title="Chọn tất cả trên trang này" className="text-slate-500 hover:text-slate-200 transition-colors mr-1">
              {paginated.length > 0 && paginated.every(i => selected.has(i.id)) ? (
                <CheckSquare size={16} className="text-indigo-400" />
              ) : (
                <Square size={16} />
              )}
            </button>
            <Globe size={14} className="text-indigo-400" />
            Proxy Pool
            <span className="ml-2 px-2 py-0.5 rounded-full text-[10px] bg-indigo-500/20 text-indigo-400 font-bold">{filtered.length}</span>
          </CardTitle>
          <div className="flex gap-2 items-center ml-auto">
            {selected.size > 0 && (
              <>
                <Button variant="danger" size="sm" onClick={deleteSelected}>
                  <Trash2 size={12} /> Xóa ({selected.size})
                </Button>
                <Button variant="secondary" size="sm" onClick={() => testSelected()} disabled={testingAll} className="text-indigo-400 border-indigo-500/30 hover:bg-indigo-500/10">
                  {testingAll ? <span className="w-3 h-3 border-2 border-indigo-400/30 border-t-indigo-400 rounded-full animate-spin" /> : <Activity size={12} />}
                  Test ({selected.size})
                </Button>
              </>
            )}
            <Button variant="secondary" size="sm" onClick={() => testSelected(new Set(filtered.map(p => p.id)))} disabled={testingAll || !filtered.length} className="text-indigo-400 border-indigo-500/30 hover:bg-indigo-500/10">
              <Activity size={12} /> Test All ({filtered.length})
            </Button>
            <select
              value={sortBy}
              onChange={e => setSortBy(e.target.value as 'label-asc' | 'recent')}
              className="bg-white/5 border border-white/10 text-slate-200 text-xs rounded-md px-2 py-1.5 focus:outline-none focus:border-indigo-500/50 cursor-pointer h-8"
            >
              <option value="label-asc" className="bg-[#0b0f19] text-slate-200">Sắp xếp: P1 → PN</option>
              <option value="recent" className="bg-[#0b0f19] text-slate-200">Sắp xếp: Gần đây</option>
            </select>
            <div className="relative flex items-center">
              <Search size={13} className="absolute left-2.5 text-slate-500 pointer-events-none" />
              <Input className="pl-7 h-8 w-[180px] text-xs bg-white/5 border-white/10" placeholder="Tìm proxy…" value={search} onChange={e => setSearch(e.target.value)} />
              {search && <button onClick={() => setSearch('')} className="absolute right-2 text-slate-500 hover:text-slate-300"><X size={11} /></button>}
            </div>
            <Button variant="secondary" size="icon-sm" onClick={loadData} disabled={loading} className="border-white/10 bg-white/5">
              <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
            </Button>
          </div>
        </CardHeader>

        {error && <div className="mx-5 mt-4 flex items-center gap-2 p-3 bg-rose-500/10 text-rose-400 rounded-lg text-[13px] border border-rose-500/30"><AlertCircle size={14} /> {error}</div>}

        <CardContent className="flex flex-col gap-3">
          {filtered.length === 0 && !loading && (
            <div className="py-10 text-center text-[13px] text-slate-500">{search ? `Không tìm thấy "${search}"` : 'Chưa có proxy nào'}</div>
          )}
          {paginated.map(p => {
            const pSlots = (slotsByProxyId.get(p.id) || []).sort((a, b) => a.slot_index - b.slot_index);
            const busyCount = pSlots.filter(s => s.connection_id).length;
            const listById = bindingsByProxy.byId.get(p.id) || [];
            const listByUrl = bindingsByProxy.byUrl.get(p.url) || [];
            const combined = [...listById];
            for (const b of listByUrl) {
              if (!combined.some(x => x.account_id === b.account_id)) {
                combined.push(b);
              }
            }
            const proxyBindings = combined.sort((a, b) => (a.email || '').localeCompare(b.email || ''));
            const isEditing = editProxyId === p.id;
            return (
              <div key={p.id} className={`p-4 rounded-xl border transition-colors ${isEditing ? 'bg-indigo-500/5 border-indigo-500/30' : 'bg-white/[0.02] border-white/5 hover:border-white/10'} flex gap-3 items-start`}>
                <button onClick={() => toggleSelect(p.id)} className="text-slate-500 hover:text-slate-200 mt-1 shrink-0">
                  {selected.has(p.id) ? <CheckSquare size={15} className="text-indigo-400" /> : <Square size={15} />}
                </button>
                <div className="flex-1 min-w-0">
                  <div className="flex justify-between items-start mb-3">
                    <div className="flex-1 min-w-0 mr-4">
                      {isEditing ? (
                        <div className="flex gap-2 mb-2">
                          <Input className="flex-[2] h-8 text-xs font-mono" value={editValues.url} onChange={e => setEditValues(v => ({ ...v, url: e.target.value }))} autoFocus />
                          <Input className="flex-1 h-8 text-xs" value={editValues.label} onChange={e => setEditValues(v => ({ ...v, label: e.target.value }))} placeholder="Label..." />
                        </div>
                      ) : (
                        <>
                          {p.label && (
                            <div className="flex items-center gap-1.5 mb-1.5">
                              <span className="px-2.5 py-0.5 bg-indigo-500/10 border border-indigo-500/25 text-indigo-400 text-[11px] font-bold rounded">
                                {p.label}
                              </span>
                            </div>
                          )}
                          <div className="font-mono text-[12px] font-semibold text-slate-300 break-all">{p.url}</div>
                          <div className="text-[11px] text-slate-500 mt-1.5 flex items-center gap-2 flex-wrap">
                            <span>Nguồn: {p.source}</span>
                            <span>•</span>
                            <span className="flex items-center gap-1">
                              <Activity size={10} className={p.last_latency_ms ? (p.last_latency_ms < 500 ? 'text-emerald-400' : 'text-amber-400') : 'text-slate-500'} />
                              Ping: {p.last_latency_ms || '?'}ms
                            </span>
                            <span className="flex items-center gap-1">
                              <Server size={10} className="text-slate-400" />
                              {busyCount}/{pSlots.length} slots
                            </span>
                          </div>
                        </>
                      )}
                    </div>
                    <div className="flex gap-1.5 shrink-0">
                      {isEditing ? (
                        <>
                          <Button variant="ghost" size="icon-sm" title="Hủy" onClick={() => setEditProxyId(null)}><X size={14} /></Button>
                          <Button variant="success" size="icon-sm" title="Lưu" onClick={saveEdit}><Save size={14} /></Button>
                        </>
                      ) : (
                        <>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            title="Kiểm tra kết nối"
                            disabled={testingIds.has(p.id)}
                            onClick={async () => {
                              setTestingIds(prev => { const n = new Set(prev); n.add(p.id); return n; });
                              try {
                                const res = await fetch(`/api/vault/proxies/${p.id}/test`, { method: 'POST' });
                                const data = await res.json();
                                if (data.ok && data.status === 'active') {
                                  addToast(`✅ Hoạt động: ${data.latency}ms`, 'success');
                                  setProxies(prev => prev.map(x => x.id === p.id ? { ...x, last_latency_ms: data.latency } : x));
                                } else {
                                  addToast(`❌ Lỗi: ${data.error || 'không thể kết nối'}`, 'error');
                                  setProxies(prev => prev.map(x => x.id === p.id ? { ...x, last_latency_ms: undefined } : x));
                                }
                              } catch (e: any) {
                                addToast(e.message, 'error');
                              }
                              setTestingIds(prev => { const n = new Set(prev); n.delete(p.id); return n; });
                            }}
                          >
                            <Activity size={14} className={testingIds.has(p.id) ? 'animate-pulse text-indigo-400' : 'text-slate-400'} />
                          </Button>
                          <Button variant="ghost" size="icon-sm" title="Chỉnh sửa" onClick={() => { setEditProxyId(p.id); setEditValues({ url: p.url, label: p.label || '' }); }}>
                            <Edit2 size={14} />
                          </Button>
                          <Button variant="danger" size="icon-sm" title="Xóa Proxy" onClick={() => deleteProxy(p.id)}>
                            <Trash2 size={14} />
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1.5 items-center">
                    {pSlots.map(s => {
                      const isBusy = !!s.connection_id;
                      const owner = combined.find(b => b.account_id === s.connection_id);
                      return (
                        <div
                          key={s.id}
                          title={isBusy ? `Đang dùng bởi ${owner?.email || s.connection_id}\n\n• Click: Giải phóng\n• Alt+Click: Xóa slot` : 'Trống • Click: Xóa slot'}
                          onClick={e => { if (isBusy && !e.altKey) resetSlot(s.id); else removeSlot(s.id, isBusy); }}
                          className={`w-7 h-7 rounded-md flex items-center justify-center text-[10px] font-bold cursor-pointer border transition-all ${isBusy ? 'bg-cyan-500/10 text-cyan-400 border-cyan-500/30 hover:border-cyan-400 shadow-[0_0_8px_rgba(34,211,238,0.15)]' : 'bg-white/5 text-slate-500 border-white/5 hover:border-white/20'}`}
                        >
                          {s.slot_index}
                        </div>
                      );
                    })}
                    <button onClick={() => addSlot(p.id)} title="Thêm slot"
                      className="w-7 h-7 rounded-md flex items-center justify-center text-slate-500 hover:text-indigo-400 border border-dashed border-white/10 hover:border-indigo-500/50 transition-all">
                      <Plus size={12} />
                    </button>
                  </div>
                  <div className="mt-3 pt-3 border-t border-white/5">
                    <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-2">Assigned Accounts ({proxyBindings.length})</div>
                    {!proxyBindings.length ? (
                      <div className="text-[11px] text-slate-500 italic">Chưa có tài khoản gán vào proxy này.</div>
                    ) : (
                      <div className="flex flex-wrap gap-1.5">
                        {proxyBindings.map(b => (
                          <div key={`${p.id}-${b.account_id}`} className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-cyan-500/10 border border-cyan-500/20">
                            <span className="text-[10px] font-semibold text-cyan-300">{b.email || b.account_id}</span>
                            {b.slot_index !== null && b.slot_index !== undefined && (
                              <span className="text-[10px] text-slate-400">slot {b.slot_index}</span>
                            )}
                            <button
                              onClick={() => unassignAccount(b.account_id)}
                              className="text-amber-400 hover:text-amber-300"
                              title="Gỡ proxy khỏi tài khoản này"
                            >
                              <X size={11} />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}

          {/* Pagination Controls */}
          {filtered.length > 0 && (
            <div className="flex flex-col sm:flex-row gap-3 items-center justify-between mt-4 pt-4 border-t border-white/5 text-xs text-slate-400">
              <div className="flex items-center gap-3">
                <span>
                  Hiển thị {(currentPage - 1) * pageSize + 1} - {Math.min(currentPage * pageSize, filtered.length)} trên tổng số {filtered.length} proxy
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
                <div className="flex gap-1.5">
                  <Button variant="ghost" size="sm" disabled={currentPage === 1} onClick={() => setCurrentPage(1)}>Trang đầu</Button>
                  <Button variant="ghost" size="sm" disabled={currentPage === 1} onClick={() => setCurrentPage(p => Math.max(1, p - 1))}>Trước</Button>
                  <span className="px-3 py-1.5 bg-white/5 rounded border border-white/10 font-medium">Trang {currentPage} / {totalPages}</span>
                  <Button variant="ghost" size="sm" disabled={currentPage === totalPages} onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}>Sau</Button>
                  <Button variant="ghost" size="sm" disabled={currentPage === totalPages} onClick={() => setCurrentPage(totalPages)}>Trang cuối</Button>
                </div>
              )}
            </div>
          )}
        </CardContent>
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
