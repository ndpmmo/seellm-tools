'use client';
import React, { useCallback, useEffect, useState } from 'react';
import {
  Plus, Search, RefreshCw, Pencil, Trash2, Save, X, 
  AlertCircle, ChevronDown, ChevronUp, Users, Tag, 
  Database, Shield, Globe, Key, FileText, Layout
} from 'lucide-react';
import { useApp } from '../../AppContext';

/* ── Helpers ── */
function StatusBadge({ status }: { status: string }) {
  const m: Record<string, { color: string; bg: string; label: string }> = {
    ready:   { color: 'var(--green)', bg: 'var(--green-dim)', label: 'Ready' },
    idle:    { color: 'var(--text-3)', bg: 'var(--glass)', label: 'Idle' },
    error:   { color: 'var(--rose)',  bg: 'var(--rose-dim)',  label: 'Error' },
  };
  const s = m[status] || { color: 'var(--text-3)', bg: 'var(--glass)', label: status };
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 10px', borderRadius: 99, fontSize: 11, fontWeight: 600, background: s.bg, color: s.color, border: `1px solid ${s.color}25` }}>
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'currentColor' }} />
      {s.label}
    </span>
  );
}

const PROVIDERS = [
  { id: 'openai',   name: 'OpenAI',   color: '#10a37f' },
  { id: 'anthropic', name: 'Anthropic', color: '#da7756' },
  { id: 'gemini',    name: 'Gemini',    color: '#1a73e8' },
  { id: 'cursor',    name: 'Cursor',    color: '#ffffff' },
  { id: 'codex',     name: 'Codex',     color: '#6366f1' },
];

