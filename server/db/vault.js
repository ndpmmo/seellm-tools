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
      status        TEXT DEFAULT 'idle',
      notes         TEXT,
      tags          TEXT,
      exported_to   TEXT,
      exported_at   TEXT,
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
    )
  `);
}

function applyMigrations() {
  const tables = ['vault_accounts', 'vault_proxies', 'vault_api_keys'];
  for (const t of tables) {
    try {
      db.exec(`ALTER TABLE ${t} ADD COLUMN deleted_at TEXT`);
    } catch (e) {
      // Bỏ qua nếu cột đã tồn tại
    }
  }
}

/* ─── Exported API ──────────────────────────────────────────────────────── */

initSchema();
applyMigrations();

/* ─── Helpers ───────────────────────────────────────────────────────────── */

export const vault = {
  db,

  // CRUD ACCOUNTS
  getAccounts: () => {
    let rawList;
    try {
      rawList = db.prepare('SELECT * FROM vault_accounts WHERE deleted_at IS NULL ORDER BY updated_at DESC').all();
    } catch(e) {
      if (e.message.includes('no such column')) {
        rawList = db.prepare('SELECT * FROM vault_accounts ORDER BY updated_at DESC').all();
      } else throw e;
    }
    const list = rawList.filter(a => a.email && a.email.trim() !== '');
    return list.map(a => ({
      ...a,
      password:      '********', // masked by default
      two_fa_secret: '********',
      access_token:  '********',
      refresh_token: '********',
      tags:          JSON.parse(a.tags || '[]'),
      cookies:       JSON.parse(a.cookies || '[]')
    }));
  },

  getAccount: (id) => {
    const a = db.prepare('SELECT * FROM vault_accounts WHERE id = ?').get(id);
    if (!a) return null;
    return {
      ...a,
      password:      a.password,
      two_fa_secret: a.two_fa_secret,
      access_token:  a.access_token,
      refresh_token: a.refresh_token,
      tags:          JSON.parse(a.tags || '[]'),
      cookies:       JSON.parse(a.cookies || '[]')
    };
  },

  // Lấy danh sách tài khoản với credentials (dùng cho Task endpoint)
  getAccountsFull: () => {
    let rawList;
    try {
      rawList = db.prepare('SELECT * FROM vault_accounts WHERE deleted_at IS NULL ORDER BY updated_at DESC').all();
    } catch(e) {
      if (e.message.includes('no such column')) {
        rawList = db.prepare('SELECT * FROM vault_accounts ORDER BY updated_at DESC').all();
      } else throw e;
    }
    const list = rawList.filter(a => a.email && a.email.trim() !== '');
    return list.map(a => ({
      ...a,
      tags:    JSON.parse(a.tags || '[]'),
      cookies: JSON.parse(a.cookies || '[]')
    }));
  },

  getAccountFull: (id) => vault.getAccount(id),

  upsertAccount: (data, skipSync = false) => {
    const id = data.id || `acc_${uuidv4().slice(0, 8)}`;
    const now = dayjs().toISOString();
    const existing = db.prepare('SELECT * FROM vault_accounts WHERE id = ?').get(id);

    // Mapping D1 schema `last_error` to Tools schema `notes`
    let rawNotes = data.notes !== undefined ? data.notes : 
                   (data.last_error !== undefined ? data.last_error : 
                   (data.lastError !== undefined ? data.lastError : (existing ? existing.notes : '')));
    
    const finalStatus = (data.status || 'idle').toLowerCase();
    
    // Auto-generate OAuth URL for Codex if it's a new account or missing auth data
    let authData = { notes: rawNotes || '' };
    if (data.provider === 'codex' && (!existing || finalStatus === 'pending' || finalStatus === 'relogin')) {
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
    } else if (finalStatus === 'ready' || finalStatus === 'idle') {
      authData.notes = ''; // Wipe error history visually if account recovered fully
    }

    const stmt = db.prepare(`
      INSERT INTO vault_accounts (
        id, provider, label, email, password, two_fa_secret, proxy_url, 
        cookies, access_token, refresh_token, status, notes, tags, 
        exported_to, exported_at, created_at, updated_at, deleted_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
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
        status        = excluded.status,
        notes         = excluded.notes,
        tags          = excluded.tags,
        exported_to   = excluded.exported_to,
        exported_at   = excluded.exported_at,
        updated_at    = excluded.updated_at,
        deleted_at    = excluded.deleted_at
    `);

    const record = {
      id, 
      provider: data.provider !== undefined ? data.provider : (existing ? existing.provider : 'codex'), 
      label: data.label !== undefined ? data.label : (existing ? existing.label : ''), 
      email: data.email !== undefined ? data.email : (existing ? existing.email : ''), 
      password: data.password !== undefined ? data.password : (existing ? existing.password : null),
      two_fa_secret: data.two_fa_secret !== undefined ? data.two_fa_secret : (existing ? existing.two_fa_secret : null),
      proxy_url: data.proxy_url !== undefined ? data.proxy_url : (existing ? existing.proxy_url : null), 
      cookies: JSON.stringify(data.cookies || (existing ? JSON.parse(existing.cookies || '[]') : [])),
      access_token: data.access_token !== undefined ? data.access_token : (existing ? existing.access_token : null),
      refresh_token: data.refresh_token !== undefined ? data.refresh_token : (existing ? existing.refresh_token : null),
      status: finalStatus,
      notes: (authData.notes === null || authData.notes === 'null') ? '' : authData.notes,
      tags: JSON.stringify(data.tags || (existing ? JSON.parse(existing.tags || '[]') : [])),
      exported_to: data.exported_to || null, exported_at: data.exported_at || null,
      created_at: existing ? existing.created_at : now, updated_at: now,
      deleted_at: data.deleted_at || (existing ? existing.deleted_at : null)
    };

    stmt.run(
      record.id, record.provider, record.label, record.email, record.password,
      record.two_fa_secret, record.proxy_url, record.cookies, record.access_token,
      record.refresh_token, record.status, record.notes, record.tags,
      record.exported_to, record.exported_at, record.created_at, record.updated_at, record.deleted_at
    );

    // [Real-time Push]
    if (!skipSync) {
      SyncManager.pushVault('account', record).catch(() => {});
    }

    return record;
  },

  deleteAccount: (id, skipSync = false) => {
    const now = dayjs().toISOString();
    db.prepare('UPDATE vault_accounts SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now, now, id);
    const record = db.prepare('SELECT * FROM vault_accounts WHERE id = ?').get(id);
    if (!skipSync && record) {
      SyncManager.pushVault('account', record).catch(() => {});
    }
    return record;
  },

  // CRUD PROXIES
  getProxies: () => db.prepare('SELECT * FROM vault_proxies ORDER BY created_at DESC').all(),
  
  upsertProxy: (data, skipSync = false) => {
    const id = data.id || `prx_${uuidv4().slice(0, 8)}`;
    const now = dayjs().toISOString();
    const stmt = db.prepare(`
      INSERT INTO vault_proxies (
        id, label, url, type, country, provider, is_active, last_tested, latency_ms, notes, created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        label       = excluded.label,
        url         = excluded.url,
        type        = excluded.type,
        country     = excluded.country,
        provider    = excluded.provider,
        is_active   = excluded.is_active,
        last_tested = excluded.last_tested,
        latency_ms  = excluded.latency_ms,
        notes       = excluded.notes,
        updated_at  = excluded.updated_at
    `);
    const record = {
      id, label: data.label || '', url: data.url, type: data.type || 'http', 
      country: data.country || null, provider: data.provider || null, 
      is_active: data.is_active ?? 1, last_tested: data.last_tested || null,
      latency_ms: data.latency_ms || null, notes: data.notes || '', 
      updated_at: now, created_at: now
    };
    stmt.run(
      record.id, record.label, record.url, record.type, record.country,
      record.provider, record.is_active, record.last_tested,
      record.latency_ms, record.notes, record.updated_at, record.created_at
    );

    // [Real-time Push]
    if (!skipSync) {
      SyncManager.pushVault('proxy', record).catch(() => {});
    }

    return record;
  },

  deleteProxy: (id, skipSync = false) => {
    const now = dayjs().toISOString();
    db.prepare('UPDATE vault_proxies SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now, now, id);
    const record = db.prepare('SELECT * FROM vault_proxies WHERE id = ?').get(id);
    if (!skipSync && record) {
      SyncManager.pushVault('proxy', record).catch(() => {});
    }
    return record;
  },

  // CRUD API KEYS
  getApiKeys: () => {
    const list = db.prepare('SELECT * FROM vault_api_keys ORDER BY created_at DESC').all();
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
        id, provider, label, key_value, base_url, is_active, daily_limit, monthly_limit, notes, created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?)
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
      password:      decrypt(a.password),
      two_fa_secret: decrypt(a.two_fa_secret),
      access_token:  decrypt(a.access_token),
      refresh_token: decrypt(a.refresh_token),
      tags:          JSON.parse(a.tags || '[]'),
      cookies:       JSON.parse(a.cookies || '[]'),
      loginUrl,
      codeVerifier
    };
  },

  updateAccountStatus: (id, status, error = null) => {
    const now = dayjs().toISOString();
    db.prepare('UPDATE vault_accounts SET status = ?, notes = ?, updated_at = ? WHERE id = ?').run(status, error || '', now, id);
  }
};
