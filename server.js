#!/usr/bin/env node
/**
 * SeeLLM Tools - Server
 * Express + SSE: manage processes, serve screenshots, sessions API
 */

import { createServer } from 'http';
import { parse } from 'url';
import next from 'next';
import express from 'express';
import { spawn } from 'child_process';
import {
  existsSync, readFileSync, writeFileSync,
  readdirSync, statSync, mkdirSync, createWriteStream,
  unlinkSync, rmSync,
  watch,
} from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadConfig, saveConfig } from './server/db/config.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
import vaultRouter, { setSSEEmitter } from './server/routes/vault.js';
import profileRouter, { setProfileSSEEmitter } from './server/routes/profiles.js';
import { vault } from './server/db/vault.js';
import { SyncManager } from './server/services/syncManager.js';
import { recoverProfilesOnStartup, closeAllProfiles } from './server/profileManager.js';

const dev = process.env.NODE_ENV !== 'production';
const hostname = 'localhost';
const PORT = parseInt(process.env.PORT || '4000', 10);

// ─── Paths ───────────────────────────────────────────────────────────────────
const SCRIPTS_DIR = path.join(__dirname, 'scripts');
const DATA_DIR = path.join(__dirname, 'data');
const SCREENSHOTS_DIR = path.join(DATA_DIR, 'screenshots');
const LOGS_DIR = path.join(DATA_DIR, 'logs');

// Ensure dirs exist
[DATA_DIR, SCREENSHOTS_DIR, LOGS_DIR].forEach(d => {
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
});

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
  const safe = name.replace(/[^\w]/g, '_').slice(0, 40);
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

function listSessions() {
  const now = Date.now();
  if (sessionsCache && (now - sessionsCacheTime < SESSIONS_CACHE_TTL)) {
    return sessionsCache;
  }

  try {
    const sessions = readdirSync(SCREENSHOTS_DIR)
      .filter(d => {
        try { return statSync(path.join(SCREENSHOTS_DIR, d)).isDirectory(); } catch { return false; }
      })
      .map(d => {
        const dir = path.join(SCREENSHOTS_DIR, d);
        let images = [];
        try {
          images = readdirSync(dir)
            .filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f))
            .sort()
            .map(f => ({ filename: f, url: `/data/screenshots/${d}/${f}` }));
        } catch { }
        const stat = statSync(dir);
        return {
          id: d,
          dir: d,
          imageCount: images.length,
          images,
          createdAt: stat.birthtime,
          mtime: stat.mtime,
        };
      })
      .sort((a, b) => new Date(b.mtime) - new Date(a.mtime));

    sessionsCache = sessions;
    sessionsCacheTime = now;
    return sessions;
  } catch { return []; }
}

// Watch SCREENSHOTS_DIR for new files → emit SSE event (debounced)
const screenshotEventQueue = new Map(); // sessionId -> { lastEvent: timestamp, timer: null }

