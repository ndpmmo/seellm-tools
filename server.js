#!/usr/bin/env node
/**
 * SeeLLM Tools - Server
 * Express + Socket.io: manage processes, serve screenshots, sessions API
 */

import { createServer } from 'http';
import { parse } from 'url';
import next from 'next';
import { Server as SocketIO } from 'socket.io';
import express from 'express';
import { spawn } from 'child_process';
import {
  existsSync, readFileSync, writeFileSync,
  readdirSync, statSync, mkdirSync, appendFileSync,
  watch,
} from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadConfig, saveConfig } from './server/db/config.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
import vaultRouter from './server/routes/vault.js';
import { vault } from './server/db/vault.js';
import { SyncManager } from './server/services/syncManager.js';

const dev = process.env.NODE_ENV !== 'production';
const hostname = 'localhost';
const PORT = parseInt(process.env.PORT || '4000', 10);

// ─── Paths ───────────────────────────────────────────────────────────────────
const SCRIPTS_DIR    = path.join(__dirname, 'scripts');
const DATA_DIR       = path.join(__dirname, 'data');
const SCREENSHOTS_DIR = path.join(DATA_DIR, 'screenshots');
const LOGS_DIR       = path.join(DATA_DIR, 'logs');

// Ensure dirs exist
[DATA_DIR, SCREENSHOTS_DIR, LOGS_DIR].forEach(d => {
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
});

// ─── Processes ───────────────────────────────────────────────────────────────
const processes = {};
let io = null;

function makeLogPath(id, name) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const safe = name.replace(/[^\w]/g, '_').slice(0, 40);
  return path.join(LOGS_DIR, `${ts}_${safe}.log`);
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
    startedAt: new Date().toISOString(),
    stoppedAt: null, exitCode: null,
    logFile,
    logs: [],
  };

  // Write header to log file
  appendFileSync(logFile, `# ${name}\n# Started: ${entry.startedAt}\n# PID: ${proc.pid}\n\n`);

  function pushLog(type, raw) {
    raw.toString().split('\n').filter(Boolean).forEach(line => {
      const log = { type, text: line, ts: new Date().toISOString() };
      entry.logs.push(log);
      if (entry.logs.length > 5000) entry.logs.shift();
      // Write to log file
      appendFileSync(logFile, `[${log.ts}] [${type}] ${line}\n`);
      io?.emit('process:log', { id, log });
    });
  }

  proc.stdout.on('data', d => pushLog('stdout', d));
  proc.stderr.on('data', d => pushLog('stderr', d));
  proc.on('exit', (code, signal) => {
    entry.status = code === 0 ? 'stopped' : 'error';
    entry.exitCode = code;
    entry.stoppedAt = new Date().toISOString();
    pushLog('system', `Thoát với code ${code} (signal: ${signal})`);
    appendFileSync(logFile, `\n# Stopped: ${entry.stoppedAt} | Exit: ${code}\n`);
    io?.emit('process:status', { id, status: entry.status, exitCode: code });
  });
  proc.on('error', err => {
    entry.status = 'error';
    pushLog('system', `Lỗi: ${err.message}`);
    io?.emit('process:status', { id, status: 'error' });
  });

  processes[id] = entry;
  io?.emit('process:status', { id, status: 'running', name, pid: proc.pid });
  return { pid: proc.pid };
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
function listSessions() {
  try {
    return readdirSync(SCREENSHOTS_DIR)
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
        } catch {}
        const stat = statSync(dir);
        return { id: d, dir: d, imageCount: images.length, images, mtime: stat.mtime };
      })
      .sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
  } catch { return []; }
}

// Watch SCREENSHOTS_DIR for new files → emit socket event
function watchScreenshots() {
  try {
    watch(SCREENSHOTS_DIR, { recursive: true }, (evt, filename) => {
      if (filename && /\.(png|jpg|jpeg|webp)$/i.test(filename)) {
        const parts = filename.split(path.sep);
        const sessionId = parts[0];
        const imgFile   = parts[parts.length - 1];
        io?.emit('screenshot:new', {
          sessionId,
          filename: imgFile,
          url: `/data/screenshots/${sessionId}/${imgFile}`,
          ts: new Date().toISOString(),
        });
      }
    });
  } catch (e) {
    console.warn('[Watch] Cannot watch screenshots dir:', e.message);
  }
}

// ─── Log files list ──────────────────────────────────────────────────────────
function listLogFiles() {
  try {
    return readdirSync(LOGS_DIR)
      .filter(f => f.endsWith('.log'))
      .sort().reverse()
      .map(f => {
        const s = statSync(path.join(LOGS_DIR, f));
        return { filename: f, size: s.size, mtime: s.mtime };
      });
  } catch { return []; }
}

