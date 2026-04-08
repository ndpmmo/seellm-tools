import { loadConfig } from '../db/config.js';

/**
 * SyncManager handles pushing Vault data to Cloudflare D1
 */
// Bộ nhớ đệm để tránh đẩy trùng dữ liệu không đổi (Save D1 Writes)
const lastPushCache = new Map();
// Đợi gom các yêu cầu đẩy (Debouncing)
const debounceTimeouts = new Map();

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

    // --- KIỂM TRA DUPLICATE (SAVE WRITES) ---
    // Tạo mã định danh cho nội dung: email + status + token + deleted_at
    const fingerprint = `${data.email}|${data.status}|${data.refresh_token ? 'HAVE_TOKEN' : 'NO_TOKEN'}|${data.deleted_at}`;
    const cacheKey = `${type}:${data.id}`;
    
    if (!force && lastPushCache.get(cacheKey) === fingerprint) {
      // console.log(`[SyncManager] 💤 Bỏ qua Push (Nội dung không đổi): ${data.email || data.id}`);
      return;
    }

    // --- DEBOUNCING (SAVE WRITES) ---
    // Nếu có nhiều yêu cầu đẩy cho cùng 1 account trong thời gian ngắn (ví dụ worker đổi status liên tục)
    // Chúng ta sẽ đợi 45 giây để gom lại nén thành 1 lần đẩy duy nhất.
    if (!force) {
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

    // Cập nhật cache trước khi thực hiện
    lastPushCache.set(cacheKey, fingerprint);

    // Wrap the record into the PushPayload format expected by the worker
    const payload = {};
    if (type === 'account') {
      payload.vaultAccounts = [{ ...data, updated_at: data.updated_at || now }];
      
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
          last_error: data.notes,
          last_sync_at: now,
          updated_at: now,
          deleted_at: data.deleted_at || null,
          version,
        }];
      } else if (data.status === 'idle') {
        // Gửi lệnh xóa cho Gateway nhưng Vault vẫn giữ nguyên (Thu hồi kho lạnh)
        payload.managedAccounts = [{
          id: data.id,
          provider: data.provider || 'codex',
          email: data.email,
          updated_at: now,
          deleted_at: now, // Soft-delete ở Gateway
          version,
        }];
      }
      
      if (data.refresh_token) {
        payload.connections = [{
          id: data.id,
          provider: data.provider || 'codex',
          email: data.email,
          name: data.email ? data.email.split('@')[0] : data.id,
          access_token: data.access_token,
          refresh_token: data.refresh_token,
          proxy_url: data.proxy_url,
          workspace_id: null,
          is_active: (data.status === 'ready' || data.status === 'success') ? 1 : 0,
          rate_limit_protection: 0,
          provider_specific_data: null,
          updated_at: now,
          deleted_at: (data.status === 'idle') ? now : (data.deleted_at || null),
          version,
        }];
      }
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
      console.log(`[SyncManager] Pulling vault changes since ${since}...`);
      const res = await fetch(`${cfg.d1WorkerUrl}/sync/pull?since=${encodeURIComponent(since)}`, {
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
                notes: ga.last_error,
                updated_at: ga.updated_at,
                deleted_at: ga.deleted_at
              });
            }
          } else {
            // Apply updates từ Gateway nếu mới hơn (chỉ cập nhật status, không ghi đè password)
            try {
              if (ga.updated_at && (!existing.updated_at || new Date(ga.updated_at) > new Date(existing.updated_at))) {
                existing.status = ga.status || existing.status;
                existing.notes = ga.last_error || existing.notes;
                // Bảo vệ: không ghi đè deleted_at lên local account đang active
                if (ga.deleted_at && !existing.deleted_at) {
                  console.log(`[pullVault] ⚠️ Bỏ qua deleted_at từ Gateway cho ${existing.email} (local active)`);
                } else {
                  existing.deleted_at = ga.deleted_at;
                }
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
          keys:     data.data?.vaultKeys || []
        };
      }
      return null;
    } catch (e) {
      console.error('[SyncManager] Pull failed:', e.message);
      return null;
    }
  }
};
