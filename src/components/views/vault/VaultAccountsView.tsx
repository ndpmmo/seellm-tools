'use client';
import React, { useCallback, useEffect, useState } from 'react';
import {
  Plus, Search, RefreshCw, Pencil, Trash2, Save, X, 
  AlertCircle, ChevronDown, ChevronUp, Users, Tag, 
  Database, Shield, Globe, Key, FileText, Layout, CopyPlus, FileUp, RotateCcw
} from 'lucide-react';
import { useApp } from '../../AppContext';

/* ── Helpers ── */
function StatusBadge({ status }: { status: string }) {
  const m: Record<string, { color: string; bg: string; label: string }> = {
    ready:      { color: 'var(--green)',   bg: 'var(--green-dim)',  label: 'Ready' },
    idle:       { color: 'var(--text-3)', bg: 'var(--glass)',      label: 'Idle' },
    error:      { color: 'var(--rose)',   bg: 'var(--rose-dim)',   label: 'Error' },
    pending:    { color: '#f59e0b',       bg: '#f59e0b20',         label: 'Pending' },
    processing: { color: '#6366f1',       bg: '#6366f120',         label: 'Processing' },
  };
  const s = m[status] || { color: 'var(--text-3)', bg: 'var(--glass)', label: status };
  const isPulsing = status === 'pending' || status === 'processing';
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 10px', borderRadius: 99, fontSize: 11, fontWeight: 600, background: s.bg, color: s.color, border: `1px solid ${s.color}25` }}>
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'currentColor', animation: isPulsing ? 'pulse 1.2s ease-in-out infinite' : 'none' }} />
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
          two_fa_secret: uiState.twoFaSecret,
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
      const r = await fetch(`http://localhost:4000/api/vault/accounts/${id}/sync`, { method: 'POST' });
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      addToast(`☁️ Đã ép đồng bộ ${email} lên D1 thành công`, 'success');
      load();
    } catch (e: any) { addToast(e.message, 'error'); }
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
      password: '********',
      twoFaSecret: it.two_fa_secret || '',
      proxy: it.proxy_url || '',
      tags: it.tags || [],
      notes: it.notes || '',
    }));
  };

  return (
    <div className="content">
      
      {/* ═══ ACTIONS ═══ */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
        <div style={{ flex: 1, position: 'relative', display: 'flex', alignItems: 'center' }}>
          <Search size={15} style={{ position: 'absolute', left: 14, color: 'var(--text-3)' }} />
          <input className="inp" style={{ paddingLeft: 42 }} placeholder="Tìm trong Vault (Email, Label...)" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-ghost" onClick={() => setUiState(s => ({ ...s, isBulk: !s.isBulk, isAdding: false, editId: null }))} style={{ height: 46 }}>
             {uiState.isBulk ? <X size={18} /> : <FileUp size={18} />} 
             <span style={{ marginLeft: 8 }}>Nhập hàng loạt</span>
          </button>
          <button className="btn btn-primary" onClick={() => setUiState(s => ({ ...s, isAdding: !s.isAdding, isBulk: false, editId: null, email: '', password: '', twoFaSecret: '', label: '' }))} style={{ height: 46, padding: '0 24px' }}>
            {uiState.isAdding ? <X size={18} /> : <Plus size={18} />} 
            <span style={{ marginLeft: 8 }}>{uiState.isAdding ? 'Hủy bỏ' : 'Thêm Tài Khoản'}</span>
          </button>
        </div>
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
                <label className="label">Hai yếu tố (2FA Secret)</label>
                <input className="inp" placeholder="Mã bí mật 2FA (Tùy chọn)" value={uiState.twoFaSecret} onChange={e => setUiState(s => ({ ...s, twoFaSecret: e.target.value }))} />
              </div>
              <div className="form-group">
                <label className="label">Proxy URL (Tùy chọn)</label>
                <input className="inp" placeholder="http://user:pass@host:port" value={uiState.proxy} onChange={e => setUiState(s => ({ ...s, proxy: e.target.value }))} />
              </div>
              <div className="form-group" style={{ display: 'flex', alignItems: 'flex-end', gridColumn: 'span 2' }}>
                <button className="btn btn-primary" onClick={save} style={{ width: '100%', height: 42 }}>
                  <Save size={16} /> <span style={{ marginLeft: 8 }}>Lưu vào Vault</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ═══ BULK FORM ═══ */}
      {uiState.isBulk && (
        <div className="card" style={{ marginBottom: 20, animation: 'slideDown .3s ease' }}>
          <div className="card-head">
            <span className="card-title"><CopyPlus size={14} /> Nhập tài khoản hàng loạt</span>
          </div>
          <div className="card-body" style={{ padding: '20px 24px' }}>
            <div className="form-group" style={{ marginBottom: 15 }}>
               <label className="label">Nhà cung cấp (Provider) cho danh sách này</label>
               <select className="inp" style={{ maxWidth: 200 }} value={uiState.provider} onChange={e => setUiState(s => ({ ...s, provider: e.target.value }))}>
                  {PROVIDERS.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
               </select>
            </div>
            <div className="form-group">
               <label className="label">Danh sách tài khoản (Định dạng: email|pass hoặc email|pass|2fa)</label>
               <textarea className="inp mono" rows={8} 
                 placeholder="user1@gmail.com|pass123&#10;user2@gmail.com|pass456|2FASECRETXXX..." 
                 value={uiState.bulkText} onChange={e => setUiState(s => ({ ...s, bulkText: e.target.value }))}
               />
            </div>
            <div style={{ marginTop: 15, display: 'flex', justifyContent: 'flex-end' }}>
               <button className="btn btn-primary" onClick={bulkSave} disabled={loading}>
                 <Save size={16} /> {loading ? 'Đang xử lý...' : 'Bắt đầu nhập vào Vault'}
               </button>
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
                        {it.status === 'idle' && it.provider === 'codex' && (
                          <button className="btn btn-sm" title="Deploy to Codex" onClick={() => retry(it.id, it.email)} style={{ color: 'var(--green)', borderColor: 'var(--green)', padding: '0 8px' }}><Globe size={12} style={{marginRight: 4}}/> Deploy</button>
                        )}
                        {(it.status !== 'idle') && it.provider === 'codex' && (
                          <button className="btn btn-sm" title="Thu hồi về kho lạnh" onClick={() => stopAccount(it.id, it.email)} style={{ color: 'var(--text-3)', padding: '0 8px' }}>Thu hồi</button>
                        )}
                        {(it.status === 'error') && it.provider === 'codex' && (
                          <button className="btn-icon" title="Thử login lại" onClick={() => retry(it.id, it.email)}><RotateCcw size={13} /></button>
                        )}
                        <button className="btn-icon" title="Đẩy lên D1" onClick={() => syncNow(it.id, it.email)} style={{ color: 'var(--indigo-2)' }}><Database size={13} /></button>
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