// ─── Next.js ─────────────────────────────────────────────────────────────────
const app  = next({ dev, hostname, port: PORT });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const ex = express();
  ex.use(express.json());

  // Serve screenshots + logs as static files
  ex.use('/data/screenshots', express.static(SCREENSHOTS_DIR));
  ex.use('/data/logs',        express.static(LOGS_DIR));

  // ── Config ──────────────────────────────────────────────────────────────
  ex.get('/api/config',  (_, res) => res.json(loadConfig()));
  ex.post('/api/config', (req, res) => {
    const cfg = { ...loadConfig(), ...req.body };
    saveConfig(cfg);
    res.json({ ok: true, config: cfg });
  });

  // ── Processes ────────────────────────────────────────────────────────────
  ex.get('/api/processes', (_, res) =>
    res.json(Object.keys(processes).map(id => safeProc(id))));

  ex.post('/api/processes/camofox/start', (req, res) => {
    const cfg = loadConfig();
    const r = spawnProcess('camofox', '🦊 Camofox Browser Server',
      'node', ['server.js'], cfg.camofoxPath,
      { CAMOFOX_PORT: String(cfg.camofoxPort) });
    if (r.error) return res.status(400).json(r);
    res.json({ ok: true, ...r });
  });

  ex.post('/api/processes/worker/start', (req, res) => {
    const cfg = loadConfig();
    const r = spawnProcess('worker', '🤖 Auto-Login Worker',
      'node', [path.join(SCRIPTS_DIR, 'auto-login-worker.js')], __dirname,
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

  // ── Log files ────────────────────────────────────────────────────────────
  ex.get('/api/logfiles', (_, res) => res.json(listLogFiles()));
  ex.get('/api/logfiles/:filename', (req, res) => {
    const p = path.join(LOGS_DIR, path.basename(req.params.filename));
    if (!existsSync(p)) return res.status(404).json({ error: 'Not found' });
    res.type('text/plain').send(readFileSync(p, 'utf-8'));
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

  // ── Vault API (SQLite) ──────────────────────────────────────────────────
  ex.use('/api/vault', vaultRouter);

  // Initial Sync Pull from D1 Cloud (Background)
  SyncManager.pullVault().then(data => {
    if (data) {
      console.log('[Startup] Syncing vault from D1 Cloud...');
      data.accounts.forEach(a => vault.upsertAccount(a, true)); // skipSync=true to avoid feedback loop
      data.proxies.forEach(p => vault.upsertProxy(p, true));
      data.keys.forEach(k => vault.upsertApiKey(k, true));
      console.log('[Startup] Cloud Vault sync complete.');
    }
  }).catch(e => console.error('[Startup] Sync failed:', e.message));

  // ── D1 API Proxy ─────────────────────────────────────────────────────────

  ex.use('/api/d1', async (req, res) => {
    const cfg = loadConfig();
    if (!cfg.d1WorkerUrl || !cfg.d1SyncSecret) {
      return res.status(400).json({ error: "Missing D1 config (url or secret)" });
    }
    
    // In app.use, req.url contains the rest of the path, e.g., /inspect/accounts
    const targetPath = req.url.startsWith('/') ? req.url.slice(1) : req.url;
    const targetUrl = `${cfg.d1WorkerUrl}/${targetPath}`;
    
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
        signal: AbortSignal.timeout(10000),
      };
      
      if (req.method !== 'GET' && req.method !== 'HEAD' && Object.keys(req.body || {}).length > 0) {
        fetchOpts.body = JSON.stringify(req.body);
      }
      
      const r = await fetch(targetUrl, fetchOpts);
      const data = await r.json().catch(() => null);
      res.status(r.status).json(data || { error: "Invalid JSON from D1" });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Next.js fallback ─────────────────────────────────────────────────────
  ex.all(/(.*)/, (req, res) => handle(req, res, parse(req.url, true)));

  // ── HTTP + Socket.io ─────────────────────────────────────────────────────
  const httpServer = createServer(ex);

  io = new SocketIO(httpServer, { cors: { origin: '*' }, path: '/socket.io' });
  io.on('connection', socket => {
    console.log('[Socket] Client:', socket.id);
    socket.emit('processes:sync', Object.keys(processes).map(id => safeProc(id)));
    socket.on('process:getLogs', ({ id }) => {
      const e = processes[id];
      if (e) socket.emit('process:logsHistory', { id, logs: e.logs });
    });
    socket.on('disconnect', () => console.log('[Socket] Disconnected:', socket.id));
  });

  // Watch screenshot directory for realtime updates
  watchScreenshots();

  httpServer.listen(PORT, hostname, () => {
    console.log(`
╔══════════════════════════════════════════════╗
║  🛠️  SeeLLM Tools                             ║
║  http://${hostname}:${PORT}                           ║
║                                              ║
║  data/screenshots → Live Screenshot View     ║
║  data/logs        → Log Files                ║
╚══════════════════════════════════════════════╝
`);
  });
});
