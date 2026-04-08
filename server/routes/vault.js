import express from 'express';
import crypto  from 'node:crypto';
import path    from 'node:path';
import fs      from 'node:fs';
import { vault }       from '../db/vault.js';
import { SyncManager } from '../services/syncManager.js';
import { loadConfig }  from '../db/config.js';

const router = express.Router();
router.use(express.json()); // Bắt buộc: parse JSON body cho mọi route trong router này

/* ─── PKCE Generator ─────────────────────────────────────────────────────── */
function generateCodexOAuthUrl() {
  const codeVerifier  = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  const state         = crypto.randomBytes(32).toString('base64url');
  const params = new URLSearchParams({
    response_type:            'code',
    client_id:                'app_EMoamEEZ73f0CkXaXp7hrann',
    redirect_uri:             'http://localhost:1455/auth/callback',
    scope:                    'openid profile email offline_access',
    code_challenge:           codeChallenge,
    code_challenge_method:    'S256',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow:  'true',
    originator:               'codex_cli_rs',
    state,
  });
  return {
    url: `https://auth.openai.com/oauth/authorize?${params}`,
    codeVerifier,
    state,
  };
}

/* ─── Token Exchange ─────────────────────────────────────────────────────── */
async function exchangeCodeForTokens(code, codeVerifier) {
  console.log(`[OAuth] 🔄 Exchanging code: ${code.substring(0, 10)}... verifier: ${codeVerifier.substring(0, 10)}...`);
  const res = await fetch('https://auth.openai.com/oauth/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'authorization_code',
      client_id:     'app_EMoamEEZ73f0CkXaXp7hrann',
      code,
      redirect_uri:  'http://localhost:1455/auth/callback',
      code_verifier: codeVerifier,
    }).toString(),
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
    const isNew   = !req.body.id;
    const record  = vault.upsertAccount(req.body); // triggers SyncManager internally (skipSync=false)
    res.json({ ok: true, id: record.id });

    // New Codex account → push lên D1 managed để Worker auto-login
    if (isNew && record.provider === 'codex') {
      console.log(`[Vault] 🚀 New Codex account → Sync to D1: ${record.email}`);
      // SyncManager đã được gọi bởi upsertAccount, không cần gọi lại
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/vault/accounts/:id
router.delete('/accounts/:id', async (req, res) => {
  try {
    vault.deleteAccount(req.params.id); // triggers SyncManager internally
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ══════════════════════════════════════════════════════════════════════════ */
/*  PROXIES CRUD                                                              */
/* ══════════════════════════════════════════════════════════════════════════ */

router.get('/proxies', (req, res) => {
  try { res.json({ ok: true, items: vault.getProxies() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/proxies', async (req, res) => {
  try {
    const record = vault.upsertProxy(req.body);
    res.json({ ok: true, id: record.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/proxies/:id', async (req, res) => {
  try { vault.deleteProxy(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
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
    const record = vault.upsertApiKey(req.body);
    res.json({ ok: true, id: record.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/api-keys/:id', async (req, res) => {
  try { vault.deleteApiKey(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

/* ══════════════════════════════════════════════════════════════════════════ */
/*  TASK ENDPOINT  (Worker poll)                                              */
/*  Worker gọi GET /api/vault/accounts/task mỗi 15 giây để lấy task         */
/* ══════════════════════════════════════════════════════════════════════════ */

router.get('/accounts/task', async (req, res) => {
  try {
    const cfg = loadConfig();

    // 1. Tìm trong local vault trước
    const allAccounts = vault.getAccountsFull();
    let task = allAccounts.find(a =>
      a.provider === 'codex' &&
      (a.status === 'pending' || a.status === 'relogin') &&
      !a.deleted_at
    );

    // 2. Nếu local không có → check D1
    if (!task && cfg.d1WorkerUrl && cfg.d1SyncSecret) {
      try {
        const d1Res = await fetch(`${cfg.d1WorkerUrl}/inspect/accounts?limit=200`, {
          headers: { 'x-sync-secret': cfg.d1SyncSecret },
          signal: AbortSignal.timeout(3000),
        });
        if (d1Res.ok) {
          const d1Data = await d1Res.json();
          const candidate = (d1Data.items || []).find(a => {
            if (a.deleted_at) return false;
            if (a.status !== 'pending' && a.status !== 'relogin') return false;
            const local = vault.getAccountFull(a.id);
            if (local && (local.status === 'processing' || local.status === 'ready')) return false;
            return true;
          });
          if (candidate) {
            const local = vault.getAccountFull(candidate.id);
            task = local ? { ...candidate, ...local } : candidate;
          }
        }
      } catch (e) {
        console.log(`[Task] D1 check failed: ${e.message}`);
      }
    }

    if (!task) return res.json({ ok: true, task: null });

    // 3. Lấy/tạo PKCE (chỉ generate 1 lần per account, dùng lại nếu poll lại)
    let pkce = pkceStore.get(task.id);
    if (!pkce || (Date.now() - pkce.createdAt > 10 * 60 * 1000)) {
      pkce = { ...generateCodexOAuthUrl(), createdAt: Date.now() };
      pkceStore.set(task.id, pkce);
      console.log(`[Task] 🔑 PKCE mới: ${task.email} | verifier: ${pkce.codeVerifier.substring(0, 8)}...`);
    } else {
      console.log(`[Task] ♻️  PKCE cũ: ${task.email} | verifier: ${pkce.codeVerifier.substring(0, 8)}...`);
    }

    // 4. Lock task
    vault.db.prepare(`UPDATE vault_accounts SET status='processing', updated_at=datetime('now') WHERE id=?`).run(task.id);

    return res.json({ ok: true, task: {
      id:           task.id,
      email:        task.email,
      password:     task.password,
      twoFaSecret:  task.two_fa_secret,
      proxyUrl:     task.proxy_url,
      loginUrl:     pkce.url,
      codeVerifier: pkce.codeVerifier,
      action:       'LOGIN',
    }});
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

    if (status === 'success' && result?.code && result?.codeVerifier) {
      // ─── Path 1: Code + Verifier → Exchange token ─────────────────────────
      console.log(`[Result] 🔄 Exchanging code for account ${id}...`);

      // Lấy PKCE từ in-memory store (ưu tiên) hoặc dùng verifier từ result
      const storedPkce = pkceStore.get(id);
      const verifierToUse = (storedPkce && result.codeVerifier === storedPkce.codeVerifier)
        ? storedPkce.codeVerifier
        : result.codeVerifier;

      try {
        const tokens = await exchangeCodeForTokens(result.code, verifierToUse);

        vault.upsertAccount({
          id,
          status:        'ready',
          notes:         '',
          access_token:  tokens.access_token,
          refresh_token: tokens.refresh_token,
          email:         tokens.email || undefined,
        });

        // Xóa PKCE khỏi store sau khi xử lý xong
        pkceStore.delete(id);

        // Đồng bộ lên D1 NGAY LẬP TỨC
        const fullRecord = vault.getAccountFull(id);
        if (fullRecord) {
          console.log(`[Result] 🚀 Syncing to D1: ${fullRecord.email}`);
          await SyncManager.pushVault('account', fullRecord);
        }

        console.log(`[Result] ✅ Account ${id} ready with tokens`);
      } catch (exchangeErr) {
        console.error(`[Result] ❌ Exchange failed: ${exchangeErr.message}`);
        // Ghi critical error log
        try {
          const logPath = path.resolve('data', 'critical_errors.log');
          fs.appendFileSync(logPath, `[${new Date().toISOString()}] exchange_failed id=${id}: ${exchangeErr.message}\n`);
        } catch (_) {}
        vault.upsertAccount({ id, status: 'error', notes: `Exchange failed: ${exchangeErr.message}` });
        pkceStore.delete(id);
      }

    } else if (status === 'success') {
      // ─── Path 2: Direct tokens (cookie-based / no-code) ──────────────────
      vault.upsertAccount({
        id,
        status:        'ready',
        notes:         message || '',
        access_token:  result?.access_token,
        refresh_token: result?.refresh_token,
        cookies:       result?.cookies,
      });
      pkceStore.delete(id);

      const fullRecord = vault.getAccountFull(id);
      if (fullRecord) await SyncManager.pushVault('account', fullRecord);

    } else {
      // ─── Path 3: Error / other status ────────────────────────────────────
      const errorMsg = message || `Worker reported status: ${status}`;
      console.log(`[Result] ⚠️ Account ${id}: ${errorMsg}`);
      vault.upsertAccount({ id, status: status || 'error', notes: errorMsg });
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

// Legacy: Worker cũ dùng /accounts/pending
router.get('/accounts/pending', (req, res) => {
  try {
    const task = vault.getPendingTask();
    if (task) {
      vault.updateAccountStatus(task.id, 'processing');
      res.json({ ok: true, task });
    } else {
      res.json({ ok: true, task: null });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Retry: Reset account về pending
router.post('/accounts/:id/retry', async (req, res) => {
  try {
    const account = vault.getAccountFull(req.params.id);
    if (!account) return res.status(404).json({ error: 'Not found' });
    pkceStore.delete(req.params.id); // Xóa PKCE cũ để generate lại
    vault.updateAccountStatus(req.params.id, 'pending');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Manual sync: Ép đồng bộ 1 account lên D1
router.post('/accounts/:id/sync', async (req, res) => {
  try {
    const account = vault.getAccountFull(req.params.id);
    if (!account) return res.status(404).json({ error: 'Account not found' });
    console.log(`[Manual Sync] Pushing ${account.email} to D1...`);
    const result = await SyncManager.pushVault('account', account);
    res.json({ ok: true, message: 'Synced to D1', result });
  } catch (e) {
    console.error(`[Manual Sync] Failed:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// Sync toàn bộ
router.post('/sync', async (req, res) => {
  try {
    const accounts = vault.getAccountsFull();
    let pushed = 0;
    for (const a of accounts) {
      await SyncManager.pushVault('account', a);
      pushed++;
    }
    console.log(`[Bulk Sync] Pushed ${pushed} accounts to D1`);
    res.json({ ok: true, pushed });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
