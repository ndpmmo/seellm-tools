'use client';
import React, { useEffect, useRef, useState } from 'react';
import { useApp, ProcessInfo } from '../AppContext';
import { Badge, fmtTime } from '../Views';

function Terminal({ proc }: { proc: ProcessInfo }) {
  const ref = useRef<HTMLDivElement>(null);
  const [auto, setAuto] = useState(true);

  useEffect(() => {
    if (auto) ref.current?.scrollIntoView({ behavior: 'smooth' });
  }, [proc.logs.length, auto]);

  const cls = (text: string) => {
    if (/✅|THÀNH CÔNG|SUCCESS|Hoàn tất/i.test(text)) return 'lc-ok';
    if (/❌|THẤT BẠI|error|lỗi/i.test(text)) return 'lc-err';
    if (/⚠|WARNING|warn/i.test(text)) return 'lc-warn';
    if (/\[.*?\]/.test(text)) return 'lc-info';
    return '';
  };

  return (
    <div className="terminal-wrap">
      <div className="term-bar">
        <div className="term-dots">
          <div className="tdot r"/><div className="tdot y"/><div className="tdot g"/>
        </div>
        <div className="term-title">{proc.name} — {proc.logs.length} lines</div>
        <button className="btn btn-ghost btn-sm" style={{ fontSize:10, padding:'2px 7px' }}
          onClick={() => setAuto(!auto)}>
          {auto ? '🔒 Auto' : '🔓 Manual'}
        </button>
      </div>
      <div className="term-body">
        {proc.logs.length === 0 && (
          <span style={{ color:'var(--text-3)' }}>Chưa có output...</span>
        )}
        {proc.logs.map((l, i) => (
          <div key={i} className={`log-line ${l.type}`}>
            <span className="log-ts">{fmtTime(l.ts)}</span>
            <span className={`log-txt ${cls(l.text)}`}>{l.text}</span>
          </div>
        ))}
        <div ref={ref} />
      </div>
    </div>
  );
}

export function TerminalView() {
  const { processes, selectedLog, setSelectedLog } = useApp();
  const procs = Object.values(processes);
  const sel   = selectedLog ? processes[selectedLog] : procs[0] || null;

  useEffect(() => {
    if (!selectedLog && procs.length) setSelectedLog(procs[0].id);
  }, [procs.length]);

  return (
    <div style={{ padding:'16px 20px', height:'calc(100vh - var(--topbar-h))', overflow:'hidden', display:'flex', flexDirection:'column', gap:14 }}>
      <div className="log-layout" style={{ flex:1 }}>
        {/* Process list */}
        <div className="log-proc-list">
          <div style={{ fontSize:11, fontWeight:600, color:'var(--text-3)', textTransform:'uppercase', letterSpacing:'.6px', marginBottom:4 }}>
            Processes ({procs.length})
          </div>
          {procs.length === 0 && (
            <div className="lp-item" style={{ cursor:'default' }}>
              <div className="lp-name" style={{ color:'var(--text-3)' }}>Chưa có processes</div>
            </div>
          )}
          {procs.map(p => (
            <div key={p.id}
              className={`lp-item ${sel?.id===p.id?'active':''}`}
              onClick={() => setSelectedLog(p.id)}>
              <div className="lp-name">{p.name}</div>
              <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginTop:3 }}>
                <span className="lp-sub">{p.logs.length} lines</span>
                <Badge status={p.status} />
              </div>
            </div>
          ))}
        </div>

        {/* Terminal output */}
        <div style={{ overflow:'hidden', display:'flex', flexDirection:'column' }}>
          {sel
            ? <Terminal proc={sel} />
            : <div className="empty"><div className="e-ico">💻</div><div className="e-txt">Chưa chọn process</div></div>
          }
        </div>
      </div>
    </div>
  );
}
