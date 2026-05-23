import { loadConfig } from '../db/config.js';
import { createHash } from 'node:crypto';

/**
 * SyncManager handles pushing Vault data to Cloudflare D1
 */
// Bộ nhớ đệm để tránh đẩy trùng dữ liệu không đổi (Save D1 Writes)
const lastPushCache = new Map();
const lastPushState = new Map();
// Đợi gom các yêu cầu đẩy (Debouncing)
const debounceTimeouts = new Map();

function normalizeProviderSpecificData(raw) {
  if (!raw) return null;
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function safeParseTags(raw) {
  if (!raw) return [];
  if (typeof raw === 'object') return Array.isArray(raw) ? raw : [];
  try { return JSON.parse(raw); } catch { return []; }
}

function normalizeAccountState(data = {}) {
  const providerData = normalizeProviderSpecificData(data.provider_specific_data || data.providerSpecificData);
  return {
    id: data.id || null,
    email: data.email || null,
    password: data.password || null,
    two_fa_secret: data.two_fa_secret || null,
    status: data.status || null,
    is_active: data.is_active ?? data.isActive ?? 1,
    ever_ready: data.ever_ready ?? 0,
    deleted_at: data.deleted_at || null,
    access_token: data.access_token || null,
    refresh_token: data.refresh_token || null,
    workspace_id: data.workspace_id || providerData?.workspaceId || null,
    device_id: data.device_id || providerData?.deviceId || null,
    machine_id: data.machine_id || providerData?.machineId || null,
    provider_specific_data: providerData || null,
    updated_at: data.updated_at || data.updatedAt || null,
  };
}

function hashJson(value) {
  return createHash('sha256').update(JSON.stringify(value || null)).digest('hex');
}

function isCriticalAccountChange(prevState, nextState) {
  if (!prevState) return true;
  const criticalKeys = [
    'email',
    'password',
    'two_fa_secret',
    'access_token',
    'refresh_token',
    'workspace_id',
    'device_id',
    'machine_id',
    'is_active',
    'ever_ready',
    'deleted_at',
  ];
  for (const key of criticalKeys) {
    if ((prevState?.[key] ?? null) !== (nextState?.[key] ?? null)) return true;
  }
  if ((prevState?.status || '') !== (nextState?.status || '')) {
    return true;
  }
  if (hashJson(prevState?.provider_specific_data) !== hashJson(nextState?.provider_specific_data)) {
    return true;
  }
  return false;
}

async function triggerGatewaySync(reason = 'manual') {
  const cfg = loadConfig();
  if (!cfg.gatewayUrl || !cfg.d1SyncSecret) return;
  // Skip nếu gatewayUrl trỏ đến D1 Worker
  if (cfg.gatewayUrl.includes('workers.dev') || cfg.gatewayUrl.includes('gateway-db.seellm.xyz')) {
    return;
  }
  try {
    const res = await fetch(`${cfg.gatewayUrl.replace(/\/+$/, '')}/api/sync/trigger`, {
      method: 'POST',
      headers: { 'x-sync-secret': cfg.d1SyncSecret, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      console.log(`[SyncManager] [GatewayTrigger] ✅ Gateway pulled snapshot (reason=${reason})`);
    } else if (res.status !== 404) {
      console.log(`[SyncManager] [GatewayTrigger] ⚠️ Gateway trigger HTTP ${res.status} (reason=${reason})`);
    }
  } catch (e) {
    // Silently ignore
  }
}

/**
 * SyncManager handles pushing Vault data to Cloudflare D1
 */
export const SyncManager = {
  async pushVault(type, data, force = false) {
    const cfg = loadConfig();
    if (!cfg.d1WorkerUrl || !cfg.d1SyncSecret) {
      console.log('[SyncManager] Skip: D1 Cloud not configured.');
      return;
    }

    // email_pool dùng email làm PK, các type khác dùng id
    const cacheKeyId = data.email || data.id;
    const cacheKey = `${type}:${cacheKeyId}`;
    const normalizedState = type === 'account' ? normalizeAccountState(data) : data;
    const fingerprint = hashJson(normalizedState);

    if (!force && lastPushCache.get(cacheKey) === fingerprint) {
      // console.log(`[SyncManager] 💤 Bỏ qua Push (Nội dung không đổi): ${data.email || data.id}`);
      return;
    }

    // --- DEBOUNCING (SAVE WRITES) ---
    // Chỉ debounce cho type 'account' khi không phải thay đổi critical.
    // Các type khác (email_pool, proxy, key) → push ngay lập tức.
    const shouldPushImmediately =
      type !== 'account' || isCriticalAccountChange(lastPushState.get(cacheKey), normalizedState);

    if (!force && !shouldPushImmediately) {
      if (debounceTimeouts.has(cacheKey)) {
        clearTimeout(debounceTimeouts.get(cacheKey));
      }

      return new Promise((resolve) => {
        const timeout = setTimeout(async () => {
          debounceTimeouts.delete(cacheKey);
          const result = await this._executePush(type, data, fingerprint);
          resolve(result);
        }, 45000); // Đợi 45 giây cho đợt gom kế tiếp
        debounceTimeouts.set(cacheKey, timeout);
      });
    }

    return await this._executePush(type, data, fingerprint);
  },

  /**
   * Pushes all records of a specific type from local SQLite to D1.
   * Useful for "Sync All" recovery or initial setup.
   */
  async pushAllVaultPool() {
    console.log('[SyncManager] 🔄 Starting full Email Pool sync to D1...');
    try {
      const { vault } = await import('../db/vault.js');
      const allEmails = vault.db.prepare('SELECT * FROM vault_email_pool').all();
      
      console.log(`[SyncManager] Found ${allEmails.length} records to sync.`);
      
      let successCount = 0;
      for (const record of allEmails) {
        // Force push by bypassing cache
        const result = await this.pushVault('email_pool', record, true);
        if (result && result.ok) successCount++;
      }
      
      console.log(`[SyncManager] ✅ Full sync completed: ${successCount}/${allEmails.length} pushed.`);
      return { ok: true, total: allEmails.length, success: successCount };
    } catch (e) {
      console.error('[SyncManager] ❌ Full sync failed:', e.message);
      return { ok: false, error: e.message };
    }
  },

  async _executePush(type, data, fingerprint) {
    const cfg = loadConfig();
    const now = new Date().toISOString();
    const version = Date.now();
    const cacheKeyId = data.email || data.id;
    const cacheKey = `${type}:${cacheKeyId}`;
    const createdAt = data.created_at || data.createdAt || now;
    const updatedAt = data.updated_at || data.updatedAt || now;

    // Store previous gateway_status for rollback on failure
    let previousGatewayStatus = null;
    if (type === 'account' && data.id) {
      try {
        const { vault } = await import('../db/vault.js');
        const currentAccount = vault.db.prepare(
          'SELECT gateway_status FROM vault_accounts WHERE id = ?'
        ).get(data.id);
        previousGatewayStatus = currentAccount?.gateway_status ?? null;
        
        // Set pending_push before making the request
        vault.updateGatewayStatus(data.id, 'pending_push');
      } catch (e) {
        console.warn('[SyncManager] Could not update gateway_status to pending_push:', e.message);
      }
    }

    // Cập nhật cache trước khi thực hiện
    lastPushCache.set(cacheKey, fingerprint);
    if (type === 'account') {
      lastPushState.set(cacheKey, normalizeAccountState(data));
    }

    // Wrap the record into the PushPayload format expected by the worker
    const payload = {};
    if (type === 'account') {
      // ✅ Rule 1: LUÔN cập nhật vault_accounts (kho lạnh cloud mirror)
      payload.vaultAccounts = [{
        id: data.id,
        provider: data.provider || 'openai',
        label: data.label || null,
        email: data.email,
        password: data.password || null,
        two_fa_secret: data.two_fa_secret || null,
        access_token: data.access_token || null,
        refresh_token: data.refresh_token || null,
        status: data.status,
        is_active: data.is_active ?? 1,
        quota_json: data.quota_json || null,
        proxy_url: data.proxy_url || null,
        cookies: data.cookies || null,
        notes: data.notes || null,
        tags: data.tags || null,
        created_at: createdAt,
        updated_at: updatedAt,
        deleted_at: data.deleted_at || null,
      }];

      // ✅ Rule 2: Account đã bị xóa cứng (deleted_at set) → tombstone tối giản
      if (data.deleted_at) {
        payload.managedAccounts = [{ id: data.id, email: data.email, updated_at: now, deleted_at: data.deleted_at, version }];
        payload.connections = [{ id: data.id, email: data.email, updated_at: now, deleted_at: data.deleted_at, is_active: 0, version }];
      }
      // ✅ Rule 3: Account idle (chưa/chưa cần deploy) → soft-delete khỏi Gateway, KHÔNG tạo record mới
      else if (data.status === 'idle') {
        payload.managedAccounts = [{ id: data.id, email: data.email, updated_at: now, deleted_at: now, version }];
        payload.connections = [{ id: data.id, email: data.email, updated_at: now, deleted_at: now, is_active: 0, version }];
      }
      // ✅ Rule 4: Account ready → push đầy đủ cả managedAccounts + connections, đánh dấu ever_ready
      else if (data.status === 'ready') {
        const providerSpecificData = normalizeProviderSpecificData(data.provider_specific_data || data.providerSpecificData) || {};
        const workspaceId = data.workspace_id || providerSpecificData.workspaceId || null;
        const mergedProviderData = {
          ...providerSpecificData,
          workspaceId: workspaceId || null,
          deviceId: data.device_id || providerSpecificData.deviceId || null,
          machineId: data.machine_id || providerSpecificData.machineId || null,
          proxyUrl: data.proxy_url || providerSpecificData.proxyUrl || null,
        };
        Object.keys(mergedProviderData).forEach((key) => {
          if (mergedProviderData[key] === null || mergedProviderData[key] === undefined) delete mergedProviderData[key];
        });
        const connectionIsActive = (data.is_active !== undefined && data.is_active !== null) ? (data.is_active === 0 ? 0 : 1) : 1;

        payload.managedAccounts = [{
          id: data.id,
          provider: data.provider || 'openai',
          email: data.email,
          password: data.password,
          two_fa_secret: data.two_fa_secret,
          proxy_url: data.proxy_url,
          proxy_id: null,
          status: data.status,
          is_active: connectionIsActive,
          quota_json: data.quota_json || null,
          last_error: data.notes,
          last_sync_at: now,
          created_at: createdAt,
          updated_at: updatedAt,
          deleted_at: null,
          version,
        }];

        payload.connections = [{
          id: data.id,
          provider: data.provider || 'openai',
          email: data.email,
          name: data.email ? data.email.split('@')[0] : data.id,
          // COALESCE-safe: send tokens when available (status=ready means tokens exist).
          // D1 Worker uses COALESCE so null = "keep existing", but on INSERT null = null.
          // Always include tokens for ready accounts to handle re-creation after DELETE.
          access_token: data.access_token || null,
          refresh_token: data.refresh_token || null,
          proxy_url: data.proxy_url || null,
          workspace_id: workspaceId,
          is_active: connectionIsActive,
          rate_limit_protection: 0,
          provider_specific_data: Object.keys(mergedProviderData).length ? mergedProviderData : null,
          created_at: createdAt,
          updated_at: updatedAt,
          deleted_at: null,
          version,
        }];
      }
      // ✅ Rule 5: Account lỗi (error/need_phone/relogin/dead)
      //   → Nếu đã từng ready (ever_ready=1): giữ connection để Gateway hiển thị lỗi trên account đang dùng
      //   → Nếu chưa từng ready: chỉ push managedAccounts, connection tombstone để xóa khỏi Gateway
      else if (['error', 'need_phone', 'relogin', 'dead'].includes(data.status)) {
        payload.managedAccounts = [{
          id: data.id,
          provider: data.provider || 'openai',
          email: data.email,
          password: data.password,
          two_fa_secret: data.two_fa_secret,
          proxy_url: data.proxy_url,
          proxy_id: null,
          status: data.status,
          is_active: data.is_active ?? 1,
          quota_json: data.quota_json || null,
          last_error: data.notes,
          last_sync_at: now,
          created_at: createdAt,
          updated_at: updatedAt,
          deleted_at: null,
          version,
        }];

        const tags = safeParseTags(data.tags);
        const isDeactivated = tags.includes('account_deactivated') || data.status === 'dead';
        if (data.ever_ready && !isDeactivated) {
          const providerSpecificData = normalizeProviderSpecificData(data.provider_specific_data || data.providerSpecificData) || {};
          const workspaceId = data.workspace_id || providerSpecificData.workspaceId || null;
          const mergedProviderData = {
            ...providerSpecificData,
            workspaceId: workspaceId || null,
            deviceId: data.device_id || providerSpecificData.deviceId || null,
            machineId: data.machine_id || providerSpecificData.machineId || null,
            proxyUrl: data.proxy_url || providerSpecificData.proxyUrl || null,
          };
          Object.keys(mergedProviderData).forEach((key) => {
            if (mergedProviderData[key] === null || mergedProviderData[key] === undefined) delete mergedProviderData[key];
          });
          const connectionIsActive = (data.is_active !== undefined && data.is_active !== null) ? (data.is_active === 0 ? 0 : 1) : 1;

          payload.connections = [{
            id: data.id,
            provider: data.provider || 'openai',
            email: data.email,
            name: data.email ? data.email.split('@')[0] : data.id,
            access_token: data.access_token || null,
            refresh_token: data.refresh_token || null,
            proxy_url: data.proxy_url || null,
            workspace_id: workspaceId,
            is_active: connectionIsActive,
            rate_limit_protection: 0,
            provider_specific_data: Object.keys(mergedProviderData).length ? mergedProviderData : null,
            created_at: createdAt,
            updated_at: updatedAt,
            deleted_at: null,
            version,
          }];
        } else {
          // Chưa từng ready → xóa connection khỏi Gateway nếu từng tồn tại
          payload.connections = [{ id: data.id, email: data.email, updated_at: now, deleted_at: now, is_active: 0, version }];
        }
      }
      // ✅ Rule 6: Account đang chạy (pending/processing/connecting/...) → chỉ push managedAccounts để Worker xử lý
      else {
        payload.managedAccounts = [{
          id: data.id,
          provider: data.provider || 'openai',
          email: data.email,
          password: data.password,
          two_fa_secret: data.two_fa_secret,
          proxy_url: data.proxy_url,
          proxy_id: null,
          status: data.status,
          is_active: data.is_active ?? 1,
          quota_json: data.quota_json || null,
          last_error: data.notes,
          last_sync_at: now,
          created_at: createdAt,
          updated_at: updatedAt,
          deleted_at: null,
          version,
        }];
        // Không tạo connection cho account chưa sẵn sàng
        payload.connections = [{ id: data.id, email: data.email, updated_at: now, deleted_at: now, is_active: 0, version }];
      }
    }
    if (type === 'email_pool') {
      payload.vaultEmailPool = [{ ...data, updated_at: data.updated_at || now }];
    }
    if (type === 'proxy') payload.vaultProxies = [{ ...data, updated_at: data.updated_at || now }];
    if (type === 'key') payload.vaultKeys = [{ ...data, updated_at: data.updated_at || now }];

    try {
      console.log(`[SyncManager] ☁️ Pushing ${type} to D1: ${data.email || data.id}`);
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

      // Update gateway_status on successful push for accounts
      if (type === 'account' && data.id) {
        try {
          const { vault } = await import('../db/vault.js');
          // undefined = không update, null/'active'/'revoked'/'pending_push' = update
          let newGatewayStatus = undefined;
          
          if (data.deleted_at) {
            // Rule 2: Hard delete → revoked
            newGatewayStatus = 'revoked';
          } else if (data.status === 'idle') {
            // Rule 3: Idle → revoked (soft-delete from Gateway)
            newGatewayStatus = 'revoked';
          } else if (data.status === 'ready') {
            // Rule 4: Ready → active
            newGatewayStatus = 'active';
          } else if (['error', 'need_phone', 'relogin', 'dead'].includes(data.status)) {
            // Rule 5: Error status
            const tags = safeParseTags(data.tags);
            const isDeactivated = tags.includes('account_deactivated') || data.status === 'dead';
            if (data.ever_ready && !isDeactivated) {
              // Keep active if was ever ready
              newGatewayStatus = 'active';
            } else {
              // Set revoked if never ready or deactivated/dead
              newGatewayStatus = 'revoked';
            }
          } else {
            // Rule 6: Processing status (pending/processing/...) → rollback pending_push về previous
            const currentAccount = vault.db.prepare(
              'SELECT gateway_status FROM vault_accounts WHERE id = ?'
            ).get(data.id);
            if (currentAccount?.gateway_status === 'pending_push') {
              vault.updateGatewayStatus(data.id, previousGatewayStatus);
            }
            // newGatewayStatus vẫn là undefined → không update thêm
          }
          
          if (newGatewayStatus !== undefined) {
            vault.updateGatewayStatus(data.id, newGatewayStatus);
          }
        } catch (e) {
          console.warn('[SyncManager] Could not update gateway_status after successful push:', e.message);
        }
      }

      const counts = result.counts || {};
      console.log(`[SyncManager] ✅ D1 Push OK: connections=${counts.connections || 0}, managedAccounts=${counts.managedAccounts || 0}, vaultAccounts=${counts.vaultAccounts || 0}`);
      if (Array.isArray(result.skipped) && result.skipped.length > 0) {
        console.warn('[SyncManager] ⚠️ D1 Push skipped records:', JSON.stringify(result.skipped));
      }
      if (Array.isArray(result.errors) && result.errors.length > 0) {
        console.warn('[SyncManager] ⚠️ D1 Push reported errors:', JSON.stringify(result.errors));
      }

      // Nếu là lệnh xóa, dọn cache
      if (data.deleted_at) {
        lastPushCache.delete(cacheKey);
        lastPushState.delete(cacheKey);
      }

      // Best-effort trigger to tell the gateway to sync/pull right away
      if (type === 'account') {
        const emailOrId = data.email || data.id;
        triggerGatewaySync(`push:${emailOrId}`).catch(() => {});
      }

      return result;
    } catch (e) {
      // Clear cache on failure to allow retrying
      lastPushCache.delete(cacheKey);
      if (type === 'account') {
        lastPushState.delete(cacheKey);
      }

      // Rollback gateway_status on failure (kể cả rollback về null)
      if (type === 'account' && data.id) {
        try {
          const { vault } = await import('../db/vault.js');
          // Luôn rollback về previousGatewayStatus (có thể là null)
          vault.updateGatewayStatus(data.id, previousGatewayStatus);
        } catch (rollbackError) {
          console.warn('[SyncManager] Could not rollback gateway_status:', rollbackError.message);
        }
      }
      console.error(`[SyncManager] ❌ Error syncing ${type}:`, e.message);
    }
  },

  async pullVault(since = '1970-01-01T00:00:00.000Z') {
  const cfg = loadConfig();
  if (!cfg.d1WorkerUrl || !cfg.d1SyncSecret) return null;

  try {
    const sinceStr = String(since ?? '');
    // Phase 2 optimization: cheap cursor preflight to avoid heavy /sync/pull scans.
    if (sinceStr && sinceStr !== '0') {
      const cursorRes = await fetch(`${cfg.d1WorkerUrl}/sync/cursor`, {
        headers: { 'x-sync-secret': cfg.d1SyncSecret }
      }).catch(() => null);
      if (cursorRes?.ok) {
        const cursorData = await cursorRes.json().catch(() => ({}));
        if (cursorData?.ok && typeof cursorData?.cursor === 'string' && cursorData.cursor <= sinceStr) {
          return null;
        }
      }
    }

    console.log(`[SyncManager] Pulling vault changes since ${since}...`);
    const tables = encodeURIComponent('vaultAccounts,vaultProxies,vaultKeys,managedAccounts,connections,vaultEmailPool');
    const res = await fetch(`${cfg.d1WorkerUrl}/sync/pull?since=${encodeURIComponent(since)}&tables=${tables}`, {
      headers: { 'x-sync-secret': cfg.d1SyncSecret }
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'D1 pull failed');

    // Check if we have new data
    if (data.ok && data.cursor && data.cursor > since) {
      // Hợp nhất dữ liệu song song (do Gateway đẩy lên codex_managed_accounts)
      // QUAN TRỌNG: import khẩu { vault } để tra cứu local accounts
      let localVault;
      try {
        const m = await import('../db/vault.js');
        localVault = m.vault;
      } catch (e) { localVault = null; }

      const accounts = [...(data.data?.vaultAccounts || [])];
      const gatewayAccounts = data.data?.managedAccounts || [];
      for (const ga of gatewayAccounts) {
        // Ưu tiên match by ID, sau đó by email (tránh tạo duplicate khi Gateway dùng ID khác)
        let existing = accounts.find(a => a.id === ga.id);
        if (!existing && ga.email) {
          existing = accounts.find(a => a.email && a.email.toLowerCase() === ga.email.toLowerCase());
        }

        // Nếu local DB có account cùng email nhưng chưa trong list, thêm vào
        if (!existing && ga.email && localVault) {
          // Tìm Kể CẢ deleted — tránh tạo duplicate khi local bị deleted_at tạm thời
          const localByEmail = localVault.db.prepare(
            'SELECT * FROM vault_accounts WHERE email = ? LIMIT 1'
          ).get(ga.email);
          if (localByEmail) {
            // Reset deleted_at nếu bị xóa ảo — đây là account thực cần giữ lại
            if (localByEmail.deleted_at) {
              localVault.db.prepare('UPDATE vault_accounts SET deleted_at=NULL WHERE id=?').run(localByEmail.id);
              console.log(`[pullVault] 🔄 Restored deleted account: ${localByEmail.email}`);
              localByEmail.deleted_at = null;
            }
            // Merge status từ Gateway vào local account (giữ nguyên ID local)
            existing = {
              ...localByEmail,
              tags: JSON.parse(localByEmail.tags || '[]'),
            };
            accounts.push(existing);
          }
        }

        if (!existing) {
          // Chỉ tạo mới nếu account thực sự chưa tồn tại ở bất kỳ đâu
          // Và phải có email hợp lệ để tránh rác
          if (ga.email && ga.email.trim()) {
            accounts.push({
              id: ga.id,
              provider: ga.provider || 'codex',
              email: ga.email,
              password: ga.password,           // Có thể null nếu từ Gateway
              two_fa_secret: ga.two_fa_secret, // Có thể null
              proxy_url: ga.proxy_url,
              status: ga.status,
              is_active: ga.is_active,
              quota_json: ga.quota_json,
              notes: ga.last_error,
              created_at: ga.created_at,
              updated_at: ga.updated_at,
              deleted_at: ga.deleted_at
            });
          }
        } else {
          try {
            // [FIX v5 — triệt để] Vault là kho ĐỘC LẬP.
            // Gateway tombstone CHỈ ảnh hưởng gateway_status (revoked), KHÔNG set local status.
            // User muốn thay đổi local status → bấm Stop/Deploy trong Vault UI.
            //
            // Trước đây logic này gây race condition:
            // 1. User xóa account (D1 tombstone)
            // 2. User Deploy lại (local = ready)
            // 3. pullVault nhận tombstone cũ → ghi đè ready thành idle
            //
            // Giải pháp: local.status chỉ thay đổi qua user action (Vault UI) hoặc worker callback (connect-result).
            // pullVault chỉ merge các field metadata không ảnh hưởng trạng thái flow (quota, proxy, notes).
            if (true) {
              // Check local DB để có quyết định chính xác cho mọi field merge
              let localRecord = null;
              if (localVault && existing.id) {
                try {
                  localRecord = localVault.db.prepare(
                    'SELECT status, ever_ready, connect_pending, updated_at FROM vault_accounts WHERE id = ?'
                  ).get(existing.id);
                } catch (_) {}
              }

              // KHÔNG ghi đè status. Chỉ áp dụng ga.status nếu local hoàn toàn chưa có (new account từ Gateway)
              if (!localRecord) {
                existing.status = ga.status || existing.status;
              }
              // Ngược lại: giữ nguyên existing.status (sẽ được overridden bởi local DB trong upsertAccount guard)

              // [PROTECT] Không cho Gateway ghi đè is_active khi account đang trong flow người dùng khởi tạo
              const localUserInitiated = localRecord && (
                localRecord.status === 'pending' ||
                localRecord.status === 'processing' ||
                Number(localRecord.connect_pending) > 0
              );
              if (!localUserInitiated) {
                existing.is_active = ga.is_active !== undefined ? ga.is_active : existing.is_active;
              }

              // Merge metadata fields (không ảnh hưởng trạng thái flow)
              existing.quota_json = ga.quota_json || existing.quota_json;
              existing.notes = ga.last_error || existing.notes;

              // KHÔNG set existing.deleted_at từ Gateway — Vault độc lập, chỉ xóa khi user explicit
              existing.updated_at = ga.updated_at || existing.updated_at;
              if (!existing.created_at && ga.created_at) existing.created_at = ga.created_at;
            }
          } catch (e) { }
        }
      }

      // ─── Filter rác: chỉ nhập accounts có email thực ───────────────────
      const JUNK_EMAILS = ['ghost@gmail.com', 'test@seellm.local', ''];
      const validAccounts = accounts.filter(a => {
        const email = (a.email || '').trim();
        if (!email) return false;
        if (JUNK_EMAILS.includes(email.toLowerCase())) return false;
        return true;
      });

      // Hợp nhất Token từ Connections (nếu Gateway rotate token thì Tools phải nắm được)
      const gatewayConnections = data.data?.connections || [];
      for (const conn of gatewayConnections) {
        const existing = validAccounts.find(a => a.id === conn.id);
        if (existing) {
          existing.access_token = conn.access_token || existing.access_token;
          existing.refresh_token = conn.refresh_token || existing.refresh_token;
          const remoteProviderData = normalizeProviderSpecificData(conn.provider_specific_data);
          if (conn.workspace_id || remoteProviderData?.workspaceId) {
            existing.workspace_id = conn.workspace_id || remoteProviderData?.workspaceId || existing.workspace_id || null;
          }
          if (remoteProviderData) {
            const localProviderData = normalizeProviderSpecificData(existing.provider_specific_data);
            existing.provider_specific_data = {
              ...(localProviderData || {}),
              ...remoteProviderData,
            };
          }
          if (existing.provider_specific_data?.deviceId && !existing.device_id) {
            existing.device_id = existing.provider_specific_data.deviceId;
          }
          if (existing.provider_specific_data?.machineId && !existing.machine_id) {
            existing.machine_id = existing.provider_specific_data.machineId;
          }
          try {
            if (conn.updated_at && (!existing.updated_at || new Date(conn.updated_at) > new Date(existing.updated_at))) {
              existing.updated_at = conn.updated_at;
            }
          } catch (e) { }
        }
      }

      // Update gateway_status based on managedAccounts and emit SSE events
      const changedIds = [];
      if (localVault) {
        for (const ga of gatewayAccounts) {
          // Find corresponding vault account
          let existing = validAccounts.find(a => a.id === ga.id);
          if (!existing && ga.email) {
            existing = validAccounts.find(a => a.email && a.email.toLowerCase() === ga.email.toLowerCase());
          }
          
          if (existing) {
            let newGatewayStatus = existing.gateway_status;
            
            if (ga.deleted_at) {
              // Gateway revocation: set to revoked but DON'T set deleted_at on vault account
              newGatewayStatus = 'revoked';
            } else if (ga.status === 'ready' && !ga.deleted_at) {
              // Active on gateway
              newGatewayStatus = 'active';
            }
            
            if (newGatewayStatus !== existing.gateway_status) {
              localVault.updateGatewayStatus(existing.id, newGatewayStatus);
              existing.gateway_status = newGatewayStatus;
              changedIds.push(existing.id);
            }
          }
        }
      }

      return {
        cursor: data.cursor,
        accounts: validAccounts,
        proxies: data.data?.vaultProxies || [],
        keys: data.data?.vaultKeys || [],
        emailPool: data.data?.vaultEmailPool || [],
        gatewayStatusChanged: changedIds.length > 0 ? changedIds : null
      };
    }
    return null;
  } catch (e) {
    console.error('[SyncManager] Pull failed:', e.message);
    return null;
  }
}
};
