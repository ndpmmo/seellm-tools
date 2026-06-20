import Database from 'better-sqlite3';
import { loadConfig } from '../server/db/config.js';

const cfg = loadConfig();

async function d1Request(cfg, endpoint, options = {}) {
  const base = String(cfg.d1WorkerUrl || '').replace(/\/+$/, '');
  const path = String(endpoint || '').replace(/^\/+/, '');
  const targetUrl = `${base}/${path}`;
  const method = options.method || 'GET';
  const headers = {
    'x-sync-secret': cfg.d1SyncSecret,
  };
  if (method !== 'GET' && method !== 'HEAD') headers['Content-Type'] = 'application/json';

  const fetchOpts = {
    method,
    headers,
    signal: AbortSignal.timeout(options.timeoutMs || 30000),
  };
  if (options.body !== undefined && method !== 'GET' && method !== 'HEAD') {
    fetchOpts.body = JSON.stringify(options.body);
  }

  const res = await fetch(targetUrl, fetchOpts);
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (_) { }
  return { ok: res.ok, status: res.status, data, text, targetUrl };
}

function normalizeProxyUrl(input) {
  const s = String(input || '').trim();
  return s.length ? s : null;
}

function computeProxyFreeSlots(proxies = [], proxySlots = []) {
  const freeByProxy = new Map();
  for (const p of proxies) {
    const slots = proxySlots.filter(s => s && s.proxy_id === p.id && !s.deleted_at);
    if (slots.length > 0) {
      freeByProxy.set(p.id, slots.filter(s => !s.connection_id).length);
    } else {
      const fallbackCap = Number(p.slot_count || p.slotCount || 0) || 0;
      freeByProxy.set(p.id, fallbackCap);
    }
  }
  return freeByProxy;
}

function sortProxiesByLabel(a, b) {
  const labelA = a.proxy?.label || '';
  const labelB = b.proxy?.label || '';
  const numA = parseInt(labelA.replace(/^\D+/g, ''), 10) || 0;
  const numB = parseInt(labelB.replace(/^\D+/g, ''), 10) || 0;
  return numA - numB;
}

function findSlotByConnection(proxySlots = [], connectionId) {
  return proxySlots.find(s => s && !s.deleted_at && String(s.connection_id || '') === String(connectionId || '')) || null;
}

function findFreeSlot(proxySlots = [], proxyId) {
  const candidates = proxySlots
    .filter(s => s && !s.deleted_at && s.proxy_id === proxyId && !s.connection_id)
    .sort((a, b) => Number(a.slot_index || 0) - Number(b.slot_index || 0));
  return candidates[0] || null;
}

async function pushProxySlotState(cfg, slotRow, connectionIdOrNull) {
  if (!slotRow?.id || !slotRow?.proxy_id) return false;
  const now = new Date().toISOString();
  const payload = {
    proxySlots: [{
      id: slotRow.id,
      proxy_id: slotRow.proxy_id,
      slot_index: Number(slotRow.slot_index || 0),
      connection_id: connectionIdOrNull || null,
      updated_at: now,
      deleted_at: null,
      version: Date.now(),
    }],
  };

  const push = await d1Request(cfg, 'sync/push', { method: 'POST', body: payload, timeoutMs: 30000 });
  return push.ok;
}

async function rebindProxySlotForAccount({
  cfg,
  accountId,
  targetProxyId,
  proxySlots,
}) {
  const current = findSlotByConnection(proxySlots, accountId);
  const currentProxyId = current?.proxy_id || null;
  const normalizedTarget = targetProxyId || null;

  if (currentProxyId && normalizedTarget && currentProxyId === normalizedTarget) {
    return { ok: true, changed: false };
  }

  if (current && (!normalizedTarget || currentProxyId !== normalizedTarget)) {
    const released = await pushProxySlotState(cfg, current, null);
    if (!released) return { ok: false, error: 'Failed to release old proxy slot' };
    current.connection_id = null;
  }

  if (!normalizedTarget) return { ok: true, changed: true };

  const freeSlot = findFreeSlot(proxySlots, normalizedTarget);
  if (!freeSlot) {
    console.warn(`[D1 Proxy] Proxy ${normalizedTarget} has no free pre-defined slots.`);
    return { ok: true, changed: true, warning: 'No pre-defined free slot available' };
  }
  const claimed = await pushProxySlotState(cfg, freeSlot, accountId);
  if (!claimed) return { ok: false, error: 'Failed to claim target proxy slot' };
  freeSlot.connection_id = accountId;
  return { ok: true, changed: true, slotId: freeSlot.id };
}

