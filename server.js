#!/usr/bin/env node
/**
 * SeeLLM Tools - Server
 * Express + SSE: manage processes, serve screenshots, sessions API
 */

import { createServer } from 'http';
import { parse } from 'url';
import next from 'next';
import express from 'express';
import { spawn, execSync } from 'child_process';
import {
  existsSync, readFileSync, writeFileSync,
  mkdirSync, createWriteStream,
  unlinkSync, rmSync,
} from 'fs';
import { readdir, stat } from 'fs/promises';
import chokidar from 'chokidar';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadConfig, saveConfig } from './server/db/config.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
import vaultRouter, { setSSEEmitter, registerProcessManager } from './server/routes/vault.js';
import profileRouter, { setProfileSSEEmitter } from './server/routes/profiles.js';
import auditLogRouter, { setAuditSSEEmitter } from './server/routes/auditLog.js';
import { vault } from './server/db/vault.js';
import { auditLog } from './server/db/auditLog.js';
import { SyncManager } from './server/services/syncManager.js';
import { recoverProfilesOnStartup, closeAllProfiles } from './server/profileManager.js';
import { getNextProxyLabel, reallocateAccountsFromDeletedProxies, allocateProxySlotForAccount } from './server/services/proxySlotAllocator.js';
import { FINGERPRINT_PRESETS, TIMEZONE_OPTIONS, LANGUAGE_OPTIONS, RESOLUTION_OPTIONS } from './server/fingerprintPresets.js';

const dev = process.env.NODE_ENV !== 'production';
const hostname = 'localhost';
const PORT = parseInt(process.env.PORT || '4000', 10);

// ─── Paths ───────────────────────────────────────────────────────────────────
const SCRIPTS_DIR = path.join(__dirname, 'scripts');
const DATA_DIR = path.join(__dirname, 'data');
const SCREENSHOTS_DIR = path.join(DATA_DIR, 'screenshots');
const LOGS_DIR = path.join(DATA_DIR, 'logs');
const NEXT_DEV_CACHE_DIR = path.join(__dirname, '.next', 'dev');

// Ensure dirs exist
[DATA_DIR, SCREENSHOTS_DIR, LOGS_DIR].forEach(d => {
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
});

// ─── Turbopack Cache Guard ──────────────────────────────────────────────────
// In dev mode, .next/dev cache can grow unbounded (800MB+) and become corrupted,
// causing Turbopack to enter an infinite recompile loop (500%+ CPU).
// Auto-purge if cache exceeds 200MB on startup.
if (dev && existsSync(NEXT_DEV_CACHE_DIR)) {
  try {
    const sizeOut = execSync(`du -sm "${NEXT_DEV_CACHE_DIR}" 2>/dev/null`, { encoding: 'utf8' });
    const sizeMB = parseInt(sizeOut.split('\t')[0], 10);
    const MAX_CACHE_MB = parseInt(process.env.SEELLM_MAX_DEV_CACHE_MB || '200', 10);
    if (sizeMB > MAX_CACHE_MB) {
      console.log(`[Turbopack] ⚠️ .next/dev cache is ${sizeMB}MB (limit: ${MAX_CACHE_MB}MB) — purging to prevent CPU spiral`);
      rmSync(NEXT_DEV_CACHE_DIR, { recursive: true, force: true });
      mkdirSync(NEXT_DEV_CACHE_DIR, { recursive: true });
    } else {
      console.log(`[Turbopack] .next/dev cache: ${sizeMB}MB (OK, limit: ${MAX_CACHE_MB}MB)`);
    }
  } catch (e) {
    // If du fails (e.g., directory doesn't exist yet), just skip
    console.log(`[Turbopack] Cache check skipped: ${e.message}`);
  }
}

// ─── Processes ───────────────────────────────────────────────────────────────
const processes = {};

// ─── SSE (Server-Sent Events) ───────────────────────────────────────────────
const sseClients = new Set();

function broadcastRealtimeEvent(type, payload) {
  // Broadcast via SSE only (consolidated from dual Socket.IO + SSE)
  const data = JSON.stringify(payload);
  sseClients.forEach(res => {
    try {
      res.write(`event: ${type}\ndata: ${data}\n\n`);
    } catch (e) {
      console.warn('[SSE] Write failed, removing client:', e.message);
      sseClients.delete(res);
    }
  });
}

// Export SSE emitter for use in other modules (e.g., vault.js)
export function emitSSE(type, payload) {
  broadcastRealtimeEvent(type, payload);
}

function logServerEvent(label, extra = '') {
  const suffix = extra ? ` ${extra}` : '';
  console.log(`[Server] ${label}${suffix}`);
}

function makeLogPath(id, name) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const safe = name.replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 60);
  return path.join(LOGS_DIR, `${ts}_${safe}.log`);
}

// Buffered log writers - map of logFile -> { buffer, timer, stream }
const logWriters = new Map();

function getLogWriter(logFile) {
  if (logWriters.has(logFile)) return logWriters.get(logFile);

  // Ensure directory exists
  mkdirSync(path.dirname(logFile), { recursive: true });

  // Create write stream with buffering
  const stream = createWriteStream(logFile, { flags: 'a', encoding: 'utf8' });
  const buffer = [];
  let timer = null;

  const flush = () => {
    if (buffer.length === 0) return;
    const chunk = buffer.join('');
    buffer.length = 0;
    try {
      stream.write(chunk);
    } catch (err) {
      console.error(`[ProcessLog] flush failed for ${logFile}:`, err.message);
    }
  };

  // Flush every 100ms or when buffer reaches 50KB
  const scheduleFlush = () => {
    if (timer) return;
    timer = setTimeout(() => {
      flush();
      timer = null;
    }, 100);
  };

  const writer = {
    write: (text) => {
      buffer.push(text);
      // Flush if buffer is large (approx 50KB)
      if (buffer.reduce((sum, s) => sum + s.length, 0) > 50000) {
        flush();
      } else {
        scheduleFlush();
      }
    },
    flush,
    close: () => {
      if (timer) clearTimeout(timer);
      flush();
      stream.end();
      logWriters.delete(logFile);
    }
  };

  logWriters.set(logFile, writer);
  return writer;
}

// SSE log batching - batch logs per process to reduce event frequency
const logBatches = new Map(); // processId -> { logs: [], timer: null }

function batchLogForSSE(id, log) {
  if (!logBatches.has(id)) {
    logBatches.set(id, { logs: [], timer: null });
  }

  const batch = logBatches.get(id);
  batch.logs.push(log);

  // Flush batch after 50ms or if it has 20 logs
  if (batch.logs.length >= 20) {
    flushLogBatch(id);
  } else if (!batch.timer) {
    batch.timer = setTimeout(() => flushLogBatch(id), 50);
  }
}

function flushLogBatch(id) {
  const batch = logBatches.get(id);
  if (!batch || batch.logs.length === 0) return;

  if (batch.timer) {
    clearTimeout(batch.timer);
    batch.timer = null;
  }

  broadcastRealtimeEvent('process:log', { id, logs: batch.logs });
  batch.logs = [];
}

function appendToProcessLog(logFile, text) {
  try {
    const writer = getLogWriter(logFile);
    writer.write(text);
  } catch (err) {
    console.error(`[ProcessLog] append failed for ${logFile}:`, err.message);
  }
}

