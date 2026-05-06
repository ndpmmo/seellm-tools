import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import dayjs from 'dayjs';
import crypto from 'crypto';
import { SyncManager } from '../services/syncManager.js';

/* ─── Setup ─────────────────────────────────────────────────────────────── */

const DATA_DIR = path.resolve('data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'vault.db');
const db = new Database(DB_PATH);

// No encryption - store all values as plain text per user preference
const encrypt = (text) => text || null;
const decrypt = (cipher) => cipher || null;

/* ─── Migrations ────────────────────────────────────────────────────────── */

function initSchema() {
  db.exec(`
    -- Accounts
    CREATE TABLE IF NOT EXISTS vault_accounts (
      id            TEXT PRIMARY KEY,
      provider      TEXT NOT NULL,
      label         TEXT,
      email         TEXT,
      password      TEXT,
      two_fa_secret TEXT,
      proxy_url     TEXT,
      cookies       TEXT,
      access_token  TEXT,
      refresh_token TEXT,
      workspace_id  TEXT,
      device_id     TEXT,
      machine_id    TEXT,
      provider_specific_data TEXT,
      status        TEXT DEFAULT 'idle',
      notes         TEXT,
      tags          TEXT,
      exported_to   TEXT,
      exported_at   TEXT,
      plan          TEXT,
      is_active     INTEGER DEFAULT 1,
      quota_json    TEXT,
      ever_ready    INTEGER DEFAULT 0,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );

    -- Proxies
    CREATE TABLE IF NOT EXISTS vault_proxies (
      id          TEXT PRIMARY KEY,
      label       TEXT,
      url         TEXT NOT NULL,
      type        TEXT DEFAULT 'http',
      country     TEXT,
      provider    TEXT,
      is_active   INTEGER DEFAULT 1,
      last_tested TEXT,
      latency_ms  INTEGER,
      notes       TEXT,
      updated_at  TEXT NOT NULL,
      deleted_at  TEXT,
      created_at  TEXT NOT NULL
    );

    -- API Keys
    CREATE TABLE IF NOT EXISTS vault_api_keys (
      id            TEXT PRIMARY KEY,
      provider      TEXT NOT NULL,
      label         TEXT,
      key_value     TEXT NOT NULL,
      base_url      TEXT,
      is_active     INTEGER DEFAULT 1,
      daily_limit   INTEGER,
      monthly_limit INTEGER,
      notes         TEXT,
      updated_at    TEXT NOT NULL,
      deleted_at    TEXT,
      created_at    TEXT NOT NULL
    );

    -- Cookies
    CREATE TABLE IF NOT EXISTS vault_cookies (
      id         TEXT PRIMARY KEY,
      label      TEXT,
      domain     TEXT,
      data       TEXT NOT NULL,
      account_id TEXT,
      created_at TEXT NOT NULL
    );

    -- Email Pool
    CREATE TABLE IF NOT EXISTS vault_email_pool (
      email             TEXT PRIMARY KEY,
      password          TEXT,
      refresh_token     TEXT,
      client_id         TEXT,
      mail_status       TEXT DEFAULT 'unknown',
      chatgpt_status    TEXT DEFAULT 'not_created',
      linked_chatgpt_id TEXT,
      services_json     TEXT,
      last_checked_at   TEXT,
      notes             TEXT,
      updated_at        TEXT NOT NULL,
      created_at        TEXT NOT NULL
    );

    -- Browser Profiles (Multi Profile)
    CREATE TABLE IF NOT EXISTS browser_profiles (
      id                TEXT PRIMARY KEY,
      name              TEXT NOT NULL,
      group_name        TEXT DEFAULT '',
      user_agent        TEXT DEFAULT '',
      screen_resolution TEXT DEFAULT '1920x1080',
      language          TEXT DEFAULT 'en-US',
      timezone          TEXT DEFAULT 'America/New_York',
      webgl_vendor      TEXT DEFAULT '',
      webgl_renderer    TEXT DEFAULT '',
      canvas_noise      INTEGER DEFAULT 0,
      font_masking      TEXT DEFAULT '',
      proxy_url         TEXT DEFAULT '',
      start_url         TEXT DEFAULT 'about:blank',
      status            TEXT DEFAULT 'idle',
      camofox_port      INTEGER DEFAULT NULL,
      novnc_port        INTEGER DEFAULT NULL,
      camofox_pid       INTEGER DEFAULT NULL,
      tab_id            TEXT DEFAULT NULL,
      tags              TEXT DEFAULT '[]',
      notes             TEXT DEFAULT '',
      last_opened_at    TEXT DEFAULT NULL,
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL
    );
  `);
}

function applyMigrations() {
  // Add last_url to browser_profiles
  try {
    db.prepare(`ALTER TABLE browser_profiles ADD COLUMN last_url TEXT`).run();
    db.prepare(`UPDATE browser_profiles SET last_url = 'https://www.google.com' WHERE last_url IS NULL`).run();
  } catch (e) {
    // Column might already exist
  }

  // Specific migrations for other tables
  try { db.exec(`ALTER TABLE vault_email_pool ADD COLUMN services_json TEXT`); } catch (e) { }
  try { db.exec(`ALTER TABLE vault_accounts ADD COLUMN is_active INTEGER DEFAULT 1`); } catch (e) { }
  try { db.exec(`ALTER TABLE vault_accounts ADD COLUMN quota_json TEXT`); } catch (e) { }
  try {
    db.exec(`ALTER TABLE vault_accounts ADD COLUMN plan TEXT`);
  } catch (e) { }
  try { db.exec(`ALTER TABLE vault_accounts ADD COLUMN workspace_id TEXT`); } catch (e) { }
  try { db.exec(`ALTER TABLE vault_accounts ADD COLUMN device_id TEXT`); } catch (e) { }
  try { db.exec(`ALTER TABLE vault_accounts ADD COLUMN machine_id TEXT`); } catch (e) { }
  try { db.exec(`ALTER TABLE vault_accounts ADD COLUMN provider_specific_data TEXT`); } catch (e) { }
  try { db.exec(`ALTER TABLE vault_email_pool ADD COLUMN auth_method TEXT DEFAULT 'graph'`); } catch (e) { }
  try { db.exec(`ALTER TABLE vault_accounts ADD COLUMN ever_ready INTEGER DEFAULT 0`); } catch (e) { }
}

/* ─── Exported API ──────────────────────────────────────────────────────── */

initSchema();
applyMigrations();

/* ─── Helpers ───────────────────────────────────────────────────────────── */
function safeParseJson(raw, fallback) {
  if (!raw) return fallback;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return fallback; }
}

