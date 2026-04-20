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
  unlinkSync, rmSync,
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
let io = null;

function logServerEvent(label, extra = '') {
  const suffix = extra ? ` ${extra}` : '';
  console.log(`[Server] ${label}${suffix}`);
}

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
    // code is 0 for normal exit, null for exit via signal (SIGTERM/SIGKILL)
    entry.status = (code === 0 || code === null) ? 'stopped' : 'error';
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
  } catch { return []; }
}

// Watch SCREENSHOTS_DIR for new files → emit socket event
function watchScreenshots() {
  try {
    watch(SCREENSHOTS_DIR, { recursive: true }, (evt, filename) => {
      if (filename && /\.(png|jpg|jpeg|webp)$/i.test(filename)) {
        const parts = filename.split(path.sep);
        const sessionId = parts[0];
        const imgFile = parts[parts.length - 1];

        let email = sessionId;
        try {
          // Thử tra cứu email từ local Vault dựa trên sessionId (chính là account ID)
          const accRow = vault.db.prepare('SELECT email FROM vault_accounts WHERE id = ?').get(sessionId);
          if (accRow && accRow.email) {
            email = accRow.email;
          }
        } catch (e) { }

        io?.emit('screenshot:new', {
          sessionId,
          email,
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
        return { filename: f, size: s.size, createdAt: s.birthtime, mtime: s.mtime };
      });
  } catch { return []; }
}

// ─── Next.js ─────────────────────────────────────────────────────────────────
const app = next({ dev, hostname: 'localhost', port: PORT });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const ex = express();
  ex.use(express.json());        // ← PHẢI đứng trước để parse body cho vault router
  ex.use('/api/vault', vaultRouter);

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
    const r = spawnProcess('worker', '🤖 Auto-Login Worker',
      'node', [path.join(SCRIPTS_DIR, 'auto-login-worker.js')], __dirname,
      { WORKER_AUTH_TOKEN: cfg.workerAuthToken });
    if (r.error) return res.status(400).json(r);
    res.json({ ok: true, ...r });
  });

  ex.post('/api/processes/connect-worker/start', (req, res) => {
    const r = spawnProcess('connect-worker', '🔌 Auto-Connect Worker',
      'node', [path.join(SCRIPTS_DIR, 'auto-connect-worker.js')], __dirname, {});
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
        io?.emit('vault:synced', { cursor: lastVaultSyncCursor });
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

      if (hasChanges && io) {
        io.emit('vault:update');
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
    if (payload.last_error !== undefined) patch.notes = payload.last_error || '';
    if (payload.lastError !== undefined) patch.notes = payload.lastError || '';

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
    if (!freeSlot) return { ok: false, error: 'Target proxy has no free slot' };
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
        fetch(`${cfg.gatewayUrl.replace(/\/+$/, '')}/api/automation/accounts/codex/${id}`, {
          method: 'DELETE',
          signal: AbortSignal.timeout(5000)
        }).then(() => {
          console.log(`[D1 Proxy] ✅ Đã truyền lệnh xóa cho Gateway (accounts/codex/${id}).`);
        }).catch(e => {
          console.log(`[D1 Proxy] ⚠️ Lỗi khi gọi Gateway xóa: ${e.message}`);
        });
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
      const account = accounts.find(a => a.id === accountId);
      if (!account) return res.status(404).json({ error: 'Account not found in D1' });

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

      const pending = accounts.filter(a => !normalizeProxyUrl(a?.proxy_url) && !a?.deleted_at);
      const freeByProxy = computeProxyFreeSlots(proxies, proxySlots);

      let assigned = 0;
      for (const account of pending) {
        const ranked = proxies
          .map((p) => ({ proxy: p, free: freeByProxy.get(p.id) || 0 }))
          .filter((x) => x.free > 0)
          .sort((a, b) => b.free - a.free);
        if (!ranked.length) break;
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
        vault.upsertProxy({
          id: d1Data.id,
          url: body.url,
          label: body.label || '',
          type: body.url.startsWith('socks5://') ? 'socks5' : 'http',
        });
        console.log(`[D1 Proxy] ✅ Mirrored New Proxy to local: ${body.url} (id=${d1Data.id})`);
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

  // ── HTTP + Socket.io ─────────────────────────────────────────────────────
  const httpServer = createServer(ex);

  io = new SocketIO(httpServer, { cors: { origin: '*' }, path: '/socket.io' });
  io.on('connection', socket => {
    const transport = socket.conn?.transport?.name || 'unknown';
    console.log('[Socket] Client:', socket.id, `transport=${transport}`);
    socket.emit('processes:sync', Object.keys(processes).map(id => safeProc(id)));
    socket.on('process:getLogs', ({ id }) => {
      const e = processes[id];
      if (e) socket.emit('process:logsHistory', { id, logs: e.logs });
    });
    socket.on('disconnect', (reason) => console.log('[Socket] Disconnected:', socket.id, `reason=${reason}`));
    socket.conn.on('upgrade', () => {
      const upgraded = socket.conn?.transport?.name || 'unknown';
      console.log('[Socket] Upgraded:', socket.id, `transport=${upgraded}`);
    });
    socket.on('error', (err) => console.log('[Socket] Error:', socket.id, err?.message || String(err)));
  });

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
function handleTerminationSignal(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logServerEvent(`${signal} received`);
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
