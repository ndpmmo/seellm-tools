import Database from 'better-sqlite3';
import { loadConfig } from '../server/db/config.js';

const cfg = loadConfig();
console.log('D1 Config:', {
  d1WorkerUrl: cfg.d1WorkerUrl,
  d1SyncSecret: cfg.d1SyncSecret ? 'PRESENT' : 'MISSING'
});

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

function computeProxyFreeSlots(proxies, proxySlots) {
  const map = new Map();
  for (const p of proxies) {
    map.set(p.id, Number(p.slot_count || p.slots || 0));
  }
  for (const s of proxySlots) {
    if (s.proxy_id && s.connection_id && !s.deleted_at) {
      const cur = map.get(s.proxy_id) || 0;
      map.set(s.proxy_id, Math.max(0, cur - 1));
    }
  }
  return map;
}

async function run() {
  try {
    const db = new Database('data/vault.db');
    const localAccounts = db.prepare('SELECT id, email, proxy_url, deleted_at, is_active FROM vault_accounts WHERE deleted_at IS NULL').all();
    
    console.log(`\nLocal accounts count (non-deleted): ${localAccounts.length}`);
    const localNoProxy = localAccounts.filter(a => !normalizeProxyUrl(a.proxy_url));
    console.log(`Local accounts with NO proxy: ${localNoProxy.length}`);
    if (localNoProxy.length > 0) {
      console.log('Sample local accounts with NO proxy (first 5):');
      localNoProxy.slice(0, 5).forEach(a => console.log(`- ${a.email} (id: ${a.id}, is_active: ${a.is_active})`));
    }

    console.log('\nFetching D1 data...');
    const [accountsR, proxiesR] = await Promise.all([
      d1Request(cfg, 'inspect/accounts?limit=1000'),
      d1Request(cfg, 'inspect/proxies'),
    ]);

    if (!accountsR.ok) {
      console.error('Failed to inspect accounts from D1:', accountsR.status, accountsR.text);
      return;
    }
    if (!proxiesR.ok) {
      console.error('Failed to inspect proxies from D1:', proxiesR.status, proxiesR.text);
      return;
    }

    const d1Accounts = Array.isArray(accountsR.data?.items) ? accountsR.data.items : [];
    const d1Proxies = Array.isArray(proxiesR.data?.proxies) ? proxiesR.data.proxies : [];
    const d1ProxySlots = Array.isArray(proxiesR.data?.proxySlots) ? proxiesR.data.proxySlots : [];

    console.log(`\nD1 Accounts Count: ${d1Accounts.length}`);
    console.log(`D1 Proxies Count: ${d1Proxies.length}`);
    console.log(`D1 Proxy Slots Count: ${d1ProxySlots.length}`);

    const freeByProxy = computeProxyFreeSlots(d1Proxies, d1ProxySlots);
    console.log('\nD1 Proxies and Free Slots:');
    d1Proxies.forEach(p => {
      const free = freeByProxy.get(p.id) || 0;
      console.log(`- ${p.label || 'unnamed'} (${p.url}) | slots: ${p.slots} | free: ${free} | active: ${p.is_active}`);
    });

    const totalFreeSlots = [...freeByProxy.values()].reduce((a, b) => a + b, 0);
    console.log(`\nTotal Free Slots in D1 Pool: ${totalFreeSlots}`);

  } catch (err) {
    console.error('Error running diagnosis:', err);
  }
}

run();
