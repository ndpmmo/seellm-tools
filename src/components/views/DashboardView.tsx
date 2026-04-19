'use client';
import React, { useCallback, useEffect, useState } from 'react';
import { useApp, ProcessInfo } from '../AppContext';
import { Badge, Spinner, relTime } from '../Views';

function ProcCard({ p }: { p: ProcessInfo }) {
  const { stopProcess, setView, setSelectedLog } = useApp();
  const [stopping, setStopping] = useState(false);
  const stop = async () => { setStopping(true); await stopProcess(p.id); setStopping(false); };
  const logs = () => { setSelectedLog(p.id); setView('terminal'); };

  return (
    <div className={`proc-card ${p.status}`}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
        <div>
          <div className="proc-name">{p.name}</div>
          <div className="proc-meta">{p.pid ? `PID ${p.pid}` : 'Khởi động...'}</div>
        </div>
        <Badge status={p.status} />
      </div>
      <div className="proc-stats">
        <div className="ps-item"><span className="ps-lbl">Bắt đầu</span><span className="ps-val">{relTime(p.startedAt)}</span></div>
        <div className="ps-item"><span className="ps-lbl">Logs</span><span className="ps-val">{p.logs.length}</span></div>
        {p.exitCode != null && <div className="ps-item"><span className="ps-lbl">Exit</span><span className="ps-val" style={{ color: p.exitCode === 0 ? 'var(--green)' : 'var(--rose)' }}>{p.exitCode}</span></div>}
      </div>
      <div className="proc-acts">
        <button className="btn btn-ghost btn-sm" onClick={logs}>📋 Logs</button>
        {p.status === 'running' && (
          <button className="btn btn-rose btn-sm" onClick={stop} disabled={stopping}>
            {stopping ? <Spinner /> : '⏹'} Stop
          </button>
        )}
      </div>
    </div>
  );
}

