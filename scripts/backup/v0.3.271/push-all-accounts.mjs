/**
 * Push all accounts: force sync all local accounts to D1
 * Usage: node scripts/push-all-accounts.mjs
 */
import Database from 'better-sqlite3';
import { SyncManager } from '../server/services/syncManager.js';

const db = new Database('./data/vault.db');

// Select all accounts that are not deleted
const accounts = db.prepare(`
  SELECT * FROM vault_accounts 
  WHERE deleted_at IS NULL
`).all();

console.log(`Found ${accounts.length} local accounts to synchronize.`);

let successCount = 0;
let failCount = 0;

for (const account of accounts) {
  // Normalize tags and other JSON fields so pushVault accepts them correctly
  try {
    const formatted = {
      ...account,
      tags: JSON.parse(account.tags || '[]'),
      quota_json: account.quota_json ? JSON.parse(account.quota_json) : null,
      provider_specific_data: account.provider_specific_data ? JSON.parse(account.provider_specific_data) : null,
    };

    console.log(`Pushing ${formatted.email} (status: ${formatted.status}, ever_ready: ${formatted.ever_ready})...`);
    await SyncManager.pushVault('account', formatted, true); // force = true to bypass cache
    successCount++;
  } catch (e) {
    console.error(`Failed to push ${account.email}: ${e.message}`);
    failCount++;
  }
}

db.close();
console.log(`\nSynchronization complete. Success: ${successCount}, Failures: ${failCount}`);
