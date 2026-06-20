import Database from 'better-sqlite3';

const db = new Database('./data/vault.db', { readonly: true });

// Check almirachadava9731
const a = db.prepare('SELECT * FROM vault_accounts WHERE id = ?').get('acc_7edbf498');
console.log('=== almirachadava9731 FULL RECORD ===');
console.log('status:', a.status);
console.log('ever_ready:', a.ever_ready);
console.log('connect_pending:', a.connect_pending);
console.log('gateway_status:', a.gateway_status);
console.log('updated_at:', a.updated_at);
console.log('notes:', (a.notes || '').slice(0, 200));
console.log('has access_token:', !!(a.access_token && a.access_token.length > 10));
console.log('has refresh_token:', !!(a.refresh_token && a.refresh_token.length > 10));
console.log('');

// Check acc_1ea0ef3c (ready but revoked)
const b = db.prepare('SELECT id, email, status, ever_ready, gateway_status, updated_at FROM vault_accounts WHERE id = ?').get('acc_1ea0ef3c');
console.log('=== iphigeniadulciegrace (ready but gw=revoked) ===');
console.log(JSON.stringify(b, null, 2));
console.log('');

// Summary: accounts that should be on Services
const ready = db.prepare("SELECT id, email, status, ever_ready, gateway_status FROM vault_accounts WHERE status='ready' AND deleted_at IS NULL").all();
console.log('=== READY ACCOUNTS (should be on Services) ===');
ready.forEach(r => console.log(`  ${r.email} | gw=${r.gateway_status}`));
console.log('');

// Check D1 via API
const cfg = JSON.parse(db.prepare("SELECT value FROM config WHERE key='d1WorkerUrl'").get()?.value || '""');
const secret = JSON.parse(db.prepare("SELECT value FROM config WHERE key='d1SyncSecret'").get()?.value || '""');
console.log('D1 Worker URL:', cfg || '(not set)');
console.log('D1 Secret:', secret ? '***set***' : '(not set)');

db.close();
