import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { vault } from '../db/vault.js';
import { SyncManager } from '../services/syncManager.js';
import { loadConfig } from '../db/config.js';
import { getNextProxyLabel, reallocateAccountsFromDeletedProxies, allocateProxySlotForAccount } from '../services/proxySlotAllocator.js';
import {
  parseCodexIdToken,
  getConsistentMachineId,
  buildStableDeviceId,
  mergeCodexProviderData,
} from '../services/codexMetadata.js';
import { extractAccountMeta } from '../../scripts/lib/openai-auth.js';
import { auditLog } from '../db/auditLog.js';
import { broadcastAudit } from './auditLog.js';

const router = express.Router();
router.use(express.json({ limit: '200mb' })); // Bắt buộc: parse JSON body cho mọi route trong router này

// Throttle cho connect-task debug log (tránh spam mỗi 10s)
let connectTaskLogThrottle = false;

// SSE emitter - set from server.js (replaces Socket.IO for realtime events)
let emitSSE = null;
export function setSSEEmitter(emitter) {
  emitSSE = emitter;
}

// Clear live screenshots associated with a task ID when a task finishes
async function clearLiveScreenshots(taskId) {
  if (!emitSSE) return;
  try {
    const screenshotsDir = path.join(process.cwd(), 'data', 'screenshots');
    if (fs.existsSync(screenshotsDir)) {
      const entries = await fs.promises.readdir(screenshotsDir).catch(() => []);
      for (const d of entries) {
        if (d.startsWith(`connect_${taskId}_`) || d.startsWith(`run_${taskId}_`)) {
          console.log(`[SSE] Clearing live screenshot session: ${d} (task completed)`);
          emitSSE('screenshot:clear', { sessionId: d });
        }
      }
    }
  } catch (err) {
    console.error('[Vault] Error clearing live screenshots:', err.message);
  }
}

/** Helper: audit + broadcast realtime */
function logAudit(opts) {
  const entry = auditLog(opts);
  broadcastAudit({ ...opts, id: entry.id, createdAt: entry.createdAt });
  return entry;
}

/**
 * Trigger Gateway Next.js to pull latest snapshot from D1 immediately.
 * Giảm độ trễ từ 30s (Gateway syncTick) xuống < 2s.
 * Best-effort — nếu Gateway không chạy Next.js (ví dụ chỉ dùng D1 Worker),
 * HTTP 404 là expected → silently skip.
 */
async function triggerGatewaySync(reason = 'manual') {
  const cfg = loadConfig();
  if (!cfg.d1SyncSecret) return;

  const targets = [];
  if (cfg.gatewayUrl && !cfg.gatewayUrl.includes('workers.dev') && !cfg.gatewayUrl.includes('gateway-db.seellm.xyz')) {
    targets.push(cfg.gatewayUrl);
  }
  if (cfg.gatewayAppUrl) {
    targets.push(cfg.gatewayAppUrl);
  } else {
    targets.push('http://localhost:1404');
  }

  for (const target of targets) {
    try {
      const url = `${target.replace(/\/+$/, '')}/api/sync/trigger`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'x-sync-secret': cfg.d1SyncSecret, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        console.log(`[GatewayTrigger] ✅ Gateway ${target} pulled snapshot (reason=${reason})`);
      } else if (res.status !== 404) {
        console.log(`[GatewayTrigger] ⚠️ Gateway ${target} trigger HTTP ${res.status} (reason=${reason})`);
      }
    } catch (e) {
      // Best-effort
    }
  }
}

/* ─── Tag helpers ──────────────────────────────────────────────────────── */
function safeParseTags(raw) {
  if (!raw) return [];
  if (typeof raw === 'object') return Array.isArray(raw) ? raw : [];
  try { return JSON.parse(raw); } catch { return []; }
}

function maybeAddNeedPhoneTag(id, message) {
  if (!message || !String(message).includes('NEED_PHONE')) return;
  const account = vault.getAccountFull(id);
  if (!account) return;
  const tags = safeParseTags(account.tags);
  if (!tags.includes('need_phone')) {
    tags.push('need_phone');
    vault.upsertAccount({ id, tags });
  }
}

function isDeactivatedMsg(message) {
  if (!message) return false;
  const msg = String(message).toLowerCase();
  return msg.includes('account_deactivated') || 
         msg.includes('deactivated') || 
         msg.includes('deactive') || 
         msg.includes('vô hiệu hóa') || 
         msg.includes('vô hiệu hoá') || 
         msg.includes('đã bị xóa') || 
         msg.includes('đã bị xoá') || 
         msg.includes('bị khóa') || 
         msg.includes('bị khoá') || 
         msg.includes('bị block');
}

function isReloginMsg(message) {
  if (!message) return false;
  const msg = String(message).toLowerCase();
  return msg.includes('relogin') || msg.includes('password_reset_required') || msg.includes('reset password') || msg.includes('đặt lại mật khẩu') || msg.includes('wrong_password') || msg.includes('incorrect password') || msg.includes('mật khẩu không đúng') || msg.includes('sai mật khẩu');
}

function maybeAddAccountDeactivatedTag(id, message) {
  if (isDeactivatedMsg(message)) {
    const account = vault.getAccountFull(id);
    if (!account) return;
    const tags = safeParseTags(account.tags);
    if (!tags.includes('account_deactivated')) {
      tags.push('account_deactivated');
      vault.upsertAccount({ id, tags });
    }
  }
}

function isWrongPasswordMsg(message) {
  if (!message) return false;
  const msg = String(message).toLowerCase();
  return msg.includes('wrong_password') || msg.includes('incorrect password') || msg.includes('mật khẩu không đúng') || msg.includes('sai mật khẩu');
}

function maybeAddWrongPasswordTag(id, message) {
  if (isWrongPasswordMsg(message)) {
    const account = vault.getAccountFull(id);
    if (!account) return;
    const tags = safeParseTags(account.tags);
    if (!tags.includes('wrong_password')) {
      tags.push('wrong_password');
      vault.upsertAccount({ id, tags });
    }
  }
}

function isNeed2faMsg(message) {
  if (!message) return false;
  const msg = String(message).toLowerCase();
  return msg.includes('yêu cầu 2fa') || msg.includes('need 2fa') || msg.includes('missing 2fa') || msg.includes('missing secret key');
}

function maybeAddNeed2faTag(id, message) {
  if (isNeed2faMsg(message)) {
    const account = vault.getAccountFull(id);
    if (!account) return;
    const tags = safeParseTags(account.tags);
    if (!tags.includes('need_2fa')) {
      tags.push('need_2fa');
      vault.upsertAccount({ id, tags });
    }
  }
}

function isEmailErrorMsg(message) {
  if (!message) return false;
  const msg = String(message).toLowerCase();
  return msg.includes('abuse mode') || 
         msg.includes('service abuse') || 
         msg.includes('email_locked') || 
         msg.includes('không lấy được mã otp từ email') || 
         msg.includes('không lấy được otp từ email') || 
         msg.includes('email-verification screen') || 
         msg.includes('fetch otp from mail failed') || 
         msg.includes('email credentials') || 
         msg.includes('login to email failed') ||
         msg.includes('lỗi lấy access token') ||
         msg.includes('graph api') ||
         msg.includes('mail.read') ||
         msg.includes('outlook.office.com') ||
         msg.includes('hộp thư');
}

function isPasswordTooShortMsg(message) {
  if (!message) return false;
  const msg = String(message).toLowerCase();
  return msg.includes('password_too_short') || msg.includes('ngắn hơn yêu cầu 12 ký tự') || msg.includes('too_short') || msg.includes('at least 12 characters');
}

function maybeAddShortPasswordTag(id, message) {
  if (isPasswordTooShortMsg(message)) {
    const account = vault.getAccountFull(id);
    if (!account) return;
    const tags = safeParseTags(account.tags);
    if (!tags.includes('short_password')) {
      tags.push('short_password');
      vault.upsertAccount({ id, tags });
    }
  }
}

function maybeAddEmailErrorTag(id, message) {
  if (isEmailErrorMsg(message)) {
    const account = vault.getAccountFull(id);
    if (!account) return;
    const tags = safeParseTags(account.tags);
    if (!tags.includes('email_error')) {
      tags.push('email_error');
      vault.upsertAccount({ id, tags });
    }
  }
}


function removeNeedPhoneTag(id) {
  const account = vault.getAccountFull(id);
  if (!account) return;
  const tags = safeParseTags(account.tags).filter((t) => t !== 'need_phone');
  vault.upsertAccount({ id, tags });
}

function updateWorkspaceTag(id, hasWorkspace) {
  const account = vault.getAccountFull(id);
  if (!account) return;
  const tags = safeParseTags(account.tags);
  const hasTag = tags.includes('workspace');
  if (hasWorkspace && !hasTag) {
    tags.push('workspace');
    vault.upsertAccount({ id, tags });
  } else if (!hasWorkspace && hasTag) {
    const updatedTags = tags.filter(t => t !== 'workspace');
    vault.upsertAccount({ id, tags: updatedTags });
  }
}

/** Tag vault-accounts with 'email_dead' when their email is dead in the pool */
function propagateEmailDeadTag(email) {
  const accounts = vault.getAccounts();
  const matched = accounts.filter(a => a.email === email);
  for (const account of matched) {
    const tags = safeParseTags(account.tags);
    if (!tags.includes('email_dead')) {
      tags.push('email_dead');
      vault.upsertAccount({ id: account.id, tags });
      logAudit({
        action: 'tag',
        entity: 'account',
        entityId: account.id,
        entityLabel: email,
        details: { tag: 'email_dead', reason: 'Email pool verification failed' },
        severity: 'warning',
        source: 'system',
      });
    }
  }
}

/** Remove 'email_dead' tag from vault-accounts when their email becomes active again */
function removeEmailDeadTag(email) {
  const accounts = vault.getAccounts();
  const matched = accounts.filter(a => a.email === email);
  for (const account of matched) {
    const tags = safeParseTags(account.tags);
    if (tags.includes('email_dead')) {
      const updatedTags = tags.filter(t => t !== 'email_dead');
      vault.upsertAccount({ id: account.id, tags: updatedTags });
      logAudit({
        action: 'untag',
        entity: 'account',
        entityId: account.id,
        entityLabel: email,
        details: { tag: 'email_dead', reason: 'Email pool verification passed' },
        severity: 'success',
        source: 'system',
      });
    }
  }
}

/* ─── PKCE Generator ─────────────────────────────────────────────────────── */
function generateCodexOAuthUrl() {
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  const state = crypto.randomBytes(32).toString('base64url');
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
    redirect_uri: 'http://localhost:1455/auth/callback',
    scope: 'openid profile email offline_access',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    originator: 'codex_cli_rs',
    state,
  });
  return {
    url: `https://auth.openai.com/oauth/authorize?${params}`,
    codeVerifier,
    state,
  };
}

/* ─── Token Exchange ─────────────────────────────────────────────────────── */
async function exchangeCodeForTokens(code, codeVerifier, options = {}) {
  const { userAgent, proxyUrl } = options;
  const targetUrl = 'https://auth.openai.com/oauth/token';
  const postData = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
    code,
    redirect_uri: 'http://localhost:1455/auth/callback',
    code_verifier: codeVerifier,
  }).toString();

  const ua = userAgent || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';

  console.log(`[OAuth] 🔄 Exchanging code for account... (Proxy: ${proxyUrl ? 'YES' : 'NO'})`);

  // --- TRƯỜNG HỢP CÓ PROXY: Dùng CURL để đảm bảo ổn định IP ---
  if (proxyUrl) {
    try {
      const { execSync } = await import('node:child_process');
      const curlCmd = [
        'curl', '-s', '-X', 'POST',
        '-H', '"Content-Type: application/x-www-form-urlencoded"',
        '-H', `"User-Agent: ${ua}"`,
        '-H', '"Origin: https://auth.openai.com"',
        '-H', '"Referer: https://auth.openai.com/"',
        '-H', '"Accept: application/json"',
        '--proxy', `"${proxyUrl}"`,
        '--data', `"${postData}"`,
        `"${targetUrl}"`
      ].join(' ');

      const responseText = execSync(curlCmd, { encoding: 'utf8', timeout: 15000 });
      const data = JSON.parse(responseText);

      if (data.error) {
        throw new Error(`OpenAI Error: ${data.error_description || data.error.message || JSON.stringify(data.error)}`);
      }

      console.log(`[OAuth] ✅ Exchange SUCCESS (via Proxy)`);
      return data;
    } catch (err) {
      console.warn(`[OAuth] ⚠️ Curl Exchange failed: ${err.message}`);
      // Fallback xuống fetch nếu curl lỗi
    }
  }

  // --- TRƯỜNG HỢP KHÔNG PROXY HOẶC CURL LỖI ---
  const res = await fetch(targetUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': ua,
      'Origin': 'https://auth.openai.com',
      'Referer': 'https://auth.openai.com/',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    body: postData,
  });

  const text = await res.text();
  if (!res.ok) {
    console.error(`[OAuth] ❌ Exchange failed (${res.status}):`, text);
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }

  const data = JSON.parse(text);
  console.log(`[OAuth] ✅ Exchange SUCCESS`);
  return data;
}

/* ─── In-memory PKCE store: account_id → {url, codeVerifier, createdAt} ─── */
// Giữ PKCE cố định cho 1 account cho đến khi hoàn thành (tránh 400 invalid_request)
const pkceStore = new Map();

/* ══════════════════════════════════════════════════════════════════════════ */
/*  ACCOUNTS CRUD                                                             */
/* ══════════════════════════════════════════════════════════════════════════ */

