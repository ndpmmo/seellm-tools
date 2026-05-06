'use client';
import React, { useCallback, useEffect, useState } from 'react';
import { useApp, ProcessInfo } from '../AppContext';
import { Spinner, relTime } from '../Views';
import { Button, Card, CardHeader, CardTitle, CardContent, StatBox } from '../ui';
import { Settings, Play, Camera, Layers, Zap, HeartPulse, RefreshCw } from 'lucide-react';

function ModeBadge({ mode }: { mode: string }) {
  const modeLabels: Record<string, string> = {
    'auto': 'Auto',
    'direct-login': 'Direct Login',
    'pkce-login': 'PKCE Login',
  };
  const label = modeLabels[mode] || mode;
  return (
    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wider border bg-indigo-500/10 text-indigo-400 border-indigo-500/20">
      {label}
    </span>
  );
}

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

function ProcCard({ p }: { p: ProcessInfo }) {
  const { stopProcess, setView, setSelectedLog, config } = useApp();
  const [stopping, setStopping] = useState(false);
  const stop = async () => { setStopping(true); await stopProcess(p.id); setStopping(false); };
  const logs = () => { setSelectedLog(p.id); setView('terminal'); };

  const isWorker = p.id === 'worker';
  const workerMode = config?.workerMode || 'auto';

  return (
    <Card className="flex flex-col h-full bg-[#1e1e23]/50 backdrop-blur-sm border-white/5">
      <CardContent className="p-4 flex-1 flex flex-col gap-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="font-semibold text-[13px] text-slate-100 truncate">{p.name}</div>
            <div className="text-[11px] text-slate-400 font-mono mt-0.5">{p.pid ? `PID ${p.pid}` : 'Khởi động...'}</div>
          </div>
          <div className="flex items-center gap-1.5">
            <StatusBadge status={p.status} />
            {isWorker && <ModeBadge mode={workerMode} />}
          </div>
        </div>

        <div className="bg-black/20 rounded-lg p-3 text-[11px] flex flex-col gap-1.5 border border-white/5">
          <div className="flex justify-between">
            <span className="text-slate-500">Bắt đầu</span>
            <span className="text-slate-300 font-medium">{relTime(p.startedAt)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-500">Logs</span>
            <span className="text-slate-300 font-medium">{p.logs.length} entries</span>
          </div>
          {p.exitCode != null && (
            <div className="flex justify-between">
              <span className="text-slate-500">Exit Code</span>
              <span className={`font-medium ${p.exitCode === 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{p.exitCode}</span>
            </div>
          )}
        </div>

        <div className="flex gap-2 mt-auto pt-1">
          <Button variant="secondary" size="sm" className="flex-1" onClick={logs}>📋 Xem Logs</Button>
          {p.status === 'running' && (
            <Button variant="danger" size="sm" onClick={stop} disabled={stopping} className="flex-[0.5]">
              {stopping ? <Spinner /> : '⏹ Stop'}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export function DashboardView() {
  const { processes, startCamofox, startWorker, connected, sseConnected, realtimeConnected, pingCamofox, pingGateway, liveShots, setView, sessions } = useApp();
  const procs = Object.values(processes)
    .filter(p => p.status === 'running')
    .sort((a, b) => Number(new Date(b.startedAt || 0)) - Number(new Date(a.startedAt || 0)));
  const running = procs.length;
  const errors = Object.values(processes).filter(p => p.status === 'error').length;
  const [cfPing, setCf] = useState<boolean | null>(null);
  const [gwPing, setGw] = useState<boolean | null>(null);
  const [checking, setChecking] = useState(false);

  const isCamofox = processes['camofox']?.status === 'running';
  const isWorker = processes['worker']?.status === 'running';

  const check = useCallback(async () => {
    setChecking(true);
    const [cf, gw] = await Promise.all([pingCamofox(), pingGateway()]);
    setCf(cf.ok); setGw(gw.ok);
    setChecking(false);
  }, [pingCamofox, pingGateway]);

  useEffect(() => {
    const initial = setTimeout(() => {
      void check();
    }, 0);
    const t = setInterval(() => {
      void check();
    }, 20000);
    return () => {
      clearTimeout(initial);
      clearInterval(t);
    };
  }, [check]);

  return (
    <div className="absolute inset-0 overflow-y-auto px-6 pb-10 pt-2 flex flex-col gap-6 custom-scrollbar">
      {/* Stats */}
      <div className="grid grid-cols-4 gap-5 mt-2">
        <StatBox label="Processes" value={procs.length} icon={Settings} colorClass="text-indigo-400" bgClass="bg-indigo-500/10" borderClass="border-indigo-500/50" />
        <StatBox label="Đang chạy" value={running} icon={Play} colorClass="text-emerald-400" bgClass="bg-emerald-500/10" borderClass="border-emerald-500/50" />
        <StatBox label="Screenshots" value={sessions.reduce((s, x) => s + x.imageCount, 0)} icon={Camera} colorClass="text-cyan-400" bgClass="bg-cyan-500/10" borderClass="border-cyan-500/50" />
        <StatBox label="Sessions" value={sessions.length} icon={Layers} colorClass="text-amber-400" bgClass="bg-amber-500/10" borderClass="border-amber-500/50" />
      </div>

      <div className="grid grid-cols-2 gap-5">
        {/* Controls */}
        <Card>
          <CardHeader>
            <CardTitle><Zap size={16} className="text-amber-400" /> Quick Launch</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="flex items-center justify-between p-3.5 bg-white/5 rounded-xl border border-white/10 hover:border-white/20 transition-colors">
              <div>
                <div className="text-[13px] font-bold text-slate-100 flex items-center gap-2">🦊 Camofox Server</div>
                <div className="text-[11px] text-slate-400 mt-1">Headless browser với anti-detection</div>
              </div>
              <div className="flex items-center gap-3">
                <StatusBadge status={processes['camofox']?.status || 'stopped'} />
                <Button variant="success" size="sm" onClick={startCamofox} disabled={isCamofox}>▶ Start</Button>
              </div>
            </div>

            <div className="flex items-center justify-between p-3.5 bg-white/5 rounded-xl border border-white/10 hover:border-white/20 transition-colors">
              <div>
                <div className="text-[13px] font-bold text-slate-100 flex items-center gap-2">🤖 Unified Auto Worker</div>
                <div className="text-[11px] text-slate-400 mt-1">1 process duy nhất — tự chọn flow connect (nhanh) hoặc login PKCE theo task</div>
              </div>
              <div className="flex items-center gap-3">
                <StatusBadge status={processes['worker']?.status || 'stopped'} />
                <Button variant="primary" size="sm" onClick={startWorker} disabled={isWorker}>▶ Start</Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Connection */}
        <Card>
          <CardHeader>
            <CardTitle><HeartPulse size={16} className="text-rose-400" /> Kết nối & Trạng thái</CardTitle>
            <Button size="icon-sm" variant="ghost" onClick={check} disabled={checking} className="ml-auto">
              <RefreshCw size={13} className={checking ? 'animate-spin' : ''} />
            </Button>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between p-3.5 bg-black/20 rounded-xl border border-white/5">
                <span className="text-[12.5px] font-semibold text-slate-300">🦊 Camofox Browser</span>
                <span className={`text-[11px] font-bold px-2.5 py-1 rounded-md border ${cfPing === null ? 'bg-slate-500/10 text-slate-400 border-slate-500/20' :
                  cfPing ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' :
                    'bg-rose-500/10 text-rose-400 border-rose-500/20'
                  }`}>
                  {cfPing === null ? 'Đang kiểm tra...' : cfPing ? '✓ Online' : '✗ Offline'}
                </span>
              </div>

              <div className="flex items-center justify-between p-3.5 bg-black/20 rounded-xl border border-white/5">
                <span className="text-[12.5px] font-semibold text-slate-300">🌐 SeeLLM Gateway</span>
                <span className={`text-[11px] font-bold px-2.5 py-1 rounded-md border ${gwPing === null ? 'bg-slate-500/10 text-slate-400 border-slate-500/20' :
                  gwPing ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' :
                    'bg-rose-500/10 text-rose-400 border-rose-500/20'
                  }`}>
                  {gwPing === null ? 'Đang kiểm tra...' : gwPing ? '✓ Online' : '✗ Offline'}
                </span>
              </div>

              <div className="flex items-center justify-between p-3.5 bg-black/20 rounded-xl border border-white/5">
                <span className="text-[12.5px] font-semibold text-slate-300">📡 SSE Stream (Realtime)</span>
                <span className={`text-[11px] font-bold px-2.5 py-1 rounded-md border ${sseConnected ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' :
                  'bg-rose-500/10 text-rose-400 border-rose-500/20'
                }`}>
                  {sseConnected ? '✓ Connected' : '✗ Disconnected'}
                </span>
              </div>

              <div className="flex items-center justify-between p-3.5 bg-black/20 rounded-xl border border-white/5">
                <span className="text-[12.5px] font-semibold text-slate-300">🔄 Realtime Status</span>
                <span className={`text-[11px] font-bold px-2.5 py-1 rounded-md border ${realtimeConnected ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' :
                  'bg-rose-500/10 text-rose-400 border-rose-500/20'
                }`}>
                  {sseConnected ? 'SSE Active' : 'Polling Fallback'}
                </span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Live screenshots */}
      {Object.keys(liveShots).length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle><Camera size={14} className="text-cyan-400" /> Live Browser View ({Object.keys(liveShots).length})</CardTitle>
            <Button variant="secondary" size="sm" onClick={() => setView('screenshots')} className="ml-auto">Xem tất cả →</Button>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
              {Object.entries(liveShots).map(([sessionId, shot]) => (
                <div key={sessionId} className="group relative cursor-pointer rounded-xl overflow-hidden border border-white/10 hover:border-indigo-500/50 transition-all bg-black/50 aspect-video flex items-center justify-center shadow-lg" onClick={() => setView('screenshots')}>
                  <div className="absolute top-2 left-2 z-10 flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-rose-500/20 text-rose-400 border border-rose-500/30 text-[9px] font-bold tracking-wider backdrop-blur-md">
                    <span className="w-1.5 h-1.5 rounded-full bg-rose-500 animate-pulse" /> LIVE
                  </div>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`${shot.url}`} alt="Live" className="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity" />
                  <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/50 to-transparent p-3 pt-8">
                    <div className="text-[11px] font-semibold text-slate-200 truncate">{shot.email || sessionId.replace(/^run_/, '')}</div>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Processes */}
      {procs.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle><Settings size={14} className="text-slate-400" /> Tiêu trình hệ thống ({procs.length})</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {procs.map(p => <ProcCard key={p.id} p={p} />)}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
