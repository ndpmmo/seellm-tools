'use client';
import React, { useCallback, useEffect, useState } from 'react';
import { Spinner } from '../Views';
import { Card, CardHeader, CardTitle, CardContent, Button } from '../ui';
import { Link2, RefreshCw, AlertCircle } from 'lucide-react';

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
    <div className="absolute inset-0 overflow-y-auto px-6 pb-10 pt-2 flex flex-col gap-5 custom-scrollbar">
      <Card className="flex-1 flex flex-col min-h-0">
        <CardHeader className="bg-black/10 border-b border-white/5 py-4 px-5">
          <CardTitle>
            <Link2 size={16} className="text-indigo-400" />
            Active Connections
            <span className="ml-2 px-2 py-0.5 rounded-full text-[10px] bg-indigo-500/20 text-indigo-400 font-bold">{items.length}</span>
          </CardTitle>
          <Button variant="secondary" size="sm" onClick={loadData} disabled={loading} className="w-auto px-3 border-white/10 hover:bg-white/10 ml-auto">
            <RefreshCw size={14} className={`${loading ? 'animate-spin' : ''} text-slate-300 mr-1.5`} />
            Refresh
          </Button>
        </CardHeader>
        <div className="flex-1 overflow-x-auto">
          {error && <div className="mx-5 mt-4 mb-1 flex items-center gap-2 p-3 bg-rose-500/10 text-rose-400 rounded-lg text-[13px] border border-rose-500/30"><AlertCircle size={14} /> {error}</div>}
          
          <table className="w-full min-w-[1000px] border-collapse text-left">
            <thead>
              <tr className="bg-white/5 border-y border-white/5">
                <th className="px-5 py-3 text-[11px] font-bold text-slate-400 uppercase tracking-wider">Email (Name)</th>
                <th className="px-5 py-3 text-[11px] font-bold text-slate-400 uppercase tracking-wider">Status</th>
                <th className="px-5 py-3 text-[11px] font-bold text-slate-400 uppercase tracking-wider">Usage</th>
                <th className="px-5 py-3 text-[11px] font-bold text-slate-400 uppercase tracking-wider">Proxy URL</th>
                <th className="px-5 py-3 text-[11px] font-bold text-slate-400 uppercase tracking-wider">Workspace</th>
                <th className="px-5 py-3 text-[11px] font-bold text-slate-400 uppercase tracking-wider">Rate Limit Protection</th>
                <th className="px-5 py-3 text-[11px] font-bold text-slate-400 uppercase tracking-wider min-w-[160px]">Updated At</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {items.length === 0 && !loading && (
                <tr><td colSpan={7} className="p-10 text-center text-[13px] text-slate-500">Không có dữ liệu</td></tr>
              )}
              {items.map(it => (
                <tr key={it.id} className="transition-colors group hover:bg-white/[0.02]">
                  <td className="px-5 py-4 font-medium min-w-[200px] align-middle">
                    <div className="text-[13px] text-slate-200">{it.email}</div>
                    <div className="text-[11px] text-slate-500 mt-0.5">{it.name || '-'}</div>
                  </td>
                  <td className="px-5 py-4 align-middle">
                    <div className={`flex items-center gap-1.5 text-[12px] font-semibold ${it.is_active ? 'text-emerald-400' : 'text-slate-500'}`}>
                      <div className={`w-1.5 h-1.5 rounded-full ${it.is_active ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]' : 'bg-slate-600'}`} />
                      {it.is_active ? 'Active' : 'Inactive'}
                    </div>
                  </td>
                  <td className="px-5 py-4 min-w-[150px] align-middle">
                    {(it.discovered_limit || it.quotas_json) ? (
                      <div className="flex flex-col gap-1.5">
                        {it.discovered_limit ? (
                          <div className="h-1 bg-white/10 rounded-full overflow-hidden">
                            <div className={`h-full ${((it.current_tokens_in||0) + (it.current_tokens_out||0)) / it.discovered_limit > 0.8 ? 'bg-rose-500' : 'bg-indigo-500 shadow-[0_0_10px_rgba(99,102,241,0.8)]'}`} style={{ 
                                width: `${Math.min(100, (((it.current_tokens_in||0) + (it.current_tokens_out||0)) / it.discovered_limit) * 100)}%` 
                              }} />
                          </div>
                        ) : null}
                        {it.quotas_json && (() => {
                          try {
                            const qs = typeof it.quotas_json === 'string' ? JSON.parse(it.quotas_json) : it.quotas_json;
                            if (!Array.isArray(qs)) return null;
                            return (
                              <div className="flex flex-wrap gap-1 mt-0.5">
                                {qs.slice(0, 2).map((q: any, i: number) => {
                                  const pct = q.total > 0 ? (q.used / q.total) * 100 : 0;
                                  const base = pct > 80 ? 'rose' : (pct > 50 ? 'amber' : 'emerald');
                                  return (
                                    <div key={i} title={`${q.name}: ${q.used}/${q.total}`} 
                                         className={`text-[9px] px-1.5 py-px rounded border font-bold flex items-center gap-1 uppercase tracking-widest whitespace-nowrap ${
                                            base === 'rose' ? 'bg-rose-500/10 text-rose-400 border-rose-500/20' :
                                            base === 'amber' ? 'bg-amber-500/10 text-amber-400 border-amber-500/20' :
                                            'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                                         }`}>
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
                      <span className="text-slate-500 text-xs">—</span>
                    )}
                  </td>
                  <td className="px-5 py-4 font-mono text-[11px] text-indigo-300/70 align-middle truncate max-w-[200px]">{it.proxy_url || '-'}</td>
                  <td className="px-5 py-4 font-mono text-[11px] text-slate-400 align-middle">{it.workspace_id || '-'}</td>
                  <td className="px-5 py-4 align-middle">
                    <span className={`px-2 py-0.5 rounded text-[10px] font-bold tracking-wider uppercase border ${it.rate_limit_protection ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-slate-500/10 text-slate-400 border-slate-500/20'}`}>
                      {it.rate_limit_protection ? 'Bật' : 'Tắt'}
                    </span>
                  </td>
                  <td className="px-5 py-4 text-[11px] text-slate-400 align-middle whitespace-nowrap">{new Date(it.updated_at).toLocaleString('vi-VN')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
