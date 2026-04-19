'use client';
import React, { createContext, useContext, useCallback, useState, useEffect } from 'react';
import { io, Socket } from 'socket.io-client';

// ─── Types ────────────────────────────────────────────────────────────────────
export interface LogEntry { type: 'stdout' | 'stderr' | 'system'; text: string; ts: string; }
export interface Screenshot { filename: string; url: string; email?: string; ts?: string; }
export interface Session { id: string; dir: string; imageCount: number; images: Screenshot[]; createdAt?: string; mtime: string; }
export interface LogFile { filename: string; size: number; createdAt?: string; mtime: string; }

export interface ProcessInfo {
  id: string; name: string; command: string; cwd: string;
  pid?: number; status: 'running' | 'stopped' | 'error';
  startedAt: string; stoppedAt?: string | null; exitCode?: number | null;
  logFile?: string;
  logs: LogEntry[];
}

export interface AppConfig {
  camofoxPath: string; camofoxNodePath?: string; camofoxPort: number; camofoxApi: string;
  gatewayUrl: string; workerAuthToken: string;
  pollIntervalMs: number; maxThreads: number;
}

interface Toast { id: string; message: string; type: 'success' | 'error' | 'info' | 'warning'; }

interface IApp {
  processes: Record<string, ProcessInfo>;
  config: AppConfig | null;
  connected: boolean;
  view: string;
  sessions: Session[];
  logFiles: LogFile[];
  liveShots: Record<string, Screenshot>; // sessionId -> latest screenshot
  selectedLog: string | null;
  toasts: Toast[];
  setView: (v: string) => void;
  setSelectedLog: (id: string | null) => void;
  startCamofox: () => Promise<void>;
  startWorker: () => Promise<void>;
  startConnectWorker: () => Promise<void>;
  stopProcess: (id: string) => Promise<void>;
  runScript: (name: string, args?: string[]) => Promise<string | null>;
  saveConfig: (cfg: Partial<AppConfig>) => Promise<void>;
  pingCamofox: () => Promise<{ ok: boolean; error?: string }>;
  pingGateway: () => Promise<{ ok: boolean; status?: number; error?: string }>;
  getScripts: () => Promise<string[]>;
  refreshSessions: () => Promise<void>;
  refreshLogFiles: () => Promise<void>;
  addToast: (msg: string, type?: Toast['type']) => void;
}

const Ctx = createContext<IApp | null>(null);
export const useApp = () => { const c = useContext(Ctx); if (!c) throw new Error('no ctx'); return c; };