// GET /api/vault/accounts
router.get('/accounts', (req, res) => {
  try { res.json({ ok: true, items: vault.getAccounts() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/vault/accounts  (create or update)
router.post('/accounts', async (req, res) => {
  try {
    const isNew = !req.body.id;
    const skipSync = req.body.skipSync === true;
    const record = vault.upsertAccount(req.body, skipSync);
    res.json({ ok: true, id: record.id });

    // Audit log
    logAudit({
      action: isNew ? 'create' : 'update',
      entity: 'account',
      entityId: record.id,
      entityLabel: record.email || record.label || record.id,
      details: { provider: record.provider, status: record.status, proxy: !!record.proxy_url },
      severity: isNew ? 'success' : 'info',
      source: 'ui',
    });

    // New Codex account → push lên D1 managed để Worker auto-login
    if (isNew && record.provider === 'codex' && !skipSync) {
      console.log(`[Vault] 🚀 New Codex account → Sync to D1: ${record.email}`);
      // SyncManager đã được gọi bởi upsertAccount
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/vault/accounts/:idOrEmail
router.get('/accounts/:idOrEmail', (req, res, next) => {
  try {
    const { idOrEmail } = req.params;
    if (['task', 'connect-task'].includes(idOrEmail)) {
      return next();
    }
    let account = vault.getAccount(idOrEmail);
    if (!account && idOrEmail.includes('@')) {
      const a = vault.db.prepare('SELECT * FROM vault_accounts WHERE email = ? AND deleted_at IS NULL').get(idOrEmail);
      if (a) {
        account = {
          ...a,
          password: a.password,
          two_fa_secret: a.two_fa_secret,
          access_token: a.access_token,
          refresh_token: a.refresh_token,
          tags: JSON.parse(a.tags || '[]'),
          cookies: JSON.parse(a.cookies || '[]'),
          provider_specific_data: JSON.parse(a.provider_specific_data || '{}'),
          gateway_status: a.gateway_status ?? null,
        };
      }
    }
    if (!account) return res.status(404).json({ error: 'Account not found' });
    res.json({ ok: true, account });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// DELETE /api/vault/accounts/:id
router.delete('/accounts/:id', async (req, res) => {
  try {
    const account = vault.getAccount(req.params.id);
    const deleteLinkedEmail = req.query.deleteLinkedEmail === 'true';
    vault.deleteAccount(req.params.id, false, deleteLinkedEmail); // triggers SyncManager internally
    res.json({ ok: true });

    // Audit log
    logAudit({
      action: 'delete',
      entity: 'account',
      entityId: req.params.id,
      entityLabel: account?.email || account?.label || req.params.id,
      details: { provider: account?.provider, hadProxy: !!account?.proxy_url, deleteLinkedEmail },
      severity: 'warning',
      source: 'ui',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ══════════════════════════════════════════════════════════════════════════ */
/*  PROXIES CRUD                                                              */
/* ══════════════════════════════════════════════════════════════════════════ */

router.get('/proxies', (req, res) => {
  try { res.json({ ok: true, items: vault.getProxies() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Lightweight list for workshop proxy selector dropdown
router.get('/proxies/list', (req, res) => {
  try {
    const items = vault.getProxies().map(p => ({ id: p.id, label: p.label || '', url: p.url, type: p.type, is_active: p.is_active }));
    res.json({ ok: true, items });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/proxies', async (req, res) => {
  try {
    const isNew = !req.body.id;
    const record = vault.upsertProxy(req.body);
    res.json({ ok: true, id: record.id });

    logAudit({
      action: isNew ? 'create' : 'update',
      entity: 'proxy',
      entityId: record.id,
      entityLabel: record.label || record.url,
      details: { type: record.type, country: record.country },
      severity: isNew ? 'success' : 'info',
      source: 'ui',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/proxies/:id', async (req, res) => {
  try {
    const proxy = vault.db.prepare('SELECT * FROM vault_proxies WHERE id = ?').get(req.params.id);
    vault.deleteProxy(req.params.id);
    res.json({ ok: true });

    logAudit({
      action: 'delete',
      entity: 'proxy',
      entityId: req.params.id,
      entityLabel: proxy?.label || proxy?.url || req.params.id,
      severity: 'warning',
      source: 'ui',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/proxies/bulk-delete', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'Missing or invalid ids' });
    }

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

    res.json({ ok: true, count: ids.length });

    logAudit({
      action: 'delete',
      entity: 'proxy',
      entityId: 'bulk',
      entityLabel: `Bulk delete ${ids.length} proxies`,
      severity: 'warning',
      source: 'ui',
      details: { ids },
    });

    // Reallocate accounts that were bound to deleted proxies
    reallocateAccountsFromDeletedProxies(deletedUrls, ids).catch((err) => {
      console.error('[Vault Router] Failed to reallocate accounts after bulk proxy deletion:', err.message);
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/proxies/bulk-add', async (req, res) => {
  try {
    const { items } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Missing or invalid items' });
    }

    // Auto-generate sequential labels P1, P2...
    let startIdx = getNextProxyLabel();
    const processedItems = items.map((item) => {
      startIdx++;
      return {
        ...item,
        label: `P${startIdx}`
      };
    });

    const added = [];
    const transaction = vault.db.transaction((rows) => {
      for (const row of rows) {
        const record = vault.upsertProxy(row, true);
        added.push(record);
      }
    });
    transaction(processedItems);

    for (const record of added) {
      SyncManager.pushVault('proxy', record).catch(() => {});
    }

    res.json({ ok: true, count: added.length, items: added });

    logAudit({
      action: 'create',
      entity: 'proxy',
      entityId: 'bulk',
      entityLabel: `Bulk add ${added.length} proxies`,
      severity: 'success',
      source: 'ui',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/vault/proxies/:id/test — HTTP request to detect public exit IP and version
router.post('/proxies/:id/test', async (req, res) => {
  const { id } = req.params;
  const proxy = vault.db.prepare('SELECT * FROM vault_proxies WHERE id = ?').get(id);
  if (!proxy) return res.status(404).json({ error: 'Proxy not found' });

  const start = Date.now();
  try {
    // Normalize proxy URL: handle host:port:user:pass compact format
    let proxyUrlStr = proxy.url || '';
    if (proxyUrlStr.includes('://')) {
      // Already a full URL — use as-is
    } else {
      // Compact format: try host:port:user:pass → http://user:pass@host:port
      const parts = proxyUrlStr.split(':');
      if (parts.length === 4 && !proxyUrlStr.includes('@')) {
        proxyUrlStr = `http://${parts[2]}:${parts[3]}@${parts[0]}:${parts[1]}`;
      } else if (parts.length === 2 && /^\d+$/.test(parts[1])) {
        proxyUrlStr = `http://${parts[0]}:${parts[1]}`;
      } else {
        proxyUrlStr = `http://${proxyUrlStr}`;
      }
    }
    const isLocalRelay = /^https?:\/\/(127\.|localhost|\[?::1)/i.test(proxyUrlStr);

    // Test proxy exit IP through multiple endpoints (some proxies hit CF challenge on ifconfig.co)
    const { execFile } = await import('child_process');
    // Each endpoint: { url, parse(stdout) → { ip, country? } | throws }
    const endpoints = [
      { url: 'https://api.myip.com', parse: (s) => { const j = JSON.parse(s); if (!j.ip) throw new Error('no ip'); return { ip: j.ip, country: j.cc || null }; } },
      { url: 'https://api64.ipify.org?format=json', parse: (s) => { const j = JSON.parse(s); if (!j.ip) throw new Error('no ip'); return { ip: j.ip, country: null }; } },
      { url: 'https://ifconfig.me/all.json', parse: (s) => { const j = JSON.parse(s); const ip = j.ip_addr || j.ip; if (!ip) throw new Error('no ip'); return { ip, country: null }; } },
      { url: 'https://ifconfig.co/json', parse: (s) => { const j = JSON.parse(s); if (!j.ip) throw new Error('no ip'); return { ip: j.ip, country: j.country_iso || null }; } },
    ];
    const probe = (url) => new Promise((resolve, reject) => {
      execFile(
        'curl',
        [
          '-L',
          '-sS',
          '--connect-timeout', '5',
          '--max-time', '12',
          '-x', proxyUrlStr,
          url,
        ],
        { timeout: 15000, killSignal: 'SIGKILL' },
        (error, stdout, stderr) => {
          if (error) return reject(new Error(stderr || error.message));
          resolve(stdout);
        }
      );
    });
    let info = null;
    let lastErr = null;
    for (const ep of endpoints) {
      try {
        const stdout = await probe(ep.url);
        info = ep.parse(stdout);
        if (info?.ip) break;
      } catch (e) {
        lastErr = `${ep.url}: ${e.message}`;
      }
    }
    if (!info?.ip) throw new Error(`All endpoints failed. Last: ${lastErr}`);
    const networkType = info.ip.includes(':') ? 'IPv6' : 'IPv4';
    const latency = Date.now() - start;

    // notes example: "IPv6 (2404:6800:4003:c00::88)"
    const notesStr = `${networkType} (${info.ip})`;
    
    // Determine country to save: prefer detected if existing is blank
    const currentCountry = (proxy.country || '').trim();
    const updatedCountry = currentCountry || (info.country || '').trim() || null;

    const now = new Date().toISOString();
    vault.upsertProxy({ ...proxy, is_active: 1, last_tested: now, latency_ms: latency, notes: notesStr, country: updatedCountry }, true);
    res.json({ ok: true, latency, status: 'active', exitIp: info.ip, networkType, country: updatedCountry, isLocalRelay });

    logAudit({
      action: 'test',
      entity: 'proxy',
      entityId: proxy.id,
      entityLabel: proxy.label || proxy.url,
      details: { exitIp: info.ip, networkType, latency, country: updatedCountry },
      severity: 'success',
      source: 'ui',
    });
  } catch (e) {
    vault.upsertProxy({ ...proxy, is_active: 0, last_tested: new Date().toISOString(), latency_ms: null }, true);
    res.json({ ok: true, latency: null, status: 'dead', error: e.message });

    logAudit({
      action: 'test',
      entity: 'proxy',
      entityId: proxy.id,
      entityLabel: proxy.label || proxy.url,
      details: { error: e.message },
      severity: 'error',
      source: 'ui',
    });
  }
});

/* ══════════════════════════════════════════════════════════════════════════ */
/*  API KEYS CRUD                                                             */
/* ══════════════════════════════════════════════════════════════════════════ */

router.get('/api-keys', (req, res) => {
  try { res.json({ ok: true, items: vault.getApiKeys() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api-keys', async (req, res) => {
  try {
    const isNew = !req.body.id;
    const record = vault.upsertApiKey(req.body);
    res.json({ ok: true, id: record.id });

    logAudit({
      action: isNew ? 'create' : 'update',
      entity: 'api_key',
      entityId: record.id,
      entityLabel: record.label || record.provider,
      details: { provider: record.provider },
      severity: isNew ? 'success' : 'info',
      source: 'ui',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/api-keys/:id', async (req, res) => {
  try {
    const key = vault.getApiKey(req.params.id, true);
    vault.deleteApiKey(req.params.id);
    res.json({ ok: true });

    logAudit({
      action: 'delete',
      entity: 'api_key',
      entityId: req.params.id,
      entityLabel: key?.label || key?.provider || req.params.id,
      severity: 'warning',
      source: 'ui',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ══════════════════════════════════════════════════════════════════════════ */
/*  EMAIL POOL CRUD                                                           */
/* ══════════════════════════════════════════════════════════════════════════ */

router.get('/email-pool', (req, res) => {
  try { res.json({ ok: true, items: vault.getEmailPool() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/email-pool', async (req, res) => {
  try {
    const record = vault.upsertEmailPool(req.body);
    res.json({ ok: true, email: record.email });
    // Emit event for real-time UI update via SSE
    if (emitSSE) emitSSE('email-pool-updated', { email: record.email });

    logAudit({
      action: 'create',
      entity: 'email_pool',
      entityId: record.email,
      entityLabel: record.email,
      details: { mail_status: record.mail_status, auth_method: record.auth_method },
      severity: 'success',
      source: 'ui',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/vault/email-pool/:email — get single email record (with full credentials)
router.get('/email-pool/:email', (req, res) => {
  try {
    const record = vault.getEmailPoolByEmail(req.params.email);
    if (!record) return res.status(404).json({ error: 'Email not found' });
    res.json({ ok: true, item: record });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/vault/email-pool/:email — update email pool record
router.put('/email-pool/:email', async (req, res) => {
  try {
    const email = req.params.email;
    const existing = vault.getEmailPoolByEmail(email);
    if (!existing) return res.status(404).json({ error: 'Email not found' });

    const record = vault.upsertEmailPool({
      email,
      password: req.body.password !== undefined ? req.body.password : existing.password,
      refresh_token: req.body.refresh_token !== undefined ? req.body.refresh_token : existing.refresh_token,
      client_id: req.body.client_id !== undefined ? req.body.client_id : existing.client_id,
      auth_method: req.body.auth_method || existing.auth_method,
      mail_status: req.body.mail_status || existing.mail_status,
      notes: req.body.notes !== undefined ? req.body.notes : existing.notes,
    });
    res.json({ ok: true, email: record.email });
    if (emitSSE) emitSSE('email-pool-updated', { email: record.email });

    logAudit({
      action: 'update',
      entity: 'email_pool',
      entityId: record.email,
      entityLabel: record.email,
      details: { mail_status: record.mail_status, auth_method: record.auth_method, updatedFields: Object.keys(req.body) },
      severity: 'info',
      source: 'ui',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/email-pool/:email', async (req, res) => {
  try {
    vault.deleteEmailPool(req.params.email);
    res.json({ ok: true });
    if (emitSSE) emitSSE('email-pool-updated', { email: req.params.email });

    logAudit({
      action: 'delete',
      entity: 'email_pool',
      entityId: req.params.email,
      entityLabel: req.params.email,
      severity: 'warning',
      source: 'ui',
    });
  }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/email-pool/sync-all', async (req, res) => {
  try {
    const result = await SyncManager.pushAllVaultPool();
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/email-pool/check', async (req, res) => {
  try {
    const { email } = req.body;
    const pool = vault.getEmailPoolFull();
    const record = pool.find(e => e.email === email);
    if (!record) return res.status(404).json({ error: 'Email not found in pool' });

    const raw = `${record.email}|${record.password || ''}|${record.auth_method || 'graph'}|${record.refresh_token || ''}|${record.client_id || ''}`;

    res.json({ ok: true, raw });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ─── Bulk email verification ───────────────────────────────────────────── */
/*  POST /api/vault/email-pool/bulk-verify                                   */
/*  Body: { emails?: string[] }  — if omitted, verify all unknown/dead       */
/*  Runs checks concurrently (up to 5 parallel) and returns results          */
/* ────────────────────────────────────────────────────────────────────────── */
router.post('/email-pool/bulk-verify', async (req, res) => {
  try {
    const pool = vault.getEmailPoolFull();
    const skipDb = !!req.body.skipDb;
    let targets;
    
    if (Array.isArray(req.body.emails) && req.body.emails.length > 0) {
      if (typeof req.body.emails[0] === 'string') {
        // Verify specific emails from pool (case insensitive)
        const reqEmailsLower = req.body.emails.map(e => e.toLowerCase());
        targets = pool.filter(e => reqEmailsLower.includes(e.email.toLowerCase()));
      } else if (typeof req.body.emails[0] === 'object') {
        // Verify raw objects directly (must contain email, refresh_token, client_id)
        targets = req.body.emails;
      }
    } else {
      // Verify all unknown/dead
      targets = pool.filter(e => e.mail_status === 'unknown' || e.mail_status === 'dead');
    }
    
    if (!targets.length) {
      return res.json({ ok: true, checked: 0, results: [] });
    }

    // Dynamic import to avoid issues
    const { getAccessToken, fetchMails } = await import('../../scripts/lib/ms-graph-email.js');

    const CONCURRENCY = 5;
    const results = [];

    // Process in batches of CONCURRENCY
    for (let i = 0; i < targets.length; i += CONCURRENCY) {
      const batch = targets.slice(i, i + CONCURRENCY);
      const batchResults = await Promise.allSettled(
        batch.map(async (record) => {
          const email = record.email;
          const refreshToken = record.refresh_token;
          const clientId = record.client_id;

          // Skip if missing credentials
          if (!refreshToken || refreshToken === 'null' || refreshToken === 'undefined' ||
              !clientId || clientId === 'null' || clientId === 'undefined') {
            const result = { email, status: 'dead', error: 'Thiếu Refresh Token hoặc Client ID' };
            if (!skipDb) {
              vault.upsertEmailPool({
                email,
                mail_status: 'dead',
                last_checked_at: new Date().toISOString(),
                notes: 'Lỗi: Thiếu Refresh Token hoặc Client ID',
              });
              if (emitSSE) emitSSE('email-pool-updated', { email });
              propagateEmailDeadTag(email);
            }
            return result;
          }

          try {
            const token = await getAccessToken(refreshToken, clientId, true, email);
            await fetchMails(token, { top: 1, email });

            const result = { email, status: 'active', error: null };
            if (!skipDb) {
              vault.upsertEmailPool({
                email,
                mail_status: 'active',
                last_checked_at: new Date().toISOString(),
                notes: `Mail OK (${new Date().toLocaleTimeString()})`,
              });
              if (emitSSE) emitSSE('email-pool-updated', { email });
              removeEmailDeadTag(email);
            }
            return result;
          } catch (err) {
            const result = { email, status: 'dead', error: err.message };
            if (!skipDb) {
              vault.upsertEmailPool({
                email,
                mail_status: 'dead',
                last_checked_at: new Date().toISOString(),
                notes: `Lỗi: ${err.message}`,
              });
              if (emitSSE) emitSSE('email-pool-updated', { email });
              propagateEmailDeadTag(email);
            }
            return result;
          }
        })
      );

      for (const r of batchResults) {
        if (r.status === 'fulfilled') results.push(r.value);
        else results.push({ email: '?', status: 'dead', error: r.reason?.message || 'Unknown error' });
      }
    }

    res.json({ ok: true, checked: results.length, results });

    logAudit({
      action: 'bulk_verify',
      entity: 'email_pool',
      entityLabel: `${results.length} emails`,
      details: { checked: results.length, active: results.filter(r => r.status === 'active').length, dead: results.filter(r => r.status === 'dead').length },
      severity: results.some(r => r.status === 'dead') ? 'warning' : 'success',
      source: 'ui',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ─── Propagate email_dead tag without re-verifying ──────────────────────── */
/*  POST /api/vault/email-pool/propagate-dead-tag                             */
/*  Body: { email: string }                                                  */
/*  Lightweight: just tags vault-accounts, no actual mail check              */
/* ────────────────────────────────────────────────────────────────────────── */
router.post('/email-pool/propagate-dead-tag', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Missing email' });

    // Verify the email is actually dead in the pool
    const poolRecord = vault.getEmailPoolFull().find(e => e.email === email);
    if (!poolRecord) return res.status(404).json({ error: 'Email not found in pool' });
    if (poolRecord.mail_status !== 'dead') {
      return res.json({ ok: true, tagged: 0, message: 'Email is not dead, skip tagging' });
    }

    propagateEmailDeadTag(email);
    const accounts = vault.getAccounts().filter(a => a.email === email);
    res.json({ ok: true, tagged: accounts.length, email });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ─── Bulk propagate all dead email tags ─────────────────────────────────── */
/*  POST /api/vault/email-pool/sync-dead-tags                                */
/*  Scans all dead emails in pool, tags matching vault-accounts              */
/* ────────────────────────────────────────────────────────────────────────── */
router.post('/email-pool/sync-dead-tags', async (req, res) => {
  try {
    const pool = vault.getEmailPoolFull();
    const deadEmails = pool.filter(e => e.mail_status === 'dead');
    let taggedAccounts = 0;
    let taggedEmails = 0;

    for (const deadEmail of deadEmails) {
      const accountsBefore = vault.getAccounts().filter(a => a.email === deadEmail.email);
      const alreadyTagged = accountsBefore.filter(a => {
        const tags = safeParseTags(a.tags);
        return tags.includes('email_dead');
      });

      if (alreadyTagged.length === accountsBefore.length && accountsBefore.length > 0) {
        // All matching accounts already tagged, skip
        continue;
      }

      propagateEmailDeadTag(deadEmail.email);
      const accountsAfter = vault.getAccounts().filter(a => a.email === deadEmail.email);
      const newlyTagged = accountsAfter.filter(a => {
        const tags = safeParseTags(a.tags);
        return tags.includes('email_dead');
      }).length;
      if (newlyTagged > 0) {
        taggedAccounts += newlyTagged;
        taggedEmails++;
      }
    }

    // Also clean up: remove email_dead tag from accounts whose email is now active
    const allAccounts = vault.getAccounts();
    let cleanedAccounts = 0;
    for (const account of allAccounts) {
      const tags = safeParseTags(account.tags);
      if (!tags.includes('email_dead')) continue;
      const poolRecord = pool.find(e => e.email === account.email);
      if (!poolRecord || poolRecord.mail_status !== 'dead') {
        const updatedTags = tags.filter(t => t !== 'email_dead');
        vault.upsertAccount({ id: account.id, tags: updatedTags });
        cleanedAccounts++;
      }
    }

    res.json({ ok: true, deadEmails: deadEmails.length, taggedEmails, taggedAccounts, cleanedAccounts });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ══════════════════════════════════════════════════════════════════════════ */
/*  TASK ENDPOINT  (Worker poll)                                              */
/*  Worker gọi GET /api/vault/accounts/task mỗi 15 giây để lấy task         */
/* ══════════════════════════════════════════════════════════════════════════ */

router.get('/accounts/task', async (req, res) => {
  try {
    // CHỈ dùng local vault — D1 fallback bị loại bỏ để tránh tạo account không có data
    const allAccounts = vault.db.prepare(
      `SELECT * FROM vault_accounts WHERE (provider='codex' OR provider='openai') ORDER BY updated_at DESC`
    ).all();

    // Danh sách ID đang được xử lý bởi các thread khác (worker gửi qua query string)
    const excludeIds = (req.query.exclude || '').split(',').filter(Boolean);

    // Tìm account pending/relogin chưa bị xóa, đang active, có email, và KHÔNG trong danh sách exclude
    // Tránh race condition: nếu account vừa được connect-result update (< 10s), skip
    // Vì connect-result set ready nhưng worker poll có thể thấy state cũ (pending) do timing
    const tenSecondsAgo = new Date(Date.now() - 10000).toISOString();

    const task = allAccounts.find(a =>
      (a.status === 'pending' || a.status === 'relogin') &&
      !a.deleted_at &&
      a.is_active !== 0 &&
      Number(a.connect_pending || 0) === 0 &&
      a.email && a.email.trim() &&
      !excludeIds.includes(a.id) // 🔑 Đây là điều kiện then chốt cho đa luồng
    );

    // Double-check: re-read từ DB để tránh race với connect-result
    if (task) {
      const freshCheck = vault.db.prepare('SELECT status, connect_pending, ever_ready FROM vault_accounts WHERE id = ?').get(task.id);
      if (freshCheck && (freshCheck.status === 'ready' || freshCheck.status === 'processing' || Number(freshCheck.connect_pending || 0) > 0)) {
        console.log(`[Task] ⏭️ Skipped ${task.email}: fresh status=${freshCheck.status} cp=${freshCheck.connect_pending} (race with connect-result)`);
        return res.json({ ok: true, task: null });
      }
    }

    if (!task) return res.json({ ok: true, task: null });

    // Parse JSON fields safely (handle double/triple encoding)
    const safeParse = (val) => {
      if (!val) return [];
      let current = val;
      for (let i = 0; i < 3; i++) {
        try {
          const parsed = typeof current === 'string' ? JSON.parse(current) : current;
          if (Array.isArray(parsed) || typeof parsed === 'object') return parsed;
          current = parsed;
        } catch (e) { break; }
      }
      return Array.isArray(current) ? current : [];
    };

    task.tags = safeParse(task.tags);
    task.cookies = safeParse(task.cookies);

    // Lấy/tạo PKCE (chỉ generate 1 lần per account ID, dùng lại nếu poll lại)
    let pkce = pkceStore.get(task.id);
    if (!pkce || (Date.now() - pkce.createdAt > 10 * 60 * 1000)) {
      pkce = { ...generateCodexOAuthUrl(), createdAt: Date.now() };
      pkceStore.set(task.id, pkce);
      console.log(`[Task] 🔑 PKCE mới: ${task.email} | verifier: ${pkce.codeVerifier.substring(0, 8)}...`);
    } else {
      console.log(`[Task] ♻️  PKCE cũ: ${task.email} | verifier: ${pkce.codeVerifier.substring(0, 8)}...`);
    }

    // Lock task
    const nowIso = new Date().toISOString();
    vault.db.prepare(
      `UPDATE vault_accounts SET status='processing', updated_at=? WHERE id=?`
    ).run(nowIso, task.id);

    // Đồng bộ ngay lập tức trạng thái processing lên cloud để tránh bị pull đè ngược lại
    const lockedTask = vault.db.prepare('SELECT * FROM vault_accounts WHERE id=?').get(task.id);
    if (lockedTask) {
      SyncManager.pushVault('account', lockedTask).catch(() => { });
    }

    return res.json({
      ok: true, task: {
        id: task.id,
        email: task.email,
        password: task.password,
        twoFaSecret: task.two_fa_secret,
        proxyUrl: task.proxy_url,
        loginUrl: pkce.url,
        codeVerifier: pkce.codeVerifier,
        action: 'LOGIN',
      }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ══════════════════════════════════════════════════════════════════════════ */
/*  RESULT ENDPOINT  (Worker báo kết quả về)                                 */
/*  POST /api/vault/accounts/result                                           */
/* ══════════════════════════════════════════════════════════════════════════ */

router.post('/accounts/result', async (req, res) => {
  try {
    // req.body được parse bởi router.use(express.json()) ở đầu file
    const body = req.body || {};
    const { id, status, message, result } = body;
    if (!id) {
      console.error('[Result] ❌ Missing id — req.body:', JSON.stringify(body).substring(0, 200));
      return res.status(400).json({ error: 'Missing id in request body' });
    }

    console.log(`[Result] Account ${id}: status=${status}`);

    if (status === 'success' && result?.code) {
      // ─── Path 1: Code + Verifier → Exchange token ─────────────────────────
      console.log(`[Result] 🔄 Exchanging code for account ${id}...`);

      // 1. Tìm Verifier: Ưu tiên từ Worker > pkceStore > Database Notes
      let verifierToUse = result.codeVerifier;
      const proxyToUse = result.proxyUrl || undefined;
      if (!verifierToUse) {
        const storedPkce = pkceStore.get(id);
        if (storedPkce) verifierToUse = storedPkce.codeVerifier;
      }
      if (!verifierToUse) {
        const account = vault.getAccountFull(id);
        if (account?.notes?.includes('Verifier: ')) {
          verifierToUse = account.notes.split('Verifier: ')[1].split('\n')[0].trim();
        }
      }

      if (!verifierToUse) {
        throw new Error('Missing code_verifier (not in result, store, or notes)');
      }

      try {
        const tokens = await exchangeCodeForTokens(result.code, verifierToUse, {
          userAgent: result.userAgent || null,
          proxyUrl: proxyToUse
        });

        // Tìm local account trước để đảm bảo email không bị mất
        // Ưu tiên: tìm by ID → tìm by email trong D1 PKCE store → dùng email từ task
        let localAccount = vault.db.prepare('SELECT * FROM vault_accounts WHERE id = ?').get(id);
        if (!localAccount) {
          // Tìm trong toàn bộ local kể cả deleted
          const allLocal = vault.db.prepare('SELECT * FROM vault_accounts ORDER BY updated_at DESC').all();
          // Chọn account có cùng provider và không có token khác
          localAccount = allLocal.find(a => a.provider === 'codex' && !a.access_token);
          console.log(`[Result] ⚠️ ID ${id} not found local, dùng: ${localAccount?.email || 'NONE'}`);
        }

        // Nếu tìm thấy local account với ID khác, dùng ID local
        const targetId = localAccount?.id || id;
        const targetEmail = localAccount?.email || tokens.email || '';

        // Restore deleted_at = null nếu account bị xóa ảo
        if (localAccount?.deleted_at) {
          vault.db.prepare('UPDATE vault_accounts SET deleted_at = NULL WHERE id = ?').run(targetId);
          console.log(`[Result] 🔄 Restored account ${targetEmail} (was deleted_at)`);
        }

        const tokenMeta = tokens.id_token ? parseCodexIdToken(tokens.id_token) : null;
        const accessMeta = extractAccountMeta(tokens.access_token || '');
        const machineId = getConsistentMachineId();
        let existingProviderData = null;
        if (localAccount?.provider_specific_data && typeof localAccount.provider_specific_data === 'string') {
          try {
            existingProviderData = JSON.parse(localAccount.provider_specific_data);
          } catch (_) {
            existingProviderData = null;
          }
        } else if (localAccount?.provider_specific_data && typeof localAccount.provider_specific_data === 'object') {
          existingProviderData = localAccount.provider_specific_data;
        }
        const providerSpecificData = mergeCodexProviderData(existingProviderData, {
          workspaceId: accessMeta?.accountId || tokenMeta?.workspaceId || result?.sessionData?.account?.id || null,
          workspacePlanType: accessMeta?.planType || tokenMeta?.workspacePlanType || result?.sessionData?.account?.planType || null,
          chatgptUserId: tokenMeta?.chatgptUserId || result?.sessionData?.user?.id || null,
          organizations: tokenMeta?.organizations || null,
          machineId,
          deviceId: buildStableDeviceId(existingProviderData, targetId),
          proxyUrl: localAccount?.proxy_url || null,
        });

        if (result?.sessionData) {
          providerSpecificData.sessionData = result.sessionData;
          if (result.sessionData.user?.id) providerSpecificData.chatgptUserId = result.sessionData.user.id;
          if (result.sessionData.account?.id) providerSpecificData.workspaceId = result.sessionData.account.id;
          if (result.sessionData.account?.planType) providerSpecificData.workspacePlanType = result.sessionData.account.planType;
        }

        const tags = safeParseTags(localAccount?.tags);
        const hasWorkspace = !!req.body.hasWorkspace;
        let finalTags = tags;
        const hasWorkspaceTag = tags.includes('workspace');
        if (hasWorkspace && !hasWorkspaceTag) {
          finalTags = [...tags, 'workspace'];
        } else if (!hasWorkspace && hasWorkspaceTag) {
          finalTags = tags.filter(t => t !== 'workspace');
        }
        finalTags = finalTags.filter(t => t !== 'need_phone');

        vault.upsertAccount({
          id: targetId,
          status: 'ready',
          notes: '',
          access_token: tokens.access_token || localAccount?.access_token || undefined,
          refresh_token: tokens.refresh_token || localAccount?.refresh_token || undefined,
          email: targetEmail || undefined,
          plan: accessMeta?.planType || tokenMeta?.workspacePlanType || result?.sessionData?.account?.planType || null,
          workspace_id: accessMeta?.accountId || tokenMeta?.workspaceId || result?.sessionData?.account?.id || null,
          device_id: providerSpecificData?.deviceId || null,
          machine_id: providerSpecificData?.machineId || machineId,
          provider_specific_data: providerSpecificData,
          cookies: result?.cookies,
          tags: finalTags,
        });

        // Xóa PKCE khỏi store sau khi xử lý xong
        pkceStore.delete(id);
        pkceStore.delete(targetId);

        const cfg = loadConfig();

        // Đồng bộ lên D1 NGAY LẬP TỨC
        const fullRecord = vault.db.prepare('SELECT * FROM vault_accounts WHERE id = ?').get(targetId);
        if (fullRecord && fullRecord.email) {
          console.log(`[Result] 🚀 Syncing to D1: ${fullRecord.email}`);
          await SyncManager.pushVault('account', fullRecord);

          // ── Gửi token lên Gateway local (provider_connections) ────────────
          if (cfg.gatewayUrl) {
            try {
              const gwRes = await fetch(`${cfg.gatewayUrl}/api/oauth/codex/import`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  id: fullRecord.id, // Gửi ID gốc để Gateway không đẻ ID mới
                  tokens: {
                    ...tokens,
                    email: fullRecord.email, // THIẾU BƯỚC NÀY: Gửi kèm email để Gateway nhận diện
                    isActive: true, // 🔥 Fix: Đảm bảo Gateway nhận diện account là ACTIVE
                    providerSpecificData: providerSpecificData || undefined,
                  },
                }),
                signal: AbortSignal.timeout(15000),
              });
              const gwData = await gwRes.json();
              if (gwRes.ok && gwData.success) {
                console.log(`[Result] 🌐 Gateway đã nhận account: ${gwData.connection?.email || fullRecord.email}`);
              } else {
                console.warn(`[Result] ⚠️ Gateway import failed: ${JSON.stringify(gwData).substring(0, 150)}`);
              }
            } catch (gwErr) {
              console.warn(`[Result] ⚠️ Không kết nối được Gateway: ${gwErr.message}`);
            }
          } else {
            console.log(`[Result] ℹ️ GatewayUrl chưa cấu hình — bỏ qua push tới Gateway local.`);
          }
          // ─────────────────────────────────────────────────────────────────
        } else {
          console.error(`[Result] ❌ Cannot sync: fullRecord missing email! id=${targetId}`);
        }

        // Trigger Gateway to fetch usage/quota immediately so UI updates
        if (cfg.gatewayUrl) {
          const syncSecret = cfg.d1SyncSecret || process.env.SEELLM_GATEWAY_SYNC_SECRET || "";
          fetch(`${cfg.gatewayUrl}/api/usage/${fullRecord.id}`, {
            headers: syncSecret ? { 'x-sync-secret': syncSecret } : undefined,
          }).catch(() => { });
        }

        console.log(`[Result] ✅ Account ${targetEmail} ready with tokens`);
        removeNeedPhoneTag(id);

        logAudit({
          action: 'connect',
          entity: 'account',
          entityId: targetId,
          entityLabel: targetEmail || targetId,
          details: { status: 'ready', provider: 'codex', hasGateway: !!cfg.gatewayUrl },
          severity: 'success',
          source: 'worker',
        });

        // Allocate proxy slot sequentially on success
        allocateProxySlotForAccount(targetId).catch((err) => {
          console.error('[Result Path 1] Failed to allocate proxy slot:', err.message);
        });

        if (emitSSE) {
          emitSSE('vault:update', { reason: 'result-success', id: targetId, email: targetEmail });
        }
      } catch (exchangeErr) {
        console.error(`[Result] ❌ Exchange failed: ${exchangeErr.message}`);
        try {
          const logPath = path.resolve('data', 'critical_errors.log');
          fs.appendFileSync(logPath, `[${new Date().toISOString()}] exchange_failed id=${id}: ${exchangeErr.message}\n`);
        } catch (_) { }
        maybeAddNeedPhoneTag(id, exchangeErr.message);
        maybeAddAccountDeactivatedTag(id, exchangeErr.message);
        const exchangeStatus = isDeactivatedMsg(exchangeErr.message) ? 'dead' : 'error';
        vault.upsertAccount({ id, status: exchangeStatus, notes: `Exchange failed: ${exchangeErr.message}` });
        pkceStore.delete(id);

        logAudit({
          action: 'connect',
          entity: 'account',
          entityId: id,
          entityLabel: targetEmail || id,
          details: { error: exchangeErr.message },
          severity: 'error',
          source: 'worker',
        });

        if (emitSSE) {
          emitSSE('vault:update', { reason: 'result-error', id, error: exchangeErr.message });
        }
      }

    } else if (status === 'success') {
      // ─── Path 2: Direct tokens (cookie-based / no-code) ──────────────────
      const localAccount = vault.getAccountFull(id);
      let existingProviderData = null;
      try { existingProviderData = localAccount?.provider_specific_data ? JSON.parse(localAccount.provider_specific_data) : null; } catch (_) { }

      const providerSpecificData = {
        ...(existingProviderData || {}),
      };
      if (result?.sessionData) {
        providerSpecificData.sessionData = result.sessionData;
        if (result.sessionData.user?.id) providerSpecificData.chatgptUserId = result.sessionData.user.id;
        if (result.sessionData.account?.id) providerSpecificData.workspaceId = result.sessionData.account.id;
        if (result.sessionData.account?.planType) providerSpecificData.workspacePlanType = result.sessionData.account.planType;
      }
      if (result?.deviceId) providerSpecificData.deviceId = result.deviceId;

      const tags = safeParseTags(localAccount?.tags);
      const hasWorkspace = !!req.body.hasWorkspace;
      let finalTags = tags;
      const hasWorkspaceTag = tags.includes('workspace');
      if (hasWorkspace && !hasWorkspaceTag) {
        finalTags = [...tags, 'workspace'];
      } else if (!hasWorkspace && hasWorkspaceTag) {
        finalTags = tags.filter(t => t !== 'workspace');
      }
      finalTags = finalTags.filter(t => t !== 'need_phone');

      vault.upsertAccount({
        id,
        status: 'ready',
        notes: message || '',
        access_token: result?.access_token || localAccount?.access_token || undefined,
        refresh_token: result?.refresh_token || localAccount?.refresh_token || undefined,
        cookies: result?.cookies,
        machine_id: getConsistentMachineId(),
        tags: finalTags,
        provider_specific_data: providerSpecificData,
        plan: result?.sessionData?.account?.planType || localAccount?.plan || undefined,
        workspace_id: result?.sessionData?.account?.id || localAccount?.workspace_id || undefined,
        device_id: result?.deviceId || providerSpecificData.deviceId || localAccount?.device_id || undefined,
      });
      removeNeedPhoneTag(id);
      pkceStore.delete(id);

      const fullRecord = vault.getAccountFull(id);

      logAudit({
        action: 'connect',
        entity: 'account',
        entityId: id,
        entityLabel: fullRecord?.email || id,
        details: { status: 'ready', method: 'direct' },
        severity: 'success',
        source: 'worker',
      });

      if (fullRecord) {
        await SyncManager.pushVault('account', fullRecord);
        const cfg = loadConfig();
        if (cfg.gatewayUrl) {
          const syncSecret = cfg.d1SyncSecret || process.env.SEELLM_GATEWAY_SYNC_SECRET || "";
          fetch(`${cfg.gatewayUrl}/api/usage/${fullRecord.id}`, {
            headers: syncSecret ? { 'x-sync-secret': syncSecret } : undefined,
          }).catch(() => { });
        }
      }

      // Allocate proxy slot sequentially on success
      allocateProxySlotForAccount(id).catch((err) => {
        console.error('[Result Path 2] Failed to allocate proxy slot:', err.message);
      });

      if (emitSSE) {
        emitSSE('vault:update', { reason: 'result-success-direct', id, email: fullRecord?.email });
      }

    } else {
      // ─── Path 3: Error / other status ────────────────────────────────────
      const errorMsg = message || `Worker reported status: ${status}`;
      console.log(`[Result] ⚠️ Account ${id}: ${errorMsg}`);
      maybeAddNeedPhoneTag(id, errorMsg);
      maybeAddAccountDeactivatedTag(id, errorMsg);
      maybeAddNeed2faTag(id, errorMsg);
      const finalStatus = isDeactivatedMsg(errorMsg) ? 'dead' : (isReloginMsg(errorMsg) ? 'relogin' : (status || 'error'));
      vault.upsertAccount({ id, status: finalStatus, notes: errorMsg });

      logAudit({
        action: 'connect',
        entity: 'account',
        entityId: id,
        entityLabel: id,
        details: { status: status || 'error', error: errorMsg },
        severity: 'error',
        source: 'worker',
      });

      const fullRecord = vault.getAccountFull(id);
      if (fullRecord && fullRecord.ever_ready === 1) {
        SyncManager.pushVault('account', fullRecord).catch(() => {});
      }

      if (emitSSE) {
        emitSSE('vault:update', { reason: 'result-error-direct', id, error: errorMsg });
      }
      // Reset về pending sau một khoảng thời gian nếu là lỗi tạm thời
    }

    clearLiveScreenshots(id).catch(() => {});
    res.json({ ok: true });
  } catch (e) {
    console.error('[Result] 💥 Unhandled error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ══════════════════════════════════════════════════════════════════════════ */
/*  UTILITY ENDPOINTS                                                         */
/* ══════════════════════════════════════════════════════════════════════════ */

let currentBulkRun = null;

class BulkRegisterRunner {
  constructor(id, queue, concurrency, enableOAuth, proxies = []) {
    this.id = id;
    this.queue = queue; // array of { emailRecord, proxy }
    this.allTasks = [...queue];
    this.proxies = proxies; // list of active proxies
    this.total = queue.length;
    this.concurrency = concurrency;
    this.enableOAuth = enableOAuth;
    this.activeWorkers = new Map(); // email -> procId
    this.autoRetryCounts = new Map(); // email -> retry count
    this.proxyHealth = new Map(); // proxy -> 'good' | 'bad'
    this.completed = [];
    this.failed = [];
    this.status = 'running'; // 'running', 'stopped', 'completed'
    this.timer = null;
    this.logs = [];
    this.log(`Khởi tạo tiến trình Bulk Registration với ${this.total} accounts, tối đa ${concurrency} luồng.`);
  }

  updateConfig(config) {
    if (!config) return;
    if (typeof config.concurrency === 'number' && config.concurrency >= 1) {
      const oldConcurrency = this.concurrency;
      this.concurrency = config.concurrency;
      if (oldConcurrency !== this.concurrency) {
        this.log(`⚙️ Cập nhật số luồng chạy song song (Concurrency): ${oldConcurrency} ➔ ${this.concurrency}`);
      }
    }
    if (typeof config.enableOAuth === 'boolean') {
      const oldEnable = this.enableOAuth;
      this.enableOAuth = config.enableOAuth;
      if (oldEnable !== this.enableOAuth) {
        this.log(`⚙️ Cập nhật trạng thái Connect OAuth2: ${oldEnable} ➔ ${this.enableOAuth}`);
      }
    }
    if (Array.isArray(config.proxies)) {
      this.proxies = config.proxies;
    }
  }

  log(text) {
    const timestamp = new Date().toLocaleTimeString();
    if (!this.logs) this.logs = [];
    this.logs.push(`[${timestamp}] ${text}`);
    // Giới hạn tối đa 500 log entries để tránh memory leak khi chạy lớn
    if (this.logs.length > 500) this.logs.splice(0, this.logs.length - 500);
    console.log(`[Bulk][${this.id}] ${text}`);
  }

  start() {
    this.tick();
    this.timer = setInterval(() => this.tick(), 2000);
  }

  tick() {
    if (this.status !== 'running') {
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
      return;
    }

    // 1. Check active workers
    const allProcs = processManager.getProcesses ? processManager.getProcesses() : {};
    for (const [email, procId] of this.activeWorkers.entries()) {
      const proc = allProcs[procId];
      if (!proc || proc.status !== 'running') {
        const exitCode = proc ? proc.exitCode : null;
        const status = proc ? proc.status : 'not_found';
        
        this.activeWorkers.delete(email);

        if (status === 'stopped' && exitCode === 0) {
          this.completed.push(email);
          this.log(`✅ Đăng ký thành công: ${email}`);
          const task = this.allTasks.find(t => t.emailRecord.email === email);
          if (task && task.proxy) {
            this.proxyHealth.set(task.proxy, 'good');
          }
        } else {
          // Find error message from logs
          let errMsg = `Exit code ${exitCode} (${status})`;
          let isProxyError = false;
          if (proc && proc.logs) {
            const errorLog = proc.logs.find(l => l.text?.includes('Lỗi:') || l.text?.includes('Error:') || l.text?.includes('Proxy validation failed') || l.text?.includes('Proxy bypassed') || l.text?.includes('PreFlight Failed') || l.text?.includes('PostVerify Failed') || l.text?.includes('IP Check failed') || l.text?.includes('BLOCKED_BY_OPENAI'));
            if (errorLog) {
              errMsg = errorLog.text.trim();
            }
            isProxyError = proc.logs.some(l => l.text?.includes('Proxy validation failed') || l.text?.includes('Proxy bypassed') || l.text?.includes('PreFlight Failed') || l.text?.includes('PostVerify Failed') || l.text?.includes('IP Check failed') || l.text?.includes('BLOCKED_BY_OPENAI') || l.text?.includes('Connection timed out'));
          }

          const task = this.allTasks.find(t => t.emailRecord.email === email);
          if (isProxyError && task && task.proxy) {
            this.proxyHealth.set(task.proxy, 'bad');
          }

          // Check if we can auto-retry this task with a rotated proxy
          const retryCount = this.autoRetryCounts.get(email) || 0;
          const maxAutoRetries = 2;
          if (isProxyError && retryCount < maxAutoRetries && this.proxies && this.proxies.length > 1) {
            this.autoRetryCounts.set(email, retryCount + 1);
            if (task) {
              const currentFailedProxy = task.proxy;
              let nextProxy = null;
              
              const goodProxies = this.proxies.filter(p => this.proxyHealth.get(p) === 'good' && p !== currentFailedProxy);
              const unknownProxies = this.proxies.filter(p => !this.proxyHealth.has(p) && p !== currentFailedProxy);
              const otherProxies = this.proxies.filter(p => p !== currentFailedProxy);

              if (goodProxies.length > 0) {
                nextProxy = goodProxies[Math.floor(Math.random() * goodProxies.length)];
                this.log(`🔄 [Tự động thử lại lần ${retryCount + 1}/${maxAutoRetries}] Ưu tiên dùng Proxy SỐNG cho ${email}.`);
              } else if (unknownProxies.length > 0) {
                nextProxy = unknownProxies[Math.floor(Math.random() * unknownProxies.length)];
                this.log(`🔄 [Tự động thử lại lần ${retryCount + 1}/${maxAutoRetries}] Dùng Proxy chưa test cho ${email}.`);
              } else if (otherProxies.length > 0) {
                nextProxy = otherProxies[Math.floor(Math.random() * otherProxies.length)];
                this.log(`🔄 [Tự động thử lại lần ${retryCount + 1}/${maxAutoRetries}] Dùng đại Proxy khác cho ${email}.`);
              }

              if (nextProxy) {
                task.proxy = nextProxy;
                this.queue.push(task);
                continue; // Skip failed list and single-item-complete notification for now
              }
            }
          }

          this.failed.push({ email, error: errMsg });
          this.log(`❌ Đăng ký thất bại: ${email} (${errMsg})`);

          // Chỉ dừng bulk run khi có ≥2 lỗi proxy nghiêm trọng liên tiếp để tránh dừng oan vì lỗi mạng tạm thời
          if (isProxyError && !errMsg.includes('BLOCKED_BY_OPENAI') && !errMsg.includes('IP Check failed')) {
            this.consecutiveProxyErrors = (this.consecutiveProxyErrors || 0) + 1;
            if (this.consecutiveProxyErrors >= 2) {
              this.log(`🛑 [An toàn] Tự động dừng tiến trình Bulk do lỗi Proxy hệ thống liên tiếp (${this.consecutiveProxyErrors} lần) ở account ${email}.`);
              this.stop();
            } else {
              this.log(`⚠️ [An toàn] Phát hiện lỗi Proxy hệ thống lần ${this.consecutiveProxyErrors} ở ${email}. Cần thêm 1 lỗi nữa mới dừng.`);
            }
          } else {
            // Reset counter khi không phải lỗi proxy nghiêm trọng
            this.consecutiveProxyErrors = 0;
          }
        }

        // Notify client via SSE of single task complete
        if (emitSSE) {
          emitSSE('bulk-register-item-complete', {
            email,
            success: status === 'stopped' && exitCode === 0
          });
        }
      }
    }

    // 2. Spawn next workers up to concurrency
    let spawnIndex = 0;
    while (this.activeWorkers.size < this.concurrency && this.queue.length > 0) {
      const task = this.queue.shift();
      const { emailRecord, proxy } = task;

      if (!processManager.spawnProcess) {
        this.log('❌ Lỗi: Process manager chưa được đăng ký!');
        this.status = 'stopped';
        break;
      }

      const delayMs = spawnIndex * 5000; // 5s đủ để tránh browser spawn race; RAM guard đã giới hạn concurrency
      const raw = `${emailRecord.email}|${emailRecord.password || ''}|${emailRecord.auth_method || 'graph'}|${emailRecord.refresh_token || ''}|${emailRecord.client_id || ''}|${proxy}${this.enableOAuth ? '|oauth=1' : ''}|stagger=${delayMs}`;
      spawnIndex++;
      
      const scriptName = 'auto-register-worker.js';
      const procId = `script_${scriptName.replace(/[^a-z0-9]/gi, '_')}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const scriptPath = path.join(process.cwd(), 'scripts', scriptName);

      this.log(`🚀 Khởi chạy trình duyệt cho ${emailRecord.email} qua proxy: ${proxy || 'Kết nối trực tiếp'} (Stagger: ${delayMs}ms)`);
      
      const cfg = loadConfig();
      const r = processManager.spawnProcess(procId, `📜 ${scriptName}`, 'node', [scriptPath, raw], process.cwd(), {
        WORKER_AUTH_TOKEN: cfg.workerAuthToken
      });

      if (r.error) {
        this.log(`⚠️ Lỗi khởi chạy tiến trình cho ${emailRecord.email}: ${r.error}`);
        this.failed.push({ email: emailRecord.email, error: r.error });
        continue;
      }

      this.activeWorkers.set(emailRecord.email, procId);
    }

    // Notify status update
    if (emitSSE) {
      emitSSE('bulk-register-status', {
        id: this.id,
        status: this.status,
        completed: this.completed.length,
        failed: this.failed.length,
        total: this.total,
        activeCount: this.activeWorkers.size,
        queueCount: this.queue.length
      });
    }

    // 3. Check if all completed
    if (this.queue.length === 0 && this.activeWorkers.size === 0) {
      this.status = 'completed';
      this.log(`🎉 Tiến trình đăng ký hàng loạt hoàn tất! Thành công: ${this.completed.length}, Thất bại: ${this.failed.length}`);
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
      
      // Tự động trigger phân bổ Proxy thông minh (Smart Proxy Slot) cho các account vừa được tạo ra
      if (this.completed.length > 0) {
        this.log(`🔄 Tự động phân bổ Proxy cho các account mới...`);
        const port = process.env.PORT || 4000;
        fetch(`http://localhost:${port}/api/proxy-assign/auto`, { method: 'POST' })
          .then(res => res.json())
          .then(data => {
            if (data.ok) {
              this.log(`✅ Phân bổ Proxy thành công: Đã gán ${data.assigned}/${data.total} account.`);
            } else {
              this.log(`⚠️ Lỗi phân bổ Proxy: ${data.error}`);
            }
          })
          .catch(err => {
            this.log(`⚠️ Không thể kết nối tới /api/proxy-assign/auto: ${err.message}`);
          });
      }
    }
  }

  stop() {
    this.status = 'stopped';
    this.log(`🛑 Tiến trình bị dừng lại bởi người dùng hoặc hệ thống bảo vệ.`);
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const [email, procId] of this.activeWorkers.entries()) {
      if (processManager.stopProcess) {
        processManager.stopProcess(procId);
      }
    }
    this.activeWorkers.clear();
    if (emitSSE) {
      emitSSE('bulk-register-status', {
        id: this.id,
        status: this.status,
        completed: this.completed.length,
        failed: this.failed.length,
        total: this.total,
        activeCount: 0,
        queueCount: 0
      });
    }
  }

  retryFailed(config) {
    if (this.status === 'running') {
      return false;
    }
    if (config) {
      this.updateConfig(config);
    }
    const failedEmails = this.failed.map(f => f.email);
    const tasksToRetry = this.allTasks.filter(t => failedEmails.includes(t.emailRecord.email));
    if (tasksToRetry.length === 0) return false;

    // Reset autoRetryCounts cho các email được retry để cho phép auto-proxy-rotation hoạt động lại
    failedEmails.forEach(e => this.autoRetryCounts.delete(e));

    // Rotate/Distribute proxies for tasks to retry if we have a pool of proxies
    if (this.proxies && this.proxies.length > 0) {
      const parsedRatio = (config && typeof config.ratio === 'number') ? config.ratio : 1;
      tasksToRetry.forEach((task, idx) => {
        const currentFailedProxy = task.proxy;
        const proxyIdx = Math.floor(idx / parsedRatio) % this.proxies.length;
        const newProxy = this.proxies[proxyIdx];
        if (currentFailedProxy !== newProxy) {
          task.proxy = newProxy;
          this.log(`🔄 [Tự động xoay Proxy] Thử lại ${task.emailRecord.email} với Proxy mới: ${currentFailedProxy || 'None'} ➔ ${task.proxy}`);
        }
      });
    }

    // Dedup: chỉ thêm tasks chưa có trong queue (tránh gọi retryFailed 2 lần → 2 worker cùng email)
    const existingQueueEmails = new Set(this.queue.map(t => t.emailRecord.email));
    const dedupedTasks = tasksToRetry.filter(t => !existingQueueEmails.has(t.emailRecord.email));
    this.queue = [...this.queue, ...dedupedTasks];
    this.total = this.completed.length + this.failed.length + this.queue.length + this.activeWorkers.size;
    this.failed = this.failed.filter(f => !failedEmails.includes(f.email));
    
    this.status = 'running';
    this.start();
    return true;
  }

  retryItem(email, config) {
    const task = this.allTasks.find(t => t.emailRecord.email === email);
    if (!task) return false;

    if (config) {
      this.updateConfig(config);
    }

    // Rotate proxy for this task if we have a pool of proxies
    if (this.proxies && this.proxies.length > 0) {
      const currentFailedProxy = task.proxy;
      const otherProxies = this.proxies.filter(p => p !== currentFailedProxy);
      if (otherProxies.length > 0) {
        task.proxy = otherProxies[Math.floor(Math.random() * otherProxies.length)];
        this.log(`🔄 [Tự động xoay Proxy] Thử lại ${email} với Proxy mới: ${currentFailedProxy || 'None'} ➔ ${task.proxy}`);
      } else {
        task.proxy = this.proxies[0];
      }
    }
    
    this.failed = this.failed.filter(f => f.email !== email);
    
    if (!this.queue.some(t => t.emailRecord.email === email) && !this.activeWorkers.has(email)) {
      this.queue.push(task);
      this.total = this.completed.length + this.failed.length + this.queue.length + this.activeWorkers.size;
      if (this.status !== 'running') {
        this.status = 'running';
        this.start();
      }
      return true;
    }
    return false;
  }
}

function smartParseProxy(inputStr) {
  let raw = inputStr.trim();
  if (!raw) return null;

  // 1. Check if there is a protocol prefix
  let protocol = 'http';
  const protoMatch = raw.match(/^([a-zA-Z0-9]+):\/\/(.*)$/);
  if (protoMatch) {
    protocol = protoMatch[1].toLowerCase();
    raw = protoMatch[2];
  }

  let host = '';
  let port = '';
  let username = '';
  let password = '';

  // Case A: user:pass@host:port
  if (raw.includes('@')) {
    const parts = raw.split('@');
    const authPart = parts[0];
    const hostPart = parts[1];
    
    const authSub = authPart.split(':');
    if (authSub.length >= 2) {
      username = authSub[0];
      password = authSub.slice(1).join(':');
    } else {
      username = authSub[0];
    }

    const hostSub = hostPart.split(':');
    host = hostSub[0];
    port = hostSub[1] || '';
  } else {
    // No @ character. Split by colon.
    const parts = raw.split(':');
    
    if (parts.length === 1) {
      host = parts[0];
    } else if (parts.length === 2) {
      host = parts[0];
      port = parts[1];
    } else if (parts.length === 4) {
      // Check which part is the port
      const part1Port = parseInt(parts[1], 10);
      const part3Port = parseInt(parts[3], 10);
      
      const isPart1Port = !isNaN(part1Port) && part1Port > 0 && part1Port <= 65535;
      const isPart3Port = !isNaN(part3Port) && part3Port > 0 && part3Port <= 65535;

      if (isPart1Port && !isPart3Port) {
        // host:port:user:pass
        host = parts[0];
        port = parts[1];
        username = parts[2];
        password = parts[3];
      } else if (isPart3Port && !isPart1Port) {
        // user:pass:host:port
        username = parts[0];
        password = parts[1];
        host = parts[2];
        port = parts[3];
      } else {
        // default host:port:user:pass
        host = parts[0];
        port = parts[1];
        username = parts[2];
        password = parts[3];
      }
    } else if (parts.length === 3) {
      // 3 parts: host:port:user or user:host:port
      const part1Port = parseInt(parts[1], 10);
      const part2Port = parseInt(parts[2], 10);
      if (!isNaN(part1Port) && part1Port > 0 && part1Port <= 65535) {
        // host:port:user
        host = parts[0];
        port = parts[1];
        username = parts[2];
      } else if (!isNaN(part2Port) && part2Port > 0 && part2Port <= 65535) {
        // user:host:port
        username = parts[0];
        host = parts[1];
        port = parts[2];
      } else {
        host = parts[0];
        port = parts[1] || '';
      }
    } else {
      host = parts[0];
      port = parts[1] || '';
    }
  }

  let normalized = '';
  if (username && password) {
    normalized = `${protocol}://${username}:${password}@${host}:${port}`;
  } else if (username) {
    normalized = `${protocol}://${username}@${host}:${port}`;
  } else {
    normalized = `${protocol}://${host}:${port}`;
  }

  let isValid = !!host && !!port;
  let error = null;
  if (isValid) {
    try {
      new URL(normalized);
    } catch (e) {
      isValid = false;
      error = 'URL proxy không hợp lệ';
    }
  } else {
    error = 'Sai định dạng proxy (cần ip:port hoặc host:port:user:pass)';
  }

  return {
    raw: inputStr,
    valid: isValid,
    normalized,
    protocol,
    host,
    port,
    username,
    password,
    error
  };
}

// POST /api/vault/accounts/bulk-register/validate-inputs
router.post('/accounts/bulk-register/validate-inputs', async (req, res) => {
  try {
    const { emails = [], proxies = [] } = req.body;
    
    const parsedEmails = (emails || []).map(line => {
      const raw = line.trim();
      if (!raw) return null;
      
      const parts = raw.split('|');
      const email = parts[0]?.trim();
      const hasAt = email && email.includes('@');
      
      if (!hasAt) {
        return { raw, valid: false, error: 'Sai định dạng email (Thiếu @)' };
      }
      
      if (parts.length >= 4) {
        return {
          raw,
          valid: true,
          email,
          password: parts[1]?.trim(),
          refresh_token: parts[2]?.trim(),
          client_id: parts[3]?.trim(),
          format: 'GraphAPI (4 trường)'
        };
      } else if (parts.length === 3) {
        return {
          raw,
          valid: true,
          email,
          refresh_token: parts[1]?.trim(),
          client_id: parts[2]?.trim(),
          format: 'OAuth2 (3 trường)'
        };
      } else {
        return {
          raw,
          valid: true,
          email,
          format: 'Chỉ Email (Đăng ký chay)'
        };
      }
    }).filter(Boolean);

    const parsedProxies = (proxies || []).map(line => {
      return smartParseProxy(line);
    }).filter(Boolean);

    res.json({
      ok: true,
      emails: parsedEmails,
      proxies: parsedProxies,
      summary: {
        totalEmails: parsedEmails.length,
        validEmails: parsedEmails.filter(e => e.valid).length,
        invalidEmails: parsedEmails.filter(e => !e.valid).length,
        totalProxies: parsedProxies.length,
        validProxies: parsedProxies.filter(p => p.valid).length,
        invalidProxies: parsedProxies.filter(p => !p.valid).length,
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/vault/accounts/bulk-register/check-proxies
router.post('/accounts/bulk-register/check-proxies', async (req, res) => {
  try {
    const { proxies = [] } = req.body;
    if (!Array.isArray(proxies)) {
      return res.status(400).json({ error: 'Tham số proxies không hợp lệ' });
    }

    const { exec } = await import('node:child_process');

    const results = [];
    const limit = 10; // Check up to 10 concurrently
    
    const checkOne = async (proxyStr) => {
      const parsed = smartParseProxy(proxyStr);
      if (!parsed || !parsed.valid) {
        return { proxy: proxyStr, status: 'invalid', error: parsed?.error || 'Sai định dạng proxy' };
      }
      
      const normUrl = parsed.normalized;

      try {
        const escapedProxy = normUrl.replace(/"/g, '\\"');
        const cmd = `curl -s -w "\\nHTTP_STATUS:%{http_code}\\nTIME:%{time_total}" --connect-timeout 5 -x "${escapedProxy}" https://www.cloudflare.com/cdn-cgi/trace`;
        
        const output = await new Promise((resolve) => {
          exec(cmd, (err, stdout) => {
            if (err) {
              resolve(`HTTP_STATUS:000\nTIME:0\nERROR:${err.message}`);
            } else {
              resolve(stdout);
            }
          });
        });

        const lines = output.split('\n');
        let httpStatus = '000';
        let timeTotal = '0';
        let ip = '';
        let loc = '';
        let errorMsg = null;

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('HTTP_STATUS:')) {
            httpStatus = trimmed.replace('HTTP_STATUS:', '');
          } else if (trimmed.startsWith('TIME:')) {
            timeTotal = trimmed.replace('TIME:', '');
          } else if (trimmed.startsWith('ip=')) {
            ip = trimmed.replace('ip=', '');
          } else if (trimmed.startsWith('loc=')) {
            loc = trimmed.replace('loc=', '');
          } else if (trimmed.startsWith('ERROR:')) {
            errorMsg = trimmed.replace('ERROR:', '');
          }
        }

        const httpCodeInt = parseInt(httpStatus, 10);
        if (httpCodeInt >= 200 && httpCodeInt < 400) {
          const latency = Math.round(parseFloat(timeTotal) * 1000);
          return { 
            proxy: proxyStr, 
            normalized: normUrl, 
            status: 'live', 
            httpCode: httpStatus,
            latency,
            ip,
            loc
          };
        } else {
          return { 
            proxy: proxyStr, 
            normalized: normUrl, 
            status: 'dead', 
            error: errorMsg || `HTTP Code ${httpStatus} (Lỗi Kết Nối hoặc Timeout)` 
          };
        }
      } catch (err) {
        return { proxy: proxyStr, normalized: normUrl, status: 'dead', error: err.message };
      }
    };

    for (let i = 0; i < proxies.length; i += limit) {
      const chunk = proxies.slice(i, i + limit);
      const chunkResults = await Promise.all(chunk.map(checkOne));
      results.push(...chunkResults);
    }

    res.json({ ok: true, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/vault/accounts/bulk-register
router.post('/accounts/bulk-register', async (req, res) => {
  try {
    if (currentBulkRun && currentBulkRun.status === 'running') {
      return res.status(400).json({ error: 'Có một tiến trình Bulk Registration đang chạy.' });
    }

    const { emails = [], proxies = [], ratio = 1, concurrency = 2, enableOAuth = false } = req.body;

    if (!emails.length) {
      return res.status(400).json({ error: 'Danh sách email trống.' });
    }

    const resolvedEmails = [];
    for (const input of emails) {
      if (!input || !input.trim()) continue;
      
      const trimmedInput = input.trim();
      if (trimmedInput.includes('|')) {
        const parts = trimmedInput.split('|');
        let email, password, refresh_token, client_id, auth_method;
        if (parts.length === 3) {
          [email, refresh_token, client_id] = parts;
          password = '';
          auth_method = 'oauth2';
        } else if (parts.length >= 4) {
          [email, password, refresh_token, client_id] = parts;
          auth_method = 'graph';
        }
        if (email && refresh_token) {
          const record = vault.upsertEmailPool({ email, password, refresh_token, client_id, auth_method });
          resolvedEmails.push(record);
        }
      } else {
        const record = vault.getEmailPoolByEmail(trimmedInput);
        if (record) {
          resolvedEmails.push(record);
        } else {
          console.log(`[Bulk] Warning: Email ${trimmedInput} not found in pool. Skipping.`);
        }
      }
    }

    if (!resolvedEmails.length) {
      return res.status(400).json({ error: 'Không tìm thấy thông tin email hợp lệ để đăng ký.' });
    }

    const activeProxies = proxies.map(p => {
      const parsed = smartParseProxy(p);
      return parsed && parsed.valid ? parsed.normalized : p.trim();
    }).filter(Boolean);
    const parsedRatio = parseInt(ratio, 10) || 1;
    const totalMemGb = os.totalmem() / (1024 * 1024 * 1024);
    const safeMaxConcurrency = totalMemGb <= 16.5 ? 3 : 5;
    const requestedConcurrency = parseInt(concurrency, 10) || 2;
    const parsedConcurrency = Math.min(safeMaxConcurrency, requestedConcurrency);
    console.log(`[Bulk] System RAM: ${totalMemGb.toFixed(2)} GB | Safe Max Concurrency: ${safeMaxConcurrency} | Requested: ${requestedConcurrency} | Applied: ${parsedConcurrency}`);

    const queue = resolvedEmails.map((emailRecord, idx) => {
      let proxy = '';
      if (activeProxies.length > 0) {
        const proxyIdx = Math.floor(idx / parsedRatio) % activeProxies.length;
        proxy = activeProxies[proxyIdx];
      }
      return { emailRecord, proxy };
    });

    const bulkRunId = `bulk_${Date.now()}`;
    currentBulkRun = new BulkRegisterRunner(bulkRunId, queue, parsedConcurrency, enableOAuth, activeProxies);
    currentBulkRun.start();

    res.json({
      ok: true,
      id: bulkRunId,
      total: queue.length,
      concurrency: parsedConcurrency
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/vault/accounts/bulk-register/status
router.get('/accounts/bulk-register/status', (req, res) => {
  try {
    if (!currentBulkRun) {
      return res.json({ status: 'idle', total: 0, completed: [], failed: [], activeWorkers: [], logs: [] });
    }

    res.json({
      id: currentBulkRun.id,
      status: currentBulkRun.status,
      total: currentBulkRun.total,
      completed: currentBulkRun.completed,
      failed: currentBulkRun.failed,
      activeWorkers: Array.from(currentBulkRun.activeWorkers.entries()).map(([email, procId]) => ({ email, procId })),
      queueLength: currentBulkRun.queue.length,
      logs: currentBulkRun.logs || []
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/vault/accounts/bulk-register/stop
router.post('/accounts/bulk-register/stop', (req, res) => {
  try {
    if (!currentBulkRun || currentBulkRun.status !== 'running') {
      return res.json({ ok: true, message: 'Không có tiến trình nào đang chạy.' });
    }

    currentBulkRun.stop();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/vault/accounts/bulk-register/retry-failed
router.post('/accounts/bulk-register/retry-failed', (req, res) => {
  try {
    if (!currentBulkRun) {
      return res.status(400).json({ error: 'Không có tiến trình Bulk Registration nào tồn tại.' });
    }
    const { concurrency, enableOAuth, proxies, ratio } = req.body;
    const ok = currentBulkRun.retryFailed({ concurrency, enableOAuth, proxies, ratio });
    res.json({ ok });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/vault/accounts/bulk-register/retry-item
router.post('/accounts/bulk-register/retry-item', (req, res) => {
  try {
    const { email, concurrency, enableOAuth, proxies, ratio } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'Email không hợp lệ.' });
    }
    if (!currentBulkRun) {
      return res.status(400).json({ error: 'Không có tiến trình Bulk Registration nào tồn tại.' });
    }
    const ok = currentBulkRun.retryItem(email, { concurrency, enableOAuth, proxies, ratio });
    res.json({ ok });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/vault/accounts/bulk-register/clear
router.post('/accounts/bulk-register/clear', (req, res) => {
  try {
    if (currentBulkRun && currentBulkRun.status === 'running') {
      return res.status(400).json({ error: 'Không thể xóa khi tiến trình đang chạy. Hãy dừng nó trước.' });
    }
    currentBulkRun = null;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// Retry / Deploy to Codex: Reset account về pending và tạo PKCE mới để Worker login
router.post('/accounts/:id/retry', async (req, res) => {
  try {
    const account = vault.getAccountFull(req.params.id);
    if (!account) return res.status(404).json({ error: 'Not found' });
    pkceStore.delete(req.params.id); // Xóa PKCE cũ để generate lại
    removeNeedPhoneTag(req.params.id);
    // Gọi upsertAccount thay vì updateAccountStatus để PKCE được sinh ra trong quá trình upsert
    vault.upsertAccount({ ...account, status: 'pending' });
    res.json({ ok: true });

    logAudit({
      action: 'deploy',
      entity: 'account',
      entityId: req.params.id,
      entityLabel: account.email || account.label || req.params.id,
      details: { previousStatus: account.status },
      severity: 'info',
      source: 'ui',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Stop: Thu hồi account về idle
router.post('/accounts/:id/stop', async (req, res) => {
  try {
    const account = vault.getAccountFull(req.params.id);
    if (!account) return res.status(404).json({ error: 'Not found' });
    pkceStore.delete(req.params.id);
    if (account.status === 'need_phone' || String(account.notes || '').includes('NEED_PHONE')) {
      maybeAddNeedPhoneTag(req.params.id, 'NEED_PHONE');
    }

    // Dọn dẹp các cờ trạng thái kẹt trong provider_specific_data khi người dùng bấm dừng
    const ps = typeof account.provider_specific_data === 'string'
      ? JSON.parse(account.provider_specific_data)
      : (account.provider_specific_data || {});
    let psChanged = false;
    if (ps.warmupStatus === 'pending') {
      ps.warmupStatus = 'failed';
      ps.warmupError = 'Tiến trình bị người dùng dừng lại thủ công.';
      psChanged = true;
    }
    if (ps.twoFaRegenStatus === 'pending') {
      ps.twoFaRegenStatus = 'failed';
      ps.twoFaRegenError = 'Tiến trình bị người dùng dừng lại thủ công.';
      psChanged = true;
    }

    // Dừng tất cả các tiến trình ngầm (warmup, check-session, 2fa) đang chạy cho account này
    const targetAccountId = req.params.id;
    if (processManager.getProcesses && processManager.stopProcess) {
      const allProcs = processManager.getProcesses();
      for (const procId of Object.keys(allProcs)) {
        if (
          procId.startsWith(`warmup_${targetAccountId}_`) ||
          procId.startsWith(`check_${targetAccountId}_`) ||
          procId.startsWith(`regen_2fa_${targetAccountId}_`)
        ) {
          console.log(`[Server] Stopping active process ${procId} for account ${targetAccountId} via stop route`);
          processManager.stopProcess(procId);
        }
      }
    }

    vault.updateAccountStatus(req.params.id, 'idle');

    if (psChanged) {
      vault.upsertAccount({
        id: req.params.id,
        provider_specific_data: ps
      });
    }

    const updated = vault.db.prepare('SELECT * FROM vault_accounts WHERE id = ?').get(req.params.id);
    if (updated && updated.ever_ready === 1) {
      await SyncManager.pushVault('account', updated);
    }
    res.json({ ok: true, gateway_status: updated?.gateway_status ?? null });

    logAudit({
      action: 'revoke',
      entity: 'account',
      entityId: req.params.id,
      entityLabel: account.email || account.label || req.params.id,
      details: { previousStatus: account.status, gateway_status: updated?.gateway_status },
      severity: 'warning',
      source: 'ui',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Webhook: Gateway gọi về đây khi xóa account trên Gateway UI
// Mục tiêu: KHÔNG xóa khỏi Vault — chỉ thu hồi về 'idle' (ngắt kết nối Codex, giữ nguyên dữ liệu kho)
router.post('/accounts/:id/webhook-delete', async (req, res) => {
  try {
    const { id } = req.params;
    const existing = vault.db.prepare('SELECT id, email, status FROM vault_accounts WHERE id = ?').get(id);
    if (!existing) {
      return res.json({ ok: true, skipped: true, reason: 'not found in vault' });
    }
    if (existing.status === 'idle') {
      return res.json({ ok: true, skipped: true, reason: 'already idle' });
    }
    // Thu hồi về kho lạnh thay vì xóa — Vault là kho độc lập
    vault.updateAccountStatus(id, 'idle');
    vault.updateGatewayStatus(id, 'revoked'); // Đánh dấu đã bị Gateway thu hồi
    pkceStore.delete(id);
    console.log(`[Webhook] 🔄 Gateway xóa account ${existing.email} → Thu hồi về Vault (idle, gateway_status=revoked)`);
    res.json({ ok: true, reverted: id, newStatus: 'idle', gateway_status: 'revoked' });

    logAudit({
      action: 'revoke',
      entity: 'account',
      entityId: id,
      entityLabel: existing.email || id,
      details: { reason: 'gateway_webhook', previousStatus: existing.status },
      severity: 'warning',
      source: 'sync',
    });
  } catch (e) {
    console.error(`[Webhook] ❌ Lỗi xử lý webhook-delete:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// Manual sync: Ép đồng bộ 1 account lên D1
router.post('/accounts/:id/sync', async (req, res) => {
  try {
    const account = vault.getAccountFull(req.params.id);
    if (!account) return res.status(404).json({ error: 'Account not found' });
    console.log(`[Manual Sync] Pushing ${account.email} to D1...`);
    const result = await SyncManager.pushVault('account', account, true);
    
    // Get updated gateway_status after sync
    const updatedAccount = vault.getAccountFull(req.params.id);
    const gateway_status = updatedAccount?.gateway_status || null;
    
    res.json({ ok: true, message: 'Synced to D1', gateway_status, result });

    logAudit({
      action: 'sync',
      entity: 'account',
      entityId: req.params.id,
      entityLabel: account.email || account.label || req.params.id,
      details: { gateway_status },
      severity: 'info',
      source: 'ui',
    });
  } catch (e) {
    console.error(`[Manual Sync] Failed:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ══════════════════════════════════════════════════════════════════════════ */
/*  CONNECT PENDING COUNT  (Worker guard check — non-consuming)               */
/*  GET /api/vault/connect-pending-count                                      */
/*  Trả về số account đang có connect_pending > 0 mà KHÔNG lock hay consume.  */
/*  Worker dùng để ngăn login/D1 poll khi còn deploy task đang chờ.           */
/* ══════════════════════════════════════════════════════════════════════════ */

router.get('/connect-pending-count', (req, res) => {
  try {
    const row = vault.db.prepare(
      `SELECT COUNT(*) as count FROM vault_accounts WHERE connect_pending > 0 AND deleted_at IS NULL`
    ).get();
    return res.json({ ok: true, count: row?.count || 0 });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

/* ══════════════════════════════════════════════════════════════════════════ */
/*  AUTO-CONNECT TASK ENDPOINT  (auto-connect-worker poll)                    */
/*  GET /api/vault/accounts/connect-task                                      */
/* ══════════════════════════════════════════════════════════════════════════ */

router.get('/accounts/connect-task', (req, res) => {
  try {
    const allAccounts = vault.db.prepare(
      `SELECT * FROM vault_accounts WHERE (provider='codex' OR provider='openai') ORDER BY updated_at DESC`
    ).all();
    const excludeIds = (req.query.exclude || '').split(',').filter(Boolean);

    // ── Auto-recovery: reset cp=2 (processing) → cp=1 (queued) nếu stuck > 10 phút ──
    // Xảy ra khi worker crash/timeout mà không gọi connect-result
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const stuckAccounts = allAccounts.filter(a =>
      Number(a.connect_pending) === 2 &&
      !a.deleted_at &&
      a.updated_at < tenMinutesAgo
    );
    if (stuckAccounts.length > 0) {
      for (const stuck of stuckAccounts) {
        const nowIso = new Date().toISOString();
        vault.db.prepare(
          `UPDATE vault_accounts SET connect_pending=1, updated_at=? WHERE id=?`
        ).run(nowIso, stuck.id);
        console.log(`[connect-task] ♻️ Auto-recovery: reset cp=2→1 for ${stuck.email?.slice(0, 30)} (stuck since ${stuck.updated_at})`);
      }
      // Reload sau khi reset để task mới được pick up ngay
      return res.json({ ok: true, task: null, recovered: stuckAccounts.length });
    }

    // Tìm account có connect_pending = 1 (đã bấm Deploy v2)
    const task = allAccounts.find(a =>
      Number(a.connect_pending) === 1 &&
      !a.deleted_at &&
      a.email && a.email.trim() &&
      a.password && a.password.trim() &&
      !excludeIds.includes(a.id)
    );

    if (!task) {
      // Debug: log why no task found (throttled — chỉ log khi có account cp>0 mới)
      const pending = allAccounts.filter(a => Number(a.connect_pending) > 0);
      if (pending.length && !connectTaskLogThrottle) {
        connectTaskLogThrottle = true;
        setTimeout(() => { connectTaskLogThrottle = false; }, 60000);
        console.log(`[connect-task] ${pending.length} accounts stuck with connect_pending>0 (cp=2=processing, cp=1=queued). First 3:`, pending.slice(0, 3).map(a => ({
          id: a.id, email: a.email?.slice(0, 20), cp: a.connect_pending,
          deleted: !!a.deleted_at, active: a.is_active, hasPwd: !!a.password?.trim(), status: a.status,
        })));
      }
      return res.json({ ok: true, task: null });
    }

    // Lock: đánh dấu đang xử lý
    const nowIso = new Date().toISOString();
    vault.db.prepare(
      `UPDATE vault_accounts SET connect_pending=2, updated_at=? WHERE id=?`
    ).run(nowIso, task.id);

    return res.json({
      ok: true, task: {
        id: task.id,
        email: task.email,
        password: task.password,
        twoFaSecret: task.two_fa_secret,
        proxyUrl: task.proxy_url,
        proxy_url: task.proxy_url,
      }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ══════════════════════════════════════════════════════════════════════════ */
/*  AUTO-CONNECT RESULT ENDPOINT  (auto-connect-worker báo kết quả)          */
/*  POST /api/vault/accounts/connect-result                                   */
/* ══════════════════════════════════════════════════════════════════════════ */

router.post('/accounts/connect-result', async (req, res) => {
  try {
    const { id, status, message, tokens } = req.body || {};
    if (!id) return res.status(400).json({ error: 'Missing id' });

    console.log(`[Connect-Result] Account ${id}: status=${status}, msg=${String(message || '').slice(0, 80)}`);

    if (status === 'success' && tokens?.accessToken) {
      // Decode JWT để lấy thêm metadata
      let tokenMeta = null;
      try {
        const { parseCodexIdToken } = await import('../services/codexMetadata.js');
        // Tạo compat id_token nếu cần để parse
        tokenMeta = { workspaceId: null, workspacePlanType: tokens.planType || 'free' };
      } catch (_) { }

      const { getConsistentMachineId, buildStableDeviceId, mergeCodexProviderData } = await import('../services/codexMetadata.js');
      const machineId = getConsistentMachineId();
      const localAccount = vault.db.prepare('SELECT * FROM vault_accounts WHERE id = ?').get(id);

      let existingProviderData = null;
      try { existingProviderData = localAccount?.provider_specific_data ? JSON.parse(localAccount.provider_specific_data) : null; } catch (_) { }

      const providerSpecificData = mergeCodexProviderData(existingProviderData, {
        workspaceId: tokens.accountId || tokens.organizationId || tokens.sessionData?.account?.id || null,
        workspacePlanType: tokens.planType || tokens.sessionData?.account?.planType || 'free',
        chatgptUserId: tokens.userId || tokens.sessionData?.user?.id || null,
        organizations: null,
        machineId,
        deviceId: tokens.deviceId || buildStableDeviceId(existingProviderData, id),
        proxyUrl: localAccount?.proxy_url || null,
      });

      if (tokens.sessionData) {
        providerSpecificData.sessionData = tokens.sessionData;
        if (tokens.sessionData.user?.id) providerSpecificData.chatgptUserId = tokens.sessionData.user.id;
        if (tokens.sessionData.account?.id) providerSpecificData.workspaceId = tokens.sessionData.account.id;
        if (tokens.sessionData.account?.planType) providerSpecificData.workspacePlanType = tokens.sessionData.account.planType;
      }

      const hasRefreshToken = !!(tokens.refresh_token || tokens.refreshToken);
      const isFallbackOnly = !hasRefreshToken; // session fallback — chỉ có access_token

      const tags = safeParseTags(localAccount?.tags);
      const hasWorkspace = !!req.body.hasWorkspace;
      let finalTags = tags;
      const hasWorkspaceTag = tags.includes('workspace');
      if (hasWorkspace && !hasWorkspaceTag) {
        finalTags = [...tags, 'workspace'];
      } else if (!hasWorkspace && hasWorkspaceTag) {
        finalTags = tags.filter(t => t !== 'workspace');
      }
      finalTags = finalTags.filter(t => t !== 'need_phone');

      // skipSync=true: tránh double-push từ upsertAccount internal — chỉ push 1 lần explicit bên dưới
      vault.upsertAccount({
        id,
        status: 'ready',
        ever_ready: 1,
        notes: '',
        access_token: tokens.access_token || tokens.accessToken || localAccount?.access_token,
        refresh_token: tokens.refresh_token || tokens.refreshToken || localAccount?.refresh_token || '',
        email: tokens.email || localAccount?.email || '',
        plan: tokens.planType || null,
        workspace_id: tokens.accountId || tokens.organizationId || null,
        device_id: providerSpecificData?.deviceId || null,
        machine_id: machineId,
        provider_specific_data: providerSpecificData,
        connect_pending: 0,
        cookies: tokens.cookies,
        tags: finalTags,
      }, /* skipSync= */ true);

      const fullRecord = vault.db.prepare('SELECT * FROM vault_accounts WHERE id = ?').get(id);
      if (fullRecord?.email) {
        console.log(`[Connect-Result] 🚀 Syncing to D1: ${fullRecord.email} (fallback=${isFallbackOnly})`);
        await SyncManager.pushVault('account', fullRecord);

        // Notify UI ngay lập tức — không cần đợi D1 pull cycle (15 phút)
        if (emitSSE) emitSSE('vault:update', { reason: 'connect-result', id, email: fullRecord.email });

        // Trigger Gateway pull ngay — giảm độ trễ Tools→Gateway từ 30s xuống <2s
        triggerGatewaySync(`connect-result:${fullRecord.email}`).catch(() => {});

        // Note: Gateway tự pull token từ D1 qua codexRemoteSync.pullCodexSnapshotFromRemote().
        const cfg = loadConfig();

        // Trigger usage refresh (optional, best-effort)
        if (cfg.gatewayUrl) {
          const syncSecret = cfg.d1SyncSecret || '';
          fetch(`${cfg.gatewayUrl}/api/usage/${fullRecord.id}`, {
            headers: syncSecret ? { 'x-sync-secret': syncSecret } : undefined,
          }).catch(() => { });
        }
      }

      console.log(`[Connect-Result] ✅ Account ${fullRecord?.email || id} ready (connect flow)`);
      removeNeedPhoneTag(id);

      logAudit({
        action: 'connect',
        entity: 'account',
        entityId: id,
        entityLabel: fullRecord?.email || id,
        details: { status: 'ready', method: 'auto-connect', plan: tokens.planType },
        severity: 'success',
        source: 'worker',
      });
    } else {
      // Error hoặc trạng thái không thành công
      const errorMsg = message || `Connect worker status: ${status}`;
      const isNeedPhone = String(errorMsg).includes('NEED_PHONE');
      const isDeactivated = isDeactivatedMsg(errorMsg);
      maybeAddNeedPhoneTag(id, errorMsg);
      maybeAddAccountDeactivatedTag(id, errorMsg);
      maybeAddNeed2faTag(id, errorMsg);

      // NEED_PHONE: set idle + tag — account chỉ hiển thị ở Vault local, không push Services
      // Deactivated: set dead
      // Relogin/Reset Password: set relogin
      // Other errors: set error + push D1
      const targetStatus = isNeedPhone ? 'idle' : (isDeactivated ? 'dead' : (isReloginMsg(errorMsg) ? 'relogin' : 'error'));
      const nowIso = new Date().toISOString();
      vault.db.prepare(
        `UPDATE vault_accounts SET status=?, notes=?, connect_pending=0, updated_at=? WHERE id=?`
      ).run(targetStatus, errorMsg, nowIso, id);

      // Chỉ push lên D1 nếu KHÔNG phải NEED_PHONE — tránh làm rối Services
      // Account cần phone chỉ hiển thị ở Vault local với nhãn NEED_PHONE
      if (!isNeedPhone) {
        const errRecord = vault.db.prepare('SELECT * FROM vault_accounts WHERE id = ?').get(id);
        if (errRecord) SyncManager.pushVault('account', errRecord).catch(() => { });
      } else {
        // Tombstone trên D1 để account biến mất khỏi Services
        console.log(`[Connect-Result] ⏭️ NEED_PHONE — tombstone trên D1, giữ local với nhãn`);
        try {
          const cfg = loadConfig();
          if (cfg.d1WorkerUrl && cfg.d1SyncSecret) {
            await fetch(`${cfg.d1WorkerUrl}/accounts/${id}`, {
              method: 'DELETE',
              headers: { 'x-sync-secret': cfg.d1SyncSecret },
              signal: AbortSignal.timeout(5000),
            });
          }
        } catch (_) {}
      }

      if (emitSSE) {
        emitSSE('vault:update', { reason: 'connect-result-error', id, status: targetStatus });
      }

      logAudit({
        action: 'connect',
        entity: 'account',
        entityId: id,
        entityLabel: id,
        details: { status: targetStatus, error: errorMsg, isNeedPhone },
        severity: 'error',
        source: 'worker',
      });
    }

    clearLiveScreenshots(id).catch(() => {});
    res.json({ ok: true });
  } catch (e) {
    console.error('[Connect-Result] 💥 Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

/* Deploy v2: đánh dấu connect_pending=1 để auto-connect-worker nhận */
router.post('/accounts/:id/retry-connect', async (req, res) => {
  try {
    const account = vault.getAccountFull(req.params.id);
    if (!account) return res.status(404).json({ error: 'Not found' });
    if (!account.password) return res.status(400).json({ error: 'Account thiếu password — không thể dùng Auto-Connect' });

    // Đảm bảo cột connect_pending tồn tại (migration an toàn)
    try {
      vault.db.prepare(`ALTER TABLE vault_accounts ADD COLUMN connect_pending INTEGER DEFAULT 0`).run();
    } catch (_) { /* column đã tồn tại */ }

    const nowIso = new Date().toISOString();
    vault.db.prepare(
      `UPDATE vault_accounts SET connect_pending=1, status='pending', is_active=1, notes='', updated_at=? WHERE id=?`
    ).run(nowIso, req.params.id);

    console.log(`[Deploy v2] 🔌 Đánh dấu connect_pending cho: ${account.email}`);
    res.json({ ok: true });

    logAudit({
      action: 'deploy',
      entity: 'account',
      entityId: req.params.id,
      entityLabel: account.email || account.label || req.params.id,
      details: { method: 'auto-connect', previousStatus: account.status },
      severity: 'info',
      source: 'ui',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Sync toàn bộ
router.post('/sync/all', async (req, res) => {
  if (SyncManager.isSyncingAll) {
    return res.status(429).json({ error: 'Tiến trình đồng bộ toàn cục đang chạy, vui lòng không gửi yêu cầu liên tiếp.' });
  }
  try {
    SyncManager.isSyncingAll = true;
    const force = req.body?.force === true || req.query?.force === 'true';
    const results = { accounts: 0, emailPool: 0, proxies: 0, keys: 0 };

    // 1. Sync Accounts
    const accounts = vault.getAccountsFull();
    for (const a of accounts) {
      await SyncManager.pushVault('account', a, force);
      results.accounts++;
    }

    // 2. Sync Email Pool
    const pool = vault.getEmailPoolFull();
    for (const e of pool) {
      await SyncManager.pushVault('email_pool', e, force);
      results.emailPool++;
    }

    // 3. Sync Proxies (including soft-deleted ones to ensure D1 is updated)
    const proxies = vault.db.prepare('SELECT * FROM vault_proxies').all();
    for (const p of proxies) {
      await SyncManager.pushVault('proxy', p, force);
      results.proxies++;
    }

    // 4. Sync API Keys (including soft-deleted ones)
    const keys = vault.db.prepare('SELECT * FROM vault_api_keys').all();
    for (const k of keys) {
      await SyncManager.pushVault('key', k, force);
      results.keys++;
    }

    console.log(`[Bulk Sync All] Pushed: Accounts=${results.accounts}, Pool=${results.emailPool}, Proxies=${results.proxies}, Keys=${results.keys} (force=${force})`);
    res.json({ ok: true, results });

    logAudit({
      action: 'sync',
      entity: 'account',
      entityLabel: 'Bulk Sync All',
      details: { ...results, force },
      severity: 'info',
      source: 'ui',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    SyncManager.isSyncingAll = false;
  }
});

// Ép đồng bộ dữ liệu từ D1 về local (bỏ qua cursor hiện tại)
router.post('/sync/force-pull', async (req, res) => {
  try {
    const CURSOR_FILE = path.join(process.cwd(), 'data/sync_cursor.json');
    console.log('[SyncManager] Triggering full force pull from D1 (beginning of time)...');
    
    const pullResult = await SyncManager.pullVault('1970-01-01T00:00:00.000Z');
    
    if (pullResult && pullResult.cursor) {
      fs.writeFileSync(CURSOR_FILE, JSON.stringify({ 
        cursor: pullResult.cursor, 
        savedAt: new Date().toISOString() 
      }));
    }
    
    res.json({ ok: true, pullResult });
    
    logAudit({
      action: 'sync',
      entity: 'account',
      entityLabel: 'Force Pull From D1',
      details: { cursor: pullResult?.cursor },
      severity: 'info',
      source: 'ui',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Lấy trạng thái đồng bộ và chẩn đoán lỗi Codex Remote Sync
router.get('/sync/status', async (req, res) => {
  try {
    const cfg = loadConfig();
    const cursorFile = path.join(process.cwd(), 'data/sync_cursor.json');
    const pendingDeletesFile = path.join(process.cwd(), 'data/pending_d1_deletes.json');

    let localCursor = '1970-01-01T00:00:00.000Z';
    let lastSavedAt = null;
    try {
      if (fs.existsSync(cursorFile)) {
        const parsed = JSON.parse(fs.readFileSync(cursorFile, 'utf-8'));
        if (parsed.cursor) localCursor = parsed.cursor;
        if (parsed.savedAt) lastSavedAt = parsed.savedAt;
      }
    } catch (_) {}

    let pendingDeletesCount = 0;
    try {
      if (fs.existsSync(pendingDeletesFile)) {
        const list = JSON.parse(fs.readFileSync(pendingDeletesFile, 'utf-8'));
        if (Array.isArray(list)) {
          pendingDeletesCount = list.length;
        }
      }
    } catch (_) {}

    // Get DB accounts counts
    let totalAccounts = 0;
    let readyAccounts = 0;
    let idleAccounts = 0;
    let errorAccounts = 0;
    let revokedAccounts = 0;
    try {
      const stats = vault.db.prepare(`
        SELECT 
          COUNT(*) as total,
          COALESCE(SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END), 0) as ready,
          COALESCE(SUM(CASE WHEN status = 'idle' THEN 1 ELSE 0 END), 0) as idle,
          COALESCE(SUM(CASE WHEN status IN ('error', 'need_phone', 'relogin', 'dead') THEN 1 ELSE 0 END), 0) as error,
          COALESCE(SUM(CASE WHEN gateway_status = 'revoked' THEN 1 ELSE 0 END), 0) as revoked
        FROM vault_accounts
        WHERE deleted_at IS NULL
      `).get();
      if (stats) {
        totalAccounts = stats.total || 0;
        readyAccounts = stats.ready || 0;
        idleAccounts = stats.idle || 0;
        errorAccounts = stats.error || 0;
        revokedAccounts = stats.revoked || 0;
      }
    } catch (_) {}

    // D1 Connection and cursor info
    let d1Connected = false;
    let d1Cursor = null;
    let d1PingMs = 0;
    let d1Error = null;

    if (cfg.d1WorkerUrl && cfg.d1SyncSecret) {
      const start = Date.now();
      try {
        const baseUrl = cfg.d1WorkerUrl.replace(/\/+$/, '');
        const response = await fetch(`${baseUrl}/sync/cursor`, {
          method: 'GET',
          headers: { 'x-sync-secret': cfg.d1SyncSecret },
          signal: AbortSignal.timeout(5000),
        });
        d1PingMs = Date.now() - start;
        if (response.ok) {
          const payload = await response.json().catch(() => ({}));
          d1Connected = true;
          d1Cursor = payload.cursor || null;
        } else {
          d1Error = `HTTP ${response.status}: ${await response.text().catch(() => '')}`;
        }
      } catch (err) {
        d1Error = err.message;
      }
    } else {
      d1Error = 'D1 Remote Sync is not configured.';
    }

    res.json({
      ok: true,
      configured: !!(cfg.d1WorkerUrl && cfg.d1SyncSecret),
      d1WorkerUrl: cfg.d1WorkerUrl || null,
      localCursor,
      lastSavedAt,
      pendingDeletesCount,
      dbStats: {
        total: totalAccounts,
        ready: readyAccounts,
        idle: idleAccounts,
        error: errorAccounts,
        revoked: revokedAccounts,
      },
      d1Health: {
        connected: d1Connected,
        cursor: d1Cursor,
        pingMs: d1PingMs,
        error: d1Error,
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Dọn dẹp các connections & accounts rác / mồ côi trên D1
router.post('/sync/cleanup-stale', async (req, res) => {
  try {
    const cfg = loadConfig();
    if (!cfg.d1WorkerUrl || !cfg.d1SyncSecret) {
      return res.status(400).json({ error: 'Codex D1 Remote Sync not configured.' });
    }
    
    const baseUrl = cfg.d1WorkerUrl.replace(/\/+$/, '');
    const headers = { 'x-sync-secret': cfg.d1SyncSecret, 'Content-Type': 'application/json', 'User-Agent': 'SeeLLM-Tools/1.0' };

    // 1. Lấy tất cả active connections trên D1
    const connRes = await fetch(`${baseUrl}/inspect/connections`, { headers });
    const connData = await connRes.json();
    const connections = connData.items || [];

    // 2. Lấy tất cả managed accounts trên D1
    const acctRes = await fetch(`${baseUrl}/inspect/accounts`, { headers });
    const acctData = await acctRes.json();
    const accounts = acctData.items || [];

    // 3. Tìm các orphaned connections (không có trong managed accounts đang hoạt động)
    const activeEmails = new Set(accounts.map(a => (a.email || '').toLowerCase()));
    const activeIds = new Set(accounts.map(a => a.id));

    const orphans = connections.filter(c => {
      const emailMatch = c.email && activeEmails.has(c.email.toLowerCase());
      const idMatch = activeIds.has(c.id);
      return !emailMatch && !idMatch;
    });

    if (orphans.length === 0) {
      return res.json({ ok: true, cleanedCount: 0, message: 'No stale connections found.' });
    }

    const now = new Date().toISOString();
    const version = Date.now();
    const tombstones = orphans.map(c => ({
      id: c.id,
      email: c.email,
      deleted_at: now,
      is_active: 0,
      updated_at: now,
      version,
    }));

    const pushRes = await fetch(`${baseUrl}/sync/push`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ connections: tombstones }),
    });
    const pushData = await pushRes.json();

    res.json({ ok: true, cleanedCount: orphans.length, pushData });
    
    logAudit({
      action: 'sync',
      entity: 'account',
      entityLabel: 'Remote Sync Cleanup',
      details: { cleanedCount: orphans.length },
      severity: 'warning',
      source: 'ui',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/sync', async (req, res) => {
  // Legacy /sync for backward compatibility (only accounts)
  try {
    const accounts = vault.getAccountsFull();
    let pushed = 0;
    for (const a of accounts) {
      await SyncManager.pushVault('account', a);
      pushed++;
    }
    res.json({ ok: true, pushed });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ══════════════════════════════════════════════════════════════════════════ */
/*  INBOX VIEWER — MS Graph per-email inbox reader                           */
/* ══════════════════════════════════════════════════════════════════════════ */

const _GRAPH_TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const _GRAPH_TOKEN_URL_CONSUMERS = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token';
const _GRAPH_ME = 'https://graph.microsoft.com/v1.0/me';
const _OUTLOOK_API = 'https://outlook.office.com/api/v2.0/me';
const _inboxTokenCache = new Map(); // email → { token, expiresAt, isPersonal }

// Personal Microsoft account domains.
// KEY INSIGHT: Token type determines which API to use — NOT account domain or scope.
//   - EwBY... (opaque)    → Graph API ✅  |  Outlook REST → IDX14100
//   - EwA...  (encrypted) → Outlook REST ✅ | Graph API → IDX14100
//   - eyJ... (JWT)        → Graph API ✅
// Different client IDs return DIFFERENT token types even with the same scope/no-scope.
// Must detect AFTER receiving the token, not guess from input params.
const _PERSONAL_MS_DOMAINS = ['outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'passport.com'];

function _isPersonalMsAccount(email) {
  const domain = (email || '').split('@')[1]?.toLowerCase();
  return domain && _PERSONAL_MS_DOMAINS.some(d => domain === d || domain.endsWith('.' + d));
}

/**
 * Detect if an MS token requires Outlook REST API or Graph API.
 * Based on token prefix — this is the ground truth, not the account domain or scope.
 *
 * EwA* = encrypted token for Outlook REST API (from .default or IMAP scopes)
 * EwBY* = opaque token that works with Graph API
 * eyJ* = standard JWT → Graph API
 */
function _isEwAToken(token) {
  if (!token) return false;
  // EwA tokens: encrypted, require Outlook REST API. They start with "EwA" followed by digits/letters.
  // EwBY tokens: also opaque but work with Graph API.
  // Safest check: starts with EwA and NOT EwBY (EwBY also starts with Ew but is Graph-compatible)
  return token.startsWith('EwA') && !token.startsWith('EwBY');
}

// Helper: safely fetch JSON response and throw descriptive error on failure
async function _safeFetchJson(res, label = 'Request') {
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    let errObj = {};
    try {
      if (text) errObj = JSON.parse(text);
    } catch (e) {}
    const msg = errObj.error_description || errObj.error?.message || `${label} failed with status ${res.status}: ${text.substring(0, 200)}`;
    throw new Error(msg);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${label} returned invalid JSON: ${text.substring(0, 200)}`);
  }
}

async function _getGraphToken(pool) {
  const cached = _inboxTokenCache.get(pool.email);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached;

  // Clear stale cache
  _inboxTokenCache.delete(pool.email);

  const isPersonalDomain = _isPersonalMsAccount(pool.email);
  const tokenUrl = isPersonalDomain ? _GRAPH_TOKEN_URL_CONSUMERS : _GRAPH_TOKEN_URL;

  const scopesToTry = [];
  if (isPersonalDomain) {
    // For personal accounts: try Graph Mail.Read first, then Outlook REST .default, then no-scope
    scopesToTry.push({ scope: 'Mail.Read offline_access', isPersonal: false });
    scopesToTry.push({ scope: 'https://outlook.office.com/.default offline_access', isPersonal: true });
    scopesToTry.push({ scope: null, isPersonal: null });
  } else {
    // For work/school accounts: try Mail.Read first, then no-scope
    scopesToTry.push({ scope: 'Mail.Read offline_access', isPersonal: false });
    scopesToTry.push({ scope: null, isPersonal: null });
  }

  let lastError = null;
  for (const item of scopesToTry) {
    try {
      console.log(`[Inbox] Fetching token for ${pool.email} (scope: ${item.scope || 'no-scope'})...`);
      const bodyParams = {
        client_id: pool.client_id,
        grant_type: 'refresh_token',
        refresh_token: pool.refresh_token,
      };
      if (item.scope) {
        bodyParams.scope = item.scope;
      }
      const r = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(bodyParams).toString(),
      });

      if (r.ok) {
        const d = await _safeFetchJson(r, `Graph Token (${item.scope || 'no-scope'})`);
        const token = d.access_token;
        
        let isPersonal = item.isPersonal;
        if (isPersonal === null) {
          isPersonal = _isEwAToken(token);
        }
        
        const tokenType = isPersonal ? 'EwA (→Outlook REST)' : token.startsWith('EwBY') ? 'EwBY (→Graph)' : 'JWT (→Graph)';
        console.log(`[Inbox] Token OK for ${pool.email} with scope "${item.scope || 'no-scope'}": ${tokenType}`);
        
        const entry = {
          token,
          expiresAt: Date.now() + ((d.expires_in || 3600) - 120) * 1000,
          isPersonal
        };
        _inboxTokenCache.set(pool.email, entry);
        return entry;
      } else {
        const text = await r.text().catch(() => '');
        let errDesc = text;
        try {
          if (text) {
            const err = JSON.parse(text);
            errDesc = err.error_description || err.error?.message || text;
          }
        } catch (e) {}
        console.log(`[Inbox] Token attempt failed for ${pool.email} (scope: ${item.scope || 'no-scope'}): ${errDesc.substring(0, 100)}`);
        lastError = new Error(errDesc);
      }
    } catch (err) {
      console.log(`[Inbox] Error during token attempt for ${pool.email} (scope: ${item.scope || 'no-scope'}): ${err.message}`);
      lastError = err;
    }
  }

  throw lastError || new Error('Failed to acquire token from all configured scopes');
}

// Helper: normalize Outlook REST API message format to match Graph API format
function _normalizeOutlookMessage(m, direction = 'incoming') {
  return {
    id: m.Id,
    subject: m.Subject,
    bodyPreview: m.BodyPreview || m.Body?.Content?.substring(0, 255),
    body: m.Body ? { content: m.Body.Content, contentType: m.Body.ContentType?.toLowerCase() } : undefined,
    from: m.From ? { emailAddress: { name: m.From.EmailAddress?.Name, address: m.From.EmailAddress?.Address } } : undefined,
    toRecipients: (m.ToRecipients || []).map(r => ({ emailAddress: { name: r.EmailAddress?.Name, address: r.EmailAddress?.Address } })),
    receivedDateTime: m.ReceivedDateTime || m.DateTimeReceived,
    isRead: m.IsRead,
    conversationId: m.ConversationId,
    direction
  };
}

// GET /api/vault/inbox/:email — list inbox + sent messages, merged & sorted
router.get('/inbox/:email', async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email).toLowerCase();
    const pool = vault.getEmailPoolFull().find(e => e.email.toLowerCase() === email);
    if (!pool) return res.status(404).json({ error: 'Email not in pool' });
    if (!pool.refresh_token || !pool.client_id)
      return res.status(400).json({ error: 'Missing MS Graph credentials (refresh_token / client_id)' });
    const tokenEntry = await _getGraphToken(pool);
    const { token, isPersonal } = tokenEntry;
    const top = Math.min(parseInt(req.query.top) || 50, 100);

    let inboxMsgs, sentMsgs;

    if (isPersonal) {
      // Use Outlook REST API for personal accounts (encrypted token not accepted by Graph API)
      const selectFields = 'Id,Subject,BodyPreview,From,ToRecipients,ReceivedDateTime,IsRead,ConversationId';

      const inboxUrl = `${_OUTLOOK_API}/messages?$top=${top}&$orderby=ReceivedDateTime desc&$select=${selectFields}`;
      const inboxRes = await fetch(inboxUrl, { headers: { Authorization: `Bearer ${token}` } });
      const inboxData = await _safeFetchJson(inboxRes, 'Outlook Inbox');
      inboxMsgs = (inboxData.value || []).map(m => _normalizeOutlookMessage(m, 'incoming'));

      // Sent items
      const sentUrl = `${_OUTLOOK_API}/mailfolders/sentitems/messages?$top=${top}&$orderby=ReceivedDateTime desc&$select=${selectFields}`;
      const sentRes = await fetch(sentUrl, { headers: { Authorization: `Bearer ${token}` } });
      const sentData = sentRes.ok ? await _safeFetchJson(sentRes, 'Outlook Sent') : { value: [] };
      sentMsgs = (sentData.value || []).map(m => _normalizeOutlookMessage(m, 'outgoing'));
    } else {
      // Use Graph API for work/school accounts
      const selectFields = 'id,subject,bodyPreview,from,toRecipients,receivedDateTime,isRead,conversationId';

      const inboxUrl = `${_GRAPH_ME}/mailFolders/inbox/messages?$top=${top}&$orderby=receivedDateTime desc&$select=${selectFields}`;
      const inboxRes = await fetch(inboxUrl, { headers: { Authorization: `Bearer ${token}` } });
      const inboxData = await _safeFetchJson(inboxRes, 'Graph Inbox');
      inboxMsgs = (inboxData.value || []).map(m => ({ ...m, direction: 'incoming' }));

      const sentUrl = `${_GRAPH_ME}/mailFolders/sentitems/messages?$top=${top}&$orderby=receivedDateTime desc&$select=${selectFields}`;
      const sentRes = await fetch(sentUrl, { headers: { Authorization: `Bearer ${token}` } });
      const sentData = sentRes.ok ? await _safeFetchJson(sentRes, 'Graph Sent') : { value: [] };
      sentMsgs = (sentData.value || []).map(m => ({ ...m, direction: 'outgoing' }));
    }

    // Merge & sort by receivedDateTime desc
    const all = [...inboxMsgs, ...sentMsgs]
      .sort((a, b) => new Date(b.receivedDateTime) - new Date(a.receivedDateTime));

    res.json({ ok: true, messages: all });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/vault/inbox/message — get full message body
router.post('/inbox/message', async (req, res) => {
  try {
    const { email, messageId } = req.body;
    if (!email || !messageId) return res.status(400).json({ error: 'Missing email or messageId' });
    const pool = vault.getEmailPoolFull().find(e => e.email === email);
    if (!pool) return res.status(404).json({ error: 'Email not in pool' });
    const tokenEntry = await _getGraphToken(pool);
    const { token, isPersonal } = tokenEntry;

    let message;
    if (isPersonal) {
      const url = `${_OUTLOOK_API}/messages/${messageId}?$select=Id,Subject,Body,BodyPreview,From,ToRecipients,ReceivedDateTime,IsRead,ConversationId`;
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      const d = await _safeFetchJson(r, 'Outlook Message Details');
      message = _normalizeOutlookMessage(d);
    } else {
      const url = `${_GRAPH_ME}/messages/${messageId}` +
        `?$select=id,subject,body,bodyPreview,from,toRecipients,receivedDateTime,isRead,conversationId`;
      const r = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Prefer: 'outlook.body-content-type="html"' },
      });
      const d = await _safeFetchJson(r, 'Graph Message Details');
      if (d && d.body) {
        d.body.contentType = d.body.contentType?.toLowerCase();
      }
      message = d;
    }
    res.json({ ok: true, message });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/vault/inbox/mark-read — mark a message as read
router.post('/inbox/mark-read', async (req, res) => {
  try {
    const { email, messageId } = req.body;
    if (!email || !messageId) return res.status(400).json({ error: 'Missing email or messageId' });
    const pool = vault.getEmailPoolFull().find(e => e.email === email);
    if (!pool) return res.status(404).json({ error: 'Email not in pool' });
    const tokenEntry = await _getGraphToken(pool);
    const { token, isPersonal } = tokenEntry;

    if (isPersonal) {
      await fetch(`${_OUTLOOK_API}/messages/${messageId}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ IsRead: true }),
      });
    } else {
      await fetch(`${_GRAPH_ME}/messages/${messageId}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ isRead: true }),
      });
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/vault/inbox/delete — delete (permanently trash) a message
router.post('/inbox/delete', async (req, res) => {
  try {
    const { email, messageId } = req.body;
    if (!email || !messageId) return res.status(400).json({ error: 'Missing email or messageId' });
    const pool = vault.getEmailPoolFull().find(e => e.email === email);
    if (!pool) return res.status(404).json({ error: 'Email not in pool' });
    const tokenEntry = await _getGraphToken(pool);
    const { token, isPersonal } = tokenEntry;

    const apiUrl = isPersonal ? `${_OUTLOOK_API}/messages/${messageId}` : `${_GRAPH_ME}/messages/${messageId}`;
    const r = await fetch(apiUrl, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok && r.status !== 204) {
      const text = await r.text().catch(() => '');
      let errObj = {};
      try {
        if (text) errObj = JSON.parse(text);
      } catch (e) {}
      throw new Error(errObj.error?.message || `Delete failed: ${r.status} - ${text}`);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/vault/inbox/send — send an email via Microsoft Graph API
router.post('/inbox/send', async (req, res) => {
  try {
    console.log(`[Inbox-Send] req.body type=${typeof req.body}, keys=${Object.keys(req.body || {}).join(',')}`);
    const { email, to, cc, bcc, subject, body, contentType, saveToSentItems } = req.body || {};
    if (!email) return res.status(400).json({ error: 'Missing sender email' });
    if (!to || !Array.isArray(to) || to.length === 0) return res.status(400).json({ error: 'Missing recipient(s)' });
    if (!subject && !body) return res.status(400).json({ error: 'Missing subject or body' });

    const pool = vault.getEmailPoolFull().find(e => e.email === email);
    if (!pool) return res.status(404).json({ error: 'Email not in pool' });
    if (!pool.refresh_token || !pool.client_id)
      return res.status(400).json({ error: 'Missing MS Graph credentials (refresh_token / client_id)' });

    const tokenEntry = await _getGraphToken(pool);
    const { token, isPersonal } = tokenEntry;

    const parseRecipients = (list) =>
      (list || []).filter(addr => addr && addr.trim()).map(addr => ({
        emailAddress: { address: addr.trim() }
      }));

    const payload = {
      message: {
        subject: subject || '(no subject)',
        body: {
          contentType: contentType || 'HTML',
          content: body || '',
        },
        toRecipients: parseRecipients(to),
        ccRecipients: parseRecipients(cc),
        bccRecipients: parseRecipients(bcc),
      },
      saveToSentItems: saveToSentItems !== false,
    };

    // Personal accounts (hotmail/outlook) use Outlook REST API — their encrypted (EwA)
    // tokens are rejected by Graph API with IDX14100.
    const sendUrl = isPersonal
      ? `${_OUTLOOK_API}/sendmail`
      : `${_GRAPH_ME}/sendMail`;

    const r = await fetch(sendUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!r.ok && r.status !== 202 && r.status !== 204) {
      const text = await r.text().catch(() => '');
      let errObj = {};
      try {
        if (text) errObj = JSON.parse(text);
      } catch (e) {}
      throw new Error(errObj.error?.message || `Send failed: ${r.status} - ${text}`);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ══════════════════════════════════════════════════════════════════════════ */
/*  BULK REGISTRATION RUNNER & ENDPOINTS                                       */
/* ══════════════════════════════════════════════════════════════════════════ */

let processManager = {
  spawnProcess: null,
  stopProcess: null,
  getProcesses: null
};

export function registerProcessManager(pm) {
  processManager = pm;
}

function getActiveProcessesCount() {
  if (!processManager.getProcesses) return 0;
  const allProcs = processManager.getProcesses();
  return Object.values(allProcs).filter(
    p => p.status === 'running' && (
      p.id.startsWith('warmup_') || 
      p.id.startsWith('check_session_') || 
      p.id.startsWith('2fa_regen_') ||
      p.id.startsWith('script_')
    )
  ).length;
}

const executionQueue = [];
let queueProcessing = false;

function enqueueTask(taskFn) {
  executionQueue.push(taskFn);
  triggerQueueProcessing();
}

async function triggerQueueProcessing() {
  if (queueProcessing) return;
  queueProcessing = true;
  
  try {
    while (executionQueue.length > 0) {
      const cfg = loadConfig();
      const maxThreads = cfg.maxThreads || 3;
      if (getActiveProcessesCount() < maxThreads) {
        const nextTask = executionQueue.shift();
        try {
          await nextTask();
        } catch (err) {
          console.error('[Queue] Error executing background process task:', err);
        }
        // Wait 2.5 seconds to allow the process to register as running and start up
        await new Promise(r => setTimeout(r, 2500));
      } else {
        // Wait 2 seconds before checking again
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  } finally {
    queueProcessing = false;
  }
}

// POST /api/vault/accounts/:id/warmup
router.post('/accounts/:id/warmup', async (req, res) => {
  try {
    const { id } = req.params;
    const { questionsCount = 0 } = req.body;
    
    const account = vault.getAccount(id);
    if (!account) return res.status(404).json({ error: 'Account not found' });
    
    if (account.status === 'dead') {
      return res.status(400).json({ error: 'Không thể warmup tài khoản đã bị khóa/vô hiệu hóa (dead).' });
    }
    
    // Set the warmup status to pending in provider_specific_data
    const existingProviderData = account.provider_specific_data || {};
    if (existingProviderData.warmupStatus === 'pending') {
      return res.status(400).json({ error: 'Tài khoản này đang trong tiến trình warmup rồi.' });
    }
    
    existingProviderData.warmupStatus = 'pending';
    existingProviderData.lastWarmedAt = new Date().toISOString();
    existingProviderData.warmupError = null;
    
    vault.upsertAccount({
      id,
      provider_specific_data: existingProviderData
    });

    emitSSE('vault:update');
    
    // Return immediately to the client to avoid socket timeouts
    res.json({ ok: true, message: 'Warmup task queued successfully', status: 'pending' });

    const enqueuedAt = Date.now();
    enqueueTask(async () => {
      const currAcc = vault.getAccount(id);
      if (!currAcc) return;
      const currProviderData = currAcc.provider_specific_data || {};
      
      if (currProviderData.warmupStatus !== 'pending') return;

      if (Date.now() - enqueuedAt > 10 * 60 * 1000) {
        currProviderData.warmupStatus = 'failed';
        currProviderData.warmupError = 'Hệ thống quá tải (chờ quá 10 phút trong hàng đợi). Vui lòng thử lại sau.';
        vault.upsertAccount({
          id,
          provider_specific_data: currProviderData
        });
        emitSSE('vault:update');
        return;
      }
      
      // Spawn scripts/warmup.js as a detached background child process
      const { fileURLToPath } = await import('node:url');
      const scriptPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/warmup.js');
      
      if (processManager.spawnProcess) {
        const procId = `warmup_${id}_${Date.now()}`;
        console.log(`[Server] Spawning warmup process ${procId} via processManager`);
        processManager.spawnProcess(
          procId, 
          `🔥 Warmup ${currAcc.email}`, 
          'node', 
          [scriptPath, '--accountId', id, '--questions', String(questionsCount)], 
          process.cwd(), 
          { env: { ...process.env } }
        );
      } else {
        const { spawn } = await import('node:child_process');
        console.log(`[Server] Spawning warmup worker for ${currAcc.email} (${id})`);
        const child = spawn('node', [scriptPath, '--accountId', id, '--questions', String(questionsCount)], {
          detached: true,
          stdio: 'ignore'
        });
        child.unref();
      }
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/vault/accounts/:id/check-session
router.post('/accounts/:id/check-session', async (req, res) => {
  try {
    const { id } = req.params;
    
    // 🔄 Tự động đồng bộ nhanh từ D1 về local trước khi check để đảm bảo nhận được token mới nhất nếu Gateway vừa refresh
    try {
      const cfg = loadConfig();
      if (cfg.d1WorkerUrl && cfg.d1SyncSecret) {
        const CURSOR_FILE = path.join(process.cwd(), 'data/sync_cursor.json');
        let cursor = '1970-01-01T00:00:00.000Z';
        try {
          if (fs.existsSync(CURSOR_FILE)) {
            const parsed = JSON.parse(fs.readFileSync(CURSOR_FILE, 'utf-8'));
            if (parsed.cursor) cursor = parsed.cursor;
          }
        } catch (_) {}
        
        console.log(`[CheckSessionRoute] 🔄 Pulling latest changes from D1 (current cursor: ${cursor})`);
        const pullResult = await SyncManager.pullVault(cursor);
        if (pullResult && pullResult.cursor > cursor) {
          console.log(`[CheckSessionRoute] ✅ Found new updates from D1 (new cursor: ${pullResult.cursor}). Saving to local DB...`);
          pullResult.accounts.forEach(a => vault.upsertAccount(a, true));
          pullResult.proxies.forEach(p => vault.upsertProxy(p, true));
          pullResult.keys.forEach(k => vault.upsertApiKey(k, true));
          
          try {
            fs.writeFileSync(CURSOR_FILE, JSON.stringify({ cursor: pullResult.cursor, savedAt: new Date().toISOString() }));
          } catch (_) {}
        }
      }
    } catch (syncErr) {
      console.warn(`[CheckSessionRoute] ⚠️ Không thể đồng bộ nhanh từ D1:`, syncErr.message);
    }

    const account = vault.getAccount(id);
    if (!account) return res.status(404).json({ error: 'Account not found' });
    
    if (account.status === 'pending' || account.status === 'processing') {
      return res.status(400).json({ error: 'Tài khoản đang trong tiến trình xử lý khác (pending/processing).' });
    }

    // Save original status in provider_specific_data to avoid auto-deploying non-deployed accounts if check succeeds
    const existingProviderData = typeof account.provider_specific_data === 'string'
      ? JSON.parse(account.provider_specific_data)
      : (account.provider_specific_data || {});
    
    existingProviderData.preCheckStatus = account.status;
    
    // Set status to pending in database
    vault.upsertAccount({
      id,
      status: 'pending',
      notes: 'Checking cookie/session...',
      provider_specific_data: existingProviderData
    });

    emitSSE('vault:update');
    
    // Return immediately to the client to avoid socket timeouts
    res.json({ ok: true, message: 'Session check task queued successfully', status: 'pending' });

    const enqueuedAt = Date.now();
    enqueueTask(async () => {
      const currAcc = vault.getAccount(id);
      if (!currAcc) return;
      
      if (currAcc.status !== 'pending') return;

      const currProviderData = typeof currAcc.provider_specific_data === 'string'
        ? JSON.parse(currAcc.provider_specific_data)
        : (currAcc.provider_specific_data || {});

      if (Date.now() - enqueuedAt > 10 * 60 * 1000) {
        vault.upsertAccount({
          id,
          status: currProviderData.preCheckStatus || 'error',
          notes: 'Check session thất bại: Hàng đợi quá tải (chờ quá 10 phút).'
        });
        emitSSE('vault:update');
        return;
      }
      
      // Spawn scripts/check-session.js as a detached background child process
      const { fileURLToPath } = await import('node:url');
      const scriptPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/check-session.js');
      
      if (processManager.spawnProcess) {
        const procId = `check_session_${id}_${Date.now()}`;
        console.log(`[Server] Spawning check-session process ${procId} via processManager`);
        processManager.spawnProcess(
          procId, 
          `🛡️ Check Session ${currAcc.email}`, 
          'node', 
          [scriptPath, '--accountId', id], 
          process.cwd(), 
          { env: { ...process.env } }
        );
      } else {
        const { spawn } = await import('node:child_process');
        console.log(`[Server] Spawning session checker for ${currAcc.email} (${id})`);
        const child = spawn('node', [scriptPath, '--accountId', id], {
          detached: true,
          stdio: 'ignore'
        });
        child.unref();
      }
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/vault/accounts/:id/warmup-result
router.post('/accounts/:id/warmup-result', async (req, res) => {
  try {
    const { id } = req.params;
    const { 
      status, 
      error = null, 
      questionsAsked = 0, 
      cookies = null,
      accountStatus = null,
      notes = null,
      accessToken = null,
      plan = null,
      workspaceId = null,
      deviceId = null,
      sessionData = null
    } = req.body;
    
    const account = vault.getAccount(id);
    if (!account) return res.status(404).json({ error: 'Account not found' });
    
    const existingProviderData = typeof account.provider_specific_data === 'string'
      ? JSON.parse(account.provider_specific_data)
      : (account.provider_specific_data || {});
      
    // Restore 'idle' status if the account was 'idle' before checking session
    const preCheckStatus = existingProviderData.preCheckStatus;
    delete existingProviderData.preCheckStatus; // Clean up
    
    existingProviderData.warmupStatus = status; // 'success' | 'failed'
    existingProviderData.lastWarmedAt = new Date().toISOString();
    existingProviderData.warmupError = error;
    existingProviderData.warmupQuestionsAsked = questionsAsked;
    existingProviderData.warmupCount = (existingProviderData.warmupCount || 0) + 1;
    if (status === 'success') {
      existingProviderData.warmupSuccessCount = (existingProviderData.warmupSuccessCount || 0) + 1;
      
      // Track unique dates of successful warmups (YYYY-MM-DD format)
      const todayStr = new Date().toISOString().slice(0, 10);
      if (!existingProviderData.warmupSuccessDates) {
        existingProviderData.warmupSuccessDates = [];
      }
      if (!existingProviderData.warmupSuccessDates.includes(todayStr)) {
        existingProviderData.warmupSuccessDates.push(todayStr);
      }
      existingProviderData.warmupSuccessDays = existingProviderData.warmupSuccessDates.length;
    }
    
    if (sessionData) {
      existingProviderData.sessionData = sessionData;
      if (sessionData.user?.id) existingProviderData.userId = sessionData.user.id;
      if (sessionData.account?.id) existingProviderData.accountId = sessionData.account.id;
      if (sessionData.account?.planType) existingProviderData.planType = sessionData.account.planType;
    }
    
    const updateData = {
      id,
      provider_specific_data: existingProviderData
    };
    
    if (cookies && Array.isArray(cookies) && cookies.length > 0) {
      updateData.cookies = cookies;
      // Giữ nguyên trạng thái 'idle' nếu account chưa từng được deploy (ever_ready !== 1)
      // Các trạng thái từng deploy hoặc đã ready thì chuyển về 'ready'.
      const isNeverDeployed = account.ever_ready !== 1 && account.status !== 'ready';
      updateData.status = isNeverDeployed ? 'idle' : 'ready';
      
      // Xoá các nhãn lỗi nếu đăng nhập thành công
      let tags = safeParseTags(account.tags);
      let tagsChanged = false;
      ['wrong_password', 'account_deactivated', 'need_phone', 'email_error', 'short_password'].forEach(t => {
        if (tags.includes(t)) {
          tags = tags.filter(x => x !== t);
          tagsChanged = true;
        }
      });
      if (tagsChanged) {
        updateData.tags = tags;
      }
    }
    
    const isDeactivated = isDeactivatedMsg(error);
    if (isDeactivated) {
      maybeAddAccountDeactivatedTag(id, error);
      updateData.status = 'dead';
      updateData.notes = `Tài khoản đã bị vô hiệu hóa (phát hiện trong Warmup: ${error})`;
    } else if (isNeed2faMsg(error)) {
      maybeAddNeed2faTag(id, error);
      updateData.status = 'error';
      updateData.notes = `Tài khoản yêu cầu 2FA nhưng thiếu Secret Key (phát hiện trong Warmup: ${error})`;
    } else if (isPasswordTooShortMsg(error)) {
      maybeAddShortPasswordTag(id, error);
      updateData.status = 'relogin';
      updateData.notes = `Mật khẩu quá ngắn, OpenAI yêu cầu tối thiểu 12 ký tự (phát hiện trong Warmup: ${error})`;
    } else if (isReloginMsg(error)) {
      maybeAddWrongPasswordTag(id, error);
      updateData.status = 'relogin';
      updateData.notes = `Tài khoản yêu cầu đăng nhập lại (phát hiện trong Warmup: ${error})`;
    } else if (isEmailErrorMsg(error)) {
      maybeAddEmailErrorTag(id, error);
      updateData.status = 'error';
      updateData.notes = `Lỗi Email/OTP (phát hiện trong Warmup: ${error})`;
    } else {
      let targetStatus = accountStatus;
      if (preCheckStatus === 'idle') {
        targetStatus = 'idle';
        console.log(`[Warmup-Result] Restoring account ${account.email || id} status to 'idle' (was idle before check)`);
      }
      
      if (targetStatus) updateData.status = targetStatus;
      if (notes !== null) updateData.notes = notes;
    }
    if (accessToken) updateData.access_token = accessToken;
    if (plan) updateData.plan = plan;
    if (workspaceId) updateData.workspace_id = workspaceId;
    if (deviceId) updateData.device_id = deviceId;
    
    vault.upsertAccount(updateData, true);
    
    // Push sync to cloud D1 ONLY IF previously deployed
    const fullRecord = vault.db.prepare('SELECT * FROM vault_accounts WHERE id = ?').get(id);
    if (fullRecord && fullRecord.email) {
      const isDeployed = fullRecord.status !== 'idle' && fullRecord.status !== 'mfa_pending' && fullRecord.status !== 'error' && fullRecord.status !== 'dead';
      if (isDeployed || fullRecord.ever_ready === 1) {
        console.log(`[Server] Syncing warmed account ${fullRecord.email} to D1`);
        await SyncManager.pushVault('account', fullRecord).catch(() => {});
      }

      if (emitSSE) {
        emitSSE('vault:update', { reason: 'warmup-result', id, email: fullRecord.email });
      }
    }
    
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/vault/accounts/:id/regenerate-2fa
router.post('/accounts/:id/regenerate-2fa', async (req, res) => {
  try {
    const { id } = req.params;
    
    const account = vault.getAccount(id);
    if (!account) return res.status(404).json({ error: 'Account not found' });
    
    // Set the 2fa regeneration status to pending in provider_specific_data
    const existingProviderData = typeof account.provider_specific_data === 'string'
      ? JSON.parse(account.provider_specific_data)
      : (account.provider_specific_data || {});
      
    if (existingProviderData.twoFaRegenStatus === 'pending') {
      return res.status(400).json({ error: 'Tài khoản này đang trong tiến trình tái tạo 2FA rồi.' });
    }
    
    existingProviderData.twoFaRegenStatus = 'pending';
    existingProviderData.twoFaRegenError = null;
    
    vault.upsertAccount({
      id,
      provider_specific_data: existingProviderData
    });

    emitSSE('vault:update');
    
    // Return immediately to the client to avoid socket timeouts
    res.json({ ok: true, message: '2FA regeneration task queued successfully', status: 'pending' });

    const enqueuedAt = Date.now();
    enqueueTask(async () => {
      const currAcc = vault.getAccount(id);
      if (!currAcc) return;

      const currProviderData = typeof currAcc.provider_specific_data === 'string'
        ? JSON.parse(currAcc.provider_specific_data)
        : (currAcc.provider_specific_data || {});

      if (currProviderData.twoFaRegenStatus !== 'pending') return;

      if (Date.now() - enqueuedAt > 10 * 60 * 1000) {
        currProviderData.twoFaRegenStatus = 'failed';
        currProviderData.twoFaRegenError = 'Tái tạo 2FA thất bại: Hàng đợi quá tải (chờ quá 10 phút).';
        vault.upsertAccount({
          id,
          provider_specific_data: currProviderData
        });
        emitSSE('vault:update');
        return;
      }
      
      // Spawn scripts/regenerate-2fa.js as a detached background child process
      const { fileURLToPath } = await import('node:url');
      const scriptPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/regenerate-2fa.js');
      
      if (processManager.spawnProcess) {
        const procId = `2fa_regen_${id}_${Date.now()}`;
        console.log(`[Server] Spawning 2FA regeneration process ${procId} via processManager`);
        processManager.spawnProcess(
          procId, 
          `🛡️ 2FA Regen ${currAcc.email}`, 
          'node', 
          [scriptPath, '--accountId', id], 
          process.cwd(), 
          { env: { ...process.env } }
        );
      } else {
        const { spawn } = await import('node:child_process');
        console.log(`[Server] Spawning 2FA regeneration worker for ${currAcc.email} (${id})`);
        const child = spawn('node', [scriptPath, '--accountId', id], {
          detached: true,
          stdio: 'ignore'
        });
        child.unref();
      }
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/vault/accounts/:id/regenerate-2fa-result
router.post('/accounts/:id/regenerate-2fa-result', async (req, res) => {
  try {
    const { id } = req.params;
    const { 
      status, 
      error = null, 
      secret = null,
      cookies = null
    } = req.body;
    
    const account = vault.getAccount(id);
    if (!account) return res.status(404).json({ error: 'Account not found' });
    
    const existingProviderData = typeof account.provider_specific_data === 'string'
      ? JSON.parse(account.provider_specific_data)
      : (account.provider_specific_data || {});
      
    existingProviderData.twoFaRegenStatus = status;
    existingProviderData.twoFaRegenError = error;
    existingProviderData.lastTwoFaRegenAt = new Date().toISOString();
    
    const updateData = {
      id,
      provider_specific_data: existingProviderData
    };
    
    const isDeactivated = isDeactivatedMsg(error);
    if (isDeactivated) {
      maybeAddAccountDeactivatedTag(id, error);
      updateData.status = 'dead';
      updateData.notes = `Tài khoản đã bị vô hiệu hóa (phát hiện trong 2FA Regen: ${error})`;
    } else if (isReloginMsg(error)) {
      updateData.status = 'relogin';
      updateData.notes = `Tài khoản yêu cầu đăng nhập lại (phát hiện trong 2FA Regen: ${error})`;
    } else if (isEmailErrorMsg(error)) {
      maybeAddEmailErrorTag(id, error);
      updateData.status = 'error';
      updateData.notes = `Lỗi Email/OTP (phát hiện trong 2FA Regen: ${error})`;
    } else if (status === 'success' && secret) {
      updateData.two_fa_secret = secret;
      // Trạng thái: nếu account chưa từng được deploy (ever_ready !== 1) thì đưa về 'idle' để tránh tự động đẩy lên gateway.
      // Nếu đã từng deploy thì khôi phục lại 'ready'.
      const isNeverDeployed = account.ever_ready !== 1 && account.status !== 'ready';
      updateData.status = isNeverDeployed ? 'idle' : 'ready';
      updateData.notes = isNeverDeployed ? '2FA regenerated successfully (idle)' : '2FA regenerated successfully';

      // Xoá nhãn need_2fa và email_error nếu thành công
      let tags = safeParseTags(account.tags);
      let tagsChanged = false;
      ['need_2fa', 'email_error'].forEach(t => {
        if (tags.includes(t)) {
          tags = tags.filter(x => x !== t);
          tagsChanged = true;
        }
      });
      if (tagsChanged) {
        updateData.tags = tags;
      }
    } else if (status === 'failed') {
      updateData.notes = `2FA regeneration failed: ${error}`;
    }
    
    if (cookies && Array.isArray(cookies) && cookies.length > 0) {
      updateData.cookies = cookies;
    }
    
    vault.upsertAccount(updateData, true);
    
    // Push sync to cloud D1 ONLY IF previously deployed
    const fullRecord = vault.db.prepare('SELECT * FROM vault_accounts WHERE id = ?').get(id);
    if (fullRecord && fullRecord.email) {
      const isDeployed = fullRecord.status !== 'idle' && fullRecord.status !== 'mfa_pending' && fullRecord.status !== 'error' && fullRecord.status !== 'dead';
      if (isDeployed || fullRecord.ever_ready === 1) {
        console.log(`[Server] Syncing regenerated 2FA account ${fullRecord.email} to D1`);
        await SyncManager.pushVault('account', fullRecord).catch(() => {});
      }
      
      // Emit vault:update event to refresh UI
      if (emitSSE) {
        emitSSE('vault:update', { reason: 'regenerate-2fa-result', id, email: fullRecord.email });
      }
    }
    
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
