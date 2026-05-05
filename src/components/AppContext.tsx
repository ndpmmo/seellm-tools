'use client';
import React, { createContext, useContext, useCallback, useState, useEffect, useRef } from 'react';

// ─── Types ────────────────────────────────────────────────────────────────────
export interface LogEntry { type: 'stdout' | 'stderr' | 'system'; text: string; ts: string; }

interface ProcessStatusEvent {
  id: string;
  status?: ProcessInfo['status'];
  exitCode?: number | null;
  pid?: number;
  name?: string;
}
export interface Screenshot { filename: string; url: string; email?: string; ts?: string; }
export interface Session { id: string; dir: string; imageCount: number; images: Screenshot[]; createdAt?: string; mtime: string; }
export interface LogFile { filename: string; size: number; createdAt?: string; mtime: string; }

export interface BrowserProfile {
  id: string; name: string; group_name: string;
  user_agent: string; screen_resolution: string; language: string;
  timezone: string; webgl_vendor: string; webgl_renderer: string;
  canvas_noise: number; font_masking: string;
  proxy_url: string; start_url: string;
  status: 'idle' | 'launching' | 'active' | 'error';
  camofox_port: number | null;
  camofox_pid: number | null; tab_id: string | null;
  tags: string[]; notes: string;
  last_opened_at: string | null;
  created_at: string; updated_at: string;
}

export interface ProfileOptions {
  presets: { key: string; label: string; icon: string }[];
  timezones: string[];
  languages: { value: string; label: string }[];
  resolutions: string[];
  proxies: { id: string; label: string; url: string }[];
}

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
  /** Bật protocol-mode registration làm primary flow (true = API-first, false = browser-only) */
  protocolFirst?: boolean;
}

interface Toast { id: string; message: string; type: 'success' | 'error' | 'info' | 'warning'; }

