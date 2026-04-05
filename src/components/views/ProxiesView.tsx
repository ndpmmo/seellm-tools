'use client';
import React, { useCallback, useEffect, useState } from 'react';
import {
  Plus, Upload, Search, RefreshCw,
  Trash2, Globe, Server, Activity, ChevronUp, ChevronDown, Check, X,
  AlertCircle, Edit2, Save
} from 'lucide-react';
import { useApp } from '../AppContext';

// ── Types ────────────────────────────────────────────────
interface ProxyItem {
  id: string;
  url: string;
  source: string;
  label?: string;
  last_latency_ms?: number;
  created_at: string;
}

interface ProxySlot {
  id: string;
  proxy_id: string;
  slot_index: number;
  connection_id?: string;
  updated_at: string;
}

// ── Helpers ──────────────────────────────────────────────
function parseBulkProxies(raw: string) {
  return raw.split('\n')
    .map(l => l.trim()).filter(Boolean)
    .map(line => {
      const norm = line.replace(/\t/g, ':').replace(/\s*[|]\s*/g, ':');
      const [url = '', label = '', slots = '4'] = norm.split(':').map(s => s.trim());
      return { url, label, slotCount: parseInt(slots, 10) || 4 };
    })
    .filter(r => r.url.startsWith('http://') || r.url.startsWith('https://') || r.url.startsWith('socks'));
}

