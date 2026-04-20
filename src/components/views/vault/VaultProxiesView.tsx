'use client';
import React, { useCallback, useEffect, useState } from 'react';
import {
  Plus, Search, RefreshCw, Pencil, Trash2, Save, X, 
  MapPin, Globe, Clock, Activity, Shield, Info
} from 'lucide-react';
import { useApp } from '../../AppContext';
import { fmtDateTimeVN } from '../../Views';
import { Button, Card, CardHeader, CardTitle, CardContent, Input } from '../../ui';

export function VaultProxiesView() {
  const { addToast } = useApp();
  const [items, setItems]     = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch]   = useState('');
  
  const [uiState, setUiState] = useState({
    isAdding: false,
    editId: null as string | null,
    label: '',
    url: '',
    type: 'http',
    country: '',
    notes: '',
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/vault/proxies');
      const d = await r.json();
      setItems(d.items || []);
    } catch (e: any) { addToast(e.message, 'error'); }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const save = async () => {
    if (!uiState.url) return;
    try {
      const r = await fetch('/api/vault/proxies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: uiState.editId,
          label: uiState.label,
          url: uiState.url,
          type: uiState.type,
          country: uiState.country,
          notes: uiState.notes,
        })
      });
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      addToast('✅ Đã lưu proxy', 'success');
      setUiState(s => ({ ...s, isAdding: false, editId: null, label: '', url: '', country: '', notes: '' }));
      load();
    } catch (e: any) { addToast(e.message, 'error'); }
  };

  const del = async (id: string) => {
    if (!confirm('Xóa proxy này?')) return;
    await fetch(`/api/vault/proxies/${id}`, { method: 'DELETE' });
    load();
  };

  const filtered = items.filter(it => !search || it.label?.toLowerCase().includes(search.toLowerCase()) || it.url.toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="absolute inset-0 overflow-y-auto px-6 pb-10 pt-2 flex flex-col gap-5 custom-scrollbar">
      <div className="flex gap-3 mb-6 mt-2 relative z-10">
        <div className="flex-1 relative flex items-center">
          <Search size={15} className="absolute left-3 text-slate-500" />
          <Input className="pl-9 bg-white/5 border border-white/10" placeholder="Tìm proxy cá nhân..." value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <Button variant="primary" onClick={() => setUiState(s => ({ ...s, isAdding: !s.isAdding, editId: null, label: '', url: '' }))} className="px-6">
          {uiState.isAdding ? <X size={16} /> : <Plus size={16} />} <span className="ml-2">{uiState.isAdding ? 'Hủy bỏ' : 'Thêm Proxy'}</span>
        </Button>
      </div>

      {uiState.isAdding && (
        <Card className="mb-6 animate-slideDown">
          <CardContent className="p-5">
            <div className="grid grid-cols-4 gap-4">
               <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1.5">Label</label>
                <Input placeholder="My Proxy 1" value={uiState.label} onChange={e => setUiState(s => ({ ...s, label: e.target.value }))} />
              </div>
              <div className="col-span-2">
                <label className="block text-xs font-semibold text-slate-400 mb-1.5">Proxy URL (protocol://user:pass@host:port)</label>
                <Input placeholder="http://1.2.3.4:8080" value={uiState.url} onChange={e => setUiState(s => ({ ...s, url: e.target.value }))} />
              </div>
              <div className="flex items-end">
                <Button variant="primary" className="w-full py-2.5" onClick={save}>Lưu Proxy</Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>
            <Globe size={14} className="text-indigo-400" /> Danh sách Proxy VAULT
            <span className="ml-2 px-2 py-0.5 rounded-full text-[10px] bg-indigo-500/20 text-indigo-400 font-bold">{filtered.length}</span>
          </CardTitle>
          <Button size="icon-sm" variant="ghost" onClick={load} className="ml-auto">
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          </Button>
        </CardHeader>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="bg-white/5 border-b border-white/5">
                <th className="px-5 py-3 text-[11px] font-bold text-slate-400 uppercase tracking-wider">LABEL / PROXY</th>
                <th className="px-5 py-3 text-[11px] font-bold text-slate-400 uppercase tracking-wider">LOCATION</th>
                <th className="px-5 py-3 text-[11px] font-bold text-slate-400 uppercase tracking-wider">TYPE</th>
                <th className="px-5 py-3 text-[11px] font-bold text-slate-400 uppercase tracking-wider text-right">ACTIONS</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {filtered.map(it => (
                <tr key={it.id} className="hover:bg-white/[0.02] transition-colors group">
                  <td className="px-5 py-4">
                    <div className="font-semibold text-[13px] text-slate-200">{it.label || '—'}</div>
                    <div className="text-[11px] text-slate-400 font-mono mt-1">{it.url}</div>
                  </td>
                  <td className="px-5 py-4">
                    <div className="flex items-center gap-1.5 text-[12.5px] text-slate-300">
                      <MapPin size={12} className="text-indigo-400" /> {it.country || 'Unknown'}
                    </div>
                  </td>
                  <td className="px-5 py-4">
                    <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-bold tracking-wider bg-slate-500/10 text-slate-400 border border-slate-500/20">
                      {it.type.toUpperCase()}
                    </span>
                  </td>
                  <td className="px-5 py-4 text-slate-400 text-[11px] whitespace-nowrap align-middle">{fmtDateTimeVN(it.createdAt)}</td>
                  <td className="px-5 py-4 text-right align-middle">
                    <Button variant="danger" size="icon-sm" onClick={() => del(it.id)}>
                      <Trash2 size={13} />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {filtered.length === 0 && !loading && (
            <div className="p-10 text-center text-[13px] text-slate-400">Chưa có proxy nào trong Vault.</div>
          )}
        </div>
      </Card>
    </div>
  );
}
