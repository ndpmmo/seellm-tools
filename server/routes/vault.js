import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { vault } from '../db/vault.js';
import { SyncManager } from '../services/syncManager.js';
import { loadConfig } from '../db/config.js';
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
router.use(express.json()); // Bắt buộc: parse JSON body cho mọi route trong router này

// Throttle cho connect-task debug log (tránh spam mỗi 10s)
let connectTaskLogThrottle = false;

// SSE emitter - set from server.js (replaces Socket.IO for realtime events)
let emitSSE = null;
export function setSSEEmitter(emitter) {
  emitSSE = emitter;
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
  if (!cfg.gatewayUrl || !cfg.d1SyncSecret) return;
  // Skip nếu gatewayUrl trỏ đến D1 Worker (không có route /api/sync/trigger)
  if (cfg.gatewayUrl.includes('workers.dev') || cfg.gatewayUrl.includes('gateway-db.seellm.xyz')) {
    return; // D1 Worker không có Next.js route
  }
  try {
    const res = await fetch(`${cfg.gatewayUrl.replace(/\/+$/, '')}/api/sync/trigger`, {
      method: 'POST',
      headers: { 'x-sync-secret': cfg.d1SyncSecret, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      console.log(`[GatewayTrigger] ✅ Gateway pulled snapshot (reason=${reason})`);
    } else if (res.status !== 404) {
      console.log(`[GatewayTrigger] ⚠️ Gateway trigger HTTP ${res.status} (reason=${reason})`);
    }
    // 404 = Gateway không có Next.js route, silently skip
  } catch (e) {
    // Best-effort — Gateway có thể down hoặc không config
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
  const tags = account.tags || [];
  if (!tags.includes('need_phone')) {
    tags.push('need_phone');
    vault.upsertAccount({ id, tags });
  }
}

function removeNeedPhoneTag(id) {
  const account = vault.getAccountFull(id);
  if (!account) return;
  const tags = (account.tags || []).filter((t) => t !== 'need_phone');
  vault.upsertAccount({ id, tags });
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

// DELETE /api/vault/accounts/:id
router.delete('/accounts/:id', async (req, res) => {
  try {
    const account = vault.getAccount(req.params.id);
    vault.deleteAccount(req.params.id); // triggers SyncManager internally
    res.json({ ok: true });

    // Audit log
    logAudit({
      action: 'delete',
      entity: 'account',
      entityId: req.params.id,
      entityLabel: account?.email || account?.label || req.params.id,
      details: { provider: account?.provider, hadProxy: !!account?.proxy_url },
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
          '--proxy-connect-timeout', '5',
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
    let targets;
    
    if (Array.isArray(req.body.emails) && req.body.emails.length > 0) {
      // Verify specific emails
      targets = pool.filter(e => req.body.emails.includes(e.email));
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
            vault.upsertEmailPool({
              email,
              mail_status: 'dead',
              last_checked_at: new Date().toISOString(),
              notes: 'Lỗi: Thiếu Refresh Token hoặc Client ID',
            });
            if (emitSSE) emitSSE('email-pool-updated', { email });
            propagateEmailDeadTag(email);
            return result;
          }

          try {
            const token = await getAccessToken(refreshToken, clientId);
            await fetchMails(token, { top: 1 });

            const result = { email, status: 'active', error: null };
            vault.upsertEmailPool({
              email,
              mail_status: 'active',
              last_checked_at: new Date().toISOString(),
              notes: `Mail OK (${new Date().toLocaleTimeString()})`,
            });
            if (emitSSE) emitSSE('email-pool-updated', { email });
            removeEmailDeadTag(email);
            return result;
          } catch (err) {
            const result = { email, status: 'dead', error: err.message };
            vault.upsertEmailPool({
              email,
              mail_status: 'dead',
              last_checked_at: new Date().toISOString(),
              notes: `Lỗi: ${err.message}`,
            });
            if (emitSSE) emitSSE('email-pool-updated', { email });
            propagateEmailDeadTag(email);
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
    vault.db.prepare(
      `UPDATE vault_accounts SET status='processing', updated_at=datetime('now') WHERE id=?`
    ).run(task.id);

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
          workspaceId: accessMeta?.accountId || tokenMeta?.workspaceId || null,
          workspacePlanType: accessMeta?.planType || tokenMeta?.workspacePlanType || null,
          chatgptUserId: tokenMeta?.chatgptUserId || null,
          organizations: tokenMeta?.organizations || null,
          machineId,
          deviceId: buildStableDeviceId(existingProviderData, targetId),
          proxyUrl: localAccount?.proxy_url || null,
        });

        vault.upsertAccount({
          id: targetId,
          status: 'ready',
          notes: '',
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          email: targetEmail || undefined,
          plan: accessMeta?.planType || tokenMeta?.workspacePlanType || null,
          workspace_id: accessMeta?.accountId || tokenMeta?.workspaceId || null,
          device_id: providerSpecificData?.deviceId || null,
          machine_id: providerSpecificData?.machineId || machineId,
          provider_specific_data: providerSpecificData,
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
      } catch (exchangeErr) {
        console.error(`[Result] ❌ Exchange failed: ${exchangeErr.message}`);
        try {
          const logPath = path.resolve('data', 'critical_errors.log');
          fs.appendFileSync(logPath, `[${new Date().toISOString()}] exchange_failed id=${id}: ${exchangeErr.message}\n`);
        } catch (_) { }
        maybeAddNeedPhoneTag(id, exchangeErr.message);
        vault.upsertAccount({ id, status: 'error', notes: `Exchange failed: ${exchangeErr.message}` });
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
      }

    } else if (status === 'success') {
      // ─── Path 2: Direct tokens (cookie-based / no-code) ──────────────────
      vault.upsertAccount({
        id,
        status: 'ready',
        notes: message || '',
        access_token: result?.access_token,
        refresh_token: result?.refresh_token,
        cookies: result?.cookies,
        machine_id: getConsistentMachineId(),
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

    } else {
      // ─── Path 3: Error / other status ────────────────────────────────────
      const errorMsg = message || `Worker reported status: ${status}`;
      console.log(`[Result] ⚠️ Account ${id}: ${errorMsg}`);
      maybeAddNeedPhoneTag(id, errorMsg);
      vault.upsertAccount({ id, status: status || 'error', notes: errorMsg });

      logAudit({
        action: 'connect',
        entity: 'account',
        entityId: id,
        entityLabel: id,
        details: { status: status || 'error', error: errorMsg },
        severity: 'error',
        source: 'worker',
      });
      // Reset về pending sau một khoảng thời gian nếu là lỗi tạm thời
    }

    res.json({ ok: true });
  } catch (e) {
    console.error('[Result] 💥 Unhandled error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ══════════════════════════════════════════════════════════════════════════ */
/*  UTILITY ENDPOINTS                                                         */
/* ══════════════════════════════════════════════════════════════════════════ */

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
    vault.updateAccountStatus(req.params.id, 'idle');
    const updated = vault.db.prepare('SELECT * FROM vault_accounts WHERE id = ?').get(req.params.id);
    if (updated) {
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
    const result = await SyncManager.pushVault('account', account);
    
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
        vault.db.prepare(
          `UPDATE vault_accounts SET connect_pending=1, updated_at=datetime('now') WHERE id=?`
        ).run(stuck.id);
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
    vault.db.prepare(
      `UPDATE vault_accounts SET connect_pending=2, updated_at=datetime('now') WHERE id=?`
    ).run(task.id);

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
        workspaceId: tokens.accountId || tokens.organizationId || null, // 🔥 Fix: Dùng accountId (chatgpt_account_id) thay vì orgId
        workspacePlanType: tokens.planType || 'free',
        chatgptUserId: tokens.userId || null,
        organizations: null,
        machineId,
        deviceId: tokens.deviceId || buildStableDeviceId(existingProviderData, id), // 🔥 Fix: Ưu tiên deviceId từ worker
        proxyUrl: localAccount?.proxy_url || null,
      });

      const hasRefreshToken = !!(tokens.refresh_token || tokens.refreshToken);
      const isFallbackOnly = !hasRefreshToken; // session fallback — chỉ có access_token

      // skipSync=true: tránh double-push từ upsertAccount internal — chỉ push 1 lần explicit bên dưới
      vault.upsertAccount({
        id,
        status: 'ready',
        ever_ready: 1,
        notes: '',
        access_token: tokens.access_token || tokens.accessToken,
        refresh_token: tokens.refresh_token || tokens.refreshToken || '',
        email: tokens.email || localAccount?.email || '',
        plan: tokens.planType || null,
        workspace_id: tokens.accountId || tokens.organizationId || null,
        device_id: providerSpecificData?.deviceId || null,
        machine_id: machineId,
        provider_specific_data: providerSpecificData,
        connect_pending: 0,
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
      maybeAddNeedPhoneTag(id, errorMsg);

      // NEED_PHONE: set idle + tag — account chỉ hiển thị ở Vault local, không push Services
      // Other errors: set error + push D1
      const targetStatus = isNeedPhone ? 'idle' : 'error';
      vault.db.prepare(
        `UPDATE vault_accounts SET status=?, notes=?, connect_pending=0, updated_at=datetime('now') WHERE id=?`
      ).run(targetStatus, errorMsg, id);

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

    vault.db.prepare(
      `UPDATE vault_accounts SET connect_pending=1, status='pending', is_active=1, notes='', updated_at=datetime('now') WHERE id=?`
    ).run(req.params.id);

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
  try {
    const results = { accounts: 0, emailPool: 0, proxies: 0, keys: 0 };

    // 1. Sync Accounts
    const accounts = vault.getAccountsFull();
    for (const a of accounts) {
      await SyncManager.pushVault('account', a);
      results.accounts++;
    }

    // 2. Sync Email Pool
    const pool = vault.getEmailPoolFull();
    for (const e of pool) {
      await SyncManager.pushVault('email_pool', e);
      results.emailPool++;
    }

    // 3. Sync Proxies (including soft-deleted ones to ensure D1 is updated)
    const proxies = vault.db.prepare('SELECT * FROM vault_proxies').all();
    for (const p of proxies) {
      await SyncManager.pushVault('proxy', p);
      results.proxies++;
    }

    // 4. Sync API Keys (including soft-deleted ones)
    const keys = vault.db.prepare('SELECT * FROM vault_api_keys').all();
    for (const k of keys) {
      await SyncManager.pushVault('key', k);
      results.keys++;
    }

    console.log(`[Bulk Sync All] Pushed: Accounts=${results.accounts}, Pool=${results.emailPool}, Proxies=${results.proxies}, Keys=${results.keys}`);
    res.json({ ok: true, results });

    logAudit({
      action: 'sync',
      entity: 'account',
      entityLabel: 'Bulk Sync All',
      details: results,
      severity: 'info',
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
const _GRAPH_ME = 'https://graph.microsoft.com/v1.0/me';
const _inboxTokenCache = new Map(); // email → { token, expiresAt }

async function _getGraphToken(pool) {
  const c = _inboxTokenCache.get(pool.email);
  if (c && c.expiresAt > Date.now() + 60_000) return c.token;
  const params = new URLSearchParams({
    client_id: pool.client_id,
    grant_type: 'refresh_token',
    refresh_token: pool.refresh_token,
  });
  const r = await fetch(_GRAPH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error_description || `Token error ${r.status}`);
  _inboxTokenCache.set(pool.email, {
    token: d.access_token,
    expiresAt: Date.now() + ((d.expires_in || 3600) - 120) * 1000,
  });
  return d.access_token;
}

// GET /api/vault/inbox/:email — list inbox messages
router.get('/inbox/:email', async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email);
    const pool = vault.getEmailPoolFull().find(e => e.email === email);
    if (!pool) return res.status(404).json({ error: 'Email not in pool' });
    if (!pool.refresh_token || !pool.client_id)
      return res.status(400).json({ error: 'Missing MS Graph credentials (refresh_token / client_id)' });
    const token = await _getGraphToken(pool);
    const top = Math.min(parseInt(req.query.top) || 50, 100);
    const url = `${_GRAPH_ME}/messages?$top=${top}&$orderby=receivedDateTime desc` +
      `&$select=id,subject,bodyPreview,from,toRecipients,receivedDateTime,isRead`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error?.message || `Graph error ${r.status}`);
    res.json({ ok: true, messages: d.value || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/vault/inbox/message — get full message body
router.post('/inbox/message', async (req, res) => {
  try {
    const { email, messageId } = req.body;
    if (!email || !messageId) return res.status(400).json({ error: 'Missing email or messageId' });
    const pool = vault.getEmailPoolFull().find(e => e.email === email);
    if (!pool) return res.status(404).json({ error: 'Email not in pool' });
    const token = await _getGraphToken(pool);
    const url = `${_GRAPH_ME}/messages/${messageId}` +
      `?$select=id,subject,body,bodyPreview,from,toRecipients,receivedDateTime,isRead`;
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Prefer: 'outlook.body-content-type="html"' },
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error?.message || `Graph error ${r.status}`);
    res.json({ ok: true, message: d });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/vault/inbox/mark-read — mark a message as read
router.post('/inbox/mark-read', async (req, res) => {
  try {
    const { email, messageId } = req.body;
    if (!email || !messageId) return res.status(400).json({ error: 'Missing email or messageId' });
    const pool = vault.getEmailPoolFull().find(e => e.email === email);
    if (!pool) return res.status(404).json({ error: 'Email not in pool' });
    const token = await _getGraphToken(pool);
    await fetch(`${_GRAPH_ME}/messages/${messageId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ isRead: true }),
    });
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
    const token = await _getGraphToken(pool);
    const r = await fetch(`${_GRAPH_ME}/messages/${messageId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok && r.status !== 204) {
      const d = await r.json().catch(() => ({}));
      throw new Error(d.error?.message || `Delete failed: ${r.status}`);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