interface IApp {
  processes: Record<string, ProcessInfo>;
  config: AppConfig | null;
  connected: boolean;
  sseConnected: boolean;
  realtimeConnected: boolean;
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
  accounts: unknown[];
  addToast: (msg: string, type?: Toast['type']) => void;
  // Multi Profile
  profiles: BrowserProfile[];
  profileOptions: ProfileOptions | null;
  refreshProfiles: () => Promise<void>;
  refreshProfileOptions: () => Promise<void>;
  launchProfile: (id: string) => Promise<void>;
  closeProfile: (id: string) => Promise<void>;
  createProfile: (data: Partial<BrowserProfile> & { name: string }) => Promise<BrowserProfile | null>;
  updateProfile: (id: string, data: Partial<BrowserProfile>) => Promise<void>;
  deleteProfile: (id: string) => Promise<void>;
  cloneProfile: (id: string, newName?: string) => Promise<BrowserProfile | null>;
  navigateProfile: (id: string, url: string) => Promise<void>;
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
  const [accounts, setAccounts] = useState<unknown[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [profiles, setProfiles] = useState<BrowserProfile[]>([]);
  const [profileOptions, setProfileOptions] = useState<ProfileOptions | null>(null);
  const [sseConnected, setSseConnected] = useState(false);
  const [realtimeConnected, setRealtimeConnected] = useState(false);
  const connectedRef = useRef(false);
  const sseConnectedRef = useRef(false);
  const sessionsRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disconnectDebounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const processedEventsCache = useRef<Map<string, number>>(new Map());

  // Batched state updates for high-frequency events
  const processesUpdateRef = useRef<Record<string, ProcessInfo>>({});
  const liveShotsUpdateRef = useRef<Record<string, Screenshot>>({});
  const processesUpdateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const liveShotsUpdateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushProcessesUpdate = useCallback(() => {
    if (Object.keys(processesUpdateRef.current).length === 0) return;
    setProcesses(p => ({ ...p, ...processesUpdateRef.current }));
    processesUpdateRef.current = {};
    processesUpdateTimer.current = null;
  }, []);

  const queueProcessesUpdate = useCallback((update: Record<string, ProcessInfo>) => {
    processesUpdateRef.current = { ...processesUpdateRef.current, ...update };
    if (!processesUpdateTimer.current) {
      processesUpdateTimer.current = setTimeout(flushProcessesUpdate, 50);
    }
  }, [flushProcessesUpdate]);

  const flushLiveShotsUpdate = useCallback(() => {
    if (Object.keys(liveShotsUpdateRef.current).length === 0) return;
    setLiveShots(p => ({ ...p, ...liveShotsUpdateRef.current }));
    liveShotsUpdateRef.current = {};
    liveShotsUpdateTimer.current = null;
  }, []);

  const queueLiveShotsUpdate = useCallback((update: Record<string, Screenshot>) => {
    liveShotsUpdateRef.current = { ...liveShotsUpdateRef.current, ...update };
    if (!liveShotsUpdateTimer.current) {
      liveShotsUpdateTimer.current = setTimeout(flushLiveShotsUpdate, 50);
    }
  }, [flushLiveShotsUpdate]);

  useEffect(() => {
    connectedRef.current = connected;
  }, [connected]);

  useEffect(() => {
    sseConnectedRef.current = sseConnected;
  }, [sseConnected]);

  useEffect(() => {
    setConnected(sseConnected);
    setRealtimeConnected(sseConnected);
  }, [sseConnected]);

  const addToast = useCallback((message: string, type: Toast['type'] = 'info') => {
    const id = Math.random().toString(36).slice(2);
    setToasts(p => [...p, { id, message, type }]);
    setTimeout(() => setToasts(p => p.filter(t => t.id !== id)), 4500);
  }, []);

  // Dedup helper to prevent duplicate event processing
  const isEventProcessed = useCallback((eventType: string, id: string, ts: string) => {
    const key = `${eventType}:${id}:${ts}`;
    const now = Date.now();
    const lastProcessed = processedEventsCache.current.get(key);
    if (lastProcessed && now - lastProcessed < 1000) {
      return true; // Already processed within last second
    }
    processedEventsCache.current.set(key, now);
    // Clean old entries (older than 10 seconds)
    if (processedEventsCache.current.size > 1000) {
      for (const [k, v] of processedEventsCache.current) {
        if (now - v > 10000) processedEventsCache.current.delete(k);
      }
    }
    return false;
  }, []);

  // Hash Routing - read hash only after hydration (client-only)
  useEffect(() => {
    if (typeof window !== 'undefined') {
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

  const refreshAccounts = useCallback(async () => {
    const res = await fetch('/api/vault/accounts').then(r => r.json());
    setAccounts(res.data || []);
  }, []);

  // SSE (Server-Sent Events) - primary realtime transport
  useEffect(() => {
    let eventSource: EventSource | null = null;
    let closedByCleanup = false;

    const updateRealtimeFromFallback = () => {
      setRealtimeConnected(false);
    };

    try {
      eventSource = new EventSource('/api/events/stream');
      console.log('[SSE] Connecting...');

      eventSource.addEventListener('ready', () => {
        console.log('[SSE] Ready');
        setSseConnected(true);
      });

      eventSource.addEventListener('processes:sync', (e: MessageEvent) => {
        try {
          const list: ProcessInfo[] = JSON.parse(e.data);
          const m: Record<string, ProcessInfo> = {};
          list.forEach(p => {
            if (!p) return;
            m[p.id] = p;
            // Fetch logs via HTTP instead of socket to remove socket dependency
            fetch(`/api/processes/${p.id}/logs`).then(r => r.json()).then(({ logs }: { logs: LogEntry[] }) => {
              setProcesses(prev => {
                const existing = prev[p.id] || p;
                return { ...prev, [p.id]: { ...existing, logs: Array.isArray(logs) ? logs.slice(-5000) : existing.logs } };
              });
            }).catch(() => {
              // If fetch fails, keep empty logs
              setProcesses(prev => {
                const existing = prev[p.id] || p;
                return { ...prev, [p.id]: { ...existing, logs: [] } };
              });
            });
          });
          setProcesses(m);
          console.log('[SSE] processes:sync received');
        } catch (err) {
          console.warn('[SSE] Failed to parse processes:sync:', err);
        }
      });

      eventSource.addEventListener('process:log', (e: MessageEvent) => {
        try {
          const data: { id: string; log?: LogEntry; logs?: LogEntry[] } = JSON.parse(e.data);
          const logs = data.logs || (data.log ? [data.log] : []);
          // Dedup to prevent duplicate processing
          logs.forEach(log => {
            if (isEventProcessed('process:log', data.id, log.ts)) return;
          });
          // Use batching to reduce rerenders
          setProcesses(p => {
            const e = p[data.id] || {
              id: data.id, name: `Script ${data.id}`, command: '', cwd: '',
              status: 'running', startedAt: new Date().toISOString(), logs: []
            };
            return { ...p, [data.id]: { ...e, logs: [...e.logs, ...logs].slice(-5000) } };
          });
        } catch (err) {
          console.warn('[SSE] Failed to parse process:log:', err);
        }
      });

      eventSource.addEventListener('process:status', (e: MessageEvent) => {
        try {
          const { id, status, exitCode, pid, name }: ProcessStatusEvent = JSON.parse(e.data);
          if (isEventProcessed('process:status', id, `${status || 'unknown'}:${exitCode ?? 'null'}:${pid ?? 'null'}`)) return;
          setProcesses(p => {
            const existing = p[id] || {
              id, name: name || `Script ${id}`, command: '', cwd: '',
              status: status || 'running', startedAt: new Date().toISOString(), logs: []
            };
            queueProcessesUpdate({
              [id]: {
                ...existing,
                status: status || existing.status,
                exitCode: exitCode ?? existing.exitCode,
                pid: pid ?? existing.pid,
                name: name || existing.name,
              }
            });
            return p;
          });
        } catch (err) {
          console.warn('[SSE] Failed to parse process:status:', err);
        }
      });

      eventSource.addEventListener('screenshot:new', (e: MessageEvent) => {
        try {
          const data: { sessionId: string; filename: string; url: string; ts: string; email?: string } = JSON.parse(e.data);
          // Dedup to prevent duplicate processing
          if (isEventProcessed('screenshot:new', data.sessionId, data.ts)) return;
          // Use batching for live shots to reduce rerenders
          queueLiveShotsUpdate({
            [data.sessionId]: { filename: data.filename, url: data.url, email: data.email, ts: data.ts }
          });
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
        } catch (err) {
          console.warn('[SSE] Failed to parse screenshot:new:', err);
        }
      });

      eventSource.addEventListener('email-pool-updated', (e: MessageEvent) => {
        try {
          const data: { email: string } = JSON.parse(e.data);
          // Trigger vault accounts refresh when email pool changes
          refreshAccounts();
        } catch (err) {
          console.warn('[SSE] Failed to parse email-pool-updated:', err);
        }
      });

      eventSource.addEventListener('vault:update', (e: MessageEvent) => {
        try {
          // Trigger vault refresh when cloud sync updates
          refreshAccounts();
        } catch (err) {
          console.warn('[SSE] Failed to parse vault:update:', err);
        }
      });

      eventSource.addEventListener('profile:launched', (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data);
          refreshProfiles();
          addToast(`🦊 Profile "${data.id}" launched on port ${data.port}`, 'success');
        } catch { }
      });

      eventSource.addEventListener('profile:closed', (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data);
          refreshProfiles();
          addToast(`Profile "${data.id}" closed`, 'info');
        } catch { }
      });

      eventSource.addEventListener('profile:status', (e: MessageEvent) => {
        try {
          refreshProfiles();
        } catch { }
      });

      eventSource.addEventListener('ping', () => {
        // Heartbeat, no action needed
      });

      eventSource.addEventListener('error', () => {
        if (closedByCleanup) return;
        const readyState = eventSource?.readyState;
        const online = typeof navigator !== 'undefined' ? navigator.onLine : undefined;
        if (readyState === EventSource.CLOSED) {
          console.warn('[SSE] Connection closed; browser will auto-reconnect', { readyState, online });
        } else {
          console.info('[SSE] Transient stream interruption', { readyState, online });
        }
        setSseConnected(false);
        updateRealtimeFromFallback();
      });

    } catch (err) {
      console.error('[SSE] Failed to connect:', err);
    }

    return () => {
      if (eventSource) {
        closedByCleanup = true;
        eventSource.close();
        console.log('[SSE] Disconnected');
        setSseConnected(false);
        updateRealtimeFromFallback();
      }
    };
  }, [isEventProcessed, queueRefreshSessions, refreshAccounts]);

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
    fetch('/api/profiles').then(r => r.json()).then(setProfiles).catch(console.error);
    fetch('/api/profiles/options').then(r => r.json()).then(setProfileOptions).catch(console.error);
  }, []);

  // Fallback sync when realtime transport disconnects or misses updates.
  useEffect(() => {
    const interval = realtimeConnected ? 10000 : 3000;
    const t = setInterval(() => {
      refreshProcesses();
      if (!realtimeConnected) queueRefreshSessions();
    }, interval);
    return () => clearInterval(t);
  }, [realtimeConnected, queueRefreshSessions, refreshProcesses]);

  async function post(url: string, body?: unknown) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    try {
      return JSON.parse(text);
    } catch {
      return { error: text || `Request failed with status ${r.status}` };
    }
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
  }, [addToast, refreshProcesses]);

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

  const refreshProfiles = useCallback(async () => {
    const p = await fetch('/api/profiles').then(r => r.json());
    setProfiles(p);
  }, []);

  const refreshProfileOptions = useCallback(async () => {
    const o = await fetch('/api/profiles/options').then(r => r.json());
    setProfileOptions(o);
  }, []);

  const launchProfile = useCallback(async (id: string) => {
    const res = await post(`/api/profiles/${id}/launch`);
    if (res.error) { addToast(`Launch failed: ${res.error}`, 'error'); return; }
    refreshProfiles();
  }, [addToast, refreshProfiles]);

  const closeProfile = useCallback(async (id: string) => {
    const res = await post(`/api/profiles/${id}/close`);
    if (res.error) { addToast(`Close failed: ${res.error}`, 'error'); return; }
    refreshProfiles();
  }, [addToast, refreshProfiles]);

  const createProfile = useCallback(async (data: Partial<BrowserProfile> & { name: string }) => {
    const res = await post('/api/profiles', data);
    if (res.error) { addToast(`Create failed: ${res.error}`, 'error'); return null; }
    addToast(`✅ Profile "${data.name}" created`, 'success');
    refreshProfiles();
    return res.profile;
  }, [addToast, refreshProfiles]);

  const updateProfile = useCallback(async (id: string, data: Partial<BrowserProfile>) => {
    const res = await fetch(`/api/profiles/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }).then(r => r.json());
    if (res.error) { addToast(`Update failed: ${res.error}`, 'error'); return; }
    refreshProfiles();
  }, [addToast, refreshProfiles]);

  const deleteProfile = useCallback(async (id: string) => {
    const res = await fetch(`/api/profiles/${id}`, { method: 'DELETE' }).then(r => r.json());
    if (res.error) { addToast(`Delete failed: ${res.error}`, 'error'); return; }
    addToast('Profile deleted', 'info');
    refreshProfiles();
  }, [addToast, refreshProfiles]);

  const cloneProfile = useCallback(async (id: string, newName?: string) => {
    const res = await post(`/api/profiles/${id}/clone`, { name: newName });
    if (res.error) { addToast(`Clone failed: ${res.error}`, 'error'); return null; }
    addToast('Profile cloned', 'success');
    refreshProfiles();
    return res.profile;
  }, [addToast, refreshProfiles]);

  const navigateProfile = useCallback(async (id: string, url: string) => {
    const res = await post(`/api/profiles/${id}/navigate`, { url });
    if (res.error) addToast(`Navigate failed: ${res.error}`, 'error');
  }, [addToast]);

  return (
    <Ctx.Provider value={{
      processes, config, connected, sseConnected, realtimeConnected, view, sessions, logFiles,
      liveShots, selectedLog, toasts,
      setView: setViewWithHash, setSelectedLog,
      startCamofox, startWorker, stopProcess, runScript,
      saveConfig, pingCamofox, pingGateway, getScripts,
      refreshSessions, refreshLogFiles, refreshProcesses, refreshAccounts,
      accounts,
      addToast,
      profiles, profileOptions, refreshProfiles, refreshProfileOptions,
      launchProfile, closeProfile, createProfile, updateProfile, deleteProfile,
      cloneProfile, navigateProfile,
    }}>
      {children}
    </Ctx.Provider>
  );
}