function safeParseJsonObject(raw) {
  const parsed = safeParseJson(raw, null);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed;
}

export const vault = {
  db,

  // CRUD ACCOUNTS
  getAccounts: () => {
    let rawList;
    try {
      rawList = db.prepare('SELECT * FROM vault_accounts WHERE deleted_at IS NULL ORDER BY updated_at DESC').all();
    } catch (e) {
      if (e.message.includes('no such column')) {
        rawList = db.prepare('SELECT * FROM vault_accounts ORDER BY updated_at DESC').all();
      } else throw e;
    }
    const list = rawList.filter(a => a.email && a.email.trim() !== '');
    return list.map(a => ({
      ...a,
      // Show plaintext - this is a personal tool
      password: a.password || '',
      two_fa_secret: a.two_fa_secret || '',
      access_token: '********',
      refresh_token: '********',
      tags: safeParseJson(a.tags, []),
      cookies: safeParseJson(a.cookies, []),
      provider_specific_data: safeParseJsonObject(a.provider_specific_data),
    }));
  },

  getAccount: (id) => {
    const a = db.prepare('SELECT * FROM vault_accounts WHERE id = ?').get(id);
    if (!a) return null;
    return {
      ...a,
      password: a.password,
      two_fa_secret: a.two_fa_secret,
      access_token: a.access_token,
      refresh_token: a.refresh_token,
      tags: safeParseJson(a.tags, []),
      cookies: safeParseJson(a.cookies, []),
      provider_specific_data: safeParseJsonObject(a.provider_specific_data),
    };
  },

  // Lấy danh sách tài khoản với credentials (dùng cho Task endpoint)
  getAccountsFull: () => {
    let rawList;
    try {
      rawList = db.prepare('SELECT * FROM vault_accounts WHERE deleted_at IS NULL ORDER BY updated_at DESC').all();
    } catch (e) {
      if (e.message.includes('no such column')) {
        rawList = db.prepare('SELECT * FROM vault_accounts ORDER BY updated_at DESC').all();
      } else throw e;
    }
    const list = rawList.filter(a => a.email && a.email.trim() !== '');
    return list.map(a => ({
      ...a,
      tags: safeParseJson(a.tags, []),
      cookies: safeParseJson(a.cookies, []),
      provider_specific_data: safeParseJsonObject(a.provider_specific_data),
    }));
  },

  getAccountFull: (id) => vault.getAccount(id),

  upsertAccount: (data, skipSync = false) => {
    let id = data.id || `acc_${uuidv4().slice(0, 8)}`;
    const now = dayjs().toISOString();
    let existing = db.prepare('SELECT * FROM vault_accounts WHERE id = ?').get(id);

    // Fallback: nếu không tìm thấy by ID nhưng có email → tìm by email (KỂ CẢ ĐÃ XÓA)
    // Tránh tạo duplicate khi người dùng xóa và thêm lại, hoặc Sync từ Gateway về
    if (!existing && data.email && data.email.trim()) {
      const byEmail = db.prepare(
        'SELECT * FROM vault_accounts WHERE email = ? LIMIT 1'
      ).get(data.email.trim());
      if (byEmail) {
        id = byEmail.id; // Tái sử dụng ID cũ để D1 thực hiện UPDATE thay vì INSERT
        existing = byEmail;
        console.log(`[Vault] Reusing ID for email ${data.email} → ID: ${id}`);

        // Nếu bản ghi cũ đang bị xóa ảo, khôi phục lại
        // [TOMBSTONE GUARD] Chỉ resurrect khi user-initiated (skipSync=false).
        // Khi pull từ D1 (skipSync=true), tôn trọng tombstone — không resurrect.
        if (byEmail.deleted_at && !skipSync) {
          db.prepare('UPDATE vault_accounts SET deleted_at = NULL WHERE id = ?').run(id);
          existing.deleted_at = null;
        }
      }
    }

    // Mapping D1 schema `last_error` to Tools schema `notes`
    let rawNotes = data.notes !== undefined ? data.notes :
      (data.last_error !== undefined ? data.last_error :
        (data.lastError !== undefined ? data.lastError : (existing ? existing.notes : '')));

    let finalStatus = (data.status || 'idle').toLowerCase();

    // [Protective Logic] Nếu local đang processing, không cho cloud ghi đè về pending
    if (existing && existing.status === 'processing' && finalStatus === 'pending') {
      finalStatus = 'processing';
    }

    // Auto-generate OAuth URL for Codex if it's a new account or missing auth data
    let authData = { notes: rawNotes || '' };
    if (data.provider === 'codex' && (finalStatus === 'pending' || finalStatus === 'relogin')) {
      const hasVerifier = existing?.notes?.includes('Verifier: ');
      if (!hasVerifier || finalStatus === 'relogin') {
        const codeVerifier = crypto.randomBytes(32).toString('base64url');
        const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
        const state = crypto.randomBytes(32).toString('base64url');
        const params = new URLSearchParams({
          response_type: "code",
          client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
          redirect_uri: "http://localhost:1455/auth/callback",
          scope: "openid profile email offline_access",
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
          id_token_add_organizations: "true",
          codex_cli_simplified_flow: "true",
          originator: "codex_cli_rs",
          state,
        });
        authData.notes = `OAuth URL: https://auth.openai.com/oauth/authorize?${params.toString()}\nVerifier: ${codeVerifier}`;
      } else {
        // Bảo toàn notes cũ nếu đã có PKCE
        authData.notes = rawNotes || (existing ? existing.notes : '');
      }
    } else if (finalStatus === 'ready' || finalStatus === 'idle') {
      authData.notes = ''; // Wipe error history visually if account recovered fully
    }

    const stmt = db.prepare(`
      INSERT INTO vault_accounts (
        id, provider, label, email, password, two_fa_secret, proxy_url, 
        cookies, access_token, refresh_token, workspace_id, device_id, machine_id, provider_specific_data, status, notes, tags, plan,
        is_active, quota_json, ever_ready, exported_to, exported_at, created_at, updated_at, deleted_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        provider      = excluded.provider,
        label         = excluded.label,
        email         = excluded.email,
        password      = excluded.password,
        two_fa_secret = excluded.two_fa_secret,
        proxy_url     = excluded.proxy_url,
        cookies       = excluded.cookies,
        access_token  = excluded.access_token,
        refresh_token = excluded.refresh_token,
        workspace_id  = excluded.workspace_id,
        device_id     = excluded.device_id,
        machine_id    = excluded.machine_id,
        provider_specific_data = excluded.provider_specific_data,
        status        = excluded.status,
        notes         = excluded.notes,
        tags          = excluded.tags,
        plan          = excluded.plan,
        is_active     = excluded.is_active,
        quota_json    = excluded.quota_json,
        ever_ready    = COALESCE(excluded.ever_ready, vault_accounts.ever_ready),
        exported_to   = excluded.exported_to,
        exported_at   = excluded.exported_at,
        updated_at    = excluded.updated_at,
        deleted_at    = excluded.deleted_at
    `);

    const parseJSON = (val) => {
      if (!val) return [];
      if (typeof val === 'object') return val;
      try { return JSON.parse(val); } catch (e) { return []; }
    };
    const parseJSONObject = (val) => {
      if (!val) return null;
      if (typeof val === 'object' && !Array.isArray(val)) return val;
      if (typeof val !== 'string') return null;
      try {
        const parsed = JSON.parse(val);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
      } catch {
        return null;
      }
    };

    const existingProviderData = parseJSONObject(existing?.provider_specific_data);
    const inputProviderData = parseJSONObject(data.provider_specific_data) || parseJSONObject(data.providerSpecificData);
    const mergedProviderData = {
      ...(existingProviderData || {}),
      ...(inputProviderData || {}),
    };

    const workspaceId =
      data.workspace_id ??
      data.workspaceId ??
      mergedProviderData.workspaceId ??
      existing?.workspace_id ??
      null;
    const deviceId =
      data.device_id ??
      data.deviceId ??
      mergedProviderData.deviceId ??
      existing?.device_id ??
      null;
    const machineId =
      data.machine_id ??
      data.machineId ??
      mergedProviderData.machineId ??
      existing?.machine_id ??
      null;

    if (workspaceId) mergedProviderData.workspaceId = workspaceId;
    if (deviceId) mergedProviderData.deviceId = deviceId;
    if (machineId) mergedProviderData.machineId = machineId;
    const providerSpecificDataRaw = Object.keys(mergedProviderData).length
      ? JSON.stringify(mergedProviderData)
      : null;

    const record = {
      id,
      provider: data.provider !== undefined ? data.provider : (existing ? existing.provider : 'codex'),
      label: data.label !== undefined ? data.label : (existing ? existing.label : ''),
      email: data.email !== undefined ? data.email : (existing ? existing.email : ''),
      password: data.password !== undefined ? data.password : (existing ? existing.password : null),
      two_fa_secret: data.two_fa_secret !== undefined ? data.two_fa_secret : (existing ? existing.two_fa_secret : null),
      proxy_url: data.proxy_url !== undefined ? data.proxy_url : (existing ? existing.proxy_url : null),
      cookies: JSON.stringify(parseJSON(data.cookies || (existing ? existing.cookies : '[]'))),
      access_token: data.access_token !== undefined ? data.access_token : (existing ? existing.access_token : null),
      refresh_token: data.refresh_token !== undefined ? data.refresh_token : (existing ? existing.refresh_token : null),
      workspace_id: workspaceId,
      device_id: deviceId,
      machine_id: machineId,
      provider_specific_data: providerSpecificDataRaw,
      status: finalStatus,
      notes: (authData.notes === null || authData.notes === 'null') ? '' : authData.notes,
      tags: JSON.stringify(parseJSON(data.tags || (existing ? existing.tags : '[]'))),
      plan: data.plan !== undefined ? data.plan : (existing ? existing.plan : null),
      is_active: data.is_active !== undefined ? data.is_active : (data.isActive !== undefined ? data.isActive : (existing ? existing.is_active : 1)),
      quota_json: data.quota_json !== undefined ? (typeof data.quota_json === 'object' ? JSON.stringify(data.quota_json) : data.quota_json) : (data.quotaJson !== undefined ? (typeof data.quotaJson === 'object' ? JSON.stringify(data.quotaJson) : data.quotaJson) : (existing ? existing.quota_json : null)),
      ever_ready: data.ever_ready !== undefined ? data.ever_ready : (existing ? existing.ever_ready : 0),
      exported_to: data.exported_to || null, exported_at: data.exported_at || null,
      created_at: existing ? existing.created_at : now, updated_at: now,
      // [CRITICAL FIX] Vault là kho độc lập.
      // Nếu có cờ data.restore_deleted = true, BĂT BUỘC ĐÁNH THỨC account (deleted_at = null)
      deleted_at: data.restore_deleted === true
        ? null
        : (skipSync
          ? (existing?.deleted_at || null)
          : (data.deleted_at !== undefined ? data.deleted_at : (existing ? existing.deleted_at : null))),
    };

    stmt.run(
      record.id, record.provider, record.label, record.email, record.password,
      record.two_fa_secret, record.proxy_url, record.cookies, record.access_token,
      record.refresh_token, record.workspace_id, record.device_id, record.machine_id, record.provider_specific_data, record.status, record.notes, record.tags, record.plan,
      record.is_active, record.quota_json, record.ever_ready,
      record.exported_to, record.exported_at, record.created_at, record.updated_at, record.deleted_at
    );

    // [Real-time Push]
    if (!skipSync) {
      SyncManager.pushVault('account', record).catch(() => { });
    }

    return record;
  },

  deleteAccount: (id, skipSync = false) => {
    const now = dayjs().toISOString();
    db.prepare('UPDATE vault_accounts SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now, now, id);
    const record = db.prepare('SELECT * FROM vault_accounts WHERE id = ?').get(id);
    if (!skipSync && record) {
      SyncManager.pushVault('account', record).catch(() => { });
    }
    return record;
  },

  // CRUD EMAIL POOL
  getEmailPool: () => {
    const list = db.prepare('SELECT * FROM vault_email_pool ORDER BY created_at DESC').all();
    return list.map(e => ({
      ...e,
      password: '********',
      services: safeParseJson(e.services_json, {}),
    }));
  },

  getEmailPoolFull: () => {
    const list = db.prepare('SELECT * FROM vault_email_pool ORDER BY created_at DESC').all();
    return list.map(e => ({
      ...e,
      services: safeParseJson(e.services_json, {}),
    }));
  },

  upsertEmailPool: (data, skipSync = false) => {
    const now = dayjs().toISOString();
    let existing = db.prepare('SELECT * FROM vault_email_pool WHERE email = ?').get(data.email);

    const stmt = db.prepare(`
      INSERT INTO vault_email_pool (
        email, password, refresh_token, client_id, auth_method, mail_status, chatgpt_status, linked_chatgpt_id, services_json, last_checked_at, notes, updated_at, created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(email) DO UPDATE SET
        password          = COALESCE(excluded.password, vault_email_pool.password),
        refresh_token     = COALESCE(excluded.refresh_token, vault_email_pool.refresh_token),
        client_id         = COALESCE(excluded.client_id, vault_email_pool.client_id),
        auth_method       = COALESCE(excluded.auth_method, vault_email_pool.auth_method),
        mail_status       = excluded.mail_status,
        chatgpt_status    = excluded.chatgpt_status,
        linked_chatgpt_id = excluded.linked_chatgpt_id,
        services_json     = excluded.services_json,
        last_checked_at   = excluded.last_checked_at,
        notes             = excluded.notes,
        updated_at        = excluded.updated_at
    `);

    // Merge services_json
    const existingServices = safeParseJson(existing?.services_json, {});
    const inputServices = typeof data.services === 'object' ? data.services : safeParseJson(data.services_json, {});
    const mergedServices = { ...existingServices, ...inputServices };

    // Auto sync chatgpt_status to services if present
    if (data.chatgpt_status === 'done') mergedServices.chatgpt = 'done';
    else if (data.chatgpt_status === 'failed') mergedServices.chatgpt = 'failed';

    const record = {
      email: data.email,
      password: data.password !== undefined ? data.password : (existing ? existing.password : null),
      refresh_token: data.refresh_token !== undefined ? data.refresh_token : (existing ? existing.refresh_token : null),
      client_id: data.client_id !== undefined ? data.client_id : (existing ? existing.client_id : null),
      auth_method: data.auth_method || (existing ? existing.auth_method : 'graph'),
      mail_status: data.mail_status || (existing ? existing.mail_status : 'unknown'),
      chatgpt_status: data.chatgpt_status || (existing ? existing.chatgpt_status : 'not_created'),
      linked_chatgpt_id: data.linked_chatgpt_id || (existing ? existing.linked_chatgpt_id : null),
      services_json: JSON.stringify(mergedServices),
      last_checked_at: data.last_checked_at || (existing ? existing.last_checked_at : null),
      notes: data.notes !== undefined ? data.notes : (existing ? existing.notes : ''),
      updated_at: now,
      created_at: existing ? existing.created_at : now
    };

    stmt.run(
      record.email, record.password, record.refresh_token, record.client_id, record.auth_method,
      record.mail_status, record.chatgpt_status, record.linked_chatgpt_id,
      record.services_json, record.last_checked_at, record.notes, record.updated_at, record.created_at
    );

    if (!skipSync) {
      SyncManager.pushVault('email_pool', record).catch(() => { });
    }

    return record;
  },

  deleteEmailPool: (email, skipSync = false) => {
    const record = db.prepare('SELECT * FROM vault_email_pool WHERE email = ?').get(email);
    db.prepare('DELETE FROM vault_email_pool WHERE email = ?').run(email);
    if (!skipSync && record) {
      // SyncManager delete currently doesn't support a separate delete type, 
      // but we can pass deleted_at if we want to mimic account logic.
      // For now, email pool can just be deleted.
      SyncManager.pushVault('email_pool', { ...record, deleted_at: dayjs().toISOString() }).catch(() => { });
    }
    return record;
  },

  // CRUD PROXIES
  getProxies: () => db.prepare('SELECT * FROM vault_proxies WHERE deleted_at IS NULL ORDER BY created_at DESC').all(),

  upsertProxy: (data, skipSync = false) => {
    let id = data.id;
    let existing = null;
    const now = dayjs().toISOString();

    // Deduplication logic: If no ID, check if URL already exists
    if (!id && data.url) {
      const byUrl = db.prepare('SELECT * FROM vault_proxies WHERE url = ? LIMIT 1').get(data.url);
      if (byUrl) {
        id = byUrl.id;
        existing = byUrl;
        // If it was deleted, restore it
        // [TOMBSTONE GUARD] Chỉ resurrect khi user-initiated (skipSync=false).
        // Khi pull từ D1 (skipSync=true), tôn trọng tombstone — không resurrect.
        if (byUrl.deleted_at && !skipSync) {
          db.prepare('UPDATE vault_proxies SET deleted_at = NULL WHERE id = ?').run(id);
          existing.deleted_at = null;
        }
      }
    }

    if (!id) id = `prx_${uuidv4().slice(0, 8)}`;
    
    const stmt = db.prepare(`
      INSERT INTO vault_proxies (
        id, label, url, type, country, provider, is_active, last_tested, latency_ms, notes, updated_at, deleted_at, created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        label       = COALESCE(excluded.label, vault_proxies.label),
        url         = excluded.url,
        type        = excluded.type,
        country     = COALESCE(excluded.country, vault_proxies.country),
        provider    = COALESCE(excluded.provider, vault_proxies.provider),
        is_active   = excluded.is_active,
        last_tested = excluded.last_tested,
        latency_ms  = excluded.latency_ms,
        notes       = excluded.notes,
        updated_at  = excluded.updated_at,
        deleted_at  = excluded.deleted_at
    `);
    const record = {
      id, 
      label: data.label || (existing ? existing.label : ''), 
      url: data.url, 
      type: data.type || (existing ? existing.type : 'http'),
      country: data.country || (existing ? existing.country : null),
      provider: data.provider || (existing ? existing.provider : null),
      is_active: data.is_active ?? 1,
      last_tested: data.last_tested || (existing ? existing.last_tested : null),
      latency_ms: data.latency_ms || (existing ? existing.latency_ms : null),
      notes: data.notes || (existing ? existing.notes : ''),
      deleted_at: data.deleted_at || null,
      updated_at: now,
      created_at: data.created_at || (existing ? existing.created_at : now),
    };

    stmt.run(
      record.id, record.label, record.url, record.type, record.country,
      record.provider, record.is_active, record.last_tested,
      record.latency_ms, record.notes, record.updated_at, record.deleted_at, record.created_at
    );


    // [Real-time Push]
    if (!skipSync) {
      SyncManager.pushVault('proxy', record).catch(() => { });
    }

    return record;
  },

  deleteProxy: (id, skipSync = false) => {
    const now = dayjs().toISOString();
    db.prepare('UPDATE vault_proxies SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now, now, id);
    const record = db.prepare('SELECT * FROM vault_proxies WHERE id = ?').get(id);
    if (!skipSync && record) {
      SyncManager.pushVault('proxy', record).catch(() => { });
    }
    return record;
  },

  // CRUD API KEYS
  getApiKeys: () => {
    const list = db.prepare('SELECT * FROM vault_api_keys WHERE deleted_at IS NULL ORDER BY created_at DESC').all();
    return list.map(k => ({ ...k, key_value: '****************' }));
  },

  getApiKey: (id, decryptVal = false) => {
    const k = db.prepare('SELECT * FROM vault_api_keys WHERE id = ?').get(id);
    if (!k) return null;
    return decryptVal ? { ...k, key_value: decrypt(k.key_value) } : { ...k, key_value: '****************' };
  },

  upsertApiKey: (data, skipSync = false) => {
    const id = data.id || `key_${uuidv4().slice(0, 8)}`;
    const now = dayjs().toISOString();
    const stmt = db.prepare(`
      INSERT INTO vault_api_keys (
        id, provider, label, key_value, base_url, is_active, daily_limit, monthly_limit, notes, updated_at, created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        provider      = excluded.provider,
        label         = excluded.label,
        key_value     = excluded.key_value,
        base_url      = excluded.base_url,
        is_active     = excluded.is_active,
        daily_limit   = excluded.daily_limit,
        monthly_limit = excluded.monthly_limit,
        notes         = excluded.notes
    `);
    const record = {
      id, provider: data.provider, label: data.label || '',
      api_key: encrypt(data.api_key), base_url: data.base_url || null,
      is_active: data.is_active ?? 1, daily_limit: data.daily_limit || null,
      monthly_limit: data.monthly_limit || null, notes: data.notes || '',
      updated_at: now, created_at: now
    };
    stmt.run(
      record.id, record.provider, record.label, record.api_key,
      record.base_url, record.is_active, record.daily_limit,
      record.monthly_limit, record.notes, record.updated_at, record.created_at
    );
    return record;
  },

  deleteApiKey: (id, skipSync = false) => {
    const now = dayjs().toISOString();
    db.prepare('UPDATE vault_api_keys SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now, now, id);
    return db.prepare('SELECT * FROM vault_api_keys WHERE id = ?').get(id);
  },

  // AUTOMATION HELPERS
  getPendingTask: () => {
    const a = db.prepare("SELECT * FROM vault_accounts WHERE status = 'pending' OR status = 'relogin' ORDER BY created_at ASC LIMIT 1").get();
    if (!a) return null;

    let loginUrl = null;
    let codeVerifier = null;
    if (a.notes && a.notes.includes('OAuth URL: ')) {
      const urlMatch = a.notes.match(/OAuth URL: (https:\/\/[^\n]+)/);
      const verMatch = a.notes.match(/Verifier: ([^\n]+)/);
      if (urlMatch) loginUrl = urlMatch[1];
      if (verMatch) codeVerifier = verMatch[1];
    }

    return {
      ...a,
      password: decrypt(a.password),
      two_fa_secret: decrypt(a.two_fa_secret),
      access_token: decrypt(a.access_token),
      refresh_token: decrypt(a.refresh_token),
      tags: JSON.parse(a.tags || '[]'),
      cookies: JSON.parse(a.cookies || '[]'),
      loginUrl,
      codeVerifier
    };
  },

  updateAccountStatus: (id, status, error = null) => {
    const now = dayjs().toISOString();
    const everReadyClause = status === 'ready' ? ', ever_ready = 1' : '';
    db.prepare(`UPDATE vault_accounts SET status = ?, notes = ?, updated_at = ?${everReadyClause} WHERE id = ?`).run(status, error || '', now, id);
  },

  // ─── BROWSER PROFILES (Multi Profile) ────────────────────────────────────

  getProfiles: () => {
    return db.prepare('SELECT * FROM browser_profiles ORDER BY last_opened_at DESC NULLS LAST, created_at DESC').all()
      .map(p => ({ ...p, tags: safeParseJson(p.tags, []) }));
  },

  getProfile: (id) => {
    const p = db.prepare('SELECT * FROM browser_profiles WHERE id = ?').get(id);
    if (!p) return null;
    return { ...p, tags: safeParseJson(p.tags, []) };
  },

  getActiveProfiles: () => {
    return db.prepare("SELECT * FROM browser_profiles WHERE status = 'active' ORDER BY camofox_port").all()
      .map(p => ({ ...p, tags: safeParseJson(p.tags, []) }));
  },

  upsertProfile: (data) => {
    const id = data.id || `prof_${uuidv4().slice(0, 8)}`;
    const now = dayjs().toISOString();
    const existing = db.prepare('SELECT * FROM browser_profiles WHERE id = ?').get(id);

    const stmt = db.prepare(`
      INSERT INTO browser_profiles (
        id, name, group_name, user_agent, screen_resolution, language, timezone,
        webgl_vendor, webgl_renderer, canvas_noise, font_masking,
        proxy_url, start_url, status, camofox_port, novnc_port, camofox_pid, tab_id,
        tags, notes, last_url, last_opened_at, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        name              = excluded.name,
        group_name        = excluded.group_name,
        user_agent        = excluded.user_agent,
        screen_resolution = excluded.screen_resolution,
        language          = excluded.language,
        timezone          = excluded.timezone,
        webgl_vendor      = excluded.webgl_vendor,
        webgl_renderer    = excluded.webgl_renderer,
        canvas_noise      = excluded.canvas_noise,
        font_masking      = excluded.font_masking,
        proxy_url         = excluded.proxy_url,
        start_url         = excluded.start_url,
        status            = excluded.status,
        camofox_port      = excluded.camofox_port,
        novnc_port        = excluded.novnc_port,
        camofox_pid       = excluded.camofox_pid,
        tab_id            = excluded.tab_id,
        tags              = excluded.tags,
        notes             = excluded.notes,
        last_url          = excluded.last_url,
        last_opened_at    = excluded.last_opened_at,
        updated_at        = excluded.updated_at
    `);

    const record = {
      id,
      name: data.name ?? existing?.name ?? '',
      group_name: data.group_name ?? existing?.group_name ?? '',
      user_agent: data.user_agent ?? existing?.user_agent ?? '',
      screen_resolution: data.screen_resolution ?? existing?.screen_resolution ?? '1920x1080',
      language: data.language ?? existing?.language ?? 'en-US',
      timezone: data.timezone ?? existing?.timezone ?? 'America/New_York',
      webgl_vendor: data.webgl_vendor ?? existing?.webgl_vendor ?? '',
      webgl_renderer: data.webgl_renderer ?? existing?.webgl_renderer ?? '',
      canvas_noise: data.canvas_noise ?? existing?.canvas_noise ?? 0,
      font_masking: data.font_masking ?? existing?.font_masking ?? '',
      proxy_url: data.proxy_url ?? existing?.proxy_url ?? '',
      start_url: data.start_url ?? existing?.start_url ?? 'https://www.google.com',
      status: data.status ?? existing?.status ?? 'idle',
      camofox_port: data.camofox_port ?? existing?.camofox_port ?? null,
      novnc_port: data.novnc_port ?? existing?.novnc_port ?? null,
      camofox_pid: data.camofox_pid ?? existing?.camofox_pid ?? null,
      tab_id: data.tab_id ?? existing?.tab_id ?? null,
      tags: JSON.stringify(data.tags ?? (existing ? safeParseJson(existing.tags, []) : [])),
      notes: data.notes ?? existing?.notes ?? '',
      last_url: data.last_url ?? existing?.last_url ?? 'https://www.google.com',
      last_opened_at: data.last_opened_at ?? existing?.last_opened_at ?? null,
      created_at: existing ? existing.created_at : now,
      updated_at: now,
    };

    stmt.run(
      record.id, record.name, record.group_name, record.user_agent, record.screen_resolution,
      record.language, record.timezone, record.webgl_vendor, record.webgl_renderer,
      record.canvas_noise, record.font_masking, record.proxy_url, record.start_url,
      record.status, record.camofox_port, record.novnc_port, record.camofox_pid, record.tab_id,
      record.tags, record.notes, record.last_url, record.last_opened_at, record.created_at, record.updated_at
    );
    return record;
  },

  deleteProfile: (id) => {
    db.prepare('DELETE FROM browser_profiles WHERE id = ?').run(id);
  },

  updateProfileRuntime: (id, { status, camofox_port, novnc_port, camofox_pid, tab_id }) => {
    const now = dayjs().toISOString();
    const lastOpened = status === 'active' ? now : undefined;
    
    if (lastOpened) {
      db.prepare(`
        UPDATE browser_profiles 
        SET status = ?, camofox_port = ?, novnc_port = ?, camofox_pid = ?, tab_id = ?, last_opened_at = ?, updated_at = ?
        WHERE id = ?
      `).run(status, camofox_port, novnc_port, camofox_pid, tab_id, lastOpened, now, id);
    } else {
      db.prepare(`
        UPDATE browser_profiles 
        SET status = ?, camofox_port = ?, novnc_port = ?, camofox_pid = ?, tab_id = ?, updated_at = ?
        WHERE id = ?
      `).run(status, camofox_port, novnc_port, camofox_pid, tab_id, now, id);
    }
  },

  updateProfileLastUrl: (id, url) => {
    if (!url) return;
    db.prepare('UPDATE browser_profiles SET last_url = ?, updated_at = ? WHERE id = ?')
      .run(url, dayjs().toISOString(), id);
  },

  cloneProfile: (id, newName) => {
    const src = db.prepare('SELECT * FROM browser_profiles WHERE id = ?').get(id);
    if (!src) return null;
    const newId = `prof_${uuidv4().slice(0, 8)}`;
    const now = dayjs().toISOString();
    db.prepare(`
      INSERT INTO browser_profiles (
        id, name, group_name, user_agent, screen_resolution, language, timezone,
        webgl_vendor, webgl_renderer, canvas_noise, font_masking,
        proxy_url, start_url, status, tags, notes, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      newId, newName || `${src.name} (Copy)`, src.group_name, src.user_agent, src.screen_resolution,
      src.language, src.timezone, src.webgl_vendor, src.webgl_renderer,
      src.canvas_noise, src.font_masking, src.proxy_url, src.start_url,
      'idle', src.tags, '', now, now
    );
    return vault.getProfile(newId);
  },
};