function spawnProcess(id, name, command, args, cwd, env = {}) {
  if (processes[id]?.status === 'running') return { error: `"${id}" đang chạy rồi` };

  const mergedEnv = { ...process.env, ...env };
  let proc;
  try {
    proc = spawn(command, args, { cwd, env: mergedEnv, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) { return { error: e.message }; }

  const logFile = makeLogPath(id, name);
  const entry = {
    proc, id, name,
    command: `${command} ${args.join(' ')}`,
    cwd, pid: proc.pid, status: 'running',
    args,
    startedAt: new Date().toISOString(),
    stoppedAt: null, exitCode: null,
    logFile,
    logs: [],
  };

  // Write header to log file
  appendToProcessLog(logFile, `# ${name}\n# Started: ${entry.startedAt}\n# PID: ${proc.pid}\n\n`);

  function pushLog(type, raw) {
    raw.toString().split('\n').filter(Boolean).forEach(line => {
      const log = { type, text: line, ts: new Date().toISOString() };
      entry.logs.push(log);
      if (entry.logs.length > 5000) entry.logs.shift();
      // Write to log file (buffered)
      appendToProcessLog(logFile, `[${log.ts}] [${type}] ${line}\n`);
      // Batch for SSE delivery
      batchLogForSSE(id, log);
    });
  }

  proc.stdout.on('data', d => pushLog('stdout', d));
  proc.stderr.on('data', d => pushLog('stderr', d));
  proc.on('exit', (code, signal) => {
    // code is 0 for normal exit, null for exit via signal (SIGTERM/SIGKILL)
    entry.status = (code === 0 || code === null) ? 'stopped' : 'error';
    entry.exitCode = code;
    entry.stoppedAt = new Date().toISOString();
    pushLog('system', `Thoát với code ${code} (signal: ${signal})`);
    appendToProcessLog(logFile, `\n# Stopped: ${entry.stoppedAt} | Exit: ${code}\n`);
    // Close the buffered log writer to flush remaining data
    const writer = logWriters.get(logFile);
    if (writer) writer.close();
    // Flush any remaining log batches for SSE
    flushLogBatch(id);
    broadcastRealtimeEvent('process:status', { id, status: entry.status, exitCode: code });
    if (id.startsWith('script_')) {
      const parts = id.split('_');
      const suffix = parts[parts.length - 1];
      if (/^\d{13}$/.test(suffix)) {
        broadcastRealtimeEvent('screenshot:clear', { sessionId: `register_${suffix}` });
        broadcastRealtimeEvent('screenshot:clear', { sessionId: `register_connect_${suffix}` });
      }
    }
  });
  proc.on('error', err => {
    entry.status = 'error';
    pushLog('system', `Lỗi: ${err.message}`);
    broadcastRealtimeEvent('process:status', { id, status: 'error' });
  });

  processes[id] = entry;
  broadcastRealtimeEvent('process:status', { id, status: 'running', name, pid: proc.pid });
  return { pid: proc.pid };
}

function resolveCamofoxNodeCommand(cfg) {
  const configured = String(cfg?.camofoxNodePath || '').trim();
  if (configured && existsSync(configured)) return configured;
  if (existsSync('/usr/local/bin/node')) return '/usr/local/bin/node';
  return 'node';
}

function stopProcess(id) {
  const e = processes[id];
  if (!e || e.status !== 'running') return { error: 'Không đang chạy' };
  try {
    e.proc.kill('SIGTERM');
    setTimeout(() => { if (processes[id]?.status === 'running') e.proc.kill('SIGKILL'); }, 3000);
  } catch (er) { return { error: er.message }; }
  return { ok: true };
}

function safeProc(id) {
  const e = processes[id];
  if (!e) return null;
  const { proc, ...rest } = e;
  return rest;
}

// ─── Sessions (screenshot dirs) ──────────────────────────────────────────────
// Cache sessions to avoid synchronous rescans on every request
let sessionsCache = null;
let sessionsCacheTime = 0;
const SESSIONS_CACHE_TTL = 5000; // 5 seconds

async function listSessions() {
  const now = Date.now();
  if (sessionsCache && (now - sessionsCacheTime < SESSIONS_CACHE_TTL)) {
    return sessionsCache;
  }

  try {
    const entries = await readdir(SCREENSHOTS_DIR);
    const sessions = [];
    for (const d of entries) {
      const dirPath = path.join(SCREENSHOTS_DIR, d);
      let s;
      try { s = await stat(dirPath); } catch { continue; }
      if (!s.isDirectory()) continue;

      let images = [];
      try {
        const files = await readdir(dirPath, { withFileTypes: true });
        for (const file of files) {
          if (file.isDirectory()) {
            const subDirPath = path.join(dirPath, file.name);
            const subFiles = await readdir(subDirPath).catch(() => []);
            for (const sf of subFiles) {
              if (/\.(png|jpg|jpeg|webp)$/i.test(sf)) {
                images.push({
                  filename: `${file.name}/${sf}`,
                  url: `/data/screenshots/${d}/${file.name}/${sf}`
                });
              }
            }
          } else if (/\.(png|jpg|jpeg|webp)$/i.test(file.name)) {
            images.push({
              filename: file.name,
              url: `/data/screenshots/${d}/${file.name}`
            });
          }
        }
        images.sort((a, b) => a.filename.localeCompare(b.filename));
      } catch { }
      sessions.push({
        id: d,
        dir: d,
        imageCount: images.length,
        images,
        createdAt: s.birthtime,
        mtime: s.mtime,
      });
    }
    sessions.sort((a, b) => new Date(b.mtime) - new Date(a.mtime));

    sessionsCache = sessions;
    sessionsCacheTime = now;
    return sessions;
  } catch { return []; }
}

// Watch SCREENSHOTS_DIR for new files → emit SSE event (debounced)
const screenshotEventQueue = new Map(); // sessionId -> { lastEvent: timestamp, timer: null }

function watchScreenshots() {
  try {
    const watcher = chokidar.watch(SCREENSHOTS_DIR, {
      ignored: /(^|[/\\])\../, // ignore dotfiles
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 50,
      },
      useFsEvents: true, // Use native FSEvents on macOS (near-zero CPU)
    });

    watcher.on('add', (filePath) => {
      if (/\.(png|jpg|jpeg|webp)$/i.test(filePath)) {
        const relative = path.relative(SCREENSHOTS_DIR, filePath);
        const parts = relative.split(path.sep);
        const sessionId = parts[0];
        const imgFile = parts[parts.length - 1];

        // Debounce events per session to reduce SSE traffic
        if (screenshotEventQueue.has(sessionId)) {
          const queue = screenshotEventQueue.get(sessionId);
          if (queue.timer) clearTimeout(queue.timer);
        }

        screenshotEventQueue.set(sessionId, {
          lastEvent: Date.now(),
          timer: setTimeout(() => {
            let email = sessionId;
            try {
              const accRow = vault.db.prepare('SELECT email FROM vault_accounts WHERE id = ?').get(sessionId);
              if (accRow && accRow.email) {
                email = accRow.email;
              }
            } catch (e) { }

            const webPath = relative.split(path.sep).join('/');
            broadcastRealtimeEvent('screenshot:new', {
              sessionId,
              filename: webPath.replace(sessionId + '/', ''),
              url: `/data/screenshots/${webPath}`,
              ts: new Date().toISOString(),
              email,
            });

            // Invalidate sessions cache on new screenshot
            sessionsCache = null;
            sessionsCacheTime = 0;

            screenshotEventQueue.delete(sessionId);
          }, 100) // 100ms debounce per session
        });
      }
    });

    watcher.on('error', (err) => {
      console.error('[Screenshots] Watch error:', err.message);
    });
  } catch (e) {
    console.error('[Screenshots] Watch failed:', e.message);
  }
}

// ─── Log files list ──────────────────────────────────────────────────────────
// Cache log files to avoid synchronous rescans on every request
let logFilesCache = null;
let logFilesCacheTime = 0;
const LOGFILES_CACHE_TTL = 5000; // 5 seconds

async function listLogFiles() {
  const now = Date.now();
  if (logFilesCache && (now - logFilesCacheTime < LOGFILES_CACHE_TTL)) {
    return logFilesCache;
  }

  try {
    const entries = await readdir(LOGS_DIR);
    const logFiles = [];
    for (const f of entries) {
      if (!f.endsWith('.log')) continue;
      let s;
      try { s = await stat(path.join(LOGS_DIR, f)); } catch { continue; }
      logFiles.push({ filename: f, size: s.size, createdAt: s.birthtime, mtime: s.mtime });
    }
    logFiles.sort((a, b) => b.filename.localeCompare(a.filename));

    logFilesCache = logFiles;
    logFilesCacheTime = now;
    return logFiles;
  } catch { return []; }
}

// ─── Next.js ─────────────────────────────────────────────────────────────────

// ── Port Conflict Guard ──────────────────────────────────────────────────
// Auto-detect and kill stale process occupying the port BEFORE Next.js init.
// Next.js detects port conflicts during app.prepare() and exits with confusing
// error. We kill the stale process early so Next.js can bind cleanly.
function killStaleProcessOnPort(port) {
  try {
    const lsof = process.platform === 'darwin' ? '/usr/sbin/lsof' : 'lsof';
    const out = execSync(`${lsof} -i :${port} -t -sTCP:LISTEN 2>/dev/null`, { encoding: 'utf8' }).trim();
    if (!out) return false;
    const pids = out.split('\n').filter(Boolean).map(Number).filter(pid => pid !== process.pid);
    if (pids.length === 0) return false;
    for (const pid of pids) {
      console.log(`[PortGuard] ⚠️ Port ${port} occupied by PID ${pid} — killing stale process`);
      try { process.kill(pid, 'SIGKILL'); } catch (_) {}
    }
    // Brief pause to let OS release the port
    execSync('sleep 0.5', { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
}

if (dev) {
  killStaleProcessOnPort(PORT);
}

const app = next({ dev, hostname: 'localhost', port: PORT });
const handle = app.getRequestHandler();

app.prepare().then(async () => {
  const ex = express();
  ex.use(express.json({ limit: '200mb' }));        // ← PHẢI đứng trước để parse body cho vault router
  // Set SSE emitter for vault router
  setSSEEmitter(emitSSE);
  registerProcessManager({
    spawnProcess,
    stopProcess,
    getProcesses: () => processes
  });
  setProfileSSEEmitter(emitSSE);
  setAuditSSEEmitter(emitSSE);
  ex.use('/api/vault', vaultRouter);
  ex.use('/api/profiles', profileRouter);
  ex.use('/api/audit-logs', auditLogRouter);

  // Recover profiles on startup (mark orphaned 'active' profiles as 'idle')
  const recoveredCount = recoverProfilesOnStartup();
  if (recoveredCount) console.log(`[ProfileManager] Recovered ${recoveredCount} orphaned profiles`);

  // Serve screenshots + logs as static files
  ex.use('/data/screenshots', express.static(SCREENSHOTS_DIR));
  ex.use('/data/logs', express.static(LOGS_DIR));

  // ── Config ──────────────────────────────────────────────────────────────
  ex.get('/api/config', (_, res) => res.json(loadConfig()));
  ex.post('/api/config', (req, res) => {
    const old = loadConfig();
    const cfg = { ...old, ...req.body };
    saveConfig(cfg);
    res.json({ ok: true, config: cfg });

    // Audit: detect which keys changed
    const changed = Object.keys(req.body).filter(k => JSON.stringify(req.body[k]) !== JSON.stringify(old[k]));
    if (changed.length > 0) {
      auditLog({
        action: 'config_change',
        entity: 'config',
        entityLabel: 'System Config',
        details: { changed },
        severity: 'info',
        source: 'ui',
      });
    }
  });

  // ── Bootstrap (single-request initial data) ────────────────────────────────
  // Combines config + processes + sessions + logFiles + accounts + profiles + profileOptions
  // into one response to eliminate 7 separate HTTP requests on page load.
  ex.get('/api/bootstrap', async (_, res) => {
    try {
      const [sessionsData, logFilesData] = await Promise.all([
        listSessions(),
        listLogFiles(),
      ]);
      res.json({
        version: JSON.parse(readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version,
        config: loadConfig(),
        processes: Object.keys(processes).map(id => safeProc(id)),
        sessions: sessionsData,
        logFiles: logFilesData,
        accounts: vault.getAccounts(),
        profiles: vault.getActiveProfiles(),
        profileOptions: {
          presets: Object.entries(FINGERPRINT_PRESETS).map(([key, val]) => ({
            key, label: val.label, icon: val.icon,
          })),
          timezones: TIMEZONE_OPTIONS,
          languages: LANGUAGE_OPTIONS,
          resolutions: RESOLUTION_OPTIONS,
          proxies: vault.getProxies().map(p => ({ id: p.id, label: p.label || p.url, url: p.url })),
        },
      });
    } catch (e) {
      console.error('[Bootstrap] Error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── Processes ────────────────────────────────────────────────────────────
  ex.get('/api/processes', (_, res) =>
    res.json(Object.keys(processes).map(id => safeProc(id))));

  ex.get('/api/processes/:id/logs', (req, res) => {
    const e = processes[req.params.id];
    if (!e) return res.status(404).json({ error: 'Process not found' });
    res.json({ id: req.params.id, logs: e.logs });
  });

  // ── SSE (Server-Sent Events) ───────────────────────────────────────────────
  ex.get('/api/events/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    sseClients.add(res);
    console.log('[SSE] Client connected, total clients:', sseClients.size);

    // Send initial processes sync
    const initialProcesses = Object.keys(processes).map(id => safeProc(id));
    res.write(`event: processes:sync\ndata: ${JSON.stringify(initialProcesses)}\n\n`);
    res.write(`event: ready\ndata: {"status":"connected"}\n\n`);

    // Keep-alive heartbeat every 15s to prevent proxy/dev server from closing connection
    const heartbeatInterval = setInterval(() => {
      try {
        res.write(`event: ping\ndata: {"ts":"${new Date().toISOString()}"}\n\n`);
      } catch (e) {
        clearInterval(heartbeatInterval);
        sseClients.delete(res);
      }
    }, 15000);

    req.on('close', () => {
      clearInterval(heartbeatInterval);
      sseClients.delete(res);
      console.log('[SSE] Client disconnected, total clients:', sseClients.size);
    });

    req.on('error', (err) => {
      clearInterval(heartbeatInterval);
      sseClients.delete(res);
      const msg = String(err?.message || err || '').toLowerCase();
      const code = String(err?.code || '').toUpperCase();
      const expectedDisconnect = code === 'ECONNRESET' || msg.includes('aborted') || msg.includes('socket hang up');
      if (expectedDisconnect) {
        console.info('[SSE] Client disconnected abruptly (expected):', err?.message || String(err));
      } else {
        console.warn('[SSE] Client error:', err?.message || String(err));
      }
    });
  });

  ex.post('/api/processes/camofox/start', (req, res) => {
    const cfg = loadConfig();
    const camofoxNode = resolveCamofoxNodeCommand(cfg);
    const r = spawnProcess('camofox', '🦊 Camofox Browser Server',
      camofoxNode, ['server.js'], cfg.camofoxPath,
      { 
        CAMOFOX_PORT: String(cfg.camofoxPort),
        MAX_CONCURRENT_TAB_CREATIONS: String(cfg.maxConcurrentTabCreations || 3),
      });
    if (r.error) return res.status(400).json(r);
    res.json({ ok: true, command: camofoxNode, ...r });

    auditLog({ action: 'start', entity: 'process', entityId: 'camofox', entityLabel: 'Camofox Browser Server', severity: 'success', source: 'ui' });
  });

  ex.post('/api/processes/worker/start', (req, res) => {
    const cfg = loadConfig();
    const r = spawnProcess('worker', '🤖 Unified Auto Worker',
      'node', [path.join(SCRIPTS_DIR, 'auto-worker.js')], __dirname,
      { WORKER_AUTH_TOKEN: cfg.workerAuthToken });
    if (r.error) return res.status(400).json(r);
    res.json({ ok: true, ...r });

    auditLog({ action: 'start', entity: 'process', entityId: 'worker', entityLabel: 'Unified Auto Worker', severity: 'success', source: 'ui' });
  });

  ex.post('/api/processes/connect-worker/start', (req, res) => {
    const cfg = loadConfig();
    const r = spawnProcess('worker', '🤖 Unified Auto Worker',
      'node', [path.join(SCRIPTS_DIR, 'auto-worker.js')], __dirname,
      { WORKER_AUTH_TOKEN: cfg.workerAuthToken });
    if (r.error) return res.status(400).json(r);
    res.json({ ok: true, ...r });

    auditLog({ action: 'start', entity: 'process', entityId: 'worker', entityLabel: 'Auto-Connect Worker', severity: 'success', source: 'ui' });
  });

  ex.post('/api/processes/script/run', (req, res) => {
    const { scriptName, args: extraArgs = [] } = req.body;
    if (!scriptName) return res.status(400).json({ error: 'scriptName required' });
    const scriptPath = path.join(SCRIPTS_DIR, scriptName);
    if (!existsSync(scriptPath)) return res.status(404).json({ error: `Script không tồn tại: ${scriptName}` });
    const procId = `script_${scriptName.replace(/[^a-z0-9]/gi, '_')}_${Date.now()}`;
    const cfg = loadConfig();
    const r = spawnProcess(procId, `📜 ${scriptName}`, 'node', [scriptPath, ...extraArgs], __dirname,
      { WORKER_AUTH_TOKEN: cfg.workerAuthToken });
    if (r.error) return res.status(400).json(r);
    res.json({ ok: true, id: procId, ...r });

    auditLog({ action: 'start', entity: 'process', entityId: procId, entityLabel: scriptName, details: { args: extraArgs }, severity: 'info', source: 'ui' });
  });

  ex.post('/api/processes/:id/stop', (req, res) => {
    const r = stopProcess(req.params.id);
    if (r.error) return res.status(400).json(r);
    res.json({ ok: true });

    auditLog({ action: 'stop', entity: 'process', entityId: req.params.id, entityLabel: req.params.id, severity: 'info', source: 'ui' });
  });

  ex.post('/api/processes/clear-inactive', (req, res) => {
    let clearedCount = 0;
    for (const id of Object.keys(processes)) {
      if (processes[id].status !== 'running') {
        delete processes[id];
        clearedCount++;
      }
    }
    const activeProcesses = Object.keys(processes).map(pid => safeProc(pid));
    broadcastRealtimeEvent('processes:sync', activeProcesses);
    res.json({ ok: true, clearedCount });
  });

  ex.delete('/api/processes/:id', (req, res) => {
    const { id } = req.params;
    if (processes[id]) {
      if (processes[id].status === 'running') {
        return res.status(400).json({ error: 'Không thể xóa tiến trình đang chạy' });
      }
      delete processes[id];
      const activeProcesses = Object.keys(processes).map(pid => safeProc(pid));
      broadcastRealtimeEvent('processes:sync', activeProcesses);
      res.json({ ok: true });
    } else {
      res.status(404).json({ error: 'Không tìm thấy tiến trình' });
    }
  });

  // ── Scripts list ─────────────────────────────────────────────────────────
  ex.get('/api/scripts', async (_, res) => {
    try {
      const entries = await readdir(SCRIPTS_DIR);
      res.json(entries
        .filter(f => (f.endsWith('.js') || f.endsWith('.mjs')) && f !== 'config.js')
        .sort());
    } catch { res.json([]); }
  });

  // ── Sessions (screenshots) ───────────────────────────────────────────────
  ex.get('/api/sessions', async (_, res) => {
    try { res.json(await listSessions()); } catch { res.json([]); }
  });
  ex.get('/api/sessions/:id', async (req, res) => {
    try {
      const sessions = await listSessions();
      const s = sessions.find(x => x.id === req.params.id);
      if (!s) return res.status(404).json({ error: 'Not found' });
      res.json(s);
    } catch { res.status(500).json({ error: 'Failed to list sessions' }); }
  });
  ex.delete('/api/sessions/:id', (req, res) => {
    const safeId = path.basename(req.params.id);
    const sessionDir = path.join(SCREENSHOTS_DIR, safeId);
    if (!existsSync(sessionDir)) return res.status(404).json({ error: 'Not found' });
    try {
      rmSync(sessionDir, { recursive: true, force: true });
      return res.json({ ok: true, deleted: safeId });
    } catch (e) {
      return res.status(500).json({ error: e.message || 'Delete session failed' });
    }
  });
  ex.delete('/api/sessions/:id/images/:filename', (req, res) => {
    const safeId = path.basename(req.params.id);
    const safeFilename = path.basename(req.params.filename);
    const imagePath = path.join(SCREENSHOTS_DIR, safeId, safeFilename);
    if (!existsSync(imagePath)) return res.status(404).json({ error: 'Not found' });
    try {
      unlinkSync(imagePath);
      return res.json({ ok: true, deleted: safeFilename });
    } catch (e) {
      return res.status(500).json({ error: e.message || 'Delete image failed' });
    }
  });

  // ── Log files ────────────────────────────────────────────────────────────
  ex.get('/api/logfiles', async (_, res) => {
    try { res.json(await listLogFiles()); } catch { res.json([]); }
  });
  ex.delete('/api/logfiles', (req, res) => {
    const files = Array.isArray(req.body?.files) ? req.body.files : [];
    if (!files.length) return res.status(400).json({ error: 'files[] required' });

    let deleted = 0;
    const errors = [];
    files.forEach((name) => {
      try {
        const safe = path.basename(String(name));
        const p = path.join(LOGS_DIR, safe);
        if (existsSync(p)) {
          unlinkSync(p);
          deleted += 1;
        }
      } catch (e) {
        errors.push(String(name));
      }
    });

    return res.json({ ok: true, deleted, errors });
  });
  ex.get('/api/logfiles/:filename', (req, res) => {
    const p = path.join(LOGS_DIR, path.basename(req.params.filename));
    if (!existsSync(p)) return res.status(404).json({ error: 'Not found' });
    res.type('text/plain').send(readFileSync(p, 'utf-8'));
  });
  ex.delete('/api/logfiles/:filename', (req, res) => {
    const p = path.join(LOGS_DIR, path.basename(req.params.filename));
    if (!existsSync(p)) return res.status(404).json({ error: 'Not found' });
    try {
      unlinkSync(p);
      return res.json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message || 'Delete log failed' });
    }
  });

  // ── Health pings ─────────────────────────────────────────────────────────
  ex.get('/api/camofox/ping', async (_, res) => {
    const cfg = loadConfig();
    try {
      const r = await fetch(`${cfg.camofoxApi}/health`, { signal: AbortSignal.timeout(2000) });
      res.json({ ok: r.ok, status: r.status });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  ex.get('/api/gateway/ping', async (_, res) => {
    const cfg = loadConfig();
    try {
      const r = await fetch(`${cfg.gatewayUrl}/api/public/worker/task`, {
        headers: { Authorization: `Bearer ${cfg.workerAuthToken}` },
        signal: AbortSignal.timeout(3000),
      });
      res.json({ ok: true, status: r.status });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  ex.get('/api/d1/ping', async (_, res) => {
    const cfg = loadConfig();
    if (!cfg.d1WorkerUrl) return res.json({ ok: false, error: "Empty D1 URL" });
    try {
      const r = await fetch(`${cfg.d1WorkerUrl}/health`, { signal: AbortSignal.timeout(3000) });
      const data = await r.json().catch(() => null);
      res.json({ ok: r.ok, status: r.status, data });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  // ▶ Cleanup: Xóa các D1 accounts không còn trong Gateway (orphans sau khi gateway xóa)
  ex.post('/api/d1/accounts/cleanup-orphans', async (req, res) => {
    const cfg = loadConfig();
    if (!cfg.d1WorkerUrl || !cfg.d1SyncSecret) {
      return res.status(400).json({ error: 'Missing D1 config' });
    }

    try {
      // 1. Lấy danh sách accounts từ D1 Cloud
      const d1AccRes = await d1Request(cfg, 'inspect/accounts?limit=1000');
      const d1Accounts = Array.isArray(d1AccRes.data?.items) ? d1AccRes.data.items : [];

      if (!d1Accounts.length) {
        return res.json({ ok: true, removed: 0, message: 'Không có accounts nào trong D1' });
      }

      // 2. Lấy danh sách local active accounts từ SQLite
      const localActiveIds = new Set(
        vault.db.prepare("SELECT id FROM vault_accounts WHERE deleted_at IS NULL AND status IN ('ready', 'pending', 'processing')").all().map(r => String(r.id))
      );

      // 3. Xác định và xóa orphan accounts (có trong D1 nhưng không có/bị xóa trong local Vault)
      let removed = 0;
      let failed = 0;
      const removedAccounts = [];

      for (const acc of d1Accounts) {
        const idStr = String(acc.id);
        const email = String(acc.email || '').toLowerCase().trim();
        if (!email || !email.includes('@')) continue;

        // Định nghĩa orphan: không có trong local SQLite hoạt động
        const isOrphan = !localActiveIds.has(idStr);

        if (isOrphan) {
          try {
            const delRes = await d1Request(cfg, `accounts/${acc.id}`, { method: 'DELETE', timeoutMs: 10000 });
            if (delRes.ok) {
              removed++;
              removedAccounts.push({ id: acc.id, email: acc.email });
              console.log(`[Cleanup] ✅ Đã xóa D1 orphan account: ${acc.email} (${acc.id})`);
            } else {
              failed++;
              console.warn(`[Cleanup] ⚠️ Không thể xóa D1 orphan ${acc.email}: HTTP ${delRes.status}`);
            }
          } catch (e) {
            failed++;
            console.warn(`[Cleanup] ⚠️ Lỗi xóa D1 orphan ${acc.email}:`, e.message);
          }
        }
      }

      if (removed > 0) {
        emitSSE('vault:update', { reason: 'cleanup-orphans' });
      }

      return res.json({
        ok: true,
        removed,
        failed,
        items: removedAccounts
      });
    } catch (e) {
      console.error('[Cleanup] Lỗi tiến trình dọn dẹp:', e.message);
      return res.status(500).json({ error: e.message });
    }
  });

  ex.get('/api/changelog', async (_, res) => {
    try {
      if (existsSync(path.join(__dirname, 'CHANGELOG.md'))) {
        const text = readFileSync(path.join(__dirname, 'CHANGELOG.md'), 'utf-8');
        res.json({ ok: true, content: text });
      } else {
        res.json({ ok: false, error: 'File not found' });
      }
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Vault API (SQLite) — đã mount ở dòng trên rồi, không mount lại ──────

  // ── Cloud Vault Synchronization Loop ───────────────────────────────────
  const CURSOR_FILE = path.join(__dirname, 'data', 'sync_cursor.json');

  function loadCursor() {
    try {
      if (existsSync(CURSOR_FILE)) {
        const { cursor } = JSON.parse(readFileSync(CURSOR_FILE, 'utf-8'));
        if (cursor && cursor > '1970') return cursor;
      }
    } catch (_) { }
    return '1970-01-01T00:00:00.000Z';
  }

  function saveCursor(cursor) {
    try {
      writeFileSync(CURSOR_FILE, JSON.stringify({ cursor, savedAt: new Date().toISOString() }));
    } catch (_) { }
  }

  let lastVaultSyncCursor = loadCursor();
  console.log(`[SyncManager] Pulling vault changes since ${lastVaultSyncCursor}...`);

  async function doVaultSync() {
    try {
      lastVaultSyncCursor = loadCursor();
      const data = await SyncManager.pullVault(lastVaultSyncCursor);
      if (data && data.cursor > lastVaultSyncCursor) {
        console.log(`[Sync] New cloud updates found. Cursor: ${data.cursor}`);

        // Cập nhật SQLite Local (dùng skipSync=true để tránh vòng lặp feedback)
        data.accounts.forEach(a => {
          vault.upsertAccount(a, true);
        });
        data.proxies.forEach(p => vault.upsertProxy(p, true));
        data.keys.forEach(k => vault.upsertApiKey(k, true));

        lastVaultSyncCursor = data.cursor;
        saveCursor(lastVaultSyncCursor); // Persist cursor để restart không cần re-pull từ đầu
        console.log('[Sync] Vault updated from cloud successfully.');

        // Emit SSE event for gateway_status changes
        if (data.gatewayStatusChanged && data.gatewayStatusChanged.length > 0) {
          emitSSE('gateway_status_changed', { ids: data.gatewayStatusChanged });
          console.log(`[Sync] Gateway status changed for ${data.gatewayStatusChanged.length} accounts`);
        }

        // Thông báo cho UI qua Socket.io nếu cần
        emitSSE('vault:synced', { cursor: lastVaultSyncCursor });
        return true; // có data mới
      }
    } catch (e) {
      console.error('[Sync] Loop failed:', e.message);
    }
    return false;
  }

  // Startup: pull nhiều lần cho đến khi caught up (tối đa 10 lần)
  async function startupSync() {
    let hasMore = true;
    let rounds = 0;
    while (hasMore && rounds < 10) {
      hasMore = await doVaultSync();
      rounds++;
    }
    if (rounds > 1) console.log(`[Sync] Startup caught up after ${rounds} pulls.`);
  }

  const D1_PULL_INTERVAL_MS = Math.max(15 * 1000, Number(process.env.SEELLM_TOOLS_D1_PULL_INTERVAL_MS || 3 * 60 * 1000));
  const D1_EVENT_POLL_MS = Math.max(5 * 1000, Number(process.env.SEELLM_TOOLS_D1_EVENT_POLL_MS || 15 * 1000));
  const D1_SELF_HEAL_MS = Math.max(10 * 60 * 1000, Number(process.env.SEELLM_TOOLS_D1_SELF_HEAL_MS || 3 * 60 * 60 * 1000));

  startupSync();

  // ── Failed D1 Deletes Retry Queue ──
  const PENDING_DELETES_FILE = path.join(DATA_DIR, 'pending_d1_deletes.json');

  function loadPendingD1Deletes() {
    try {
      if (existsSync(PENDING_DELETES_FILE)) {
        const content = readFileSync(PENDING_DELETES_FILE, 'utf8');
        const list = JSON.parse(content);
        if (Array.isArray(list)) {
          return new Set(list);
        }
      }
    } catch (err) {
      console.error('[Sync] Lỗi khi đọc file pending_d1_deletes.json:', err.message);
    }
    return new Set();
  }

  function savePendingD1Deletes(set) {
    try {
      const list = Array.from(set);
      writeFileSync(PENDING_DELETES_FILE, JSON.stringify(list, null, 2), 'utf8');
    } catch (err) {
      console.error('[Sync] Lỗi khi ghi file pending_d1_deletes.json:', err.message);
    }
  }

  const pendingD1Deletes = loadPendingD1Deletes();
  if (pendingD1Deletes.size > 0) {
    console.log(`[Sync] 🩺 Đã khôi phục ${pendingD1Deletes.size} yêu cầu xóa D1 chưa hoàn tất từ đĩa.`);
  }

  setInterval(async () => {
    if (pendingD1Deletes.size === 0) return;
    const cfg = loadConfig();
    if (!cfg.d1WorkerUrl || !cfg.d1SyncSecret) return;

    console.log(`[Sync] Retrying ${pendingD1Deletes.size} failed D1 deletion(s)...`);
    for (const accountId of [...pendingD1Deletes]) {
      try {
        const delRes = await d1Request(cfg, `accounts/${accountId}`, { method: 'DELETE', timeoutMs: 8000 });
        if (delRes.ok) {
          console.log(`[Sync] ✅ Retry thành công: Đã xóa ${accountId} khỏi D1`);
          pendingD1Deletes.delete(accountId);
          savePendingD1Deletes(pendingD1Deletes);
        }
      } catch (err) {
        console.warn(`[Sync] Retry xóa ${accountId} thất bại:`, err.message);
      }
    }
  }, 45000);

  // ── Startup Repair: force re-push accounts local=ready nhưng có thể bị stuck trên D1 ──
  // Xảy ra khi task endpoint race với connect-result → D1 nhận push processing SAU push ready
  setTimeout(async () => {
    try {
      const readyAccounts = vault.db.prepare(
        `SELECT * FROM vault_accounts WHERE status='ready' AND ever_ready=1 AND deleted_at IS NULL AND (provider='codex' OR provider='openai')`
      ).all();
      if (readyAccounts.length > 0) {
        let repaired = 0;
        for (const acc of readyAccounts) {
          try {
            await SyncManager.pushVault('account', acc);
            repaired++;
          } catch (_) {}
        }
        if (repaired > 0) {
          console.log(`[Sync] 🩺 Startup repair: re-pushed ${repaired} ready account(s) to D1`);
        }
      }
    } catch (e) {
      console.error(`[Sync] 🩺 Startup repair failed:`, e.message);
    }
  }, 5000); // Chạy sau 5s để đảm bảo startup sync xong

  setInterval(doVaultSync, D1_PULL_INTERVAL_MS);

  // ── D1 Event Bus Poller (Zero-Config Realtime Sync) ──
  let lastEventCheck = new Date(Date.now() - 60000).toISOString();
  setInterval(async () => {
    const cfg = loadConfig();
    if (!cfg.d1WorkerUrl || !cfg.d1SyncSecret) return;
    try {
      const res = await fetch(`${cfg.d1WorkerUrl.replace(/\/+$/, '')}/sync/events?since=${encodeURIComponent(lastEventCheck)}&ack=1`, {
        headers: { 
          'x-sync-secret': cfg.d1SyncSecret,
          'User-Agent': 'SeeLLM-Tools/1.0',
          'Accept': 'application/json'
        },
        signal: AbortSignal.timeout(30000)
      });
      const data = await res.json();
      if (!data.ok || !data.events?.length) {
        lastEventCheck = new Date().toISOString();
        return;
      }

      let hasChanges = false;
      for (const event of data.events) {
        if (event.event_type === 'ACCOUNT_DELETED') {
          try {
            const payload = JSON.parse(event.payload);
            const accountId = payload.accountId || payload.id;
            const email = payload.email || '';
            console.log(`[EventBus] ℹ️ Gateway đã xóa ${email || accountId} khỏi D1`);

            // [FIX v5] Vault là kho ĐỘC LẬP — chỉ update gateway_status, KHÔNG set local status.
            // User muốn thay đổi local status → bấm Stop trong Vault UI.
            if (accountId) {
              const local = vault.db.prepare('SELECT status, updated_at, connect_pending, email FROM vault_accounts WHERE id = ?').get(accountId);
              if (local) {
                vault.updateGatewayStatus(accountId, 'revoked');
                
                if (local.status !== 'idle') {
                  const isUserPending = local.status === 'pending' ||
                    local.status === 'processing' ||
                    Number(local.connect_pending) > 0;
                  
                  if (!isUserPending) {
                    console.log(`[EventBus] 🔄 Auto-reverting local account status to 'idle' due to Gateway deletion event: ${local.email || accountId}`);
                    vault.updateAccountStatus(accountId, 'idle');
                  }
                }
                hasChanges = true;
              }

              // [FIX v6] Khi Gateway xóa account, cũng xóa khỏi D1 Cloud accounts table
              // để ServicesView (?view=services) hiển thị đúng số lượng.
              // Gateway chỉ push tombstone vào managed_accounts/connections, KHÔNG xóa accounts table.
              try {
                const delRes = await d1Request(cfg, `accounts/${accountId}`, { method: 'DELETE', timeoutMs: 10000 });
                if (delRes.ok) {
                  console.log(`[EventBus] ✅ Đã xóa account ${accountId} khỏi D1 Cloud accounts table`);
                  pendingD1Deletes.delete(accountId);
                  savePendingD1Deletes(pendingD1Deletes);
                } else {
                  console.warn(`[EventBus] ⚠️ Không thể xóa account ${accountId} khỏi D1 (HTTP ${delRes.status}): ${delRes.text?.slice(0, 100)}`);
                  pendingD1Deletes.add(accountId);
                  savePendingD1Deletes(pendingD1Deletes);
                }
              } catch (delErr) {
                console.warn(`[EventBus] ⚠️ Lỗi khi xóa account ${accountId} khỏi D1:`, delErr.message);
                pendingD1Deletes.add(accountId);
                savePendingD1Deletes(pendingD1Deletes);
              }
            }
          } catch (err) {
            console.warn('[EventBus] Failed to parse ACCOUNT_DELETED:', err.message);
          }
        }
      }

      if (hasChanges) {
        emitSSE('vault:update', { reason: 'event-bus' });
      }
      // Trừ lùi 5 giây để tránh mất event do chênh lệch mili-giây hoặc clock drift giữa VPS/Local/Cloud
      lastEventCheck = new Date(Date.now() - 5000).toISOString();
    } catch (e) { /* Bỏ qua lỗi mạng */ }
  }, D1_EVENT_POLL_MS);
  // ───────────────────────────────────────────────────
  // [SELF-HEALING] Định kỳ 3 tiếng một lần quét toàn phần (Full-Sync)
  setInterval(async () => {
    console.log(`[Sync] 🩺 Bắt đầu quét Self-Healing (Toàn phần)...`);
    try {
      const data = await SyncManager.pullVault(0); // Quét lại từ năm 1970
      if (data) {
        let accountsRepaired = 0;
        data.accounts.forEach(a => {
          const localRecord = vault.db.prepare('SELECT updated_at FROM vault_accounts WHERE id = ?').get(a.id);
          // Chỉ lấy về nếu local không có, hoặc D1 mới hơn (chênh lệch > 1s để tránh sai số miliseconds)
          if (!localRecord || (new Date(a.updated_at).getTime() - new Date(localRecord.updated_at).getTime() > 1000)) {
            vault.upsertAccount(a, true);
            accountsRepaired++;
          }
        });

        let proxiesRepaired = 0;
        data.proxies.forEach(p => {
          const localRecord = vault.db.prepare('SELECT updated_at FROM vault_proxies WHERE id = ?').get(p.id);
          if (!localRecord || (new Date(p.updated_at).getTime() - new Date(localRecord.updated_at).getTime() > 1000)) {
            vault.upsertProxy(p, true);
            proxiesRepaired++;
          }
        });
        console.log(`[Sync] 🩺 Self-Healing hoàn tất. Sửa lỗi: ${accountsRepaired} account, ${proxiesRepaired} proxy.`);

        // Self-heal gateway_status mismatch: ready nhưng gw≠active, hoặc idle nhưng gw=active, hoặc ready nhưng gw=revoked
        let gwRepaired = 0;
        const mismatch = vault.db.prepare(`
          SELECT id, email, status, ever_ready, gateway_status FROM vault_accounts
          WHERE deleted_at IS NULL AND (
            (status = 'ready' AND ever_ready = 1 AND (gateway_status IS NULL OR (gateway_status != 'active' AND gateway_status != 'revoked')))
            OR (status = 'idle' AND gateway_status = 'active')
            OR (status = 'ready' AND gateway_status = 'revoked')
          )
        `).all();
        for (const m of mismatch) {
          if (m.status === 'ready' && m.gateway_status === 'revoked') {
            console.log(`[Sync] 🩺 Auto-healing local status to 'idle' (Gateway revoked): ${m.email}`);
            vault.updateAccountStatus(m.id, 'idle');
            gwRepaired++;
            continue;
          }
          const fullRecord = vault.db.prepare('SELECT * FROM vault_accounts WHERE id = ?').get(m.id);
          if (fullRecord) {
            console.log(`[Sync] 🩺 gateway_status mismatch: ${m.email} status=${m.status} gw=${m.gateway_status} → re-push`);
            await SyncManager.pushVault('account', fullRecord, true);
            gwRepaired++;
          }
        }
        if (gwRepaired) console.log(`[Sync] 🩺 gateway_status repaired: ${gwRepaired} accounts`);
      }
    } catch (e) {
      console.error(`[Sync] 🩺 Self-Healing thất bại:`, e.message);
    }
  }, D1_SELF_HEAL_MS);

  // ── D1 API Proxy ─────────────────────────────────────────────────────────

  function normalizeProxyUrl(input) {
    const s = String(input || '').trim();
    return s.length ? s : null;
  }

  async function d1Request(cfg, endpoint, options = {}) {
    const base = String(cfg.d1WorkerUrl || '').replace(/\/+$/, '');
    const path = String(endpoint || '').replace(/^\/+/, '');
    const targetUrl = `${base}/${path}`;
    const method = options.method || 'GET';
    const headers = {
      'x-sync-secret': cfg.d1SyncSecret,
      'User-Agent': 'SeeLLM-Tools/1.0',
      'Accept': 'application/json'
    };
    if (method !== 'GET' && method !== 'HEAD') headers['Content-Type'] = 'application/json';

    const fetchOpts = {
      method,
      headers,
      signal: AbortSignal.timeout(options.timeoutMs || 30000),
    };
    if (options.body !== undefined && method !== 'GET' && method !== 'HEAD') {
      fetchOpts.body = JSON.stringify(options.body);
    }

    const res = await fetch(targetUrl, fetchOpts);
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch (_) { }
    return { ok: res.ok, status: res.status, data, text, targetUrl };
  }

  const gatewayProbeState = {
    downUntil: 0,
    lastError: '',
    lastWarnAt: 0,
  };

  async function checkGatewayAvailability(gatewayUrl) {
    const base = String(gatewayUrl || '').trim().replace(/\/+$/, '');
    if (!base) return { ok: false, reason: 'missing_gateway_url' };

    const now = Date.now();
    if (gatewayProbeState.downUntil > now) {
      return { ok: false, reason: 'cooldown' };
    }

    try {
      // Accept any HTTP response as "service reachable" (even 404/401), only network failures mark down.
      const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500) });
      if (r.status >= 100 && r.status < 600) {
        gatewayProbeState.downUntil = 0;
        return { ok: true, reason: 'reachable' };
      }
    } catch (e) {
      gatewayProbeState.downUntil = now + 60_000;
      gatewayProbeState.lastError = e.message || String(e);
      if (now - gatewayProbeState.lastWarnAt > 15_000) {
        gatewayProbeState.lastWarnAt = now;
        console.warn(`[D1 Proxy] ⚠️ Gateway local unavailable (${gatewayProbeState.lastError}). Skip notify for 60s.`);
      }
      return { ok: false, reason: 'unreachable' };
    }
    return { ok: false, reason: 'unknown' };
  }

  async function notifyGatewayDeleteAccount(gatewayUrl, accountId) {
    const base = String(gatewayUrl || '').trim().replace(/\/+$/, '');
    if (!base || !accountId) return false;
    const availability = await checkGatewayAvailability(base);
    if (!availability.ok) return false;
    try {
      await fetch(`${base}/api/automation/accounts/codex/${accountId}`, {
        method: 'DELETE',
        signal: AbortSignal.timeout(5000),
      });
      return true;
    } catch (e) {
      // Put probe into cooldown immediately after a hard network failure.
      gatewayProbeState.downUntil = Date.now() + 60_000;
      gatewayProbeState.lastError = e.message || String(e);
      console.warn(`[D1 Proxy] ⚠️ Gateway delete notify failed (${gatewayProbeState.lastError}). Skip notify for 60s.`);
      return false;
    }
  }

  function mirrorPatchedAccountToLocal(id, payload = {}) {
    const existing = vault.getAccountFull(id);
    const patch = { id, provider: existing?.provider || 'openai' };

    if (payload.email !== undefined) patch.email = payload.email;
    if (payload.password !== undefined) patch.password = payload.password || '';
    if (payload.twoFaSecret !== undefined) patch.two_fa_secret = payload.twoFaSecret || '';
    if (payload.two_fa_secret !== undefined) patch.two_fa_secret = payload.two_fa_secret || '';
    if (payload.proxyUrl !== undefined) patch.proxy_url = normalizeProxyUrl(payload.proxyUrl);
    if (payload.proxy_url !== undefined) patch.proxy_url = normalizeProxyUrl(payload.proxy_url);
    if (payload.status !== undefined) patch.status = payload.status;
    if (payload.isActive !== undefined) patch.is_active = payload.isActive ? 1 : 0;
    if (payload.is_active !== undefined) patch.is_active = payload.is_active ? 1 : 0;
    if (payload.last_error !== undefined) patch.last_error = payload.last_error || '';
    if (payload.lastError !== undefined) patch.last_error = payload.lastError || '';
    if (payload.notes !== undefined) patch.notes = payload.notes || '';

    if (!existing && !patch.email) return false;
    if (!patch.email && existing?.email) patch.email = existing.email;
    vault.upsertAccount(patch, true);
    return true;
  }

  function buildProxyPoolState(accounts = [], proxies = [], proxySlots = []) {
    const capByProxy = new Map();
    for (const p of proxies) {
      const slotCountFromSlots = proxySlots.filter(s => s && s.proxy_id === p.id && !s.deleted_at).length;
      const slotCount = slotCountFromSlots || Number(p.slot_count || p.slotCount || 0) || 0;
      capByProxy.set(p.id, slotCount);
    }

    const usedByProxy = new Map();
    for (const p of proxies) usedByProxy.set(p.id, 0);
    for (const a of accounts) {
      const proxyId = a?.proxy_id || null;
      const proxyUrl = normalizeProxyUrl(a?.proxy_url);
      let matched = null;
      if (proxyId && usedByProxy.has(proxyId)) {
        matched = proxyId;
      } else if (proxyUrl) {
        const byUrl = proxies.find(p => normalizeProxyUrl(p.url) === proxyUrl);
        if (byUrl) matched = byUrl.id;
      }
      if (matched) usedByProxy.set(matched, (usedByProxy.get(matched) || 0) + 1);
    }
    return { capByProxy, usedByProxy };
  }

  function computeProxyFreeSlots(proxies = [], proxySlots = []) {
    const freeByProxy = new Map();
    for (const p of proxies) {
      const slots = proxySlots.filter(s => s && s.proxy_id === p.id && !s.deleted_at);
      if (slots.length > 0) {
        freeByProxy.set(p.id, slots.filter(s => !s.connection_id).length);
      } else {
        const fallbackCap = Number(p.slot_count || p.slotCount || 0) || 0;
        freeByProxy.set(p.id, fallbackCap);
      }
    }
    return freeByProxy;
  }

  function findSlotByConnection(proxySlots = [], connectionId) {
    return proxySlots.find(s => s && !s.deleted_at && String(s.connection_id || '') === String(connectionId || '')) || null;
  }

  function findFreeSlot(proxySlots = [], proxyId) {
    const candidates = proxySlots
      .filter(s => s && !s.deleted_at && s.proxy_id === proxyId && !s.connection_id)
      .sort((a, b) => Number(a.slot_index || 0) - Number(b.slot_index || 0));
    return candidates[0] || null;
  }

  async function pushProxySlotState(cfg, slotRow, connectionIdOrNull) {
    if (!slotRow?.id || !slotRow?.proxy_id) return false;
    const now = new Date().toISOString();
    const payload = {
      proxySlots: [{
        id: slotRow.id,
        proxy_id: slotRow.proxy_id,
        slot_index: Number(slotRow.slot_index || 0),
        connection_id: connectionIdOrNull || null,
        updated_at: now,
        deleted_at: null,
        version: Date.now(),
      }],
    };

    const push = await d1Request(cfg, 'sync/push', { method: 'POST', body: payload, timeoutMs: 30000 });
    return push.ok;
  }

  async function rebindProxySlotForAccount({
    cfg,
    accountId,
    targetProxyId,
    proxySlots,
  }) {
    const current = findSlotByConnection(proxySlots, accountId);
    const currentProxyId = current?.proxy_id || null;
    const normalizedTarget = targetProxyId || null;

    // No change needed
    if (currentProxyId && normalizedTarget && currentProxyId === normalizedTarget) {
      return { ok: true, changed: false };
    }

    // Release old slot if needed
    if (current && (!normalizedTarget || currentProxyId !== normalizedTarget)) {
      const released = await pushProxySlotState(cfg, current, null);
      if (!released) return { ok: false, error: 'Failed to release old proxy slot' };
      current.connection_id = null;
    }

    // No new proxy requested -> done after release
    if (!normalizedTarget) return { ok: true, changed: true };

    // Claim slot in target proxy
    const freeSlot = findFreeSlot(proxySlots, normalizedTarget);
    if (!freeSlot) {
      console.warn(`[D1 Proxy] Proxy ${normalizedTarget} has no free pre-defined slots. Proceeding with URL assignment only.`);
      return { ok: true, changed: true, warning: 'No pre-defined free slot available' };
    }
    const claimed = await pushProxySlotState(cfg, freeSlot, accountId);
    if (!claimed) return { ok: false, error: 'Failed to claim target proxy slot' };
    freeSlot.connection_id = accountId;
    return { ok: true, changed: true, slotId: freeSlot.id };
  }

  function resolveProxyIdFromInput({ proxies, proxyId, proxyUrl }) {
    if (proxyId) return proxyId;
    const urlNorm = normalizeProxyUrl(proxyUrl);
    if (!urlNorm) return null;
    const match = proxies.find(p => normalizeProxyUrl(p.url) === urlNorm);
    return match?.id || null;
  }

  function buildProxyBindings(accounts = [], proxies = [], proxySlots = [], connections = []) {
    const byId = new Map((proxies || []).map((p) => [String(p.id), p]));
    const byUrl = new Map((proxies || []).map((p) => [normalizeProxyUrl(p.url), p]));

    // Map connection ID to its lowercase email for fallback mapping
    const connectionEmailMap = new Map();
    for (const c of connections || []) {
      if (c && c.id && c.email) {
        connectionEmailMap.set(String(c.id), String(c.email).toLowerCase());
      }
    }

    const slotByAccount = new Map();
    const slotByEmail = new Map();
    for (const s of proxySlots || []) {
      if (!s || s.deleted_at || !s.connection_id) continue;
      const connId = String(s.connection_id);
      slotByAccount.set(connId, s);
      const email = connectionEmailMap.get(connId);
      if (email) {
        slotByEmail.set(email, s);
      }
    }

    const bindings = [];
    for (const a of accounts || []) {
      const accountId = String(a?.id || '');
      if (!accountId) continue;
      const emailNorm = String(a?.email || '').toLowerCase();
      const proxyUrl = normalizeProxyUrl(a?.proxy_url);
      const proxyId = a?.proxy_id || null;

      // Match slot by account ID first, fallback to matching by email if ID lookup fails
      const slot = slotByAccount.get(accountId) || (emailNorm ? slotByEmail.get(emailNorm) : null) || null;
      const matchedProxy =
        (proxyId ? byId.get(String(proxyId)) : null) ||
        (proxyUrl ? byUrl.get(proxyUrl) : null) ||
        (slot?.proxy_id ? byId.get(String(slot.proxy_id)) : null) ||
        null;

      bindings.push({
        account_id: accountId,
        email: a?.email || '',
        provider: a?.provider || 'openai',
        proxy_id: matchedProxy?.id || proxyId || slot?.proxy_id || null,
        proxy_url: proxyUrl || normalizeProxyUrl(matchedProxy?.url) || null,
        proxy_label: matchedProxy?.label || '',
        slot_id: slot?.id || null,
        slot_index: slot?.slot_index ?? null,
      });
    }
    return bindings;
  }

  const sortProxiesByLabel = (a, b) => {
    const labelA = a.proxy.label || '';
    const labelB = b.proxy.label || '';
    const matchA = labelA.match(/^P(\d+)$/i);
    const matchB = labelB.match(/^P(\d+)$/i);
    if (matchA && matchB) return parseInt(matchA[1], 10) - parseInt(matchB[1], 10);
    if (matchA) return -1;
    if (matchB) return 1;
    return labelA.localeCompare(labelB);
  };

  function getAssignableProxy(proxies = [], capByProxy, usedByProxy, explicitProxyId = null) {
    if (explicitProxyId) {
      const p = proxies.find(x => x.id === explicitProxyId);
      if (!p) return { error: 'Proxy not found' };
      const free = (capByProxy.get(p.id) || 0) - (usedByProxy.get(p.id) || 0);
      if (free <= 0) return { error: 'Proxy has no free slots' };
      return { proxy: p };
    }

    const candidates = proxies
      .map((p) => {
        const cap = capByProxy.get(p.id) || 0;
        const used = usedByProxy.get(p.id) || 0;
        return { proxy: p, free: cap - used, cap };
      })
      .filter((x) => x.cap > 0 && x.free > 0)
      .sort(sortProxiesByLabel);

    if (!candidates.length) return { error: 'No proxy with free slots' };
    return { proxy: candidates[0].proxy };
  }

  // ▶ Intercept: POST /api/d1/accounts/add → ngăn chặn duplicate và mirror vào local vault
  // Lý do: task endpoint chỉ đọc local, user thêm từ "Codex Accts" tab thì phải đồng bộ ngay.
  ex.post('/api/d1/accounts/add', async (req, res, next) => {
    const cfg = loadConfig();
    if (!cfg.d1WorkerUrl || !cfg.d1SyncSecret) return next();

    const body = req.body || {};
    if (!body.email || !String(body.email).includes('@')) return next();

    try {
      // 1. Kiểm tra xem local đã có email này chưa (kể cả đã xóa)
      const existing = vault.db.prepare('SELECT id FROM vault_accounts WHERE email = ? LIMIT 1').get(body.email);

      if (existing) {
        console.log(`[D1 Proxy] 🛑 Ngăn chặn Duplicate Account từ UI. Đã có ID: ${existing.id}`);
        const nowIso = new Date().toISOString();
        vault.db.prepare(`
          UPDATE vault_accounts 
          SET deleted_at = NULL, status = 'pending', notes = '', password = ?, two_fa_secret = ?, proxy_url = ?, updated_at = ?
          WHERE id = ?
        `).run(body.password || '', body.twoFaSecret || '', body.proxyUrl || null, nowIso, existing.id);

        // Gọi upsertAccount lần nữa để sinh PKCE và đồng bộ D1 (skipSync=false)
        vault.upsertAccount({
          id: existing.id,
          provider: 'codex',
          email: body.email,
          status: 'pending'
        }, false);

        return res.json({ ok: true, id: existing.id });
      }

      // 2. Chạy bình thường nếu là account thực sự MỚI
      const d1Res = await fetch(`${cfg.d1WorkerUrl.replace(/\/+$/, '')}/accounts/add`, {
        method: 'POST',
        headers: { 'x-sync-secret': cfg.d1SyncSecret, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      });
      const d1Data = await d1Res.json();

      // Mirror vào local vault ngay lập tức (dùng ID từ D1 để đồng nhất)
      if (d1Data.ok && d1Data.id) {
        vault.upsertAccount({
          id: d1Data.id,
          provider: 'codex',
          email: body.email,
          password: body.password || '',
          two_fa_secret: body.twoFaSecret || '',
          proxy_url: body.proxyUrl || null,
          status: 'pending',
        });
        console.log(`[D1 Proxy] ✅ Mirrored New Account to local: ${body.email} (id=${d1Data.id})`);
      }

      res.setHeader('Content-Type', 'application/json');
      return res.status(d1Res.status).json(d1Data);
    } catch (e) {
      console.error(`[D1 Proxy] accounts/add interceptor error:`, e.message);
      return next(); // Fallback về generic proxy
    }
  });

  // ▶ Intercept: DELETE /api/d1/accounts/:id → ngắt kết nối Codex, thu hồi về kho lạnh (idle)
  ex.delete('/api/d1/accounts/:id', async (req, res, next) => {
    try {
      const { id } = req.params;
      console.log(`[D1 Proxy] 🛑 Bắt lệnh xóa Codex account. ID: ${id}`);

      try {
        // Thu hồi về kho lạnh (idle) trong local vault
        vault.db.prepare(`UPDATE vault_accounts SET status = 'idle', deleted_at = NULL WHERE id = ?`).run(id);
        console.log(`[D1 Proxy] ✅ Đã chuyển trạng thái thành 'idle' trong local vault: ${id}`);
      } catch (err) {
        console.error(`[D1 Proxy] Lỗi khi set idle trong local vault:`, err.message);
      }

      // Thông báo Gateway xóa connection tương ứng (đồng bộ Gateway ← Tools)
      const cfg = loadConfig();
      if (id && cfg.gatewayUrl) {
        notifyGatewayDeleteAccount(cfg.gatewayUrl, id).then((ok) => {
          if (ok) {
            console.log(`[D1 Proxy] ✅ Đã truyền lệnh xóa cho Gateway (accounts/codex/${id}).`);
          }
        }).catch(() => { });

        // Trigger Gateway pull snapshot ngay sau khi xóa — đảm bảo Gateway hard-delete
        // cả managed_account và connection trong local DB trong < 2s (thay vì đợi syncTick 30s)
        // Skip nếu gatewayUrl trỏ đến D1 Worker (không có Next.js route)
        if (!cfg.gatewayUrl.includes('workers.dev') && !cfg.gatewayUrl.includes('gateway-db.seellm.xyz')) {
          setTimeout(() => {
            fetch(`${cfg.gatewayUrl.replace(/\/+$/, '')}/api/sync/trigger`, {
              method: 'POST',
              headers: { 'x-sync-secret': cfg.d1SyncSecret || '', 'Content-Type': 'application/json' },
              signal: AbortSignal.timeout(5000),
            }).then(r => {
              if (r.ok) console.log(`[GatewayTrigger] ✅ Gateway pulled snapshot after delete ${id}`);
              else if (r.status !== 404) console.log(`[GatewayTrigger] ⚠️ HTTP ${r.status} after delete ${id}`);
            }).catch(() => {});
          }, 500);
        }
      }
      return next(); // Proxy lệnh xóa lên D1 Cloud
    } catch (e) {
      return next();
    }
  });

  // ▶ Intercept: PATCH /api/d1/accounts/:id → update D1 and mirror local vault instantly
  ex.patch('/api/d1/accounts/:id', async (req, res, next) => {
    const cfg = loadConfig();
    if (!cfg.d1WorkerUrl || !cfg.d1SyncSecret) return next();
    const { id } = req.params;
    const body = req.body || {};
    if (!id) return next();

    try {
      let proxySlots = [];
      let proxies = [];
      if (body.proxyUrl !== undefined || body.proxy_url !== undefined || body.proxyId !== undefined || body.proxy_id !== undefined) {
        const inspect = await d1Request(cfg, 'inspect/proxies');
        proxies = Array.isArray(inspect.data?.proxies) ? inspect.data.proxies : [];
        proxySlots = Array.isArray(inspect.data?.proxySlots) ? inspect.data.proxySlots : [];
      }

      const d1 = await d1Request(cfg, `accounts/${id}`, { method: 'PATCH', body, timeoutMs: 30000 });
      if (d1.ok) {
        mirrorPatchedAccountToLocal(id, body);

        if (proxySlots.length || proxies.length) {
          const targetProxyId = resolveProxyIdFromInput({
            proxies,
            proxyId: body.proxyId ?? body.proxy_id ?? null,
            proxyUrl: body.proxyUrl ?? body.proxy_url ?? null,
          });
          const proxyUrlNorm = normalizeProxyUrl(body.proxyUrl ?? body.proxy_url ?? null);
          const shouldUnassign = (body.proxyUrl !== undefined || body.proxy_url !== undefined) && !proxyUrlNorm;
          const slotSync = await rebindProxySlotForAccount({
            cfg,
            accountId: id,
            targetProxyId: shouldUnassign ? null : targetProxyId,
            proxySlots,
          });
          if (!slotSync.ok) {
            console.warn(`[D1 Proxy] Slot rebind warning for ${id}: ${slotSync.error}`);
          }
        }
      }
      res.setHeader('Content-Type', 'application/json');
      // Trigger Gateway pull snapshot ngay sau khi PATCH (is_active toggle, proxy change)
      // Skip nếu gatewayUrl trỏ đến D1 Worker (không có Next.js route)
      if (d1.ok && cfg.gatewayUrl && !cfg.gatewayUrl.includes('workers.dev') && !cfg.gatewayUrl.includes('gateway-db.seellm.xyz')) {
        setTimeout(() => {
          fetch(`${cfg.gatewayUrl.replace(/\/+$/, '')}/api/sync/trigger`, {
            method: 'POST',
            headers: { 'x-sync-secret': cfg.d1SyncSecret || '', 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(5000),
          }).then(r => {
            if (r.ok) console.log(`[GatewayTrigger] ✅ Gateway pulled after PATCH ${id}`);
          }).catch(() => {});
        }, 500);
      }
      return res.status(d1.status).json(d1.data || { ok: d1.ok, raw: d1.text });
    } catch (e) {
      console.error(`[D1 Proxy] accounts/${id} PATCH interceptor error:`, e.message);
      return next();
    }
  });

  // ▶ Tools API: assign one account to a proxy from pool
  ex.post('/api/proxy-assign/assign', async (req, res) => {
    const cfg = loadConfig();
    if (!cfg.d1WorkerUrl || !cfg.d1SyncSecret) {
      return res.status(400).json({ error: "Missing D1 config (url or secret)" });
    }
    const { accountId, proxyId } = req.body || {};
    if (!accountId) return res.status(400).json({ error: 'accountId is required' });

    try {
      const proxiesR = await d1Request(cfg, 'inspect/proxies');
      const proxies = Array.isArray(proxiesR.data?.proxies) ? proxiesR.data.proxies : [];
      const proxySlots = Array.isArray(proxiesR.data?.proxySlots) ? proxiesR.data.proxySlots : [];
      
      const account = vault.getAccount(accountId);
      if (!account) return res.status(404).json({ error: 'Account not found in local vault' });

      const freeByProxy = computeProxyFreeSlots(proxies, proxySlots);
      let chosen = null;
      if (proxyId) {
        chosen = proxies.find(p => p.id === proxyId) || null;
        if (!chosen) return res.status(404).json({ error: 'Proxy not found' });
        if ((freeByProxy.get(chosen.id) || 0) <= 0) return res.status(400).json({ error: 'Proxy has no free slot' });
      } else {
        const ranked = proxies
          .map((p) => ({ proxy: p, free: freeByProxy.get(p.id) || 0 }))
          .filter((x) => x.free > 0)
          .sort(sortProxiesByLabel);
        if (!ranked.length) return res.status(400).json({ error: 'No proxy with free slots' });
        chosen = ranked[0].proxy;
      }

      const patchBody = { proxyUrl: normalizeProxyUrl(chosen.url), proxyId: chosen.id };
      const patchR = await d1Request(cfg, `accounts/${accountId}`, { method: 'PATCH', body: patchBody });
      if (!patchR.ok && patchR.status !== 404) {
        return res.status(patchR.status).json(patchR.data || { error: patchR.text || 'Patch failed' });
      }

      mirrorPatchedAccountToLocal(accountId, patchBody);
      const updatedLocalAcc = vault.getAccount(accountId);
      if (updatedLocalAcc) {
        await SyncManager.pushVault('account', updatedLocalAcc, true);
      }

      const slotSync = await rebindProxySlotForAccount({
        cfg,
        accountId,
        targetProxyId: chosen.id,
        proxySlots,
      });
      if (!slotSync.ok) {
        return res.status(409).json({ error: slotSync.error || 'Slot sync failed after account patch' });
      }
      return res.json({ ok: true, accountId, proxy: { id: chosen.id, url: chosen.url, label: chosen.label || '' } });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  // ▶ Tools API: consolidated proxy state for all screens
  ex.get('/api/proxy/state', async (req, res) => {
    const cfg = loadConfig();
    if (!cfg.d1WorkerUrl || !cfg.d1SyncSecret) {
      return res.status(400).json({ error: "Missing D1 config (url or secret)" });
    }

    try {
      const [proxiesR, connectionsR] = await Promise.all([
        d1Request(cfg, 'inspect/proxies'),
        d1Request(cfg, 'inspect/connections?limit=1000').catch(() => ({ data: { items: [] } })),
      ]);
      const accounts = vault.getAccountsFull();
      const proxies = Array.isArray(proxiesR.data?.proxies) ? proxiesR.data.proxies : [];
      const proxySlots = Array.isArray(proxiesR.data?.proxySlots) ? proxiesR.data.proxySlots : [];
      const connections = Array.isArray(connectionsR.data?.items) ? connectionsR.data.items : [];
      const freeByProxy = computeProxyFreeSlots(proxies, proxySlots);
      const bindings = buildProxyBindings(accounts, proxies, proxySlots, connections);

      const proxyStats = proxies.map((p) => {
        const totalSlots = proxySlots.filter((s) => s && !s.deleted_at && s.proxy_id === p.id).length
          || Number(p.slot_count || p.slotCount || 0)
          || 0;
        const freeSlots = freeByProxy.get(p.id) || 0;
        return {
          proxy_id: p.id,
          total_slots: totalSlots,
          free_slots: freeSlots,
          used_slots: Math.max(0, totalSlots - freeSlots),
        };
      });

      return res.json({
        ok: true,
        proxies,
        proxySlots,
        accounts,
        bindings,
        proxyStats,
      });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  // ▶ Tools API: unassign proxy from one account
  ex.post('/api/proxy-assign/unassign', async (req, res) => {
    const cfg = loadConfig();
    if (!cfg.d1WorkerUrl || !cfg.d1SyncSecret) {
      return res.status(400).json({ error: "Missing D1 config (url or secret)" });
    }
    const { accountId } = req.body || {};
    if (!accountId) return res.status(400).json({ error: 'accountId is required' });

    try {
      const proxiesR = await d1Request(cfg, 'inspect/proxies');
      const proxySlots = Array.isArray(proxiesR.data?.proxySlots) ? proxiesR.data.proxySlots : [];

      const account = vault.getAccount(accountId);
      if (!account) return res.status(404).json({ error: 'Account not found in local vault' });

      const patchBody = { proxyUrl: '', proxyId: null };
      const patchR = await d1Request(cfg, `accounts/${accountId}`, { method: 'PATCH', body: patchBody });
      if (!patchR.ok && patchR.status !== 404) {
        return res.status(patchR.status).json(patchR.data || { error: patchR.text || 'Patch failed' });
      }

      mirrorPatchedAccountToLocal(accountId, patchBody);
      const updatedLocalAcc = vault.getAccount(accountId);
      if (updatedLocalAcc) {
        await SyncManager.pushVault('account', updatedLocalAcc, true);
      }

      const slotSync = await rebindProxySlotForAccount({
        cfg,
        accountId,
        targetProxyId: null,
        proxySlots,
      });
      if (!slotSync.ok) {
        return res.status(409).json({ error: slotSync.error || 'Slot sync failed after account patch' });
      }
      return res.json({ ok: true, accountId });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  // ▶ Tools API: bulk assign / unassign proxies
  ex.post('/api/proxy-assign/bulk', async (req, res) => {
    const cfg = loadConfig();
    if (!cfg.d1WorkerUrl || !cfg.d1SyncSecret) {
      return res.status(400).json({ error: "Missing D1 config (url or secret)" });
    }
    const { action, accountIds, proxyId } = req.body || {};
    const ids = Array.isArray(accountIds) ? accountIds.filter(Boolean) : [];
    if (!['assign', 'unassign'].includes(String(action || ''))) {
      return res.status(400).json({ error: 'action must be assign or unassign' });
    }
    if (!ids.length) return res.status(400).json({ error: 'accountIds is required' });

    try {
      const proxiesR = await d1Request(cfg, 'inspect/proxies');
      const proxies = Array.isArray(proxiesR.data?.proxies) ? proxiesR.data.proxies : [];
      const proxySlots = Array.isArray(proxiesR.data?.proxySlots) ? proxiesR.data.proxySlots : [];
      const freeByProxy = computeProxyFreeSlots(proxies, proxySlots);

      let done = 0;
      const errors = [];
      for (const accountId of ids) {
        try {
          const account = vault.getAccount(accountId);
          if (!account) throw new Error('Account not found');

          if (action === 'unassign') {
            const patchBody = { proxyUrl: '', proxyId: null };
            const patchR = await d1Request(cfg, `accounts/${accountId}`, { method: 'PATCH', body: patchBody });
            if (!patchR.ok && patchR.status !== 404) throw new Error(patchR.data?.error || patchR.text || 'Patch failed');
            
            mirrorPatchedAccountToLocal(accountId, patchBody);
            const updatedLocalAcc = vault.getAccount(accountId);
            if (updatedLocalAcc) {
              await SyncManager.pushVault('account', updatedLocalAcc, true);
            }

            const slotSync = await rebindProxySlotForAccount({ cfg, accountId, targetProxyId: null, proxySlots });
            if (!slotSync.ok) throw new Error(slotSync.error || 'Slot sync failed');
            done++;
            continue;
          }

          let chosen = null;
          if (proxyId === 'account_proxy') {
            const existingProxyUrl = normalizeProxyUrl(account.proxy_url || account.proxyUrl);
            const existingProxyId = account.proxy_id || account.proxyId;
            if (existingProxyUrl) {
              const matched = proxies.find((p) => p.id === existingProxyId || normalizeProxyUrl(p.url) === existingProxyUrl);
              if (matched) {
                if ((freeByProxy.get(matched.id) || 0) <= 0) {
                  throw new Error(`Proxy ${matched.label || matched.url} has no free slots available`);
                }
                chosen = matched;
              } else {
                const patchBody = { proxyUrl: existingProxyUrl, proxyId: existingProxyId || null };
                const patchR = await d1Request(cfg, `accounts/${accountId}`, { method: 'PATCH', body: patchBody });
                if (!patchR.ok && patchR.status !== 404) throw new Error(patchR.data?.error || patchR.text || 'Patch failed');
                
                mirrorPatchedAccountToLocal(accountId, patchBody);
                const updatedLocalAcc = vault.getAccount(accountId);
                if (updatedLocalAcc) {
                  await SyncManager.pushVault('account', updatedLocalAcc, true);
                }

                const slotSync = await rebindProxySlotForAccount({ cfg, accountId, targetProxyId: null, proxySlots });
                if (!slotSync.ok) throw new Error(slotSync.error || 'Slot sync failed');
                done++;
                continue;
              }
            }
          } else if (proxyId) {
            chosen = proxies.find((p) => p.id === proxyId) || null;
            if (!chosen) throw new Error('Proxy not found');
            if ((freeByProxy.get(chosen.id) || 0) <= 0) throw new Error('Proxy has no free slot');
          }

          if (!chosen) {
            const ranked = proxies
              .map((p) => ({ proxy: p, free: freeByProxy.get(p.id) || 0 }))
              .filter((x) => x.free > 0)
              .sort(sortProxiesByLabel);
            if (!ranked.length) throw new Error('No proxy with free slots');
            chosen = ranked[0].proxy;
          }

          const patchBody = { proxyUrl: normalizeProxyUrl(chosen.url), proxyId: chosen.id };
          const patchR = await d1Request(cfg, `accounts/${accountId}`, { method: 'PATCH', body: patchBody });
          if (!patchR.ok && patchR.status !== 404) throw new Error(patchR.data?.error || patchR.text || 'Patch failed');
          
          mirrorPatchedAccountToLocal(accountId, patchBody);
          const updatedLocalAcc = vault.getAccount(accountId);
          if (updatedLocalAcc) {
            await SyncManager.pushVault('account', updatedLocalAcc, true);
          }

          const slotSync = await rebindProxySlotForAccount({ cfg, accountId, targetProxyId: chosen.id, proxySlots });
          if (!slotSync.ok) throw new Error(slotSync.error || 'Slot sync failed');
          freeByProxy.set(chosen.id, Math.max(0, (freeByProxy.get(chosen.id) || 0) - 1));
          done++;
        } catch (e) {
          errors.push({ accountId, error: e.message || String(e) });
        }
      }

      return res.json({ ok: true, action, total: ids.length, done, failed: errors.length, errors });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  // ▶ Tools API: auto assign all accounts that do not have proxy_url
  ex.post('/api/proxy-assign/auto', async (req, res) => {
    const cfg = loadConfig();
    if (!cfg.d1WorkerUrl || !cfg.d1SyncSecret) {
      return res.status(400).json({ error: "Missing D1 config (url or secret)" });
    }

    try {
      const proxiesR = await d1Request(cfg, 'inspect/proxies');
      const proxies = Array.isArray(proxiesR.data?.proxies) ? proxiesR.data.proxies : [];
      const proxySlots = Array.isArray(proxiesR.data?.proxySlots) ? proxiesR.data.proxySlots : [];

      // Lấy danh sách local không có proxy (bỏ qua những cái đã xóa)
      const localAccounts = vault.getAccountsFull().filter(a => !normalizeProxyUrl(a?.proxy_url) && !a?.deleted_at);
      const freeByProxy = computeProxyFreeSlots(proxies, proxySlots);

      let assigned = 0;
      for (const account of localAccounts) {
        const ranked = proxies
          .map((p) => ({ proxy: p, free: freeByProxy.get(p.id) || 0 }))
          .filter((x) => x.free > 0)
          .sort(sortProxiesByLabel);
        if (!ranked.length) break;

        const chosen = ranked[0].proxy;
        console.log(`[Auto-Assign] Đang gán proxy cho ${account.id} (${assigned + 1}/${localAccounts.length})...`);
        const patchBody = { proxyUrl: normalizeProxyUrl(chosen.url), proxyId: chosen.id };
        const patchR = await d1Request(cfg, `accounts/${account.id}`, { method: 'PATCH', body: patchBody });
        if (!patchR.ok && patchR.status !== 404) continue;
        
        mirrorPatchedAccountToLocal(account.id, patchBody);
        const updatedLocalAcc = vault.getAccount(account.id);
        if (updatedLocalAcc) {
          await SyncManager.pushVault('account', updatedLocalAcc, true);
        }

        const slotSync = await rebindProxySlotForAccount({
          cfg,
          accountId: account.id,
          targetProxyId: chosen.id,
          proxySlots,
        });
        if (!slotSync.ok) continue;
        freeByProxy.set(chosen.id, Math.max(0, (freeByProxy.get(chosen.id) || 0) - 1));
        assigned++;
      }

      return res.json({ ok: true, assigned, total: localAccounts.length });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });


  // ▶ Intercept: POST /api/d1/proxies/add → mirror new proxy vào local vault
  ex.post('/api/d1/proxies/add', async (req, res, next) => {
    const cfg = loadConfig();
    if (!cfg.d1WorkerUrl || !cfg.d1SyncSecret) return next();
    const body = req.body || {};
    if (!body.url) return next();

    try {
      const d1Res = await fetch(`${cfg.d1WorkerUrl.replace(/\/+$/, '')}/proxies/add`, {
        method: 'POST',
        headers: { 'x-sync-secret': cfg.d1SyncSecret, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      });
      const d1Data = await d1Res.json();

      if (d1Data.ok && d1Data.id) {
        // Normalize proxy URL for local vault (host:port:user:pass → http://user:pass@host:port)
        let normUrl = body.url || '';
        if (!normUrl.includes('://')) {
          const parts = normUrl.split(':');
          if (parts.length === 4 && !normUrl.includes('@')) {
            normUrl = `http://${parts[2]}:${parts[3]}@${parts[0]}:${parts[1]}`;
          } else {
            normUrl = `http://${normUrl}`;
          }
        }
        vault.upsertProxy({
          id: d1Data.id,
          url: normUrl,
          label: body.label || '',
          type: normUrl.startsWith('socks5://') ? 'socks5' : normUrl.startsWith('https://') ? 'https' : 'http',
        });
        console.log(`[D1 Proxy] ✅ Mirrored New Proxy to local: ${normUrl} (id=${d1Data.id})`);
      }

      res.setHeader('Content-Type', 'application/json');
      return res.status(d1Res.status).json(d1Data);
    } catch (e) {
      console.error(`[D1 Proxy] proxies/add interceptor error:`, e.message);
      return next();
    }
  });

  // ▶ Intercept: DELETE /api/d1/proxies/:id → mirror proxy deletion
  ex.delete('/api/d1/proxies/:id', async (req, res, next) => {
    try {
      const { id } = req.params;
      console.log(`[D1 Proxy] 🛑 Bắt lệnh xóa proxy từ UI (Gateway). ID: ${id}`);
      if (id) {
        vault.deleteProxy(id, false);
      }
      return next();
    } catch (e) {
      return next();
    }
  });

  // ▶ Intercept: POST /api/d1/proxies/bulk-delete → mirror bulk proxy deletion
  ex.post('/api/d1/proxies/bulk-delete', async (req, res, next) => {
    try {
      const { ids } = req.body || {};
      if (Array.isArray(ids) && ids.length > 0) {
        console.log(`[D1 Proxy] 🛑 Bắt lệnh xóa bulk proxy từ UI (Gateway). Số lượng: ${ids.length}`);
        
        // Retrieve deleted proxies first to get their URLs
        const deletedProxies = ids.map(id => vault.db.prepare('SELECT * FROM vault_proxies WHERE id = ?').get(id)).filter(Boolean);
        const deletedUrls = deletedProxies.map(p => p.url).filter(Boolean);

        const now = new Date().toISOString();
        const stmt = vault.db.prepare('UPDATE vault_proxies SET deleted_at = ?, updated_at = ? WHERE id = ?');
        const transaction = vault.db.transaction((proxyIds) => {
          for (const id of proxyIds) {
            stmt.run(now, now, id);
          }
        });
        transaction(ids);

        for (const id of ids) {
          const record = vault.db.prepare('SELECT * FROM vault_proxies WHERE id = ?').get(id);
          if (record) {
            SyncManager.pushVault('proxy', record).catch(() => {});
          }
        }

        // Reallocate accounts that were bound to deleted proxies
        reallocateAccountsFromDeletedProxies(deletedUrls, ids).catch((err) => {
          console.error('[D1 Proxy] Failed to reallocate accounts after bulk proxy deletion:', err.message);
        });
      }
      return next();
    } catch (e) {
      console.error(`[D1 Proxy] bulk-delete interceptor error:`, e.message);
      return next();
    }
  });

  // ▶ Intercept: POST /api/d1/proxies/bulk-add → mirror bulk proxy add
  ex.post('/api/d1/proxies/bulk-add', async (req, res, next) => {
    const cfg = loadConfig();
    if (!cfg.d1WorkerUrl || !cfg.d1SyncSecret) return next();
    const { items } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) return next();

    try {
      // Auto-generate sequential labels P1, P2... and assign default slot count
      let startIdx = getNextProxyLabel();
      const processedItems = items.map((item) => {
        startIdx++;
        return {
          ...item,
          label: `P${startIdx}`,
          slotCount: item.slotCount || cfg.defaultSlotsPerProxy || 4
        };
      });

      const d1Res = await fetch(`${cfg.d1WorkerUrl.replace(/\/+$/, '')}/proxies/bulk-add`, {
        method: 'POST',
        headers: { 'x-sync-secret': cfg.d1SyncSecret, 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: processedItems }),
        signal: AbortSignal.timeout(60000),
      });
      const d1Data = await d1Res.json();

      if (d1Data.ok && Array.isArray(d1Data.ids)) {
        const now = new Date().toISOString();
        const transaction = vault.db.transaction((addedItems, addedIds) => {
          for (let i = 0; i < addedItems.length; i++) {
            const item = addedItems[i];
            const id = addedIds[i];
            if (!id) continue;
            
            let normUrl = item.url || '';
            if (!normUrl.includes('://')) {
              const parts = normUrl.split(':');
              if (parts.length === 4 && !normUrl.includes('@')) {
                normUrl = `http://${parts[2]}:${parts[3]}@${parts[0]}:${parts[1]}`;
              } else {
                normUrl = `http://${normUrl}`;
              }
            }
            vault.upsertProxy({
              id,
              url: normUrl,
              label: item.label || '',
              type: normUrl.startsWith('socks5://') ? 'socks5' : normUrl.startsWith('https://') ? 'https' : 'http',
            }, true);
          }
        });
        transaction(processedItems, d1Data.ids);

        for (const id of d1Data.ids) {
          const record = vault.db.prepare('SELECT * FROM vault_proxies WHERE id = ?').get(id);
          if (record) {
            SyncManager.pushVault('proxy', record).catch(() => {});
          }
        }
        console.log(`[D1 Proxy] ✅ Mirrored Bulk Add to local: ${d1Data.ids.length} proxies`);
      }

      res.setHeader('Content-Type', 'application/json');
      return res.status(d1Res.status).json(d1Data);
    } catch (e) {
      console.error(`[D1 Proxy] proxies/bulk-add interceptor error:`, e.message);
      return next();
    }
  });

  // ▶ Intercept: PATCH /api/automation/accounts/:provider/:id → Toggle is_active locally & push to D1
  ex.patch('/api/automation/accounts/:provider/:id', async (req, res) => {
    console.log(`[D1 Proxy] 🎯 Nhận yêu cầu: ${req.method} ${req.url}`);
    try {
      const { id } = req.params;
      const { isActive, action } = req.body;

      console.log(`[D1 Proxy] 🔄 Bật/tắt tài khoản: ${id} -> isActive=${isActive}`);

      // 1. Cập nhật local vault ngay lập tức
      const existing = vault.getAccountFull(id);
      if (!existing) {
        return res.status(404).json({ error: `Account ${id} not found in local vault` });
      }

      const newIsActive = isActive ? 1 : 0;

      // Determine expected gateway_status to avoid mismatch before pull/self-healing runs
      let newGatewayStatus = 'revoked';
      if (newIsActive === 1 && !existing.deleted_at && existing.status !== 'idle') {
        if (existing.status === 'ready') {
          newGatewayStatus = 'active';
        } else if (['error', 'need_phone', 'relogin', 'dead'].includes(existing.status)) {
          const tags = [];
          try {
            if (existing.tags) {
              const parsed = JSON.parse(existing.tags);
              if (Array.isArray(parsed)) tags.push(...parsed);
            }
          } catch (_) {}
          const isDeactivated = tags.includes('account_deactivated') || 
                                tags.includes('email_dead') || 
                                existing.status === 'dead' || 
                                existing.status === 'relogin' || 
                                existing.status === 'need_phone';
          if (existing.ever_ready === 1 && !isDeactivated) {
            newGatewayStatus = 'active';
          }
        }
      }

      const nowIso = new Date().toISOString();
      vault.db.prepare(
        `UPDATE vault_accounts SET is_active = ?, gateway_status = ?, updated_at = ? WHERE id = ?`
      ).run(newIsActive, newGatewayStatus, nowIso, id);

      console.log(`[D1 Proxy] ✅ Local vault updated: ${existing.email} is_active=${newIsActive}, gateway_status=${newGatewayStatus}`);

      // Emit SSE update immediately so other listeners/UI views refresh their states instantly
      emitSSE('vault:update', { reason: 'toggle-active', id, isActive: newIsActive === 1 });

      // 2. Đẩy trực tiếp lên D1 qua endpoint PATCH của Worker (KHÔNG có version check)
      const cfg = loadConfig();
      if (cfg.d1WorkerUrl && cfg.d1SyncSecret) {
        const workerPatchUrl = `${cfg.d1WorkerUrl.replace(/\/+$/, '')}/accounts/${id}`;
        fetch(workerPatchUrl, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'x-sync-secret': cfg.d1SyncSecret,
          },
          body: JSON.stringify({ isActive: newIsActive === 1 }),
          signal: AbortSignal.timeout(10000),
        }).then(async r => {
          const result = await r.json().catch(() => ({}));
          if (r.ok) {
            console.log(`[D1 Proxy] ☁️ Direct PATCH OK: is_active=${newIsActive} for ${existing.email}`);

            // 3. (Smart Sync) Gõ cửa Gateway để bảo Gateway kéo dữ liệu ngay lập tức (delay 500ms chờ D1 truyền tải)
            if (cfg.gatewayUrl && cfg.d1SyncSecret) {
              setTimeout(() => {
                fetch(`${cfg.gatewayUrl.replace(/\/+$/, '')}/api/sync/trigger`, {
                  method: 'POST',
                  headers: {
                    'x-sync-secret': cfg.d1SyncSecret,
                  },
                  signal: AbortSignal.timeout(5000),
                }).then(gr => {
                  if (gr.ok) console.log(`[Smart Sync] 🚀 Đã gửi trigger tới Gateway để pull data`);
                  else console.warn(`[Smart Sync] ⚠️ Gateway trigger responded with status ${gr.status}`);
                }).catch(err => console.error(`[Smart Sync] ⚠️ Gửi trigger tới Gateway lỗi:`, err.message));
              }, 500);
            } else if (cfg.gatewayUrl && !cfg.d1SyncSecret) {
              console.warn(`[Smart Sync] ⚠️ Thiếu d1SyncSecret — bỏ qua trigger tới Gateway`);
            }

          } else {
            console.warn(`[D1 Proxy] ⚠️ Direct PATCH failed (${r.status}):`, result);
            // Fallback
            const updatedRecord = vault.getAccountFull(id);
            if (updatedRecord) SyncManager.pushVault('account', updatedRecord, true).catch(() => { });
          }
        }).catch(err => {
          console.warn(`[D1 Proxy] ⚠️ Direct PATCH error: ${err.message}, fallback to SyncManager`);
          const updatedRecord = vault.getAccountFull(id);
          if (updatedRecord) SyncManager.pushVault('account', updatedRecord, true).catch(() => { });
        });
      } else {
        // Fallback nếu không có config
        const updatedRecord = vault.getAccountFull(id);
        if (updatedRecord) SyncManager.pushVault('account', updatedRecord, true).catch(() => { });
      }

      return res.json({ ok: true, id, isActive: newIsActive === 1 });
    } catch (e) {
      console.error(`[D1 Proxy] toggle error:`, e.message);
      return res.status(500).json({ error: e.message });
    }
  });

  ex.use('/api/d1', async (req, res) => {

    const cfg = loadConfig();
    if (!cfg.d1WorkerUrl || !cfg.d1SyncSecret) {
      return res.status(400).json({ error: "Missing D1 config (url or secret)" });
    }

    // Làm sạch đường dẫn để tránh lỗi // (double slashes)
    const cleanBaseUrl = cfg.d1WorkerUrl.replace(/\/+$/, '');
    const cleanPath = req.url.replace(/^\/+/, '');
    const targetUrl = `${cleanBaseUrl}/${cleanPath}`;

    console.log(`[D1 Proxy] Forwarding ${req.method} ${req.url} -> ${targetUrl}`);

    try {
      const headers = {
        'x-sync-secret': cfg.d1SyncSecret,
        'User-Agent': 'SeeLLM-Tools/1.0',
        'Accept': 'application/json'
      };
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        headers['Content-Type'] = 'application/json';
      }

      const fetchOpts = {
        method: req.method,
        headers,
        signal: AbortSignal.timeout(30000),
      };

      if (req.method !== 'GET' && req.method !== 'HEAD' && Object.keys(req.body || {}).length > 0) {
        fetchOpts.body = JSON.stringify(req.body);
      }

      const r = await fetch(targetUrl, fetchOpts).catch(err => {
        throw new Error(`Cloudflare Connection Error: ${err.message}`);
      });

      const text = await r.text();
      let data = null;
      try {
        data = JSON.parse(text);
      } catch (err) {
        console.error(`[D1 Proxy] Invalid JSON from ${targetUrl}. Status: ${r.status}. Preview: ${text.slice(0, 50)}`);
      }

      res.setHeader('Content-Type', 'application/json');
      res.status(r.status).json(data || {
        ok: false,
        error: `Invalid JSON from D1 (Status: ${r.status})`,
        raw: text.slice(0, 100)
      });
    } catch (e) {
      console.error(`[D1 Proxy] Fatal Error:`, e.message);
      res.setHeader('Content-Type', 'application/json');
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── Error Handling Middleware ───────────────────────────────────────────
  ex.use((err, req, res, next) => {
    console.error(`[Error Handler] Error on ${req.method} ${req.url}:`, err);
    if (err.status === 413 || err.statusCode === 413) {
      console.error(`[Error Handler] Content-Length: ${req.headers['content-length']}, limit: ${err.limit}`);
      return res.status(413).json({
        ok: false,
        error: `Payload quá lớn: ${req.headers['content-length']} bytes (Giới hạn cho phép: ${err.limit} bytes).`
      });
    }
    res.status(err.status || err.statusCode || 500).json({
      ok: false,
      error: err.message || 'Internal Server Error'
    });
  });

  // ── Next.js fallback ─────────────────────────────────────────────────────
  ex.all(/(.*)/, (req, res) => handle(req, res));

  // ── HTTP Server (SSE-only, Socket.IO removed for performance) ───────────────
  const httpServer = createServer(ex);

  // Watch screenshot directory for realtime updates
  watchScreenshots();

  httpServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n[Server] ❌ Port ${PORT} is already in use. Another SeeLLM Tools instance may be running.`);
      console.error(`[Server] Run: lsof -i :${PORT} -t | xargs kill -9`);
      console.error(`[Server] Or change port: PORT=4001 bun run dev\n`);
      process.exit(1);
    } else {
      throw err;
    }
  });

  httpServer.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════╗
║  🛠️  SeeLLM Tools                             ║
║  http://localhost:${PORT}                        ║
║                                              ║
║  data/screenshots → Live Screenshot View     ║
║  data/logs        → Log Files                ║
╚══════════════════════════════════════════════╝
`);
  });
});

let shuttingDown = false;
async function handleTerminationSignal(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logServerEvent(`${signal} received, stopping all processes...`);

  // Close all active browser profiles
  await closeAllProfiles(emitSSE);

  // Stop all running processes
  const stopPromises = Object.entries(processes)
    .filter(([_, e]) => e.status === 'running')
    .map(([id, e]) => {
      try {
        e.proc.kill('SIGTERM');
        return new Promise(resolve => {
          setTimeout(() => {
            if (processes[id]?.status === 'running') {
              e.proc.kill('SIGKILL');
            }
            resolve();
          }, 3000);
        });
      } catch (err) {
        console.error(`Failed to stop process ${id}:`, err.message);
        return Promise.resolve();
      }
    });

  await Promise.all(stopPromises);
  logServerEvent('All processes stopped, exiting...');
  process.exit(0);
}

process.on('SIGINT', () => {
  handleTerminationSignal('SIGINT');
});

process.on('SIGTERM', () => {
  handleTerminationSignal('SIGTERM');
});

process.on('beforeExit', (code) => {
  logServerEvent('beforeExit', `code=${code}`);
});

process.on('exit', (code) => {
  logServerEvent('exit', `code=${code}`);
});

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? `${reason.message}\n${reason.stack || ''}` : String(reason);
  console.error('[Server] unhandledRejection:', msg);
});

process.on('uncaughtException', (err) => {
  console.error('[Server] uncaughtException:', err?.stack || err?.message || String(err));
});
