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
async function exchangeCodeForTokens(code, codeVerifier, options = {}) {
  const { userAgent, proxyUrl } = options;
  const targetUrl = 'https://auth.openai.com/oauth/token';
  const postData  = new URLSearchParams({
    grant_type:    'authorization_code',
    client_id:     'app_EMoamEEZ73f0CkXaXp7hrann',
    code,
    redirect_uri:  'http://localhost:1455/auth/callback',
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
    method:  'POST',
    headers: { 
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent':    ua,
      'Origin':        'https://auth.openai.com',
      'Referer':       'https://auth.openai.com/',
      'Accept':        'application/json, text/plain, */*',
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

/**
 * Decode base64 URL safe string
 */
function base64Decode(str) {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) base64 += '=';
  return Buffer.from(base64, 'base64').toString('utf8');
}

/**
 * Parse id_token JWT to extract plan info
 */
function parseIdToken(idToken) {
  try {
    const parts = idToken.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(base64Decode(parts[1]));
    const authInfo = payload["https://api.openai.com/auth"];
    
    let plan = (authInfo?.chatgpt_plan_type || "").toLowerCase();
    
    // Check organizations for Team/Business
    const organizations = authInfo?.organizations || [];
    if (organizations.length > 0) {
      const teamOrg = organizations.find(org => 
        !org.is_default && (org.role === 'admin' || org.role === 'member')
      );
      if (teamOrg && (plan === 'free' || plan === '')) {
        plan = 'team';
      }
    }
    
    return plan || 'free';
  } catch (e) {
    console.error('[OAuth] ⚠️ Failed to parse id_token:', e.message);
    return null;
  }
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
    // CHỈ dùng local vault — D1 fallback bị loại bỏ để tránh tạo account không có data
    const allAccounts = vault.db.prepare(
      `SELECT * FROM vault_accounts WHERE provider='codex' ORDER BY updated_at DESC`
    ).all();

    // Danh sách ID đang được xử lý bởi các thread khác (worker gửi qua query string)
    const excludeIds = (req.query.exclude || '').split(',').filter(Boolean);

    // Tìm account pending/relogin chưa bị xóa, đang active, có email, và KHÔNG trong danh sách exclude
    const task = allAccounts.find(a =>
      (a.status === 'pending' || a.status === 'relogin') &&
      !a.deleted_at &&
      a.is_active !== 0 &&
      a.email && a.email.trim() &&
      !excludeIds.includes(a.id) // 🔑 Đây là điều kiện then chốt cho đa luồng
    );

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

    task.tags    = safeParse(task.tags);
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
      SyncManager.pushVault('account', lockedTask).catch(() => {});
    }

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

        const planType = tokens.id_token ? parseIdToken(tokens.id_token) : null;

        vault.upsertAccount({
          id:            targetId,
          status:        'ready',
          notes:         '',
          access_token:  tokens.access_token,
          refresh_token: tokens.refresh_token,
          email:         targetEmail || undefined,
          plan:          planType,
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
          fetch(`${cfg.gatewayUrl}/api/usage/${fullRecord.id}`).catch(() => {});
        }

        console.log(`[Result] ✅ Account ${targetEmail} ready with tokens`);
      } catch (exchangeErr) {
        console.error(`[Result] ❌ Exchange failed: ${exchangeErr.message}`);
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
      if (fullRecord) {
        await SyncManager.pushVault('account', fullRecord);
        const cfg = loadConfig();
        if (cfg.gatewayUrl) {
          fetch(`${cfg.gatewayUrl}/api/usage/${fullRecord.id}`).catch(() => {});
        }
      }

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

// Retry / Deploy to Codex: Reset account về pending và tạo PKCE mới để Worker login
router.post('/accounts/:id/retry', async (req, res) => {
  try {
    const account = vault.getAccountFull(req.params.id);
    if (!account) return res.status(404).json({ error: 'Not found' });
    pkceStore.delete(req.params.id); // Xóa PKCE cũ để generate lại
    // Gọi upsertAccount thay vì updateAccountStatus để PKCE được sinh ra trong quá trình upsert
    vault.upsertAccount({ ...account, status: 'pending' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Stop: Thu hồi account về idle
router.post('/accounts/:id/stop', async (req, res) => {
  try {
    const account = vault.getAccountFull(req.params.id);
    if (!account) return res.status(404).json({ error: 'Not found' });
    pkceStore.delete(req.params.id);
    vault.updateAccountStatus(req.params.id, 'idle');
    res.json({ ok: true });
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
    pkceStore.delete(id);
    console.log(`[Webhook] 🔄 Gateway xóa account ${existing.email} → Thu hồi về Vault (idle)`);
    res.json({ ok: true, reverted: id, newStatus: 'idle' });
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
