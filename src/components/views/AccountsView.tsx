'use client';
import React, { useCallback, useEffect, useState } from 'react';
import {
  Plus, Upload, Search, RefreshCw,
  Copy, Check, Pencil, Trash2, RotateCcw,
  Save, X, AlertCircle, ChevronDown, ChevronUp,
  Users, CheckCircle, Clock, XCircle, Globe, Database
} from 'lucide-react';
import { useApp } from '../AppContext';

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
      style={{ background: 'none', border: 'none', cursor: 'pointer', color: ok ? 'var(--green)' : 'var(--text-3)', padding: '2px', display: 'inline-flex', transition: 'color .2s', flexShrink: 0 }}>
      {ok ? <Check size={12} /> : <Copy size={12} />}
    </button>
  );
}

/* ── Mono Cell (for pass/2fa) ── */
function MonoCell({ value }: { value?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      <code style={{ fontSize: 12, fontFamily: "'JetBrains Mono', monospace", color: value ? 'var(--text-2)' : 'var(--text-4)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 180 }}>
        {value || '—'}
      </code>
      <CopyBtn text={value} />
    </div>
  );
}

/* ── Status Badge ── */
function StatusBadge({ status }: { status: string }) {
  const m: Record<string, { color: string; bg: string; label: string }> = {
    ready:   { color: 'var(--green)', bg: 'var(--green-dim)', label: 'Ready' },
    pending: { color: 'var(--amber)', bg: 'var(--amber-dim)', label: 'Pending' },
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

/* ── Stat Card ── */
function StatCard({ icon: Icon, value, label, color, bg, active, onClick }: {
  icon: React.ElementType; value: number; label: string; color: string; bg: string; active: boolean; onClick: () => void;
}) {
  return (
    <div onClick={onClick} style={{
      minWidth: 0,
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '14px 16px', borderRadius: 12, cursor: 'pointer', transition: 'all .15s',
      background: active ? bg : 'var(--glass)',
      border: `1px solid ${active ? color + '40' : 'var(--border)'}`,
      boxShadow: active ? `0 0 20px ${color}18` : 'none',
    }}>
      <div style={{ width: 38, height: 38, borderRadius: 10, background: bg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, color }}>
        <Icon size={18} />
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 22, fontWeight: 800, color, lineHeight: 1 }}>{value}</div>
        <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 3 }}>{label}</div>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════ */
export function AccountsView() {
  const { addToast } = useApp();
  const [items, setItems]     = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  const [search, setSearch]           = useState('');
  const [statusFilter, setStatusFilter] = useState('all');

  const [newEmail, setNewEmail] = useState('');
  const [newPass, setNewPass]   = useState('');
  const [new2fa, setNew2fa]     = useState('');
  const [adding, setAdding]     = useState(false);

  const [bulkOpen, setBulkOpen]     = useState(false);
  const [bulkText, setBulkText]     = useState('');
  const [bulkRows, setBulkRows]     = useState<ReturnType<typeof parseBulk>>([]);
  const [bulkBusy, setBulkBusy]     = useState(false);

  const [editId, setEditId]       = useState<string | null>(null);
  const [editPass, setEditPass]   = useState('');
  const [edit2fa, setEdit2fa]     = useState('');
  const [editProxy, setEditProxy] = useState('');
  const [editSaving, setEditSaving] = useState(false);

  /* ── Load ── */
  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [accountsRes, connectionsRes, vaultRes] = await Promise.all([
        fetch('/api/d1/inspect/accounts?limit=500'),
        fetch('/api/d1/inspect/connections').catch(() => null as any),
        fetch('/api/vault/accounts').catch(() => null as any),
      ]);

      if (!accountsRes.ok) throw new Error(`HTTP ${accountsRes.status}`);
      const accountsData = await accountsRes.json();
      if (accountsData.error) throw new Error(accountsData.error);

      let connections: any[] = [];
      if (connectionsRes?.ok) {
        const cd = await connectionsRes.json().catch(() => ({}));
        connections = Array.isArray(cd?.items) ? cd.items : [];
      }

      let vaultAccounts: any[] = [];
      if (vaultRes?.ok) {
        const vd = await vaultRes.json().catch(() => ({}));
        vaultAccounts = Array.isArray(vd?.items) ? vd.items : [];
      }

      const connById = new Map<string, any>();
      const connByEmail = new Map<string, any>();
      for (const c of connections) {
        if (c?.id) connById.set(String(c.id), c);
        if (c?.email) connByEmail.set(String(c.email).toLowerCase(), c);
      }

      const vaultById = new Map<string, any>();
      const vaultByEmail = new Map<string, any>();
      for (const v of vaultAccounts) {
        if (v?.id) vaultById.set(String(v.id), v);
        if (v?.email) vaultByEmail.set(String(v.email).toLowerCase(), v);
      }

      const merged = (accountsData.items || []).map((a: any) => {
        const byIdConn = a?.id ? connById.get(String(a.id)) : null;
        const byEmailConn = a?.email ? connByEmail.get(String(a.email).toLowerCase()) : null;
        const conn = byIdConn || byEmailConn || null;

        const byIdVault = a?.id ? vaultById.get(String(a.id)) : null;
        const byEmailVault = a?.email ? vaultByEmail.get(String(a.email).toLowerCase()) : null;
        const local = byIdVault || byEmailVault || null;

        return {
          ...a,
          discovered_limit: a.discovered_limit ?? conn?.discovered_limit ?? null,
          current_tokens_in: a.current_tokens_in ?? conn?.current_tokens_in ?? 0,
          current_tokens_out: a.current_tokens_out ?? conn?.current_tokens_out ?? 0,
          quotas_json: a.quotas_json ?? conn?.quotas_json ?? null,
          quota_json: a.quota_json ?? local?.quota_json ?? null,
        };
      });

      setItems(merged);
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const cnt = { total: items.length, ready: items.filter(i => i.status === 'ready').length, pending: items.filter(i => i.status === 'pending').length, error: items.filter(i => i.status === 'error').length };

  const filtered = items.filter(it => (statusFilter === 'all' || it.status === statusFilter) && (!search || it.email.toLowerCase().includes(search.toLowerCase())));

  /* ── API ── */
  const post = async (url: string, b: object) => (await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).json();
  const patch = async (url: string, b: object) => (await fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).json();

  const add = async () => { if (!newEmail) return; setAdding(true); const d = await post('/api/d1/accounts/add', { email: newEmail, password: newPass, twoFaSecret: new2fa }); if (d.error) addToast(d.error, 'error'); else { addToast('✅ Đã thêm', 'success'); setNewEmail(''); setNewPass(''); setNew2fa(''); load(); } setAdding(false); };
  const del = async (id: string) => { if (!confirm('Xóa?')) return; await fetch(`/api/d1/accounts/${id}`, { method: 'DELETE' }); addToast('Đã xoá', 'info'); load(); };
  const reset = async (id: string) => { await patch(`/api/d1/accounts/${id}`, { status: 'pending' }); addToast('→ pending', 'info'); load(); };
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
      addToast(!isActive ? '✅ Đã bật tài khoản' : '🛑 Đã tắt tài khoản', 'info');
      load();
    } catch (e: any) { addToast(e.message, 'error'); }
  };
  const openEdit = (it: any) => { setEditId(it.id); setEditPass(it.password || ''); setEdit2fa(it.two_fa_secret || ''); setEditProxy(it.proxy_url || ''); };
  const saveEdit = async () => { if (!editId) return; setEditSaving(true); await patch(`/api/d1/accounts/${editId}`, { password: editPass, twoFaSecret: edit2fa, proxyUrl: editProxy }); addToast('✅ Đã lưu', 'success'); setEditId(null); setEditSaving(false); load(); };
  const cancelEdit = () => setEditId(null);
  const bypassSync = async (id: string, email: string) => {
    try {
      const r = await fetch(`http://localhost:4000/api/vault/accounts/${id}/sync`, { method: 'POST' });
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      addToast(`☁️ Đã ép đồng bộ ${email} lên D1`, 'success');
      load();
    } catch (e: any) { addToast(e.message, 'error'); }
  };
  const bulkImport = async () => { if (!bulkRows.length) return; setBulkBusy(true); let ok = 0; for (const r of bulkRows) { try { const d = await post('/api/d1/accounts/add', r); if (d.ok) ok++; } catch {} } setBulkBusy(false); setBulkText(''); setBulkRows([]); setBulkOpen(false); addToast(`✅ Imported ${ok}/${bulkRows.length}`, 'success'); load(); };

  /* ── base cell style ── */
  const th: React.CSSProperties = { padding: '10px 14px', fontSize: 11, fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: .6, whiteSpace: 'nowrap', borderBottom: '1px solid var(--border-2)' };
  const td: React.CSSProperties = { padding: '10px 14px', fontSize: 13, verticalAlign: 'middle' };

  return (
    <div className="content">

      {/* ═══ STATS ═══ */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
        <StatCard icon={Users}       value={cnt.total}   label="Tất cả"  color="var(--indigo-2)" bg="var(--indigo-soft)" active={statusFilter === 'all'}     onClick={() => setStatusFilter('all')} />
        <StatCard icon={CheckCircle} value={cnt.ready}   label="Ready"   color="var(--green)"    bg="var(--green-dim)"   active={statusFilter === 'ready'}   onClick={() => setStatusFilter('ready')} />
        <StatCard icon={Clock}       value={cnt.pending} label="Pending" color="var(--amber)"    bg="var(--amber-dim)"   active={statusFilter === 'pending'} onClick={() => setStatusFilter('pending')} />
        <StatCard icon={XCircle}     value={cnt.error}   label="Error"   color="var(--rose)"     bg="var(--rose-dim)"    active={statusFilter === 'error'}   onClick={() => setStatusFilter('error')} />
      </div>

      {/* ═══ ADD / BULK ═══ */}
      <div className="card">
        <div className="card-head">
          <span className="card-title"><Plus size={14} /> Thêm Tài Khoản</span>
          <button className={`btn btn-sm ${bulkOpen ? 'btn-warning' : 'btn-ghost'}`} onClick={() => setBulkOpen(v => !v)}>
            <Upload size={12} /> Import hàng loạt {bulkOpen ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
          </button>
        </div>
        <div className="card-body" style={{ padding: '14px 18px' }}>
          {!bulkOpen ? (
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <input className="inp" style={{ flex: '2 1 200px' }} placeholder="Email *" value={newEmail} onChange={e => setNewEmail(e.target.value)} onKeyDown={e => e.key === 'Enter' && add()} />
              <input className="inp" style={{ flex: '1 1 150px' }} placeholder="Password" value={newPass} onChange={e => setNewPass(e.target.value)} />
              <input className="inp" style={{ flex: '1 1 150px' }} placeholder="2FA Secret" value={new2fa} onChange={e => setNew2fa(e.target.value)} />
              <button className="btn btn-primary" disabled={adding || !newEmail} onClick={add} style={{ flexShrink: 0 }}>
                {adding ? <span className="spin" style={{ width: 13, height: 13 }} /> : <Plus size={14} />} Tạo mới
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ padding: '8px 12px', background: 'var(--glass)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12, color: 'var(--text-2)', lineHeight: 1.7 }}>
                <strong style={{ color: 'var(--text)' }}>Định dạng:</strong>{' '}
                <code style={{ fontSize: 11, color: 'var(--cyan)' }}>email:password:2fa</code> hoặc <code style={{ fontSize: 11, color: 'var(--cyan)' }}>email|pass|2fa</code> hoặc <code style={{ fontSize: 11, color: 'var(--cyan)' }}>Tab-separated</code>
              </div>
              <textarea className="inp mono" rows={5} placeholder={`chatgpt@mail.com:password123:JBSWY3DP\nuser2@mail.com:pass2`}
                value={bulkText} onChange={e => { setBulkText(e.target.value); setBulkRows(parseBulk(e.target.value)); }}
                style={{ resize: 'vertical', lineHeight: 1.7 }} />
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                <span style={{ fontSize: 12, color: bulkRows.length ? 'var(--green)' : 'var(--text-3)' }}>
                  {bulkRows.length ? `✅ ${bulkRows.length} tài khoản hợp lệ` : 'Dán danh sách vào ô trên…'}
                </span>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn btn-ghost btn-sm" onClick={() => { setBulkOpen(false); setBulkText(''); setBulkRows([]); }}><X size={12} /> Hủy</button>
                  <button className="btn btn-primary btn-sm" disabled={bulkBusy || !bulkRows.length} onClick={bulkImport}>
                    {bulkBusy ? <span className="spin" style={{ width: 12, height: 12 }} /> : <Upload size={12} />} Import {bulkRows.length || ''}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ═══ TABLE ═══ */}
      <div className="card">
        {/* Header bar */}
        <div className="card-head">
          <span className="card-title">Managed Accounts <span className="nav-badge b">{filtered.length}</span></span>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginLeft: 'auto' }}>
            <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
              <Search size={13} style={{ position: 'absolute', left: 10, color: 'var(--text-3)', pointerEvents: 'none' }} />
              <input className="inp inp-sm" style={{ paddingLeft: 28, width: 180 }} placeholder="Tìm email…" value={search} onChange={e => setSearch(e.target.value)} />
              {search && <button onClick={() => setSearch('')} style={{ position: 'absolute', right: 8, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-3)', padding: 0, display: 'flex' }}><X size={11} /></button>}
            </div>
            <div style={{ display: 'flex', gap: 3, background: 'var(--glass)', padding: 3, borderRadius: 8, border: '1px solid var(--border)' }}>
              {['all', 'ready', 'pending', 'error'].map(f => (
                <button key={f} onClick={() => setStatusFilter(f)} style={{
                  padding: '4px 10px', fontSize: 11, fontWeight: 600, border: 'none', borderRadius: 6, cursor: 'pointer', transition: 'all .12s',
                  background: statusFilter === f ? 'var(--indigo-glow)' : 'transparent',
                  color: statusFilter === f ? 'var(--indigo-2)' : 'var(--text-3)',
                }}>{f}</button>
              ))}
            </div>
            <button className="btn-icon" title="Refresh" onClick={load} disabled={loading}>
              <RefreshCw size={13} style={{ animation: loading ? 'rotate .65s linear infinite' : 'none' }} />
            </button>
          </div>
        </div>

        {error && <div style={{ margin: '12px 18px 0', display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', background: 'var(--rose-dim)', color: 'var(--rose)', borderRadius: 8, fontSize: 13, border: '1px solid rgba(244,63,94,.2)' }}><AlertCircle size={14} /> {error}</div>}

        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', minWidth: 960, borderCollapse: 'collapse', textAlign: 'left' }}>
            <thead>
              <tr style={{ background: 'var(--glass)' }}>
                <th style={th}>Email</th>
                <th style={th}>Mật khẩu</th>
                <th style={th}>2FA</th>
                <th style={th}>Status</th>
                <th style={th}>Usage</th>
                <th style={th}>Proxy</th>
                <th style={th}>Cập nhật</th>
                <th style={{ ...th, textAlign: 'right', minWidth: 90 }}></th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && !loading && (
                <tr><td colSpan={8} style={{ textAlign: 'center', padding: 40, color: 'var(--text-3)' }}>{search ? `Không tìm thấy "${search}"` : 'Chưa có tài khoản nào'}</td></tr>
              )}
              {filtered.map(it => {
                const ed = editId === it.id;
                return (
                  <tr key={it.id} style={{ borderBottom: '1px solid var(--border)', background: ed ? 'rgba(99,102,241,.05)' : 'transparent', transition: 'background .1s' }}
                      onMouseEnter={e => { if (!ed) (e.currentTarget.style.background = 'var(--glass)'); }}
                      onMouseLeave={e => { if (!ed) (e.currentTarget.style.background = 'transparent'); }}>

                    {/* Email & Activation Toggle */}
                    <td style={{ ...td, minWidth: 240 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <div 
                          onClick={() => toggleActive(it.id, it.is_active)}
                          style={{
                            width: 12, height: 12, borderRadius: '50%', cursor: 'pointer', flexShrink: 0,
                            background: it.is_active === 0 ? 'var(--text-4)' : 'var(--green)',
                            border: `2px solid ${it.is_active === 0 ? 'var(--border)' : 'var(--green-dim)'}`,
                            boxShadow: it.is_active === 0 ? 'none' : '0 0 10px var(--green-dim)',
                            transition: 'all .2s'
                          }}
                          title={it.is_active === 0 ? "Đang tạm dừng (Nhấn để bật)" : "Đang hoạt động (Nhấn để tắt)"}
                        />
                        <div style={{ 
                          fontWeight: 600, 
                          fontSize: 13.5, 
                          color: it.is_active === 0 ? 'var(--text-4)' : 'var(--text)', 
                          textDecoration: it.is_active === 0 ? 'line-through' : 'none',
                          opacity: it.is_active !== 0 ? 1 : 0.6
                        }}>
                          {it.email}
                        </div>
                      </div>
                      {it.last_error && !ed && (
                        <div title={it.last_error} style={{ marginTop: 4, fontSize: 11, color: 'var(--rose)', display: 'flex', alignItems: 'center', gap: 4, maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          <AlertCircle size={10} style={{ flexShrink: 0 }} /> {it.last_error}
                        </div>
                      )}
                    </td>

                    {/* Pass */}
                    <td style={{ ...td, minWidth: 160 }}>
                      {ed ? <input className="inp inp-sm mono" value={editPass} onChange={e => setEditPass(e.target.value)} placeholder="Password" /> : <MonoCell value={it.password} />}
                    </td>

                    {/* 2FA */}
                    <td style={{ ...td, minWidth: 160 }}>
                      {ed ? <input className="inp inp-sm mono" value={edit2fa} onChange={e => setEdit2fa(e.target.value)} placeholder="2FA Secret" /> : <MonoCell value={it.two_fa_secret} />}
                    </td>

                    {/* Status */}
                    <td style={td}><StatusBadge status={it.status} /></td>

                    {/* Usage */}
                    <td style={{ ...td, minWidth: 140 }}>
                      {(it.discovered_limit || it.quotas_json || it.quota_json) ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                          {it.discovered_limit ? (
                            <div>
                              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, fontWeight: 700, color: 'var(--text-3)', marginBottom: 3 }}>
                                <span>{( ( (it.current_tokens_in||0) + (it.current_tokens_out||0) ) / 1000).toFixed(1)}k tokens</span>
                                <span>{ (it.discovered_limit / 1000).toFixed(0) }k limit</span>
                              </div>
                              <div style={{ height: 4, background: 'var(--border)', borderRadius: 2, overflow: 'hidden' }}>
                                <div style={{ 
                                  height: '100%', 
                                  background: ((it.current_tokens_in||0) + (it.current_tokens_out||0)) / it.discovered_limit > 0.8 ? 'var(--rose)' : 'var(--indigo-glow)', 
                                  width: `${Math.min(100, (((it.current_tokens_in||0) + (it.current_tokens_out||0)) / it.discovered_limit) * 100)}%` 
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
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                                  {qs.map((q: any, i: number) => {
                                    const pct = q.total > 0 ? (q.used / q.total) * 100 : 0;
                                    const color = pct > 80 ? 'var(--rose)' : (pct > 50 ? 'var(--amber)' : 'var(--emerald)');
                                    const remain = safePercentRemaining(q.used, q.total);
                                    return (
                                      <div key={i} title={`${q.name}: ${q.used}/${q.total}`} 
                                           style={{ fontSize: 9, padding: '1px 5px', borderRadius: 4, border: `1px solid ${color}33`, background: `${color}11`, color, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 3 }}>
                                        <div style={{ width: 4, height: 4, borderRadius: '50%', background: color }} />
                                        {q.name}: {remain ?? 0}%
                                      </div>
                                    );
                                  })}
                                </div>
                              );
                          })()}
                        </div>
                      ) : (
                        <span style={{ color: 'var(--text-4)', fontSize: 12 }}>Unknown</span>
                      )}
                    </td>

                    {/* Proxy */}
                    <td style={{ ...td, minWidth: 140 }}>
                      {ed ? (
                        <input className="inp inp-sm mono" value={editProxy} onChange={e => setEditProxy(e.target.value)} placeholder="http://proxy:port" />
                      ) : it.proxy_url ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11.5, color: 'var(--indigo-2)', fontFamily: 'monospace', maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          <Globe size={11} style={{ flexShrink: 0 }} /> {it.proxy_url}
                        </div>
                      ) : <span style={{ color: 'var(--text-4)', fontSize: 12 }}>—</span>}
                    </td>

                    {/* Updated */}
                    <td style={{ ...td, color: 'var(--text-3)', fontSize: 12, whiteSpace: 'nowrap' }}>
                      {new Date(it.updated_at).toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                    </td>

                    {/* Actions */}
                    <td style={{ ...td, textAlign: 'right' }}>
                      {ed ? (
                        <div style={{ display: 'flex', gap: 5, justifyContent: 'flex-end' }}>
                          <button className="btn btn-success btn-sm" disabled={editSaving} onClick={saveEdit}>{editSaving ? <span className="spin" style={{ width: 11, height: 11 }} /> : <Save size={12} />} Lưu</button>
                          <button className="btn-icon" onClick={cancelEdit} title="Hủy"><X size={13} /></button>
                        </div>
                      ) : (
                        <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                          <button className="btn-icon" title="Ép đồng bộ lên D1" onClick={() => bypassSync(it.id, it.email)} style={{ color: 'var(--indigo-2)' }}><Database size={13} /></button>
                          <button className="btn-icon" title="Sửa" onClick={() => openEdit(it)}><Pencil size={13} /></button>
                          <button className="btn-icon success" title="Re-run → pending" onClick={() => reset(it.id)}><RotateCcw size={13} /></button>
                          <button className="btn-icon danger" title="Xóa" onClick={() => del(it.id)}><Trash2 size={13} /></button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
