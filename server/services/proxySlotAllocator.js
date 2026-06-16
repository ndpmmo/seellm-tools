import { loadConfig } from '../db/config.js';
import { vault } from '../db/vault.js';
import { SyncManager } from './syncManager.js';

/**
 * Fetch helper for D1 Cloud Worker
 */
export async function d1Request(cfg, endpoint, options = {}) {
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

function findSlotByConnection(proxySlots = [], connectionId) {
  return proxySlots.find(s => s && !s.deleted_at && String(s.connection_id || '') === String(connectionId || '')) || null;
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

/**
 * Scan all active local proxies to find the next sequential P{N} label
 */
export function getNextProxyLabel() {
  const proxies = vault.getProxies() || [];
  let max = 0;
  for (const p of proxies) {
    if (p.label) {
      const match = p.label.match(/^P(\d+)$/i);
      if (match) {
        const num = parseInt(match[1], 10);
        if (num > max) {
          max = num;
        }
      }
    }
  }
  return max;
}

/**
 * Allocate a proxy slot for a given account id based on sequential P{N} label order
 */
export async function allocateProxySlotForAccount(accountId) {
  const cfg = loadConfig();
  if (!cfg.d1WorkerUrl || !cfg.d1SyncSecret) {
    console.log('[Proxy Allocation] Skip: D1 Cloud not configured.');
    return { ok: false, error: 'D1 Cloud not configured' };
  }

  try {
    const account = vault.db.prepare('SELECT * FROM vault_accounts WHERE id = ?').get(accountId);
    if (!account) return { ok: false, error: 'Account not found locally' };

    const proxiesR = await d1Request(cfg, 'inspect/proxies');
    if (!proxiesR.ok) return { ok: false, error: 'Failed to retrieve proxies/slots from D1' };

    const proxies = Array.isArray(proxiesR.data?.proxies) ? proxiesR.data.proxies : [];
    const proxySlots = Array.isArray(proxiesR.data?.proxySlots) ? proxiesR.data.proxySlots : [];

    // Check if account already has a bound slot in D1
    const currentSlot = findSlotByConnection(proxySlots, accountId);
    if (currentSlot) {
      const parentProxy = proxies.find(p => p.id === currentSlot.proxy_id);
      if (parentProxy && account.proxy_url !== parentProxy.url) {
        vault.db.prepare('UPDATE vault_accounts SET proxy_url = ?, updated_at = ? WHERE id = ?')
          .run(parentProxy.url, new Date().toISOString(), accountId);
        const updatedAcc = vault.getAccountFull(accountId);
        await SyncManager.pushVault('account', updatedAcc, true);
      }
      return { ok: true, slotId: currentSlot.id, proxyUrl: parentProxy?.url };
    }

    // Sort active proxies naturally by label (P1 -> P2 -> ...)
    const sortedProxies = proxies
      .filter(p => (p.is_active || p.is_active === undefined) && !p.deleted_at)
      .sort((a, b) => {
        const labelA = a.label || '';
        const labelB = b.label || '';
        const matchA = labelA.match(/^P(\d+)$/i);
        const matchB = labelB.match(/^P(\d+)$/i);
        if (matchA && matchB) return parseInt(matchA[1], 10) - parseInt(matchB[1], 10);
        if (matchA) return -1;
        if (matchB) return 1;
        return labelA.localeCompare(labelB);
      });

    let chosenSlot = null;
    let chosenProxy = null;

    // Find first vacant slot
    for (const p of sortedProxies) {
      const slots = proxySlots
        .filter(s => s.proxy_id === p.id && !s.deleted_at && !s.connection_id)
        .sort((a, b) => Number(a.slot_index || 0) - Number(b.slot_index || 0));
      if (slots.length > 0) {
        chosenSlot = slots[0];
        chosenProxy = p;
        break;
      }
    }

    // Auto expansion if enabled and no vacant slot found
    if (!chosenSlot && cfg.autoExpandSlots && sortedProxies.length > 0) {
      const proxyCounts = sortedProxies.map(p => {
        const count = proxySlots.filter(s => s.proxy_id === p.id && !s.deleted_at).length;
        return { proxy: p, count };
      });

      proxyCounts.sort((a, b) => {
        if (a.count !== b.count) return a.count - b.count;
        const labelA = a.proxy.label || '';
        const labelB = b.proxy.label || '';
        const matchA = labelA.match(/^P(\d+)$/i);
        const matchB = labelB.match(/^P(\d+)$/i);
        if (matchA && matchB) return parseInt(matchA[1], 10) - parseInt(matchB[1], 10);
        if (matchA) return -1;
        if (matchB) return 1;
        return labelA.localeCompare(labelB);
      });

      const targetProxy = proxyCounts[0].proxy;
      const expandStep = Number(cfg.autoExpandSlotStep || 1) || 1;
      console.log(`[Proxy Allocation] Auto-expanding proxy ${targetProxy.label} (current slots count ${proxyCounts[0].count}) by +${expandStep} slots`);
      
      let lastSlotId = null;
      let addedSlotsCount = 0;
      for (let step = 0; step < expandStep; step++) {
        const addSlotRes = await d1Request(cfg, `proxies/${targetProxy.id}/slots`, { method: 'POST' });
        if (addSlotRes.ok && addSlotRes.data?.id) {
          lastSlotId = addSlotRes.data.id;
          addedSlotsCount++;
        }
      }
      
      if (addedSlotsCount > 0) {
        chosenProxy = targetProxy;
        chosenSlot = {
          id: lastSlotId,
          proxy_id: targetProxy.id,
          slot_index: proxyCounts[0].count + addedSlotsCount - 1,
          connection_id: null
        };
      }
    }

    if (chosenSlot && chosenProxy) {
      const claimed = await pushProxySlotState(cfg, chosenSlot, accountId);
      if (claimed) {
        const now = new Date().toISOString();
        vault.db.prepare('UPDATE vault_accounts SET proxy_url = ?, updated_at = ? WHERE id = ?')
          .run(chosenProxy.url, now, accountId);
        const updatedAcc = vault.getAccountFull(accountId);
        await SyncManager.pushVault('account', updatedAcc, true);
        return { ok: true, slotId: chosenSlot.id, proxyUrl: chosenProxy.url };
      }
    }

    // Fallback: clear proxy
    const now = new Date().toISOString();
    vault.db.prepare('UPDATE vault_accounts SET proxy_url = NULL, updated_at = ? WHERE id = ?')
      .run(now, accountId);
    const updatedAcc = vault.getAccountFull(accountId);
    await SyncManager.pushVault('account', updatedAcc, true);
    return { ok: true, slotId: null, proxyUrl: null };

  } catch (err) {
    console.error('[Proxy Allocation] Error in allocateProxySlotForAccount:', err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Reallocate accounts bound to deleted proxies to other active proxies' slots
 */
export async function reallocateAccountsFromDeletedProxies(deletedProxyUrls, deletedProxyIds) {
  const cfg = loadConfig();
  if (!cfg.d1WorkerUrl || !cfg.d1SyncSecret) {
    console.log('[Proxy Reallocation] Skip: D1 Cloud not configured.');
    return;
  }

  try {
    const inspectRes = await d1Request(cfg, 'inspect/proxies');
    if (!inspectRes.ok) throw new Error('Failed to fetch proxies/slots from D1');
    const proxies = Array.isArray(inspectRes.data?.proxies) ? inspectRes.data.proxies : [];
    const proxySlots = Array.isArray(inspectRes.data?.proxySlots) ? inspectRes.data.proxySlots : [];

    const deletedProxyIdsSet = new Set(deletedProxyIds);
    const deletedProxyUrlsSet = new Set(deletedProxyUrls);

    // Active proxies that are NOT deleted
    const activeProxies = proxies.filter(p => 
      !deletedProxyIdsSet.has(p.id) && 
      (p.is_active || p.is_active === undefined) && 
      !p.deleted_at
    );

    // Sort naturally
    const sortedActiveProxies = activeProxies.sort((a, b) => {
      const labelA = a.label || '';
      const labelB = b.label || '';
      const matchA = labelA.match(/^P(\d+)$/i);
      const matchB = labelB.match(/^P(\d+)$/i);
      if (matchA && matchB) return parseInt(matchA[1], 10) - parseInt(matchB[1], 10);
      if (matchA) return -1;
      if (matchB) return 1;
      return labelA.localeCompare(labelB);
    });

    // Affected accounts
    const localAccounts = vault.db.prepare('SELECT * FROM vault_accounts WHERE deleted_at IS NULL').all();
    const affectedAccounts = localAccounts.filter(acc => {
      if (acc.proxy_url && deletedProxyUrlsSet.has(acc.proxy_url)) return true;
      const slot = proxySlots.find(s => s.connection_id === acc.id && !s.deleted_at);
      if (slot && deletedProxyIdsSet.has(slot.proxy_id)) return true;
      return false;
    });

    if (affectedAccounts.length === 0) {
      console.log('[Proxy Reallocation] No affected accounts found.');
      return;
    }

    console.log(`[Proxy Reallocation] Reallocating ${affectedAccounts.length} accounts from deleted proxies...`);

    const slotUpdates = [];
    const now = new Date().toISOString();

    // Release slots on deleted proxies
    const deletedSlots = proxySlots.filter(s => deletedProxyIdsSet.has(s.proxy_id) && s.connection_id);
    for (const ds of deletedSlots) {
      slotUpdates.push({
        id: ds.id,
        proxy_id: ds.proxy_id,
        slot_index: Number(ds.slot_index || 0),
        connection_id: null,
        updated_at: now,
        deleted_at: null,
        version: Date.now()
      });
      ds.connection_id = null;
    }

    for (const acc of affectedAccounts) {
      let chosenSlot = null;
      let chosenProxy = null;

      // Find first vacant slot in remaining proxies
      for (const p of sortedActiveProxies) {
        const vacantSlots = proxySlots.filter(s => 
          s.proxy_id === p.id && 
          !s.deleted_at && 
          !s.connection_id && 
          !slotUpdates.some(su => su.id === s.id && su.connection_id !== null)
        ).sort((a, b) => Number(a.slot_index || 0) - Number(b.slot_index || 0));

        if (vacantSlots.length > 0) {
          chosenSlot = vacantSlots[0];
          chosenProxy = p;
          break;
        }
      }

      // Auto expand if enabled and none vacant
      if (!chosenSlot && cfg.autoExpandSlots && sortedActiveProxies.length > 0) {
        const proxyCounts = sortedActiveProxies.map(p => {
          const count = proxySlots.filter(s => s.proxy_id === p.id && !s.deleted_at).length;
          return { proxy: p, count };
        });

        proxyCounts.sort((a, b) => {
          if (a.count !== b.count) return a.count - b.count;
          const labelA = a.proxy.label || '';
          const labelB = b.proxy.label || '';
          const matchA = labelA.match(/^P(\d+)$/i);
          const matchB = labelB.match(/^P(\d+)$/i);
          if (matchA && matchB) return parseInt(matchA[1], 10) - parseInt(matchB[1], 10);
          if (matchA) return -1;
          if (matchB) return 1;
          return labelA.localeCompare(labelB);
        });

        const targetProxy = proxyCounts[0].proxy;
        const expandStep = Number(cfg.autoExpandSlotStep || 1) || 1;
        console.log(`[Proxy Reallocation] Auto-expanding proxy ${targetProxy.label} to accommodate account ${acc.email || acc.id} by +${expandStep} slots`);
        
        let lastSlotId = null;
        let addedSlotsCount = 0;
        for (let step = 0; step < expandStep; step++) {
          const addSlotRes = await d1Request(cfg, `proxies/${targetProxy.id}/slots`, { method: 'POST' });
          if (addSlotRes.ok && addSlotRes.data?.id) {
            const newSlot = {
              id: addSlotRes.data.id,
              proxy_id: targetProxy.id,
              slot_index: proxyCounts[0].count + addedSlotsCount,
              connection_id: null
            };
            proxySlots.push(newSlot);
            lastSlotId = addSlotRes.data.id;
            addedSlotsCount++;
            if (step === expandStep - 1) {
              chosenSlot = newSlot;
            }
          }
        }
        if (addedSlotsCount > 0) {
          chosenProxy = targetProxy;
        }
      }

      if (chosenSlot && chosenProxy) {
        chosenSlot.connection_id = acc.id;
        slotUpdates.push({
          id: chosenSlot.id,
          proxy_id: chosenSlot.proxy_id,
          slot_index: Number(chosenSlot.slot_index || 0),
          connection_id: acc.id,
          updated_at: now,
          deleted_at: null,
          version: Date.now()
        });

        vault.db.prepare('UPDATE vault_accounts SET proxy_url = ?, updated_at = ? WHERE id = ?')
          .run(chosenProxy.url, now, acc.id);
        
        const updatedAcc = vault.getAccountFull(acc.id);
        await SyncManager.pushVault('account', updatedAcc, true);
        console.log(`[Proxy Reallocation] Reallocated ${acc.email || acc.id} -> ${chosenProxy.label} (slot index ${chosenSlot.slot_index})`);
      } else {
        vault.db.prepare('UPDATE vault_accounts SET proxy_url = NULL, updated_at = ? WHERE id = ?')
          .run(now, acc.id);
        
        const updatedAcc = vault.getAccountFull(acc.id);
        await SyncManager.pushVault('account', updatedAcc, true);
        console.log(`[Proxy Reallocation] No slots available. Set ${acc.email || acc.id} -> proxy_url = NULL`);
      }
    }

    if (slotUpdates.length > 0) {
      await d1Request(cfg, 'sync/push', {
        method: 'POST',
        body: { proxySlots: slotUpdates }
      });
      console.log(`[Proxy Reallocation] Pushed ${slotUpdates.length} slot state updates to D1.`);
    }

  } catch (err) {
    console.error('[Proxy Reallocation] Error reallocating accounts:', err.message);
  }
}
