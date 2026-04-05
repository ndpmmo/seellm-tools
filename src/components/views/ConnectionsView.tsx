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
                  <th style={{ padding: 8 }}>Proxy URL</th>
                  <th style={{ padding: 8 }}>Workspace</th>
                  <th style={{ padding: 8 }}>Rate Limit Protection</th>
                  <th style={{ padding: 8 }}>Updated At</th>
                </tr>
              </thead>
              <tbody>
                {items.length === 0 && !loading && (
                  <tr><td colSpan={6} style={{ padding: 8, textAlign: 'center', color: 'var(--text-3)' }}>Không có dữ liệu</td></tr>
                )}
                {items.map(it => (
                  <tr key={it.id} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: 8, fontWeight: 500 }}>
                      {it.email} <br/>
                      <span style={{color: 'var(--text-3)', fontSize: 11}}>{it.name || '-'}</span>
                    </td>
                    <td style={{ padding: 8 }}>
                      <span style={{ color: it.is_active ? 'var(--green)' : 'var(--text-3)' }}>
                        {it.is_active ? '● Active' : '○ Inactive'}
                      </span>
                    </td>
                    <td style={{ padding: 8 }}>{it.proxy_url || '-'}</td>
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