// ─── Provider ────────────────────────────────────────────────────────────────
export function AppProvider({ children }: { children: React.ReactNode }) {
  const [processes, setProcesses] = useState<Record<string, ProcessInfo>>({});
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [connected, setConnected] = useState(false);
  const [view, setView] = useState('dashboard');
  const [sessions, setSessions] = useState<Session[]>([]);
  const [logFiles, setLogFiles] = useState<LogFile[]>([]);
  const [liveShots, setLiveShots] = useState<Record<string, Screenshot>>({});
  const [selectedLog, setSelectedLog] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const addToast = useCallback((message: string, type: Toast['type'] = 'info') => {
    const id = Math.random().toString(36).slice(2);
    setToasts(p => [...p, { id, message, type }]);
    setTimeout(() => setToasts(p => p.filter(t => t.id !== id)), 4500);
  }, []);

  // Hash Routing
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const hash = window.location.hash.replace('#', '');
      if (hash) setView(hash);

      const handleHash = () => {
        const h = window.location.hash.replace('#', '');
        if (h) setView(h);
      };
      window.addEventListener('hashchange', handleHash);
      return () => window.removeEventListener('hashchange', handleHash);
    }
  }, []);

  const setViewWithHash = useCallback((v: string) => {
    setView(v);
    if (typeof window !== 'undefined') window.location.hash = v;
  }, []);

  // Socket.io
  useEffect(() => {
    const socket: Socket = io('/', { path: '/socket.io', transports: ['websocket'] });
    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));

    socket.on('processes:sync', (list: ProcessInfo[]) => {
      const m: Record<string, ProcessInfo> = {};
      list.forEach(p => { if (p) m[p.id] = p; });
      setProcesses(m);
    });

    socket.on('process:log', ({ id, log }: { id: string; log: LogEntry }) => {
      setProcesses(p => {
        const e = p[id]; if (!e) return p;
        return { ...p, [id]: { ...e, logs: [...e.logs, log].slice(-5000) } };
      });
    });

    socket.on('process:status', ({ id, status, exitCode, pid }: any) => {
      setProcesses(p => {
        const e = p[id]; if (!e) return p;
        return { ...p, [id]: { ...e, status: status || e.status, exitCode: exitCode ?? e.exitCode, pid: pid ?? e.pid } };
      });
    });

    // Live screenshot pushed from server when new file appears
    socket.on('screenshot:new', (data: { sessionId: string; filename: string; url: string; ts: string; email?: string }) => {
      setLiveShots(prev => ({
        ...prev,
        [data.sessionId]: { filename: data.filename, url: data.url, email: data.email, ts: data.ts }
      }));
      // Refresh sessions so gallery updates
      fetch('/api/sessions').then(r => r.json()).then(setSessions).catch(() => { });
    });

    return () => { socket.disconnect(); };
  }, []);

  // Initial load
  useEffect(() => {
    fetch('/api/config').then(r => r.json()).then(setConfig).catch(console.error);
    fetch('/api/processes').then(r => r.json()).then((list: ProcessInfo[]) => {
      const m: Record<string, ProcessInfo> = {};
      list.forEach(p => { if (p) m[p.id] = p; });
      setProcesses(m);
    }).catch(console.error);
    fetch('/api/sessions').then(r => r.json()).then(setSessions).catch(console.error);
    fetch('/api/logfiles').then(r => r.json()).then(setLogFiles).catch(console.error);
  }, []);

  async function post(url: string, body?: unknown) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return r.json();
  }

  function optimisticAdd(id: string, name: string, command: string, pid?: number) {
    setProcesses(p => ({
      ...p,
      [id]: {
        id, name, command, cwd: '', pid,
        status: 'running',
        startedAt: new Date().toISOString(),
        logs: [], stoppedAt: null, exitCode: null,
      },
    }));
  }

  const startCamofox = useCallback(async () => {
    const res = await post('/api/processes/camofox/start');
    if (res.error) { addToast(`Camofox: ${res.error}`, 'error'); return; }
    addToast('🦊 Camofox đã khởi động!', 'success');
    optimisticAdd('camofox', '🦊 Camofox Browser Server', 'node server.js', res.pid);
  }, [addToast, config]);

  const startWorker = useCallback(async () => {
    const res = await post('/api/processes/worker/start');
    if (res.error) { addToast(`Worker: ${res.error}`, 'error'); return; }
    addToast('🤖 Worker đã khởi động!', 'success');
    optimisticAdd('worker', '🤖 Auto-Login Worker', 'node scripts/auto-login-worker.js', res.pid);
  }, [addToast]);

  const startConnectWorker = useCallback(async () => {
    const res = await post('/api/processes/connect-worker/start');
    if (res.error) { addToast(`Connect Worker: ${res.error}`, 'error'); return; }
    addToast('🔌 Auto-Connect Worker đã khởi động!', 'success');
    optimisticAdd('connect-worker', '🔌 Auto-Connect Worker', 'node scripts/auto-connect-worker.js', res.pid);
  }, [addToast]);

  const stopProcess = useCallback(async (id: string) => {
    const res = await post(`/api/processes/${id}/stop`);
    if (res.error) addToast(`Lỗi: ${res.error}`, 'error');
    else addToast('Đã dừng process', 'info');
  }, [addToast]);

  const runScript = useCallback(async (name: string, args: string[] = []): Promise<string | null> => {
    const res = await post('/api/processes/script/run', { scriptName: name, args });
    if (res.error) { addToast(`Lỗi: ${res.error}`, 'error'); return null; }
    addToast(`📜 Đang chạy ${name}`, 'success');
    optimisticAdd(res.id, `📜 ${name}`, `node scripts/${name}`, res.pid);
    return res.id;
  }, [addToast]);

  const saveConfig = useCallback(async (cfg: Partial<AppConfig>) => {
    const res = await post('/api/config', cfg);
    if (res.ok) { setConfig(res.config); addToast('✅ Đã lưu cài đặt', 'success'); }
  }, [addToast]);

  const pingCamofox = useCallback(() => fetch('/api/camofox/ping').then(r => r.json()), []);
  const pingGateway = useCallback(() => fetch('/api/gateway/ping').then(r => r.json()), []);
  const getScripts = useCallback(() => fetch('/api/scripts').then(r => r.json()), []);

  const refreshSessions = useCallback(async () => {
    const s = await fetch('/api/sessions').then(r => r.json());
    setSessions(s);
  }, []);

  const refreshLogFiles = useCallback(async () => {
    const l = await fetch('/api/logfiles').then(r => r.json());
    setLogFiles(l);
  }, []);

  return (
    <Ctx.Provider value={{
      processes, config, connected, view, sessions, logFiles,
      liveShots, selectedLog, toasts,
      setView: setViewWithHash, setSelectedLog,
      startCamofox, startWorker, startConnectWorker, stopProcess, runScript,
      saveConfig, pingCamofox, pingGateway, getScripts,
      refreshSessions, refreshLogFiles,
      addToast,
    }}>
      {children}
    </Ctx.Provider>
  );
}
