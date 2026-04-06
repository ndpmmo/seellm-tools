import { loadConfig } from '../db/config.js';

/**
 * SyncManager handles pushing Vault data to Cloudflare D1
 */
export const SyncManager = {
  async pushVault(type, data) {
    const cfg = loadConfig();
    if (!cfg.d1WorkerUrl || !cfg.d1SyncSecret) {
      console.log('[SyncManager] Skip: D1 Cloud not configured.');
      return;
    }

    // Wrap the record into the PushPayload format expected by the worker
    const payload = {};
    if (type === 'account') payload.vaultAccounts = [data];
    if (type === 'proxy')   payload.vaultProxies = [data];
    if (type === 'key')     payload.vaultKeys = [data];

    try {
      console.log(`[SyncManager] Pushing ${type} to D1...`);
      const res = await fetch(`${cfg.d1WorkerUrl}/sync/push`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-sync-secret': cfg.d1SyncSecret,
        },
        body: JSON.stringify(payload),
      });
      
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'D1 push failed');
      
      console.log(`[SyncManager] Successfully synced ${type} to D1.`);
      return result;
    } catch (e) {
      console.error(`[SyncManager] Error syncing ${type}:`, e.message);
    }
  },

  async pullVault() {
    const cfg = loadConfig();
    if (!cfg.d1WorkerUrl || !cfg.d1SyncSecret) return;

    try {
      console.log('[SyncManager] Pulling vault data from D1...');
      const res = await fetch(`${cfg.d1WorkerUrl}/sync/pull?since=0`, {
        headers: { 'x-sync-secret': cfg.d1SyncSecret }
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'D1 pull failed');

      return {
        accounts: data.vaultAccounts || [],
        proxies:  data.vaultProxies || [],
        keys:     data.vaultKeys || []
      };
    } catch (e) {
      console.error('[SyncManager] Initial pull failed:', e.message);
      return null;
    }
  }
};