// ── Stat Card ──
function StatCard({ icon: Icon, value, label, color, bg }: {
  icon: React.ElementType; value: number | string; label: string; color: string; bg: string;
}) {
  return (
    <div style={{
      flex: 1, minWidth: 0,
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '14px 16px', borderRadius: 12,
      background: 'var(--glass)',
      border: '1px solid var(--border)',
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

// ── Main ──────────────────────────────────────────────────
export function ProxiesView() {
  const { addToast } = useApp();
  const [proxies, setProxies] = useState<ProxyItem[]>([]);
  const [slots, setSlots]     = useState<ProxySlot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  const [search, setSearch]   = useState('');

  // Add single
  const [newUrl, setNewUrl]     = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [newCount, setNewCount] = useState('4');
  const [adding, setAdding]     = useState(false);

  // Bulk
  const [bulkOpen, setBulkOpen]   = useState(false);
  const [bulkText, setBulkText]   = useState('');
  const [bulkRows, setBulkRows]   = useState<ReturnType<typeof parseBulkProxies>>([]);
  const [bulkBusy, setBulkBusy]   = useState(false);

  // Edit inline
  const [editProxyId, setEditProxyId] = useState<string | null>(null);
  const [editValues, setEditValues]   = useState({ url: '', label: '' });

  /* ── Load ── */
  const loadData = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetch('/api/d1/inspect/proxies');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      if (data.error) throw new Error(data.error);
      setProxies(data.proxies || []);
      setSlots(data.proxySlots || []);
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const filtered = proxies.filter(p => !search || p.url.toLowerCase().includes(search.toLowerCase()) || (p.label && p.label.toLowerCase().includes(search.toLowerCase())));

  /* ── Stats ── */
  const totalSlots = slots.length;
  const busySlots  = slots.filter(s => s.connection_id).length;
  const freeSlots  = totalSlots - busySlots;

  /* ── API ── */
  async function apiPost(url: string, body: object) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return r.json();
  }

  const addProxy = async () => {
    if (!newUrl) return;
    setAdding(true);
    const d = await apiPost('/api/d1/proxies/add', { url: newUrl, label: newLabel, slotCount: parseInt(newCount, 10) || 4 });
    if (d.error) addToast(d.error, 'error');
    else { addToast('✅ Đã thêm proxy', 'success'); setNewUrl(''); setNewLabel(''); setNewCount('4'); await loadData(); }
    setAdding(false);
  };

  const deleteProxy = async (id: string) => {
    if (!confirm('Xóa proxy này? Các slot cũng sẽ bị xóa.')) return;
    await fetch(`/api/d1/proxies/${id}`, { method: 'DELETE' });
    addToast('Đã xoá proxy', 'info');
    loadData();
  };

  const saveEdit = async () => {
    if (!editProxyId) return;
    const r = await fetch(`/api/d1/proxies/${editProxyId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(editValues),
    });
    if (!r.ok) {
      addToast('Lỗi khi lưu proxy', 'error');
    } else {
      addToast('Đã cập nhật proxy', 'success');
      setEditProxyId(null);
      loadData();
    }
  };

  const addSlot = async (proxyId: string) => {
    const r = await fetch(`/api/d1/proxies/${proxyId}/slots`, { method: 'POST' });
    if (r.ok) { addToast('Đã thêm slot', 'success'); loadData(); }
    else addToast('Lỗi thêm slot', 'error');
  };

  const removeSlot = async (slotId: string, isBusy: boolean) => {
    if (isBusy) {
      if (!confirm('Slot này ĐANG ĐƯỢC DÙNG. Ngắt kết nối và xoá?')) return;
    } else {
      if (!confirm('Xoá slot trống này?')) return;
    }
    const r = await fetch(`/api/d1/slots/${slotId}`, { method: 'DELETE' });
    if (r.ok) { addToast('Đã xoá slot', 'info'); loadData(); }
  };

  const resetSlot = async (slotId: string) => {
    if (!confirm('Giải phóng slot (ngắt kết nối)?')) return;
    const r = await fetch(`/api/d1/slots/${slotId}/reset`, { method: 'POST' });
    if (r.ok) { addToast('Đã giải phóng slot', 'success'); loadData(); }
  };

  // ── Bulk import ──
  const importBulk = async () => {
    if (!bulkRows.length) return;
    setBulkBusy(true);
    let ok = 0;
    for (const row of bulkRows) {
      try { const d = await apiPost('/api/d1/proxies/add', row); if (!d.error) ok++; } catch {}
    }
    setBulkBusy(false); setBulkText(''); setBulkRows([]); setBulkOpen(false);
    addToast(`✅ Imported ${ok}/${bulkRows.length} proxy`, 'success');
    await loadData();
  };

  return (
    <div className="content">

      {/* ═══ STATS ═══ */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
        <StatCard icon={Globe}    value={proxies.length} label="Tổng Proxies" color="var(--indigo-2)" bg="var(--indigo-soft)" />
        <StatCard icon={Server}   value={totalSlots}     label="Tổng Slots"   color="var(--cyan)"     bg="var(--cyan-dim)" />
        <StatCard icon={Activity} value={busySlots}      label="Slots Đang Dùng" color="var(--amber)" bg="var(--amber-dim)" />
        <StatCard icon={Check}    value={freeSlots}      label="Slots Trống"  color="var(--green)"    bg="var(--green-dim)" />
      </div>

      {/* ═══ ADD / BULK ═══ */}
      <div className="card">
        <div className="card-head">
          <span className="card-title"><Plus size={14} /> Thêm Proxy</span>
          <button className={`btn btn-sm ${bulkOpen ? 'btn-warning' : 'btn-ghost'}`} onClick={() => setBulkOpen(v => !v)}>
            <Upload size={12} /> Import hàng loạt {bulkOpen ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
          </button>
        </div>
        
        <div className="card-body" style={{ padding: '14px 18px' }}>
          {!bulkOpen ? (
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <input className="inp" style={{ flex: '2 1 200px' }} placeholder="Proxy URL (http://...)" value={newUrl} onChange={e => setNewUrl(e.target.value)} onKeyDown={e => e.key === 'Enter' && addProxy()} />
              <input className="inp" style={{ flex: '1 1 150px' }} placeholder="Label (Vps, Router...)" value={newLabel} onChange={e => setNewLabel(e.target.value)} />
              <input className="inp" type="number" style={{ width: 80 }} placeholder="Slots" value={newCount} onChange={e => setNewCount(e.target.value)} />
              <button className="btn btn-primary" disabled={adding || !newUrl} onClick={addProxy} style={{ flexShrink: 0 }}>
                {adding ? <span className="spin" style={{ width: 13, height: 13 }} /> : <Plus size={14} />} Thêm
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ padding: '8px 12px', background: 'var(--glass)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12, color: 'var(--text-2)', lineHeight: 1.7 }}>
                <strong style={{ color: 'var(--text)' }}>Định dạng:</strong>{' '}
                <code style={{ fontSize: 11, color: 'var(--cyan)' }}>url:label:slots</code> hoặc <code style={{ fontSize: 11, color: 'var(--cyan)' }}>url|label|slots</code>
              </div>
              <textarea className="inp mono" rows={5} placeholder={`http://user:pass@12.34.56.78:8080:VPS_US:4\nhost:port:Router:2`}
                value={bulkText} onChange={e => { setBulkText(e.target.value); setBulkRows(parseBulkProxies(e.target.value)); }}
                style={{ resize: 'vertical', lineHeight: 1.7 }} />
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                <span style={{ fontSize: 12, color: bulkRows.length ? 'var(--green)' : 'var(--text-3)' }}>
                  {bulkRows.length ? `✅ Nhận diện được ${bulkRows.length} proxy hợp lệ` : 'Dán danh sách vào ô trên…'}
                </span>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn btn-ghost btn-sm" onClick={() => { setBulkOpen(false); setBulkText(''); setBulkRows([]); }}>
                    <X size={12} /> Hủy
                  </button>
                  <button className="btn btn-primary btn-sm" disabled={bulkBusy || !bulkRows.length} onClick={importBulk}>
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
        <div className="card-head">
          <span className="card-title">Proxy Pool <span className="nav-badge b">{filtered.length}</span></span>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginLeft: 'auto' }}>
            <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
              <Search size={13} style={{ position: 'absolute', left: 10, color: 'var(--text-3)', pointerEvents: 'none' }} />
              <input className="inp inp-sm" style={{ paddingLeft: 28, width: 180 }} placeholder="Tìm proxy…" value={search} onChange={e => setSearch(e.target.value)} />
              {search && <button onClick={() => setSearch('')} style={{ position: 'absolute', right: 8, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-3)', padding: 0, display: 'flex' }}><X size={11} /></button>}
            </div>
            <button className="btn-icon" title="Refresh" onClick={loadData} disabled={loading}>
              <RefreshCw size={13} style={{ animation: loading ? 'rotate .65s linear infinite' : 'none' }} />
            </button>
          </div>
        </div>

        {error && <div style={{ margin: '12px 18px 0', display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', background: 'var(--rose-dim)', color: 'var(--rose)', borderRadius: 8, fontSize: 13, border: '1px solid rgba(244,63,94,.2)' }}><AlertCircle size={14} /> {error}</div>}

        <div className="card-body" style={{ padding: '0 18px 18px' }}>
          <div style={{ display: 'grid', gap: 10, marginTop: 12 }}>
            {filtered.length === 0 && !loading && (
              <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-3)' }}>{search ? `Không tìm thấy "${search}"` : 'Chưa có proxy nào'}</div>
            )}
            
            {filtered.map(p => {
              const pSlots = slots.filter(s => s.proxy_id === p.id).sort((a,b) => a.slot_index - b.slot_index);
              const busyCount = pSlots.filter(s => s.connection_id).length;
              const isEditing = editProxyId === p.id;
              
              return (
                <div key={p.id} style={{ background: isEditing ? 'var(--glass-2)' : 'var(--glass)', padding: '14px 16px', borderRadius: 12, border: '1px solid var(--border)', transition: 'border-color .2s' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
                    <div style={{ flex: 1, minWidth: 0, marginRight: 16 }}>
                      {isEditing ? (
                        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                          <input className="inp inp-sm" style={{ flex: 2 }} value={editValues.url} onChange={e => setEditValues(v => ({ ...v, url: e.target.value }))} autoFocus />
                          <input className="inp inp-sm" style={{ flex: 1 }} value={editValues.label} onChange={e => setEditValues(v => ({ ...v, label: e.target.value }))} placeholder="Label..." />
                        </div>
                      ) : (
                        <>
                          <div style={{ fontWeight: 600, fontSize: 13.5, color: 'var(--indigo-2)', fontFamily: "'JetBrains Mono', monospace", wordBreak: 'break-all' }}>{p.url}</div>
                          <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4, display: 'flex', alignItems: 'center', gap: 8 }}>
                            {p.label && <span style={{ background: 'var(--glass-2)', padding: '2px 8px', borderRadius: 4, border: '1px solid var(--border)' }}>{p.label}</span>}
                            <span>Nguồn: {p.source}</span>
                            <span>•</span>
                            <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                              <Activity size={10} color={p.last_latency_ms ? (p.last_latency_ms < 500 ? 'var(--green)' : 'var(--amber)') : 'var(--text-3)'} />
                              Ping: {p.last_latency_ms || '?'}ms
                            </span>
                          </div>
                        </>
                      )}
                    </div>
                    
                    <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                      {isEditing ? (
                        <>
                          <button className="btn-icon" title="Hủy" onClick={() => setEditProxyId(null)}>
                            <X size={14} />
                          </button>
                          <button className="btn-icon btn-primary" title="Lưu lại" onClick={saveEdit}>
                            <Save size={14} />
                          </button>
                        </>
                      ) : (
                        <>
                          <button className="btn-icon" title="Chỉnh sửa Proxy" onClick={() => { setEditProxyId(p.id); setEditValues({ url: p.url, label: p.label || '' }); }}>
                            <Edit2 size={14} />
                          </button>
                          <button className="btn-icon danger" title="Xóa Proxy" onClick={() => deleteProxy(p.id)}>
                            <Trash2 size={14} />
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                  
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                    {pSlots.map(s => {
                      const isBusy = !!s.connection_id;
                      return (
                        <div key={s.id} 
                             title={isBusy ? `Đang dùng bởi ${s.connection_id}\n\n• Click Trái: Giải phóng\n• Alt+Click: Xóa slot` : 'Trống\n• Click: Xóa slot'}
                             onClick={(e) => {
                               if (isBusy && !e.altKey) resetSlot(s.id);
                               else removeSlot(s.id, isBusy);
                             }}
                             style={{ 
                               width: 26, height: 26, borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', 
                               fontSize: 10, fontWeight: 700, cursor: 'pointer',
                               background: isBusy ? 'var(--cyan-dim)' : 'var(--glass-3)', 
                               color: isBusy ? 'var(--cyan)' : 'var(--text-3)',
                               border: `1px solid ${isBusy ? 'rgba(6, 182, 212, 0.3)' : 'transparent'}`,
                               boxShadow: isBusy ? '0 0 10px rgba(6, 182, 212, 0.1)' : 'none',
                               transition: 'all .15s'
                             }}
                             onMouseOver={e => e.currentTarget.style.borderColor = isBusy ? 'rgba(6, 182, 212, 0.6)' : 'var(--border)'}
                             onMouseOut={e => e.currentTarget.style.borderColor = isBusy ? 'rgba(6, 182, 212, 0.3)' : 'transparent'}
                             >
                          {s.slot_index}
                        </div>
                      );
                    })}
                    <button className="btn-icon" onClick={() => addSlot(p.id)} title="Thêm slot" style={{ width: 26, height: 26, padding: 0 }}>
                      <Plus size={12} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
