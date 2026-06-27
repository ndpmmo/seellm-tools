import Database from 'better-sqlite3';

const db = new Database('./data/vault.db', { readonly: true });

console.log('=== LOCAL VAULT (ready accounts) ===');
const ready = db.prepare("SELECT id, email, status, ever_ready, gateway_status, workspace_id, updated_at FROM vault_accounts WHERE status='ready' AND deleted_at IS NULL").all();
console.log(`Total ready: ${ready.length}`);
ready.forEach(r => {
  console.log(`  ${r.id} | ${r.email} | st=${r.status} | gw=${r.gateway_status} | ws=${r.workspace_id || 'null'} | ${r.updated_at}`);
});

console.log('\n=== D1 MANAGED ACCOUNTS ===');
const fetch1 = await fetch('http://localhost:4000/api/d1/inspect/accounts').then(r => r.json());
console.log(`Visible: ${(fetch1.items || []).length}`);
(fetch1.items || []).forEach(a => {
  console.log(`  ${a.id} | ${a.email} | st=${a.status} | active=${a.is_active}`);
});

console.log('\n=== D1 ACTIVE CONNECTIONS ===');
const fetch2 = await fetch('http://localhost:4000/api/d1/inspect/connections').then(r => r.json());
console.log(`Active: ${(fetch2.items || []).length}`);
(fetch2.items || []).forEach(c => {
  let wsid = null;
  try {
    const psd = typeof c.provider_specific_data === 'string' ? JSON.parse(c.provider_specific_data) : c.provider_specific_data;
    wsid = psd?.workspaceId;
  } catch {}
  console.log(`  ${c.id} | ${c.email} | ws=${wsid || 'null'}`);
});

db.close();
