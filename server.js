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
const app  = next({ dev, hostname: 'localhost', port: PORT });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const ex = express();
  ex.use(express.json());        // ← PHẢI đứng trước để parse body cho vault router
  ex.use('/api/vault', vaultRouter);

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

  // ── Vault API (SQLite) — đã mount ở dòng trên rồi, không mount lại ──────

  // ── Cloud Vault Synchronization Loop ───────────────────────────────────
  const CURSOR_FILE = path.join(__dirname, 'data', 'sync_cursor.json');

  function loadCursor() {
    try {
      if (existsSync(CURSOR_FILE)) {
        const { cursor } = JSON.parse(readFileSync(CURSOR_FILE, 'utf-8'));
        if (cursor && cursor > '1970') return cursor;
      }
    } catch (_) {}
    return '1970-01-01T00:00:00.000Z';
  }

  function saveCursor(cursor) {
    try {
      writeFileSync(CURSOR_FILE, JSON.stringify({ cursor, savedAt: new Date().toISOString() }));
    } catch (_) {}
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

  startupSync();
  setInterval(doVaultSync, 15 * 60 * 1000); // 15 phút (Đã có Interceptors xử lý tức thời)

  // ── D1 Event Bus Poller (Zero-Config Realtime Sync) ──
  let lastEventCheck = new Date(Date.now() - 60000).toISOString();
  setInterval(async () => {
    const cfg = loadConfig();
    if (!cfg.d1WorkerUrl || !cfg.d1SyncSecret) return;
    try {
      const res = await fetch(`${cfg.d1WorkerUrl.replace(/\/+$/, '')}/sync/events?since=${encodeURIComponent(lastEventCheck)}`, {
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
          try {
            const payload = JSON.parse(event.payload);
            const updated = vault.db.prepare(
              "UPDATE vault_accounts SET status=?, updated_at=? WHERE id=? AND status != 'idle'"
            ).run('idle', new Date().toISOString(), payload.accountId);
            
            if (updated.changes > 0) {
              console.log(`[EventBus] 🔄 Gateway đã xóa ${payload.email} → Chuyển về idle`);
              hasChanges = true;
            }
          } catch(err) {}
        }
      }
      
      if (hasChanges && io) {
        io.emit('vault:update');
      }
      // Trừ lùi 5 giây để tránh mất event do chênh lệch mili-giây hoặc clock drift giữa VPS/Local/Cloud
      lastEventCheck = new Date(Date.now() - 5000).toISOString();
    } catch(e) { /* Bỏ qua lỗi mạng */ }
  }, 30 * 1000); // 30s
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
  }, 3 * 60 * 60 * 1000);

  // ── D1 API Proxy ─────────────────────────────────────────────────────────

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
          id:           d1Data.id,
          provider:     'codex',
          email:        body.email,
          password:     body.password || '',
          two_fa_secret: body.twoFaSecret || '',
          proxy_url:    body.proxyUrl || null,
          status:       'pending',
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
      console.log(`[D1 Proxy] 🛑 Bắt lệnh xóa Codex account. ID: ${id} → Thu hồi về Vault (idle)`);
      if (id) {
        const existing = vault.db.prepare('SELECT id, email, status FROM vault_accounts WHERE id = ?').get(id);
        if (existing && existing.status !== 'idle') {
          // Chỉ thu hồi về idle, KHÔNG xóa — Vault là kho lưu trữ độc lập
          vault.db.prepare('UPDATE vault_accounts SET status = ?, updated_at = ? WHERE id = ?')
            .run('idle', new Date().toISOString(), id);
          console.log(`[D1 Proxy] 🔄 Account ${existing.email} → idle (vẫn còn trong Vault)`);
          // 📡 Thông báo UI cập nhật ngay lập tức (trước đây thiếu bước này)
          if (io) io.emit('vault:update');
        }
      }
      return next(); // Vẫn cho proxy qua D1 để xóa khỏi Codex Cloud
    } catch(e) {
      return next();
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
    } catch(e) {
      return next();
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