function watchScreenshots() {
  try {
    watch(SCREENSHOTS_DIR, { recursive: true }, (evt, filename) => {
      if (filename && /\.(png|jpg|jpeg|webp)$/i.test(filename)) {
        const parts = filename.split(path.sep);
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

            broadcastRealtimeEvent('screenshot:new', {
              sessionId,
              filename: imgFile,
              url: `/data/screenshots/${sessionId}/${imgFile}`,
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
  } catch (e) {
    console.error('[Screenshots] Watch failed:', e.message);
  }
}

// ─── Log files list ──────────────────────────────────────────────────────────
// Cache log files to avoid synchronous rescans on every request
let logFilesCache = null;
let logFilesCacheTime = 0;
const LOGFILES_CACHE_TTL = 5000; // 5 seconds

function listLogFiles() {
  const now = Date.now();
  if (logFilesCache && (now - logFilesCacheTime < LOGFILES_CACHE_TTL)) {
    return logFilesCache;
  }

  try {
    const logFiles = readdirSync(LOGS_DIR)
      .filter(f => f.endsWith('.log'))
      .sort().reverse()
      .map(f => {
        const s = statSync(path.join(LOGS_DIR, f));
        return { filename: f, size: s.size, createdAt: s.birthtime, mtime: s.mtime };
      });

    logFilesCache = logFiles;
    logFilesCacheTime = now;
    return logFiles;
  } catch { return []; }
}

// ─── Next.js ─────────────────────────────────────────────────────────────────
const app = next({ dev, hostname: 'localhost', port: PORT });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const ex = express();
  ex.use(express.json());        // ← PHẢI đứng trước để parse body cho vault router
  // Set SSE emitter for vault router
  setSSEEmitter(emitSSE);
  setProfileSSEEmitter(emitSSE);
  ex.use('/api/vault', vaultRouter);
  ex.use('/api/profiles', profileRouter);

  // Recover profiles on startup (mark orphaned 'active' profiles as 'idle')
  const recoveredCount = recoverProfilesOnStartup();
  if (recoveredCount) console.log(`[ProfileManager] Recovered ${recoveredCount} orphaned profiles`);

  // Serve screenshots + logs as static files
  ex.use('/data/screenshots', express.static(SCREENSHOTS_DIR));
  ex.use('/data/logs', express.static(LOGS_DIR));

  // ── Config ──────────────────────────────────────────────────────────────
  ex.get('/api/config', (_, res) => res.json(loadConfig()));
  ex.post('/api/config', (req, res) => {
    const cfg = { ...loadConfig(), ...req.body };
    saveConfig(cfg);
    res.json({ ok: true, config: cfg });
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
      { CAMOFOX_PORT: String(cfg.camofoxPort) });
    if (r.error) return res.status(400).json(r);
    res.json({ ok: true, command: camofoxNode, ...r });
  });

  ex.post('/api/processes/worker/start', (req, res) => {
    const cfg = loadConfig();
    const r = spawnProcess('worker', '🤖 Unified Auto Worker',
      'node', [path.join(SCRIPTS_DIR, 'auto-worker.js')], __dirname,
      { WORKER_AUTH_TOKEN: cfg.workerAuthToken });
    if (r.error) return res.status(400).json(r);
    res.json({ ok: true, ...r });
  });

  ex.post('/api/processes/connect-worker/start', (req, res) => {
    const cfg = loadConfig();
    const r = spawnProcess('worker', '🤖 Unified Auto Worker',
      'node', [path.join(SCRIPTS_DIR, 'auto-worker.js')], __dirname,
      { WORKER_AUTH_TOKEN: cfg.workerAuthToken });
    if (r.error) return res.status(400).json(r);
    res.json({ ok: true, ...r });
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
  });

  ex.post('/api/processes/:id/stop', (req, res) => {
    const r = stopProcess(req.params.id);
    if (r.error) return res.status(400).json(r);
    res.json({ ok: true });
  });

  // ── Scripts list ─────────────────────────────────────────────────────────
  ex.get('/api/scripts', (_, res) => {
    try {
      res.json(readdirSync(SCRIPTS_DIR)
        .filter(f => (f.endsWith('.js') || f.endsWith('.mjs')) && f !== 'config.js')
        .sort());
    } catch { res.json([]); }
  });

  // ── Sessions (screenshots) ───────────────────────────────────────────────
  ex.get('/api/sessions', (_, res) => res.json(listSessions()));
  ex.get('/api/sessions/:id', (req, res) => {
    const sessions = listSessions();
    const s = sessions.find(x => x.id === req.params.id);
    if (!s) return res.status(404).json({ error: 'Not found' });
    res.json(s);
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
  ex.get('/api/logfiles', (_, res) => res.json(listLogFiles()));
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

  const D1_PULL_INTERVAL_MS = Math.max(60 * 1000, Number(process.env.SEELLM_TOOLS_D1_PULL_INTERVAL_MS || 15 * 60 * 1000));
  const D1_EVENT_POLL_MS = Math.max(30 * 1000, Number(process.env.SEELLM_TOOLS_D1_EVENT_POLL_MS || 60 * 1000));
  const D1_SELF_HEAL_MS = Math.max(60 * 60 * 1000, Number(process.env.SEELLM_TOOLS_D1_SELF_HEAL_MS || 12 * 60 * 60 * 1000));

  startupSync();
  setInterval(doVaultSync, D1_PULL_INTERVAL_MS);

  // ── D1 Event Bus Poller (Zero-Config Realtime Sync) ──
  let lastEventCheck = new Date(Date.now() - 60000).toISOString();
  setInterval(async () => {
    const cfg = loadConfig();
    if (!cfg.d1WorkerUrl || !cfg.d1SyncSecret) return;
    try {
      const res = await fetch(`${cfg.d1WorkerUrl.replace(/\/+$/, '')}/sync/events?since=${encodeURIComponent(lastEventCheck)}&ack=1`, {
        headers: { 'x-sync-secret': cfg.d1SyncSecret },
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
          // Chỉ log để biết Gateway đã xóa. #accounts tự cập nhật khi reload
          // vì nó đọc thẳng từ D1 — không cần chạm vào Vault local
          try {
            const payload = JSON.parse(event.payload);
            console.log(`[EventBus] ℹ️ Gateway đã xóa ${payload.email || payload.accountId} khỏi D1`);
          } catch (err) { }
        }
      }

      if (hasChanges) {
        emitSSE('vault:update', {});
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

  function buildProxyBindings(accounts = [], proxies = [], proxySlots = []) {
    const byId = new Map((proxies || []).map((p) => [String(p.id), p]));
    const byUrl = new Map((proxies || []).map((p) => [normalizeProxyUrl(p.url), p]));
    const slotByAccount = new Map(
      (proxySlots || [])
        .filter((s) => s && !s.deleted_at && s.connection_id)
        .map((s) => [String(s.connection_id), s])
    );

    const bindings = [];
    for (const a of accounts || []) {
      const accountId = String(a?.id || '');
      if (!accountId) continue;
      const proxyUrl = normalizeProxyUrl(a?.proxy_url);
      const proxyId = a?.proxy_id || null;
      const slot = slotByAccount.get(accountId) || null;
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
      .sort((a, b) => b.free - a.free);

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
        // Reset trạng thái thủ công bằng db.prepare để ép bỏ qua protective logic của upsertAccount
        vault.db.prepare(`
          UPDATE vault_accounts 
          SET deleted_at = NULL, status = 'pending', notes = '', password = ?, two_fa_secret = ?, proxy_url = ?, updated_at = datetime('now')
          WHERE id = ?
        `).run(body.password || '', body.twoFaSecret || '', body.proxyUrl || null, existing.id);

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

      // Thông báo Gateway xóa connection tương ứng (đồng bộ Gateway ← Tools)
      const cfg = loadConfig();
      if (id && cfg.gatewayUrl) {
        notifyGatewayDeleteAccount(cfg.gatewayUrl, id).then((ok) => {
          if (ok) {
            console.log(`[D1 Proxy] ✅ Đã truyền lệnh xóa cho Gateway (accounts/codex/${id}).`);
          }
        }).catch(() => { });
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
      const [accountsR, proxiesR] = await Promise.all([
        d1Request(cfg, 'inspect/accounts?limit=1000'),
        d1Request(cfg, 'inspect/proxies'),
      ]);
      const accounts = Array.isArray(accountsR.data?.items) ? accountsR.data.items : [];
      const proxies = Array.isArray(proxiesR.data?.proxies) ? proxiesR.data.proxies : [];
      const proxySlots = Array.isArray(proxiesR.data?.proxySlots) ? proxiesR.data.proxySlots : [];
      let account = accounts.find(a => a.id === accountId);
      if (!account) {
        console.log(`[D1 Proxy] Account ${accountId} not found in D1. Attempting auto-sync from local...`);
        const localAcc = vault.getAccount(accountId);
        if (!localAcc) return res.status(404).json({ error: 'Account not found in local vault' });

        try {
          const syncResult = await SyncManager.pushVault('account', localAcc);
          if (!syncResult || !syncResult.ok) throw new Error('Sync failed');
        } catch (err) {
          console.error(`[D1 Proxy] Auto-sync failed for ${accountId}:`, err.message);
          return res.status(500).json({ error: 'Account not mirrored in Cloud D1. Please click "Sync All to D1" first.' });
        }
        account = localAcc;
      }

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
          .sort((a, b) => b.free - a.free);
        if (!ranked.length) return res.status(400).json({ error: 'No proxy with free slots' });
        chosen = ranked[0].proxy;
      }

      const patchBody = { proxyUrl: normalizeProxyUrl(chosen.url), proxyId: chosen.id };
      const patchR = await d1Request(cfg, `accounts/${accountId}`, { method: 'PATCH', body: patchBody });
      if (!patchR.ok) {
        return res.status(patchR.status).json(patchR.data || { error: patchR.text || 'Patch failed' });
      }

      mirrorPatchedAccountToLocal(accountId, patchBody);
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
      const [accountsR, proxiesR] = await Promise.all([
        d1Request(cfg, 'inspect/accounts?limit=1000'),
        d1Request(cfg, 'inspect/proxies'),
      ]);
      const accounts = Array.isArray(accountsR.data?.items) ? accountsR.data.items : [];
      const proxies = Array.isArray(proxiesR.data?.proxies) ? proxiesR.data.proxies : [];
      const proxySlots = Array.isArray(proxiesR.data?.proxySlots) ? proxiesR.data.proxySlots : [];
      const freeByProxy = computeProxyFreeSlots(proxies, proxySlots);
      const bindings = buildProxyBindings(accounts, proxies, proxySlots);

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
      if (!patchR.ok) {
        return res.status(patchR.status).json(patchR.data || { error: patchR.text || 'Patch failed' });
      }

      mirrorPatchedAccountToLocal(accountId, patchBody);
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
      const [accountsR, proxiesR] = await Promise.all([
        d1Request(cfg, 'inspect/accounts?limit=1000'),
        d1Request(cfg, 'inspect/proxies'),
      ]);
      const accounts = Array.isArray(accountsR.data?.items) ? accountsR.data.items : [];
      const proxies = Array.isArray(proxiesR.data?.proxies) ? proxiesR.data.proxies : [];
      const proxySlots = Array.isArray(proxiesR.data?.proxySlots) ? proxiesR.data.proxySlots : [];
      const freeByProxy = computeProxyFreeSlots(proxies, proxySlots);

      let done = 0;
      const errors = [];
      for (const accountId of ids) {
        try {
          const account = accounts.find((a) => a.id === accountId) || vault.getAccount(accountId);
          if (!account) throw new Error('Account not found');

          if (action === 'unassign') {
            const patchBody = { proxyUrl: '', proxyId: null };
            const patchR = await d1Request(cfg, `accounts/${accountId}`, { method: 'PATCH', body: patchBody });
            if (!patchR.ok) throw new Error(patchR.data?.error || patchR.text || 'Patch failed');
            mirrorPatchedAccountToLocal(accountId, patchBody);
            const slotSync = await rebindProxySlotForAccount({ cfg, accountId, targetProxyId: null, proxySlots });
            if (!slotSync.ok) throw new Error(slotSync.error || 'Slot sync failed');
            done++;
            continue;
          }

          let chosen = null;
          if (proxyId) {
            chosen = proxies.find((p) => p.id === proxyId) || null;
            if (!chosen) throw new Error('Proxy not found');
            if ((freeByProxy.get(chosen.id) || 0) <= 0) throw new Error('Proxy has no free slot');
          } else {
            const ranked = proxies
              .map((p) => ({ proxy: p, free: freeByProxy.get(p.id) || 0 }))
              .filter((x) => x.free > 0)
              .sort((a, b) => b.free - a.free);
            if (!ranked.length) throw new Error('No proxy with free slots');
            chosen = ranked[0].proxy;
          }

          const patchBody = { proxyUrl: normalizeProxyUrl(chosen.url), proxyId: chosen.id };
          const patchR = await d1Request(cfg, `accounts/${accountId}`, { method: 'PATCH', body: patchBody });
          if (!patchR.ok) throw new Error(patchR.data?.error || patchR.text || 'Patch failed');
          mirrorPatchedAccountToLocal(accountId, patchBody);
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
      const [accountsR, proxiesR] = await Promise.all([
        d1Request(cfg, 'inspect/accounts?limit=1000'),
        d1Request(cfg, 'inspect/proxies'),
      ]);
      const accounts = Array.isArray(accountsR.data?.items) ? accountsR.data.items : [];
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
          .sort((a, b) => b.free - a.free);
        if (!ranked.length) break;

        // Nếu account chưa có trên D1, tự động đồng bộ lên trước khi gán
        if (!accounts.find(a => a.id === account.id)) {
          console.log(`[D1 Proxy] Auto-syncing missing account ${account.email} before assign...`);
          try {
            await SyncManager.pushVault('account', account);
          } catch (err) {
            console.error(`[D1 Proxy] Auto-sync failed for ${account.email}:`, err.message);
            continue; // Bỏ qua account bị lỗi sync
          }
        }

        const chosen = ranked[0].proxy;
        const patchBody = { proxyUrl: normalizeProxyUrl(chosen.url), proxyId: chosen.id };
        const patchR = await d1Request(cfg, `accounts/${account.id}`, { method: 'PATCH', body: patchBody });
        if (!patchR.ok) continue;
        mirrorPatchedAccountToLocal(account.id, patchBody);
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

      return res.json({ ok: true, assigned, total: pending.length });
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
      vault.db.prepare(
        `UPDATE vault_accounts SET is_active = ?, updated_at = datetime('now') WHERE id = ?`
      ).run(newIsActive, id);

      console.log(`[D1 Proxy] ✅ Local vault updated: ${existing.email} is_active=${newIsActive}`);

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

            // 3. (Smart Sync) Gõ cửa Gateway để bảo Gateway kéo dữ liệu ngay lập tức
            if (cfg.gatewayUrl && cfg.d1SyncSecret) {
              fetch(`${cfg.gatewayUrl.replace(/\/+$/, '')}/api/sync/trigger`, {
                method: 'POST',
                headers: {
                  'x-sync-secret': cfg.d1SyncSecret,
                },
                signal: AbortSignal.timeout(3000),
              }).then(gr => {
                if (gr.ok) console.log(`[Smart Sync] 🚀 Đã gửi trigger tới Gateway để pull data`);
              }).catch(err => console.error(`[Smart Sync] ⚠️ Gửi trigger tới Gateway lỗi:`, err.message));
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

  // ── Next.js fallback ─────────────────────────────────────────────────────
  ex.all(/(.*)/, (req, res) => handle(req, res));

  // ── HTTP Server (SSE-only, Socket.IO removed for performance) ───────────────
  const httpServer = createServer(ex);

  // Watch screenshot directory for realtime updates
  watchScreenshots();

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
