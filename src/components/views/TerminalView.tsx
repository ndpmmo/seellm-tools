'use client';
import React, { useEffect, useRef, useState } from 'react';
import { useApp, ProcessInfo } from '../AppContext';
import { fmtTime } from '../Views';
import { Card, CardHeader, CardTitle, CardContent, Button } from '../ui';
import { Terminal as TerminalIcon, ShieldAlert, CheckCircle2, AlertCircle, Info, Lock, Unlock } from 'lucide-react';

function StatusBadge({ status }: { status: string }) {
  const isRunning = status === 'running';
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wider border ${
      isRunning ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 
      status === 'error' ? 'bg-rose-500/10 text-rose-400 border-rose-500/20' : 
      'bg-slate-500/10 text-slate-400 border-slate-500/20'
    }`}>
      {status}
    </span>
  );
}

function Terminal({ proc }: { proc: ProcessInfo }) {
  const ref = useRef<HTMLDivElement>(null);
  const [auto, setAuto] = useState(true);

  useEffect(() => {
    if (auto) ref.current?.scrollIntoView({ behavior: 'smooth' });
  }, [proc.logs.length, auto]);

  const cls = (text: string) => {
    if (/✅|THÀNH CÔNG|SUCCESS|Hoàn tất/i.test(text)) return 'text-emerald-400 font-medium';
    if (/❌|THẤT BẠI|error|lỗi/i.test(text)) return 'text-rose-400 font-medium';
    if (/⚠|WARNING|warn/i.test(text)) return 'text-amber-400';
    if (/\[.*?\]/.test(text)) return 'text-indigo-300';
    return 'text-slate-300';
  };

  return (
    <Card className="flex flex-col h-full bg-[#0a0a0f] border-white/10 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 bg-black/40 border-b border-white/5">
        <div className="flex items-center gap-4">
          <div className="flex gap-1.5">
            <div className="w-3 h-3 rounded-full bg-rose-500/80" />
            <div className="w-3 h-3 rounded-full bg-amber-500/80" />
            <div className="w-3 h-3 rounded-full bg-emerald-500/80" />
          </div>
          <div className="text-[12px] font-mono text-slate-300">
            {proc.name} <span className="text-slate-500">— {proc.logs.length} lines</span>
          </div>
        </div>
        <Button variant="ghost" size="sm" className="h-6 text-[10px] px-2 py-0" onClick={() => setAuto(!auto)}>
          {auto ? <><Lock size={12} className="mr-1" /> Auto</> : <><Unlock size={12} className="mr-1 text-slate-400" /> Manual</>}
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto p-4 font-mono text-[12px] leading-relaxed break-all">
        {proc.logs.length === 0 && (
          <span className="text-slate-500 italic">Chưa có output...</span>
        )}
        {proc.logs.map((l, i) => (
          <div key={i} className="flex gap-3 mb-1 hover:bg-white/5 px-1 -mx-1 rounded">
            <span className="text-slate-600 shrink-0 select-none">{fmtTime(l.ts)}</span>
            <span className={`flex-1 ${cls(l.text)} ${l.type === 'stderr' ? 'text-rose-400' : ''}`}>{l.text}</span>
          </div>
        ))}
        <div ref={ref} />
      </div>
    </Card>
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
    <div className="flex-1 overflow-hidden px-6 pb-6 pt-2 flex flex-col gap-4">
      <div className="grid grid-cols-[280px_1fr] gap-6 flex-1 min-h-0">
        {/* Process list */}
        <Card className="flex flex-col bg-[#1e1e23]/50 backdrop-blur-sm border-white/5">
          <CardHeader className="py-4 border-b border-white/5">
            <CardTitle className="text-[11px] uppercase tracking-wider text-slate-400">Processes ({procs.length})</CardTitle>
          </CardHeader>
          <div className="flex-1 overflow-y-auto p-2">
            {procs.length === 0 && (
              <div className="p-4 text-center text-[12px] text-slate-500">Chưa có processes</div>
            )}
            {procs.map(p => (
              <div key={p.id}
                className={`p-3 rounded-lg cursor-pointer mb-1 border-l-[3px] transition-all hover:bg-white/5 ${
                  sel?.id === p.id ? 'border-l-indigo-500 bg-indigo-500/10' : 'border-l-transparent'
                }`}
                onClick={() => setSelectedLog(p.id)}>
                <div className="font-semibold text-[13px] text-slate-200 truncate">{p.name}</div>
                <div className="flex items-center justify-between mt-2">
                  <span className="text-[11px] text-slate-400 font-mono">{p.logs.length} lines</span>
                  <StatusBadge status={p.status} />
                </div>
              </div>
            ))}
          </div>
        </Card>

        {/* Terminal output */}
        <div className="flex flex-col overflow-hidden">
          {sel
            ? <Terminal proc={sel} />
            : (
              <Card className="flex-1 flex items-center justify-center bg-[#0a0a0f] border-white/10">
                <div className="flex flex-col items-center gap-4 text-slate-500">
                  <TerminalIcon size={48} className="opacity-20" />
                  <div className="text-sm">Chưa chọn process</div>
                </div>
              </Card>
            )
          }
        </div>
      </div>
    </div>
  );
}
