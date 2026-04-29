'use client';
import React, { createContext, useContext, useCallback, useState, useEffect, useRef } from 'react';
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
  logFile?: string; args?: string[];
  logs: LogEntry[];
}

export interface AppConfig {
  camofoxPath: string; camofoxNodePath?: string; camofoxPort: number; camofoxApi: string;
  gatewayUrl: string; workerAuthToken: string;
  pollIntervalMs: number; maxThreads: number;
  /** Ép Camofox dùng locale 'en-US' bất kể proxy GeoIP, để UI luôn render English */
  forceEnLocale?: boolean;
  /** Worker mode: 'auto' | 'direct-login' | 'pkce-login' */
  workerMode?: string;
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
  socket: Socket | null;
  setView: (v: string) => void;
  setSelectedLog: (id: string | null) => void;
  startCamofox: () => Promise<void>;
  startWorker: () => Promise<void>;
  stopProcess: (id: string) => Promise<void>;
  runScript: (name: string, args?: string[]) => Promise<string | null>;
  saveConfig: (cfg: Partial<AppConfig>) => Promise<void>;
  pingCamofox: () => Promise<{ ok: boolean; error?: string }>;
  pingGateway: () => Promise<{ ok: boolean; status?: number; error?: string }>;
  getScripts: () => Promise<string[]>;
  refreshSessions: () => Promise<void>;
  refreshLogFiles: () => Promise<void>;
  refreshProcesses: () => Promise<void>;
  refreshAccounts: () => Promise<void>;
  accounts: any[];
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
  const [accounts, setAccounts] = useState<any[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [socket, setSocket] = useState<Socket | null>(null);
  const sessionsRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disconnectDebounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const refreshProcesses = useCallback(async () => {
    try {
      const list: ProcessInfo[] = await fetch('/api/processes').then(r => r.json());
      const m: Record<string, ProcessInfo> = {};
      list.forEach(p => { if (p) m[p.id] = p; });
      setProcesses(m);
    } catch { }
  }, []);

  const queueRefreshSessions = useCallback(() => {
    if (sessionsRefreshTimer.current) return;
    sessionsRefreshTimer.current = setTimeout(async () => {
      sessionsRefreshTimer.current = null;
      try {
        const s = await fetch('/api/sessions').then(r => r.json());
        setSessions(s);
      } catch { }
    }, 900);
  }, []);

  // Socket.io
  useEffect(() => {
    const markDisconnectedSoon = (delayMs = 1500) => {
      if (disconnectDebounceTimer.current) {
        clearTimeout(disconnectDebounceTimer.current);
      }
      disconnectDebounceTimer.current = setTimeout(() => {
        setConnected(false);
        disconnectDebounceTimer.current = null;
      }, delayMs);
    };

    const clearDisconnectDebounce = () => {
      if (disconnectDebounceTimer.current) {
        clearTimeout(disconnectDebounceTimer.current);
        disconnectDebounceTimer.current = null;
      }
    };

    const socketInstance: Socket = io('/', {
      path: '/socket.io',
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 800,
      reconnectionDelayMax: 8000,
      timeout: 20000,
    });
    setSocket(socketInstance);
    socketInstance.on('connect', () => {
      clearDisconnectDebounce();
      setConnected(true);
      refreshProcesses();
      queueRefreshSessions();
    });
    socketInstance.on('disconnect', () => {
      markDisconnectedSoon(1500);
      refreshProcesses();
      queueRefreshSessions();
    });
    socketInstance.on('reconnect', (attemptNumber) => {
      console.log('[Socket] Reconnected after', attemptNumber, 'attempts');
      setConnected(true);
      refreshProcesses();
    });
    socketInstance.on('reconnect_attempt', (attemptNumber) => {
      console.log('[Socket] Reconnection attempt', attemptNumber);
    });
    socketInstance.on('reconnect_failed', () => {
      console.log('[Socket] Reconnection failed');
      markDisconnectedSoon(0);
    });
    socketInstance.on('connect_error', (err) => {
      console.log('[Socket] Connect error:', err?.message || String(err));
      markDisconnectedSoon(1000);
    });

    socketInstance.on('processes:sync', (list: ProcessInfo[]) => {
      const m: Record<string, ProcessInfo> = {};
      list.forEach(p => {
        if (!p) return;
        m[p.id] = p;
        socketInstance.emit('process:getLogs', { id: p.id });
      });
      setProcesses(m);
    });

    socketInstance.on('process:log', ({ id, log }: { id: string; log: LogEntry }) => {
      setProcesses(p => {
        const e = p[id] || { 
          id, name: `Script ${id}`, command: '', cwd: '', 
          status: 'running', startedAt: new Date().toISOString(), logs: [] 
        };
        return { ...p, [id]: { ...e, logs: [...e.logs, log].slice(-5000) } };
      });
    });

    socketInstance.on('process:logsHistory', ({ id, logs }: { id: string; logs: LogEntry[] }) => {
      setProcesses(p => {
        const e = p[id] || {
          id, name: `Script ${id}`, command: '', cwd: '',
          status: 'running', startedAt: new Date().toISOString(), logs: []
        };
        return { ...p, [id]: { ...e, logs: Array.isArray(logs) ? logs.slice(-5000) : e.logs } };
      });
    });

    socketInstance.on('process:status', ({ id, status, exitCode, pid, name }: any) => {
      setProcesses(p => {
        const e = p[id] || { 
          id, name: name || `Script ${id}`, command: '', cwd: '', 
          status: status || 'running', startedAt: new Date().toISOString(), logs: [] 
        };
        return { ...p, [id]: { ...e, status: status || e.status, exitCode: exitCode ?? e.exitCode, pid: pid ?? e.pid, name: name || e.name } };
      });
    });

    // Live screenshot pushed from server when new file appears
    socketInstance.on('screenshot:new', (data: { sessionId: string; filename: string; url: string; ts: string; email?: string }) => {
      setLiveShots(prev => ({
        ...prev,
        [data.sessionId]: { filename: data.filename, url: data.url, email: data.email, ts: data.ts }
      }));
      // Keep sessions in sync without immediate full reload on every frame.
      setSessions(prev => {
        const idx = prev.findIndex(s => s.id === data.sessionId);
        if (idx === -1) return prev;
        const session = prev[idx];
        const exists = session.images.some(img => img.filename === data.filename);
        const nextShot: Screenshot = { filename: data.filename, url: data.url, email: data.email, ts: data.ts };
        const nextSession: Session = {
          ...session,
          mtime: data.ts || session.mtime,
          imageCount: exists ? session.imageCount : session.imageCount + 1,
          images: exists ? session.images : [nextShot, ...session.images].slice(0, 200),
        };
        const out = [...prev];
        out[idx] = nextSession;
        return out;
      });
      queueRefreshSessions();
    });

    return () => {
      if (sessionsRefreshTimer.current) {
        clearTimeout(sessionsRefreshTimer.current);
        sessionsRefreshTimer.current = null;
      }
      if (disconnectDebounceTimer.current) {
        clearTimeout(disconnectDebounceTimer.current);
        disconnectDebounceTimer.current = null;
      }
      socketInstance.disconnect();
    };
  }, [queueRefreshSessions, refreshProcesses]);

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
    fetch('/api/vault/accounts').then(r => r.json()).then(res => setAccounts(res.data || [])).catch(console.error);
  }, []);

  // Fallback sync when socket disconnects or misses updates.
  useEffect(() => {
    const interval = connected ? 10000 : 3000;
    const t = setInterval(() => {
      refreshProcesses();
      if (!connected) queueRefreshSessions();
    }, interval);
    return () => clearInterval(t);
  }, [connected, queueRefreshSessions, refreshProcesses]);

  // Socket watchdog: if disconnected for too long, trigger reconnect.
  useEffect(() => {
    if (connected || !socket) return;
    const t = setInterval(() => {
      if (!socket.connected) {
        try { socket.connect(); } catch { }
      }
    }, 5000);
    return () => clearInterval(t);
  }, [connected, socket]);

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
    refreshProcesses();
  }, [addToast, config, refreshProcesses]);

  const startWorker = useCallback(async () => {
    const res = await post('/api/processes/worker/start');
    if (res.error) { addToast(`Worker: ${res.error}`, 'error'); return; }
    addToast('🤖 Unified Worker đã khởi động!', 'success');
    optimisticAdd('worker', '🤖 Unified Auto Worker', 'node scripts/auto-worker.js', res.pid);
    refreshProcesses();
  }, [addToast, refreshProcesses]);

  const stopProcess = useCallback(async (id: string) => {
    const res = await post(`/api/processes/${id}/stop`);
    if (res.error) addToast(`Lỗi: ${res.error}`, 'error');
    else addToast('Đã dừng process', 'info');
    refreshProcesses();
  }, [addToast, refreshProcesses]);

  const runScript = useCallback(async (name: string, args: string[] = []): Promise<string | null> => {
    const res = await post('/api/processes/script/run', { scriptName: name, args });
    if (res.error) { addToast(`Lỗi: ${res.error}`, 'error'); return null; }
    addToast(`📜 Đang chạy ${name}`, 'success');
    optimisticAdd(res.id, `📜 ${name}`, `node scripts/${name}`, res.pid);
    refreshProcesses();
    return res.id;
  }, [addToast, refreshProcesses]);

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

  const refreshAccounts = useCallback(async () => {
    const res = await fetch('/api/vault/accounts').then(r => r.json());
    setAccounts(res.data || []);
  }, []);

  return (
    <Ctx.Provider value={{
      processes, config, connected, view, sessions, logFiles,
      liveShots, selectedLog, toasts, socket,
      setView: setViewWithHash, setSelectedLog,
      startCamofox, startWorker, stopProcess, runScript,
      saveConfig, pingCamofox, pingGateway, getScripts,
      refreshSessions, refreshLogFiles, refreshProcesses, refreshAccounts,
      accounts,
      addToast,
    }}>
      {children}
    </Ctx.Provider>
  );
}
