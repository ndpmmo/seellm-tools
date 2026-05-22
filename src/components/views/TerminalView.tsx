'use client';
import React, { useEffect, useRef, useState, useMemo } from 'react';
import { useApp, ProcessInfo } from '../AppContext';
import { fmtTime } from '../Views';
import { Card, CardHeader, CardTitle, CardContent, Button } from '../ui';
import { Terminal as TerminalIcon, ShieldAlert, Info, Lock, Unlock, AlertTriangle, XCircle, CheckCircle, Zap } from 'lucide-react';

/* ── Log level detection ── */
type LogLevel = 'error' | 'warn' | 'success' | 'info' | 'system' | 'debug';

const LOG_PATTERNS: { level: LogLevel; re: RegExp }[] = [
  { level: 'error',   re: /❌|THẤT BẠI|fatal|uncaught|unhandled|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|crash|panic|abort|SIGTERM|SIGKILL|exit code [1-9]|non-zero|ERROR|Error:|ERR_|FAILED|Failed/i },
  { level: 'warn',    re: /⚠|WARNING|WARN|deprecated|slow|retry|timeout|rate.limit|429/i },
  { level: 'success', re: /✅|THÀNH CÔNG|SUCCESS|Hoàn tất|connected|ready|online|started|deployed|synced|\bOK\b/i },
  { level: 'system',  re: /^\[.*?\]|^#{1,3}\s|^\s*[━─═]{3,}|^={3,}|^─{3,}/ },
  { level: 'debug',   re: /debug|trace|verbose|dump|inspect/i },
];

function detectLogLevel(text: string, type: string): LogLevel {
  if (type === 'stderr') return 'error';
  for (const p of LOG_PATTERNS) {
    if (p.re.test(text)) return p.level;
  }
  return 'info';
}

const LEVEL_STYLES: Record<LogLevel, { text: string; bg: string; badge: string; icon: any }> = {
  error:   { text: 'text-rose-300',   bg: 'bg-rose-500/[0.06] hover:bg-rose-500/10',   badge: 'bg-rose-500/20 text-rose-400 border-rose-500/30',   icon: XCircle },
  warn:    { text: 'text-amber-300',  bg: 'bg-amber-500/[0.04] hover:bg-amber-500/8',  badge: 'bg-amber-500/20 text-amber-400 border-amber-500/30', icon: AlertTriangle },
  success: { text: 'text-emerald-300',bg: 'bg-emerald-500/[0.04] hover:bg-emerald-500/8',badge: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',icon: CheckCircle },
  info:    { text: 'text-slate-300',  bg: 'hover:bg-white/5',                            badge: 'bg-slate-500/20 text-slate-400 border-slate-500/30', icon: Info },
  system:  { text: 'text-indigo-300', bg: 'bg-indigo-500/[0.04] hover:bg-indigo-500/8', badge: 'bg-indigo-500/20 text-indigo-400 border-indigo-500/30', icon: Zap },
  debug:   { text: 'text-cyan-300',   bg: 'hover:bg-white/5',                            badge: 'bg-cyan-500/20 text-cyan-400 border-cyan-500/30',   icon: Info },
};

function StatusBadge({ status }: { status: string }) {
  const isRunning = status === 'running';
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wider border ${isRunning ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' :
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
  const [filterLevel, setFilterLevel] = useState<LogLevel | 'all'>('all');

  useEffect(() => {
    if (auto) ref.current?.scrollIntoView({ behavior: 'smooth' });
  }, [proc.logs.length, auto]);

  // Count log levels
  const levelCounts = useMemo(() => {
    const counts: Record<string, number> = { error: 0, warn: 0, success: 0, info: 0, system: 0, debug: 0 };
    proc.logs.forEach(l => { counts[detectLogLevel(l.text, l.type)]++; });
    return counts as Record<LogLevel, number>;
  }, [proc.logs]);

  const filteredLogs = useMemo(() => {
    if (filterLevel === 'all') return proc.logs;
    return proc.logs.filter(l => detectLogLevel(l.text, l.type) === filterLevel);
  }, [proc.logs, filterLevel]);

  return (
    <div className="flex flex-col h-full bg-[#050810] overflow-hidden">
      <div className="flex items-center justify-between px-5 py-3 bg-[#0d111c]/90 border-b border-white/5 backdrop-blur-md">
        <div className="flex items-center gap-4">
          <div className="flex gap-2">
            <div className="w-3 h-3 rounded-full bg-[#ff5f56] shadow-[0_0_10px_rgba(255,95,86,0.2)]" />
            <div className="w-3 h-3 rounded-full bg-[#ffbd2e] shadow-[0_0_10px_rgba(255,189,46,0.2)]" />
            <div className="w-3 h-3 rounded-full bg-[#27c93f] shadow-[0_0_10px_rgba(39,201,63,0.2)]" />
          </div>
          <div className="flex items-center gap-3 ml-2 border-l border-white/10 pl-4">
            <div className="text-[13px] font-mono text-slate-200 font-semibold tracking-wide">{proc.name}</div>
            <div className="text-[11px] font-mono text-indigo-300/70 bg-indigo-500/10 border border-indigo-500/20 px-2 py-0.5 rounded-md">{filteredLogs.length}/{proc.logs.length} lines</div>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {/* Level filter buttons */}
          {([
            { level: 'all' as const, label: 'Tất cả', Icon: null },
            ...(Object.entries(levelCounts) as [LogLevel, number][])
              .filter(([, c]) => c > 0)
              .map(([level, c]) => ({ level, label: `${c}`, Icon: LEVEL_STYLES[level].icon }))
          ]).map(({ level, label, Icon }) => (
            <button
              key={level}
              onClick={() => setFilterLevel(level)}
              className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-bold border transition-all ${filterLevel === level
                ? (level === 'all' ? 'bg-white/10 text-white border-white/20' : `${LEVEL_STYLES[level as LogLevel]?.badge || ''}`)
                : 'bg-white/5 text-slate-500 border-white/5 hover:bg-white/10 hover:text-slate-300'
              }`}
            >
              {Icon && <Icon size={10} />}
              {label}
            </button>
          ))}
          <div className="w-px h-5 bg-white/10 mx-1" />
          <Button variant="ghost" size="sm" className="h-7 text-[11.5px] px-3 font-semibold border border-transparent hover:border-white/10 bg-white/5" onClick={() => setAuto(!auto)}>
            {auto ? <><Lock size={12} className="mr-1.5 text-indigo-400" /> Auto-scroll</> : <><Unlock size={12} className="mr-1.5 text-slate-500" /> Manual</>}
          </Button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-4 font-mono text-[12.5px] leading-relaxed break-all custom-scrollbar">
        {filteredLogs.length === 0 && (
          <span className="text-slate-500 italic">Chưa có dòng log nào được ghi...</span>
        )}
        {filteredLogs.map((l, i) => {
          const level = detectLogLevel(l.text, l.type);
          const style = LEVEL_STYLES[level];
          const Icon = style.icon;
          return (
            <div key={i} className={`flex gap-3 mb-0.5 px-2 py-0.5 -mx-2 rounded transition-colors group ${style.bg}`}>
              <span className="text-slate-600 shrink-0 select-none whitespace-nowrap opacity-40 group-hover:opacity-100 transition-opacity min-w-[65px] text-right">{fmtTime(l.ts)}</span>
              <span className={`shrink-0 w-[30px] flex items-center justify-center opacity-60 group-hover:opacity-100 transition-opacity`} title={level.toUpperCase()}>
                <Icon size={11} className={style.text} />
              </span>
              <span className={`flex-1 ${style.text}`}>{l.text}</span>
            </div>
          );
        })}
        <div ref={ref} className="h-4" />
      </div>
    </div>
  );
}

export function TerminalView() {
  const { processes, selectedLog, setSelectedLog } = useApp();
  const procs = Object.values(processes)
    .sort((a, b) => Number(new Date(b.startedAt || 0)) - Number(new Date(a.startedAt || 0)));
  const sel = selectedLog ? processes[selectedLog] : procs[0] || null;

  useEffect(() => {
    if (!selectedLog && procs.length) setSelectedLog(procs[0].id);
  }, [procs.length]);

  const handleClearInactive = async () => {
    try {
      await fetch('/api/processes/clear-inactive', { method: 'POST' });
    } catch (_) {}
  };

  return (
    <div className="absolute inset-0 px-6 pb-10 pt-2 flex flex-col overflow-hidden">
      <div className="flex-1 flex flex-col lg:flex-row gap-5 min-h-0">
        {/* Process list Sidebar */}
        <Card className="flex flex-col shrink-0 lg:w-72 h-[45%] lg:h-full bg-[#0d111c]/70 backdrop-blur-md border border-white/5 shadow-lg overflow-hidden">
          <CardHeader className="py-4 border-b border-white/5 shrink-0 bg-transparent flex flex-row items-center justify-between">
            <CardTitle className="text-[11.5px] font-bold uppercase tracking-widest text-slate-400 flex items-center gap-2">
              <TerminalIcon size={14} className="text-indigo-400" />
              Tiến trình ({procs.length})
            </CardTitle>
            {procs.some(p => p.status !== 'running') && (
              <button
                onClick={handleClearInactive}
                className="text-[10px] text-indigo-400 hover:text-indigo-300 px-2 py-0.5 rounded bg-indigo-500/10 hover:bg-indigo-500/20 border border-indigo-500/20 transition-all font-semibold"
              >
                Dọn dẹp
              </button>
            )}
          </CardHeader>
          <div className="flex-1 overflow-y-auto p-3 custom-scrollbar">
            {procs.length === 0 && (
              <div className="p-8 text-center flex flex-col items-center gap-3">
                <ShieldAlert size={24} className="text-slate-600" />
                <div className="text-[13px] text-slate-400">Không có tiến trình nào hoạt động</div>
              </div>
            )}
            {procs.map(p => (
              <div key={p.id}
                className={`p-3.5 rounded-xl cursor-pointer mb-2 border transition-all duration-200 ${sel?.id === p.id
                  ? 'border-indigo-500/40 bg-indigo-500/10 shadow-[0_0_20px_rgba(99,102,241,0.15)] ring-1 ring-indigo-500/20'
                  : 'border-white/5 bg-white/[0.02] hover:bg-white/5 hover:border-white/10 hover:-translate-y-[1px]'
                  }`}
                onClick={() => setSelectedLog(p.id)}>
                <div className="font-semibold text-[13.5px] text-slate-200 truncate">{p.name}</div>
                <div className="flex items-center justify-between mt-3">
                  <span className="text-[11.5px] text-slate-400 font-mono bg-white/5 px-2 py-0.5 rounded border border-white/5">{p.logs.length} lines</span>
                  <StatusBadge status={p.status} />
                </div>
              </div>
            ))}
          </div>
        </Card>

        {/* Terminal output */}
        <div className="flex-1 min-w-0 flex flex-col overflow-hidden shadow-2xl rounded-xl border border-white/5 relative z-10 bg-[#050810]">
          {sel
            ? <Terminal proc={sel} />
            : (
              <div className="flex-1 flex items-center justify-center bg-[radial-gradient(ellipse_at_center,_rgba(99,102,241,0.05)_0%,_rgba(5,8,16,1)_70%)] relative overflow-hidden">
                <div className="absolute inset-0 bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-20 pointer-events-none"></div>
                <div className="flex flex-col items-center gap-5 text-slate-500 relative z-10 p-8 rounded-2xl bg-white/[0.02] border border-white/5 backdrop-blur-sm">
                  <div className="w-16 h-16 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center shadow-inner">
                    <TerminalIcon size={32} className="text-slate-600" />
                  </div>
                  <div className="text-[14px] font-medium text-slate-400">Chọn một tiến trình để xem nhật ký</div>
                </div>
              </div>
            )
          }
        </div>
      </div>
    </div>
  );
}
