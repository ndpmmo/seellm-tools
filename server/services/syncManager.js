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

function normalizeAccountState(data = {}) {
  const providerData = normalizeProviderSpecificData(data.provider_specific_data || data.providerSpecificData);
  return {
    id: data.id || null,
    email: data.email || null,
    password: data.password || null,
    two_fa_secret: data.two_fa_secret || null,
    status: data.status || null,
    is_active: data.is_active ?? data.isActive ?? 1,
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

    const cacheKey = `${type}:${data.id}`;
    const normalizedState = type === 'account' ? normalizeAccountState(data) : data;
    const fingerprint = hashJson(normalizedState);
    
    if (!force && lastPushCache.get(cacheKey) === fingerprint) {
      // console.log(`[SyncManager] 💤 Bỏ qua Push (Nội dung không đổi): ${data.email || data.id}`);
      return;
    }

    // --- DEBOUNCING (SAVE WRITES) ---
    // Nếu có nhiều yêu cầu đẩy cho cùng 1 account trong thời gian ngắn (ví dụ worker đổi status liên tục)
    // Chúng ta sẽ đợi 45 giây để gom lại nén thành 1 lần đẩy duy nhất.
    const shouldPushImmediately =
      type === 'account' ? isCriticalAccountChange(lastPushState.get(cacheKey), normalizedState) : false;

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

  async _executePush(type, data, fingerprint) {
    const cfg = loadConfig();
    const now = new Date().toISOString();
    const version = Date.now();
    const cacheKey = `${type}:${data.id}`;
    const createdAt = data.created_at || data.createdAt || now;
    const updatedAt = data.updated_at || data.updatedAt || now;

    // Cập nhật cache trước khi thực hiện
    lastPushCache.set(cacheKey, fingerprint);
    if (type === 'account') {
      lastPushState.set(cacheKey, normalizeAccountState(data));
    }

    // Wrap the record into the PushPayload format expected by the worker
    const payload = {};
    if (type === 'account') {
      payload.vaultAccounts = [{ ...data, created_at: createdAt, updated_at: updatedAt }];
      
      // Push đồng thời sang schema Gateway để Gateway nhìn thấy
      if (data.status !== 'idle' || data.deleted_at) {
        payload.managedAccounts = [{
          id: data.id,
          provider: data.provider || 'codex',
          email: data.email,
          password: data.password,
          two_fa_secret: data.two_fa_secret,
          proxy_url: data.proxy_url,
          proxy_id: null,
          status: data.status,
          is_active: data.is_active !== undefined ? data.is_active : 1,
          quota_json: data.quota_json || null,
          last_error: data.notes,
          last_sync_at: now,
          created_at: createdAt,
          updated_at: updatedAt,
          deleted_at: data.deleted_at || null,
          version,
        }];
      } else if (data.status === 'idle') {
        // Gửi lệnh xóa cho Gateway nhưng Vault vẫn giữ nguyên (Thu hồi kho lạnh)
        payload.managedAccounts = [{
          id: data.id,
          provider: data.provider || 'codex',
          email: data.email,
          created_at: createdAt,
          updated_at: now,
          deleted_at: now, // Soft-delete ở Gateway
          version,
        }];
      }
      
      // Luôn đồng bộ is_active vào codex_connections kể cả khi không có token
      // Chỉ dùng is_active trực tiếp từ data, không phụ thuộc vào status
      const connectionIsActive = (data.is_active !== undefined && data.is_active !== null) 
        ? (data.is_active === 0 ? 0 : 1) 
        : 1;
      const providerSpecificData = normalizeProviderSpecificData(data.provider_specific_data || data.providerSpecificData) || {};
      const workspaceId = data.workspace_id || providerSpecificData.workspaceId || null;
      const mergedProviderData = {
        ...providerSpecificData,
        workspaceId: workspaceId || providerSpecificData.workspaceId || null,
        deviceId: data.device_id || providerSpecificData.deviceId || null,
        machineId: data.machine_id || providerSpecificData.machineId || null,
        proxyUrl: data.proxy_url || providerSpecificData.proxyUrl || null,
      };
      Object.keys(mergedProviderData).forEach((key) => {
        if (mergedProviderData[key] === undefined) delete mergedProviderData[key];
      });
      payload.connections = [{
        id: data.id,
        provider: data.provider || 'codex',
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
        deleted_at: (data.status === 'idle') ? now : (data.deleted_at || null),
        version,
      }];
    }
    if (type === 'email_pool') {
      payload.vaultEmailPool = [{ ...data, updated_at: data.updated_at || now }];
    }
    if (type === 'proxy') payload.vaultProxies = [{ ...data, updated_at: data.updated_at || now }];
    if (type === 'key')   payload.vaultKeys   = [{ ...data, updated_at: data.updated_at || now }];

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
      
      const counts = result.counts || {};
      console.log(`[SyncManager] ✅ D1 Push OK: connections=${counts.connections||0}, managedAccounts=${counts.managedAccounts||0}, vaultAccounts=${counts.vaultAccounts||0}`);
      
      // Nếu là lệnh xóa, dọn cache
      if (data.deleted_at) {
        lastPushCache.delete(cacheKey);
        lastPushState.delete(cacheKey);
      }
      
      return result;
    } catch (e) {
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
        } catch(e) { localVault = null; }

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
              if (ga.updated_at && (!existing.updated_at || new Date(ga.updated_at) > new Date(existing.updated_at))) {
                // Khi Gateway gửi deleted_at (đã xóa account), chuyển về idle thay vì bỏ qua
                // Vault là kho độc lập — xóa ở Gateway = thu hồi về kho lạnh (idle)
                if (ga.deleted_at && !existing.deleted_at) {
                  // Gateway đã xóa account này khỏi D1 managed_accounts.
                  // Vault là kho lưu trữ ĐỘC LẬP → không xóa, không đổi status.
                  // #accounts sẽ tự không hiện nữa vì nó đọc thẳng từ D1.
                  existing.deleted_at = ga.deleted_at; // Đánh dấu để bỏ qua khi filter
                } else {
                  existing.status = ga.status || existing.status;
                  existing.is_active = ga.is_active !== undefined ? ga.is_active : existing.is_active;
                  existing.quota_json = ga.quota_json || existing.quota_json;
                  existing.notes = ga.last_error || existing.notes;
                  existing.deleted_at = ga.deleted_at;
                }
                if (!existing.created_at && ga.created_at) existing.created_at = ga.created_at;
                existing.updated_at = ga.updated_at;
              }
            } catch(e) {}
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
            } catch(e) {}
          }
        }

        return {
          cursor:   data.cursor,
          accounts: validAccounts,
          proxies:  data.data?.vaultProxies || [],
          keys:     data.data?.vaultKeys || [],
          emailPool: data.data?.vaultEmailPool || []
        };
      }
      return null;
    } catch (e) {
      console.error('[SyncManager] Pull failed:', e.message);
      return null;
    }
  }
};
