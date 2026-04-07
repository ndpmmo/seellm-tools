'use client';
import React, { useCallback, useEffect, useState } from 'react';
import { Spinner } from '../Views';

export function ConnectionsView() {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch('/api/d1/inspect/connections');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      if (data.error) throw new Error(data.error);
      setItems(data.items || []);
    } catch (e: any) {
      setError(e.message);
    }
    setLoading(false);
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  return (
    <div className="content">
      <div className="card">
        <div className="card-head">
          <span className="card-title">🔗 Active Connections ({items.length})</span>
          <button className="btn btn-ghost btn-sm" onClick={loadData} disabled={loading}>{loading ? <Spinner/> : '↻ Refresh'}</button>
        </div>
        <div className="card-body">
          {error && <div style={{color:'var(--rose)', marginBottom: 10}}>{error}</div>}
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', textAlign: 'left', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)', color: 'var(--text-3)' }}>
                  <th style={{ padding: 8 }}>Email (Name)</th>
                  <th style={{ padding: 8 }}>Status</th>
                  <th style={{ padding: 8 }}>Usage</th>
                  <th style={{ padding: 8 }}>Proxy URL</th>
                  <th style={{ padding: 8 }}>Workspace</th>
                  <th style={{ padding: 8 }}>Rate Limit Protection</th>
                  <th style={{ padding: 8, minWidth: 160 }}>Updated At</th>
                </tr>
              </thead>
              <tbody>
                {items.length === 0 && !loading && (
                  <tr><td colSpan={7} style={{ padding: 8, textAlign: 'center', color: 'var(--text-3)' }}>Không có dữ liệu</td></tr>
                )}
                {items.map(it => (
                  <tr key={it.id} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: 8, fontWeight: 500, minWidth: 200 }}>
                      <div style={{ color: 'var(--text)' }}>{it.email}</div>
                      <div style={{ color: 'var(--text-3)', fontSize: 11 }}>{it.name || '-'}</div>
                    </td>
                    <td style={{ padding: 8 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: it.is_active ? 'var(--emerald)' : 'var(--text-4)', fontWeight: 600 }}>
                        <div style={{ width: 6, height: 6, borderRadius: '50%', background: it.is_active ? 'var(--emerald)' : 'var(--text-4)' }} />
                        {it.is_active ? 'Active' : 'Inactive'}
                      </div>
                    </td>
                    <td style={{ padding: 8, minWidth: 150 }}>
                      {(it.discovered_limit || it.quotas_json) ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          {it.discovered_limit ? (
                            <div>
                              <div style={{ height: 4, background: 'var(--border)', borderRadius: 2, overflow: 'hidden', marginBottom: 3 }}>
                                <div style={{ 
                                  height: '100%', 
                                  background: ((it.current_tokens_in||0) + (it.current_tokens_out||0)) / it.discovered_limit > 0.8 ? 'var(--rose)' : 'var(--indigo-glow)', 
                                  width: `${Math.min(100, (((it.current_tokens_in||0) + (it.current_tokens_out||0)) / it.discovered_limit) * 100)}%` 
                                }} />
                              </div>
                            </div>
                          ) : null}
                          {it.quotas_json && (() => {
                            try {
                              const qs = typeof it.quotas_json === 'string' ? JSON.parse(it.quotas_json) : it.quotas_json;
                              if (!Array.isArray(qs)) return null;
                              return (
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                                  {qs.slice(0, 2).map((q: any, i: number) => {
                                    const pct = q.total > 0 ? (q.used / q.total) * 100 : 0;
                                    const color = pct > 80 ? 'var(--rose)' : (pct > 50 ? 'var(--amber)' : 'var(--emerald)');
                                    return (
                                      <div key={i} title={`${q.name}: ${q.used}/${q.total}`} 
                                           style={{ fontSize: 9, padding: '1px 4px', borderRadius: 4, border: `1px solid ${color}33`, background: `${color}11`, color, fontWeight: 700, whiteSpace: 'nowrap' }}>
                                        {q.name}: {Math.round(100 - pct)}%
                                      </div>
                                    );
                                  })}
                                </div>
                              );
                            } catch (e) { return null; }
                          })()}
                        </div>
                      ) : (
                        <span style={{ color: 'var(--text-4)', fontSize: 11 }}>Unknown</span>
                      )}
                    </td>
                    <td style={{ padding: 8, fontFamily: 'monospace', fontSize: 11 }}>{it.proxy_url || '-'}</td>
                    <td style={{ padding: 8, fontFamily: 'monospace' }}>{it.workspace_id || '-'}</td>
                    <td style={{ padding: 8 }}>{it.rate_limit_protection ? 'Bật' : 'Tắt'}</td>
                    <td style={{ padding: 8, color: 'var(--text-3)' }}>{new Date(it.updated_at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
