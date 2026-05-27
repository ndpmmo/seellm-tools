/**
 * Reset all active accounts to 'idle' status and push the revocation/tombstone to D1.
 *
 * Usage: node scripts/reset-all-accounts-idle.mjs
 */
import Database from 'better-sqlite3';
import { SyncManager } from '../server/services/syncManager.js';

const db = new Database('./data/vault.db');

// Find all active accounts that are not already idle
const accounts = db.prepare(`
  SELECT * FROM vault_accounts 
  WHERE deleted_at IS NULL 
    AND (status != 'idle' OR gateway_status = 'active' OR gateway_status IS NULL)
`).all();

console.log(`Found ${accounts.length} active accounts to reset to 'idle'`);

for (const account of accounts) {
  console.log(`\n🔧 Resetting: ${account.email}`);
  console.log(`   Current: status=${account.status}, gateway_status=${account.gateway_status}`);

  // 1. Reset in local SQLite database
  db.prepare(`
    UPDATE vault_accounts 
    SET status = 'idle', 
        gateway_status = 'pending_push', 
        updated_at = datetime('now') 
    WHERE id = ?
  `).run(account.id);

  // 2. Fetch updated record
  const updated = db.prepare('SELECT * FROM vault_accounts WHERE id = ?').get(account.id);

  // 3. Force push the 'idle' status to D1 (SyncManager will push tombstone/deleted_at for idle accounts)
  try {
    const result = await SyncManager.pushVault('account', updated, true); // force=true bypasses cache
    if (result && result.ok) {
      console.log(`   ✅ Successfully reset to idle and pushed tombstone to D1`);
    } else {
      console.log(`   ⚠️ Push completed but returned:`, JSON.stringify(result));
    }
  } catch (e) {
    console.log(`   ❌ Push failed: ${e.message}`);
  }
}

db.close();
console.log('\n✅ Reset completed!');
