/**
 * Repair script: fix accounts that are status='ready' but gateway_status='revoked'
 * This happens when pullVault incorrectly set idle (now fixed in v0.2.64)
 * and the subsequent push set gateway_status='revoked' based on the wrong status.
 *
 * Usage: node scripts/repair-gateway-status.mjs
 */
import Database from 'better-sqlite3';
import { SyncManager } from '../server/services/syncManager.js';

const db = new Database('./data/vault.db');

// Find accounts that are ready but gateway_status is wrong
const broken = db.prepare(`
  SELECT * FROM vault_accounts 
  WHERE status = 'ready' 
    AND ever_ready = 1 
    AND deleted_at IS NULL 
    AND (gateway_status IS NULL OR gateway_status != 'active')
`).all();

console.log(`Found ${broken.length} accounts with status=ready but gateway_status != active`);

for (const account of broken) {
  console.log(`\n🔧 Fixing: ${account.email}`);
  console.log(`   status=${account.status}, gateway_status=${account.gateway_status}`);
  
  // Force push to D1 (this will set gateway_status='active' on success)
  try {
    await SyncManager.pushVault('account', account, true); // force=true bypasses cache
    console.log(`   ✅ Pushed to D1 and gateway_status should now be 'active'`);
  } catch (e) {
    console.log(`   ❌ Push failed: ${e.message}`);
  }
}

// Also fix almirachadava9731 — it has tokens but status=idle (was overwritten by pullVault bug)
const overwritten = db.prepare(`
  SELECT * FROM vault_accounts 
  WHERE status = 'idle' 
    AND ever_ready = 1 
    AND access_token IS NOT NULL 
    AND length(access_token) > 10
    AND deleted_at IS NULL
`).all();

console.log(`\n\nFound ${overwritten.length} accounts with status=idle but ever_ready=1 and has tokens (likely pullVault overwrite victims)`);

for (const account of overwritten) {
  console.log(`\n🔧 Restoring: ${account.email}`);
  console.log(`   status=${account.status} → ready, gateway_status=${account.gateway_status}`);
  
  // Restore to ready
  db.prepare(`UPDATE vault_accounts SET status='ready', gateway_status='pending_push', updated_at=datetime('now') WHERE id=?`).run(account.id);
  
  // Re-read and push
  const updated = db.prepare('SELECT * FROM vault_accounts WHERE id = ?').get(account.id);
  try {
    await SyncManager.pushVault('account', updated, true);
    console.log(`   ✅ Restored to ready and pushed to D1`);
  } catch (e) {
    console.log(`   ❌ Push failed: ${e.message}`);
  }
}

// Also fix deactivated/dead accounts that are active on Gateway (e.g. email_dead / need_phone / relogin)
const deactivatedActive = db.prepare(`
  SELECT * FROM vault_accounts 
  WHERE deleted_at IS NULL 
    AND gateway_status = 'active'
    AND (
      tags LIKE '%email_dead%' 
      OR tags LIKE '%account_deactivated%' 
      OR status = 'dead' 
      OR status = 'relogin' 
      OR status = 'need_phone'
    )
`).all();

console.log(`\n\nFound ${deactivatedActive.length} deactivated/dead accounts that are still 'active' on Gateway`);

for (const account of deactivatedActive) {
  console.log(`\n🔧 Revoking deactivated account from Gateway: ${account.email}`);
  console.log(`   status=${account.status}, gateway_status=${account.gateway_status}`);
  
  try {
    await SyncManager.pushVault('account', account, true);
    console.log(`   ✅ Successfully pushed tombstone/revoke to D1 for ${account.email}`);
  } catch (e) {
    console.log(`   ❌ Push failed: ${e.message}`);
  }
}

db.close();
console.log('\n✅ Repair complete');
