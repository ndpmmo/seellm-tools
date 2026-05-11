/**
 * Cleanup: tombstone all D1 connections that no longer have a matching
 * active managed_account (managed_accounts already deleted from Services UI).
 *
 * Usage: node scripts/cleanup-d1-stale-connections-v2.mjs
 */
import { loadConfig } from '../server/db/config.js';

const cfg = loadConfig();
if (!cfg.d1WorkerUrl || !cfg.d1SyncSecret) {
  console.error('D1 not configured');
  process.exit(1);
}

const baseUrl = cfg.d1WorkerUrl.replace(/\/+$/, '');
const headers = { 'x-sync-secret': cfg.d1SyncSecret, 'Content-Type': 'application/json' };

// 1. Get all active connections
const connRes = await fetch(`${baseUrl}/inspect/connections?active=1`, { headers });
const connData = await connRes.json();
const connections = connData.items || [];
console.log(`Active connections on D1: ${connections.length}`);

// 2. Get all visible managed accounts
const acctRes = await fetch(`${baseUrl}/inspect/accounts`, { headers });
const acctData = await acctRes.json();
const accounts = acctData.items || [];
const activeEmails = new Set(accounts.map(a => (a.email || '').toLowerCase()));
const activeIds = new Set(accounts.map(a => a.id));
console.log(`Active managed accounts on D1: ${accounts.length}`);

// 3. Find orphan connections (no matching managed account)
const orphans = connections.filter(c => {
  const emailMatch = c.email && activeEmails.has(c.email.toLowerCase());
  const idMatch = activeIds.has(c.id);
  return !emailMatch && !idMatch;
});

console.log(`\nOrphan connections to tombstone: ${orphans.length}`);
if (orphans.length === 0) {
  console.log('Nothing to clean up!');
  process.exit(0);
}

// 4. Push tombstones
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

console.log('\nTombstoning:');
tombstones.forEach(t => console.log(`  ${t.id} | ${t.email}`));

const pushRes = await fetch(`${baseUrl}/sync/push`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ connections: tombstones }),
});
const pushData = await pushRes.json();
console.log(`\nPush result:`, JSON.stringify(pushData, null, 2));

// 5. Verify
const verifyRes = await fetch(`${baseUrl}/inspect/connections?active=1`, { headers });
const verifyData = await verifyRes.json();
console.log(`\nActive connections after cleanup: ${(verifyData.items || []).length}`);
