/**
 * BACKUP — Task endpoint (LOGIN flow) logic trước v0.2.74
 * 
 * File này lưu lại logic gốc của GET /api/vault/accounts/task
 * trước khi thêm double-check race condition guard.
 * 
 * Endpoint này phục vụ LOGIN flow (Gateway-originated PKCE):
 * - Tìm account pending/relogin
 * - Generate PKCE code challenge
 * - Lock account (set status=processing)
 * - Trả về task cho worker chạy runLoginFlow
 * 
 * Vấn đề đã fix ở v0.2.74:
 * - Race condition: task endpoint pick up account mà connect-result vừa set ready
 * - Vì allAccounts query có thể thấy state cũ (pending) do timing
 * - Task endpoint set processing → push D1 → ghi đè ready → UI hiển thị sai
 * 
 * Backup date: 2026-05-12
 */

// ═══════════════════════════════════════════════════════════════
// ORIGINAL LOGIC (trước v0.2.74 double-check fix)
// ═══════════════════════════════════════════════════════════════

/*
router.get('/accounts/task', async (req, res) => {
  try {
    const allAccounts = vault.db.prepare(
      `SELECT * FROM vault_accounts WHERE (provider='codex' OR provider='openai') ORDER BY updated_at DESC`
    ).all();

    const excludeIds = (req.query.exclude || '').split(',').filter(Boolean);

    // Filter: pending/relogin, not deleted, active, no connect_pending, has email, not excluded
    const task = allAccounts.find(a =>
      (a.status === 'pending' || a.status === 'relogin') &&
      !a.deleted_at &&
      a.is_active !== 0 &&
      Number(a.connect_pending || 0) === 0 &&
      a.email && a.email.trim() &&
      !excludeIds.includes(a.id)
    );

    if (!task) return res.json({ ok: true, task: null });

    // Parse JSON fields
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

    // Generate/reuse PKCE
    let pkce = pkceStore.get(task.id);
    if (!pkce || (Date.now() - pkce.createdAt > 10 * 60 * 1000)) {
      pkce = { ...generateCodexOAuthUrl(), createdAt: Date.now() };
      pkceStore.set(task.id, pkce);
      console.log(`[Task] 🔑 PKCE mới: ${task.email} | verifier: ${pkce.codeVerifier.substring(0, 8)}...`);
    } else {
      console.log(`[Task] ♻️  PKCE cũ: ${task.email} | verifier: ${pkce.codeVerifier.substring(0, 8)}...`);
    }

    // Lock task → processing
    vault.db.prepare(
      `UPDATE vault_accounts SET status='processing', updated_at=datetime('now') WHERE id=?`
    ).run(task.id);

    // Push processing status to D1
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
*/

// ═══════════════════════════════════════════════════════════════
// WORKER-SIDE: runLoginFlow trong auto-worker.js
// ═══════════════════════════════════════════════════════════════
// runLoginFlow nhận task từ endpoint trên và:
// 1. Mở browser tab với loginUrl (Codex OAuth authorize URL)
// 2. Điền email/password/MFA
// 3. Chờ redirect đến localhost:1455?code=...
// 4. Gửi code + codeVerifier về /accounts/result
//
// Khác với CONNECT flow (runConnectFlow):
// - CONNECT: login chatgpt.com trực tiếp → tự generate PKCE → exchange token ngay
// - LOGIN: dùng PKCE từ server → chỉ lấy code → server exchange token
//
// LOGIN flow được trigger bởi:
// - Gateway gửi task (source=gateway)
// - D1 có account status=pending/relogin (source=d1)
// - Local vault có account pending/relogin (source=tools)
