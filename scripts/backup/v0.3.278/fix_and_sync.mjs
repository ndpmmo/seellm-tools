#!/usr/bin/env node
/**
 * fix_and_sync.mjs
 * Dọn rác DB, reset accounts bị kẹt, đồng bộ toàn bộ lên D1
 */

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH   = path.join(__dirname, '../data/vault.db');
const db        = new Database(DB_PATH);

// Load config
const { loadConfig } = await import('../server/db/config.js');
const cfg = loadConfig();

console.log('\n🔧 SeeLLM Tools — Fix & Sync Script');
console.log('=====================================');
console.log('D1 URL:', cfg.d1WorkerUrl || '❌ NOT SET');
console.log('D1 Secret:', cfg.d1SyncSecret ? '✅ SET' : '❌ NOT SET');

// ─── STEP 1: Show current DB state ───────────────────────────────────────────
console.log('\n📊 Trạng thái DB hiện tại:');
const allAccounts = db.prepare('SELECT id, email, status, provider, deleted_at, refresh_token FROM vault_accounts').all();
allAccounts.forEach(a => {
  const flags = [];
  if (!a.email || a.email.trim() === '') flags.push('NO_EMAIL');
  if (a.deleted_at) flags.push('DELETED');
  if (a.status === 'processing') flags.push('⚠️ STUCK_PROCESSING');
  if (a.refresh_token) flags.push('HAS_TOKEN');
  console.log(`  ${a.id.substring(0,8)}... | ${a.email || '(empty)'} | ${a.status} | ${a.provider} ${flags.join(' ')}`);
});

// ─── STEP 2: Clean ghost records (no email) ──────────────────────────────────
console.log('\n🗑️  Xóa records rác (không có email):');
const ghostResult = db.prepare(`
  UPDATE vault_accounts 
  SET deleted_at = datetime('now'), updated_at = datetime('now')
  WHERE (email IS NULL OR email = '') AND deleted_at IS NULL
`).run();
console.log(`  → Đã soft-delete ${ghostResult.changes} records rác`);

// ─── STEP 3: Reset stuck "processing" accounts ───────────────────────────────
console.log('\n🔄 Reset accounts bị kẹt ở trạng thái "processing":');
const stuckResult = db.prepare(`
  UPDATE vault_accounts
  SET status = 'pending', updated_at = datetime('now')
  WHERE status = 'processing' AND deleted_at IS NULL
`).run();
console.log(`  → Đã reset ${stuckResult.changes} accounts từ processing → pending`);

// ─── STEP 4: Sync valid accounts to D1 ───────────────────────────────────────
if (!cfg.d1WorkerUrl || !cfg.d1SyncSecret) {
  console.log('\n⚠️  D1 chưa được cấu hình. Bỏ qua bước sync.');
  process.exit(0);
}

const validAccounts = db.prepare(`
  SELECT * FROM vault_accounts 
  WHERE email IS NOT NULL AND email != '' AND deleted_at IS NULL
`).all();

console.log(`\n☁️  Đồng bộ ${validAccounts.length} account hợp lệ lên D1...`);

const now = new Date().toISOString();
const version = Date.now();

for (const a of validAccounts) {
  const payload = {
    managedAccounts: [{
      id:           a.id,
      email:        a.email,
      password:     a.password,
      two_fa_secret: a.two_fa_secret,
      proxy_url:    a.proxy_url,
      proxy_id:     null,
      status:       a.status,
      last_error:   a.notes || null,
      last_sync_at: now,
      updated_at:   now,
      deleted_at:   a.deleted_at || null,
      version,
    }],
    vaultAccounts: [{
      id:            a.id,
      provider:      a.provider || 'codex',
      label:         a.label || null,
      email:         a.email,
      password:      a.password,
      two_fa_secret: a.two_fa_secret,
      access_token:  a.access_token,
      refresh_token: a.refresh_token,
      status:        a.status,
      proxy_url:     a.proxy_url,
      notes:         a.notes || null,
      tags:          a.tags || '[]',
      metadata:      null,
      updated_at:    now,
    }],
  };

  // Nếu có refresh_token → cũng sync lên connections để Gateway thấy
  if (a.refresh_token) {
    let providerData = null;
    try {
      providerData = typeof a.provider_specific_data === 'string'
        ? JSON.parse(a.provider_specific_data)
        : (a.provider_specific_data || null);
    } catch {}
    const workspaceId = a.workspace_id || providerData?.workspaceId || null;
    payload.connections = [{
      id:                   a.id,
      email:                a.email,
      name:                 a.email.split('@')[0],
      access_token:         a.access_token,
      refresh_token:        a.refresh_token,
      proxy_url:            a.proxy_url,
      workspace_id:         workspaceId,
      is_active:            (a.status === 'ready' || a.status === 'success') ? 1 : 0,
      rate_limit_protection: 0,
      provider_specific_data: providerData,
      updated_at:           now,
      deleted_at:           null,
      version,
    }];
  }

  try {
    const res = await fetch(`${cfg.d1WorkerUrl}/sync/push`, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'x-sync-secret': cfg.d1SyncSecret,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    });

    const result = await res.json();
    if (res.ok) {
      const c = result.counts || {};
      const hasToken = a.refresh_token ? '🔑' : '';
      console.log(`  ✅ ${a.email} ${hasToken} → conn=${c.connections||0}, managed=${c.managedAccounts||0}, vault=${c.vaultAccounts||0}`);
    } else {
      console.error(`  ❌ ${a.email} → D1 error: ${JSON.stringify(result)}`);
    }
  } catch (e) {
    console.error(`  ❌ ${a.email} → Network error: ${e.message}`);
  }
}

// ─── STEP 5: Verify D1 state ─────────────────────────────────────────────────
console.log('\n🔍 Kiểm tra D1 sau sync:');
try {
  const summaryRes = await fetch(`${cfg.d1WorkerUrl}/inspect/summary`, {
    headers: { 'x-sync-secret': cfg.d1SyncSecret },
    signal: AbortSignal.timeout(8000),
  });
  const summary = await summaryRes.json();
  if (summary.ok) {
    console.log(`  connections:      ${summary.counts.connections}`);
    console.log(`  managedAccounts:  ${summary.counts.managedAccounts}`);
    console.log(`  proxies:          ${summary.counts.proxies}`);
  }
} catch (e) {
  console.log('  ⚠️  Không thể kiểm tra D1:', e.message);
}

console.log('\n✨ Hoàn tất! Reload trang SeeLLM Tools để thấy kết quả.\n');