/* ══════════════════════════════════════════════════════════ */
export function VaultAccountsView() {
  const { addToast } = useApp();
  const [items, setItems]     = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  const [search, setSearch]   = useState('');
  const [providerFilter, setProviderFilter] = useState('all');

  const [uiState, setUiState] = useState({
    isAdding: false,
    editId: null as string | null,
    provider: 'openai',
    label: '',
    email: '',
    password: '',
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
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const filtered = items.filter(it => (providerFilter === 'all' || it.provider === providerFilter) && (!search || it.email.toLowerCase().includes(search.toLowerCase()) || it.label?.toLowerCase().includes(search.toLowerCase())));

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
          password: uiState.password === '********' ? undefined : uiState.password,
          proxy_url: uiState.proxy,
          notes: uiState.notes,
          tags: uiState.tags,
        })
      });
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      addToast(uiState.editId ? '✅ Đã cập nhật' : '✅ Đã thêm vào Vault', 'success');
      setUiState(s => ({ ...s, isAdding: false, editId: null, email: '', password: '', label: '', notes: '', tags: [] }));
      load();
    } catch (e: any) { addToast(e.message, 'error'); }
  };

  const del = async (id: string) => {
    if (!confirm('Xóa tài khoản này khỏi Vault?')) return;
    await fetch(`/api/vault/accounts/${id}`, { method: 'DELETE' });
    addToast('Đã xoá', 'info');
    load();
  };

  const startEdit = (it: any) => {
    setUiState({
      isAdding: true,
      editId: it.id,
      provider: it.provider,
      label: it.label || '',
      email: it.email || '',
      password: '********',
      proxy: it.proxy_url || '',
      tags: it.tags || [],
      notes: it.notes || '',
    });
  };

  return (
    <div className="content">
      
      {/* ═══ ACTIONS ═══ */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
        <div style={{ flex: 1, position: 'relative', display: 'flex', alignItems: 'center' }}>
          <Search size={15} style={{ position: 'absolute', left: 14, color: 'var(--text-3)' }} />
          <input className="inp" style={{ paddingLeft: 42 }} placeholder="Tìm trong Vault (Email, Label...)" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <button className="btn btn-primary" onClick={() => setUiState(s => ({ ...s, isAdding: !s.isAdding, editId: null, email: '', password: '', label: '' }))} style={{ height: 46, padding: '0 24px' }}>
          {uiState.isAdding ? <X size={18} /> : <Plus size={18} />} 
          <span style={{ marginLeft: 8 }}>{uiState.isAdding ? 'Hủy bỏ' : 'Thêm Tài Khoản'}</span>
        </button>
      </div>

      {/* ═══ FORM ═══ */}
      {uiState.isAdding && (
        <div className="card" style={{ marginBottom: 20, animation: 'slideDown .3s ease' }}>
          <div className="card-head">
            <span className="card-title">{uiState.editId ? <Pencil size={14} /> : <Plus size={14} />} {uiState.editId ? 'Chỉnh sửa tài khoản' : 'Thêm tài khoản mới vào Vault'}</span>
          </div>
          <div className="card-body" style={{ padding: '20px 24px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }}>
              <div className="form-group">
                <label className="label">Nhà cung cấp (Provider)</label>
                <select className="inp" value={uiState.provider} onChange={e => setUiState(s => ({ ...s, provider: e.target.value }))}>
                  {PROVIDERS.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
              <div className="form-group">
                <label className="label">Tên gợi nhớ (Label)</label>
                <input className="inp" placeholder="Ví dụ: Acc chính, VPS 1..." value={uiState.label} onChange={e => setUiState(s => ({ ...s, label: e.target.value }))} />
              </div>
              <div className="form-group">
                <label className="label">Email / Username</label>
                <input className="inp" placeholder="email@example.com" value={uiState.email} onChange={e => setUiState(s => ({ ...s, email: e.target.value }))} />
              </div>
              <div className="form-group">
                <label className="label">Mật khẩu</label>
                <input className="inp" type="password" placeholder="••••••••" value={uiState.password} onChange={e => setUiState(s => ({ ...s, password: e.target.value }))} />
              </div>
              <div className="form-group">
                <label className="label">Proxy URL (Tùy chọn)</label>
                <input className="inp" placeholder="http://user:pass@host:port" value={uiState.proxy} onChange={e => setUiState(s => ({ ...s, proxy: e.target.value }))} />
              </div>
              <div className="form-group" style={{ display: 'flex', alignItems: 'flex-end' }}>
                <button className="btn btn-primary" onClick={save} style={{ width: '100%', height: 42 }}>
                  <Save size={16} /> <span style={{ marginLeft: 8 }}>Lưu vào Vault</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ═══ TABLE ═══ */}
      <div className="card">
        <div className="card-head">
          <span className="card-title"><Shield size={14} color="var(--indigo-2)" /> Tài Khoản Vault <span className="nav-badge b">{filtered.length}</span></span>
          <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
            <button key="all" className={`btn btn-sm ${providerFilter === 'all' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setProviderFilter('all')}>All</button>
            {PROVIDERS.map(p => (
              <button key={p.id} className={`btn btn-sm ${providerFilter === p.id ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setProviderFilter(p.id)}>{p.name}</button>
            ))}
            <button className="btn-icon" onClick={load}><RefreshCw size={13} style={{ animation: loading ? 'rotate .6s linear infinite' : 'none' }} /></button>
          </div>
        </div>

        <div className="card-body" style={{ padding: 0 }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
              <thead>
                <tr style={{ background: 'var(--glass)', borderBottom: '1px solid var(--border)' }}>
                  <th style={{ padding: '12px 20px', fontSize: 11, fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase' }}>Tài khoản / Label</th>
                  <th style={{ padding: '12px 20px', fontSize: 11, fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase' }}>Provider</th>
                  <th style={{ padding: '12px 20px', fontSize: 11, fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase' }}>Status</th>
                  <th style={{ padding: '12px 20px', fontSize: 11, fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase' }}>Exported</th>
                  <th style={{ padding: '12px 20px', fontSize: 11, fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', textAlign: 'right' }}>Thao tác</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(it => (
                  <tr key={it.id} style={{ borderBottom: '1px solid var(--border)', transition: 'background .15s' }}
                      onMouseEnter={e => e.currentTarget.style.background = 'var(--glass)'}
                      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                    <td style={{ padding: '14px 20px' }}>
                      <div style={{ fontWeight: 600, color: 'var(--text)' }}>{it.email || 'No email'}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2, display: 'flex', alignItems: 'center', gap: 6 }}>
                        {it.label && <span style={{ color: 'var(--indigo-2)' }}>{it.label}</span>}
                        {it.proxy_url && <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}><Globe size={10} /> {it.proxy_url}</span>}
                      </div>
                    </td>
                    <td style={{ padding: '14px 20px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <div style={{ width: 8, height: 8, borderRadius: '50%', background: PROVIDERS.find(p => p.id === it.provider)?.color || '#999' }} />
                        <span style={{ fontSize: 13, textTransform: 'capitalize' }}>{it.provider}</span>
                      </div>
                    </td>
                    <td style={{ padding: '14px 20px' }}><StatusBadge status={it.status} /></td>
                    <td style={{ padding: '14px 20px' }}>
                      {it.exported_to ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--green)' }}>
                          <Database size={10} /> {it.exported_to.toUpperCase()}
                        </div>
                      ) : <span style={{ color: 'var(--text-4)', fontSize: 11 }}>Chưa export</span>}
                    </td>
                    <td style={{ padding: '14px 20px', textAlign: 'right' }}>
                      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                        <button className="btn-icon" title="Sửa" onClick={() => startEdit(it)}><Pencil size={13} /></button>
                        <button className="btn-icon danger" title="Xóa" onClick={() => del(it.id)}><Trash2 size={13} /></button>
                      </div>
                    </td>
                  </tr>
                ))}
                {filtered.length === 0 && !loading && (
                  <tr><td colSpan={5} style={{ padding: 60, textAlign: 'center', color: 'var(--text-3)' }}>Vault trống hoặc không khớp từ khóa tìm kiếm.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