export function DashboardView() {
  const { processes, startCamofox, startWorker, startConnectWorker, connected, pingCamofox, pingGateway, liveShots, setView, sessions } = useApp();
  const procs = Object.values(processes);
  const running = procs.filter(p => p.status === 'running').length;
  const errors = procs.filter(p => p.status === 'error').length;
  const [cfPing, setCf] = useState<boolean | null>(null);
  const [gwPing, setGw] = useState<boolean | null>(null);
  const [checking, setChecking] = useState(false);

  const isCamofox = processes['camofox']?.status === 'running';
  const isWorker = processes['worker']?.status === 'running';
  const isConnectWorker = processes['connect-worker']?.status === 'running';

  const check = useCallback(async () => {
    setChecking(true);
    const [cf, gw] = await Promise.all([pingCamofox(), pingGateway()]);
    setCf(cf.ok); setGw(gw.ok);
    setChecking(false);
  }, [pingCamofox, pingGateway]);

  useEffect(() => { check(); const t = setInterval(check, 20000); return () => clearInterval(t); }, [check]);

  return (
    <div className="content">
      {/* Stats */}
      <div className="stat-row">
        <div className="stat-card"><div className="stat-ico i">⚙️</div><div><div className="stat-num">{procs.length}</div><div className="stat-lbl">Processes</div></div></div>
        <div className="stat-card"><div className="stat-ico g">▶️</div><div><div className="stat-num">{running}</div><div className="stat-lbl">Đang chạy</div></div></div>
        <div className="stat-card"><div className="stat-ico a">📸</div><div><div className="stat-num">{sessions.reduce((s, x) => s + x.imageCount, 0)}</div><div className="stat-lbl">Screenshots</div></div></div>
        <div className="stat-card"><div className="stat-ico c">🗂️</div><div><div className="stat-num">{sessions.length}</div><div className="stat-lbl">Sessions</div></div></div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        {/* Controls */}
        <div className="card">
          <div className="card-head"><span className="card-title">🚀 Quick Launch</span></div>
          <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', background: 'var(--glass-2)', borderRadius: 10, border: '1px solid var(--border)' }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>🦊 Camofox Server</div>
                <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>Headless browser với anti-detection</div>
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <Badge status={processes['camofox']?.status || 'stopped'} />
                <button className="btn btn-green btn-sm" onClick={startCamofox} disabled={isCamofox}>▶ Start</button>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', background: 'var(--glass-2)', borderRadius: 10, border: '1px solid var(--border)' }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>🤖 Auto-Login Worker</div>
                <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>Poll task &amp; OAuth login tự động</div>
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <Badge status={processes['worker']?.status || 'stopped'} />
                <button className="btn btn-primary btn-sm" onClick={startWorker} disabled={isWorker}>▶ Start</button>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', background: 'rgba(99,102,241,.07)', borderRadius: 10, border: '1px solid rgba(99,102,241,.2)' }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#818cf8' }}>🔌 Auto-Connect Worker <span style={{ fontSize: 10, fontWeight: 700, background: 'rgba(99,102,241,.2)', color: '#818cf8', borderRadius: 4, padding: '1px 6px', marginLeft: 4 }}>v2</span></div>
                <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>Đăng nhập chatgpt.com · Lấy session token</div>
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <Badge status={processes['connect-worker']?.status || 'stopped'} />
                <button className="btn btn-sm" onClick={startConnectWorker} disabled={isConnectWorker} style={{ background: 'rgba(99,102,241,.15)', color: '#818cf8', border: '1px solid rgba(99,102,241,.3)' }}>▶ Start</button>
              </div>
            </div>
          </div>
        </div>

        {/* Connection */}
        <div className="card">
          <div className="card-head">
            <span className="card-title">📡 Kết nối</span>
            <button className="btn btn-ghost btn-sm" onClick={check} disabled={checking}>{checking ? <Spinner /> : '↻'}</button>
          </div>
          <div className="card-body">
            <div className="ping-row">
              <div className="ping-item">
                <span className="ping-lbl">🦊 Camofox Browser Server</span>
                <span className={`ping-status ${cfPing === null ? 'wait' : cfPing ? 'ok' : 'fail'}`}>{cfPing === null ? 'Kiểm tra...' : cfPing ? '✓ Online' : '✗ Offline'}</span>
              </div>
              <div className="ping-item">
                <span className="ping-lbl">🌐 SeeLLM Gateway</span>
                <span className={`ping-status ${gwPing === null ? 'wait' : gwPing ? 'ok' : 'fail'}`}>{gwPing === null ? 'Kiểm tra...' : gwPing ? '✓ Online' : '✗ Offline'}</span>
              </div>
              <div className="ping-item">
                <span className="ping-lbl">⚡ Socket.io Realtime</span>
                <span className={`ping-status ${connected ? 'ok' : 'fail'}`}>{connected ? '✓ Connected' : '✗ Disconnected'}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Live screenshots */}
      {Object.keys(liveShots).length > 0 && (
        <div className="card">
          <div className="card-head">
            <span className="card-title">📸 Live Browser View ({Object.keys(liveShots).length})</span>
            <button className="btn btn-ghost btn-sm" onClick={() => setView('screenshots')}>Xem tất cả →</button>
          </div>
          <div className="card-body">
            <div className="live-grid">
              {Object.entries(liveShots).map(([sessionId, shot]) => (
                <div key={sessionId} className="live-entry-container">
                  <div className="live-screen clickable" style={{ maxWidth: 400 }} onClick={() => setView('screenshots')}>
                    <div className="live-badge"><span className="live-dot" />LIVE</div>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={`${shot.url}?t=${Date.now()}`} alt="Live" />
                  </div>
                  <div className="live-info" style={{ marginTop: 4 }}>
                    <div className="live-label" style={{ fontSize: 12 }}>{shot.email || sessionId.replace(/^run_/, '')}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}


      {/* Processes */}
      {procs.length > 0 && (
        <div className="card">
          <div className="card-head"><span className="card-title">⚙️ Processes ({procs.length})</span></div>
          <div className="card-body">
            <div className="proc-grid">
              {procs.map(p => <ProcCard key={p.id} p={p} />)}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
