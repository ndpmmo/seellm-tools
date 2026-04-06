'use client';
import React, { useCallback, useEffect, useState } from 'react';
import {
  Plus, Search, RefreshCw, Pencil, Trash2, Save, X, 
  MapPin, Globe, Clock, Activity, Shield, Info
} from 'lucide-react';
import { useApp } from '../../AppContext';

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
    <div className="content">
      <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
        <div style={{ flex: 1, position: 'relative', display: 'flex', alignItems: 'center' }}>
          <Search size={15} style={{ position: 'absolute', left: 14, color: 'var(--text-3)' }} />
          <input className="inp" style={{ paddingLeft: 42 }} placeholder="Tìm proxy cá nhân..." value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <button className="btn btn-primary" onClick={() => setUiState(s => ({ ...s, isAdding: !s.isAdding, editId: null, label: '', url: '' }))} style={{ height: 46 }}>
          {uiState.isAdding ? <X size={18} /> : <Plus size={18} />} <span style={{ marginLeft: 8 }}>Thêm Proxy</span>
        </button>
      </div>

      {uiState.isAdding && (
        <div className="card" style={{ marginBottom: 20 }}>
          <div className="card-body" style={{ padding: 24 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 16 }}>
               <div className="form-group">
                <label className="label">Label</label>
                <input className="inp" placeholder="My Proxy 1" value={uiState.label} onChange={e => setUiState(s => ({ ...s, label: e.target.value }))} />
              </div>
              <div className="form-group" style={{ gridColumn: 'span 2' }}>
                <label className="label">Proxy URL (protocol://user:pass@host:port)</label>
                <input className="inp" placeholder="http://1.2.3.4:8080" value={uiState.url} onChange={e => setUiState(s => ({ ...s, url: e.target.value }))} />
              </div>
              <div className="form-group" style={{ display: 'flex', alignItems: 'flex-end' }}>
                 <button className="btn btn-primary" style={{ width: '100%', height: 42 }} onClick={save}>Lưu</button>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <span className="card-title"><Globe size={14} /> Danh sách Proxy VAULT <span className="nav-badge b">{filtered.length}</span></span>
          <button className="btn-icon" onClick={load}><RefreshCw size={13} style={{ animation: loading ? 'rotate .6s linear infinite' : 'none' }} /></button>
        </div>
        <div className="card-body" style={{ padding: 0 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'var(--glass)', borderBottom: '1px solid var(--border)', textAlign: 'left' }}>
                <th style={{ padding: '12px 20px', fontSize: 11, fontWeight: 700, color: 'var(--text-3)' }}>LABEL / PROXY</th>
                <th style={{ padding: '12px 20px', fontSize: 11, fontWeight: 700, color: 'var(--text-3)' }}>LOCATION</th>
                <th style={{ padding: '12px 20px', fontSize: 11, fontWeight: 700, color: 'var(--text-3)' }}>TYPE</th>
                <th style={{ padding: '12px 20px', fontSize: 11, fontWeight: 700, color: 'var(--text-3)', textAlign: 'right' }}>ACTIONS</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(it => (
                <tr key={it.id} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '14px 20px' }}>
                    <div style={{ fontWeight: 600 }}>{it.label || '—'}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-3)', fontFamily: 'monospace', marginTop: 2 }}>{it.url}</div>
                  </td>
                  <td style={{ padding: '14px 20px' }}><div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}><MapPin size={12} color="var(--indigo-2)" /> {it.country || 'Unknown'}</div></td>
                  <td style={{ padding: '14px 20px' }}><span className="nav-badge">{it.type.toUpperCase()}</span></td>
                  <td style={{ padding: '14px 20px', textAlign: 'right' }}>
                    <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                       <button className="btn-icon danger" onClick={() => del(it.id)}><Trash2 size={13} /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {filtered.length === 0 && !loading && (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-3)' }}>Chưa có proxy nào trong Vault.</div>
          )}
        </div>
      </div>
    </div>
  );
}