async function run() {
  try {
    const db = new Database('data/vault.db');
    // Using simple query since we are testing
    const localAccounts = db.prepare('SELECT id, email, proxy_url, deleted_at, is_active FROM vault_accounts WHERE deleted_at IS NULL').all();
    const candidateAccounts = localAccounts.filter(a => !normalizeProxyUrl(a.proxy_url));
    console.log(`Candidate accounts count: ${candidateAccounts.length}`);

    if (candidateAccounts.length === 0) {
      console.log('No candidate accounts without proxy url found!');
      return;
    }

    console.log('Fetching D1 data...');
    const [accountsR, proxiesR] = await Promise.all([
      d1Request(cfg, 'inspect/accounts?limit=1000'),
      d1Request(cfg, 'inspect/proxies'),
    ]);

    if (!accountsR.ok) {
      console.error('Failed to fetch D1 accounts:', accountsR.status, accountsR.text);
      return;
    }
    if (!proxiesR.ok) {
      console.error('Failed to fetch D1 proxies:', proxiesR.status, proxiesR.text);
      return;
    }

    const accounts = Array.isArray(accountsR.data?.items) ? accountsR.data.items : [];
    const proxies = Array.isArray(proxiesR.data?.proxies) ? proxiesR.data.proxies : [];
    const proxySlots = Array.isArray(proxiesR.data?.proxySlots) ? proxiesR.data.proxySlots : [];

    const freeByProxy = computeProxyFreeSlots(proxies, proxySlots);
    console.log(`D1 accounts: ${accounts.length}, D1 proxies: ${proxies.length}, D1 slots: ${proxySlots.length}`);

    // Try processing the first 2 accounts to see what errors we encounter
    const testAccounts = candidateAccounts.slice(0, 2);
    for (const account of testAccounts) {
      console.log(`\n--- Processing account: ${account.email} (id: ${account.id}) ---`);
      
      const ranked = proxies
        .map((p) => ({ proxy: p, free: freeByProxy.get(p.id) || 0 }))
        .filter((x) => x.free > 0)
        .sort(sortProxiesByLabel);
        
      if (!ranked.length) {
        console.log('No proxies with free slots found!');
        break;
      }

      console.log(`Top chosen proxy candidate: ${ranked[0].proxy.label} (url: ${ranked[0].proxy.url}, free slots: ${ranked[0].free})`);

      const d1Acc = accounts.find(a => a.id === account.id);
      if (!d1Acc) {
        console.log(`Account ${account.email} is missing on D1! We need to sync it first.`);
        // Note: we won't sync it in this test script, but we know it's missing.
        // Let's print if sync is required.
      } else {
        console.log(`Account exists on D1. D1 details: proxy_id: ${d1Acc.proxy_id}, proxy_url: ${d1Acc.proxy_url}`);
      }

      const chosen = ranked[0].proxy;
      const patchBody = { proxyUrl: normalizeProxyUrl(chosen.url), proxyId: chosen.id };
      console.log('Patching account on D1 with body:', patchBody);
      const patchR = await d1Request(cfg, `accounts/${account.id}`, { method: 'PATCH', body: patchBody });
      console.log(`PATCH response status: ${patchR.status}, success: ${patchR.ok}, response text: ${patchR.text}`);
      
      if (!patchR.ok && patchR.status !== 404) {
        console.error('PATCH failed with non-404 error, skipping.');
        continue;
      }

      console.log('Updating local and pushing to D1 vault_accounts...');
      // Simulate mirrorPatchedAccountToLocal and force push
      const dbInstance = new Database('data/vault.db');
      dbInstance.prepare('UPDATE vault_accounts SET proxy_url = ?, updated_at = ? WHERE id = ?')
        .run(patchBody.proxyUrl, new Date().toISOString(), account.id);
      dbInstance.close();

      // Trigger sync
      const { SyncManager: SM } = await import('../server/services/syncManager.js');
      // Read updated record
      const db2 = new Database('data/vault.db');
      const updatedRecord = db2.prepare('SELECT * FROM vault_accounts WHERE id = ?').get(account.id);
      db2.close();

      console.log('Force pushing to D1 via SyncManager...');
      const pushRes = await SM.pushVault('account', updatedRecord, true);
      console.log('SyncManager push result:', pushRes);

      console.log('Rebinding proxy slot on D1...');
      const slotSync = await rebindProxySlotForAccount({
        cfg,
        accountId: account.id,
        targetProxyId: chosen.id,
        proxySlots,
      });
      console.log('Slot sync result:', slotSync);
    }

  } catch (err) {
    console.error('Test run failed:', err);
  }
}

run();
