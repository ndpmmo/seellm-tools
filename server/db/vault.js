import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import cryptlib from 'cryptlib';
import { machineIdSync } from 'node-machine-id';
import { v4 as uuidv4 } from 'uuid';
import dayjs from 'dayjs';

/* ─── Setup ─────────────────────────────────────────────────────────────── */

const DATA_DIR = path.resolve('data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'vault.db');
const db = new Database(DB_PATH);

// Simple encryption using machineId as part of the salt
const mid = machineIdSync();
const SALT = 'seellm_vault_v3_salt';
const KEY  = cryptlib.getHash(mid + SALT, 'sha256').slice(0, 32);
const IV   = cryptlib.getHash(SALT + mid, 'sha256').slice(0, 16);

function encrypt(text) {
  if (!text) return null;
  return cryptlib.encrypt(text, KEY, IV);
}

function decrypt(cipher) {
  if (!cipher) return null;
  try { return cryptlib.decrypt(cipher, KEY, IV); } catch { return '***[DECRYPT_ERROR]***'; }
}

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

initSchema();

/* ─── Helpers ───────────────────────────────────────────────────────────── */

export const vault = {
  db,

  // CRUD ACCOUNTS
  getAccounts: () => {
    const list = db.prepare('SELECT * FROM vault_accounts ORDER BY updated_at DESC').all();
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

  getAccount: (id, decryptFull = false) => {
    const a = db.prepare('SELECT * FROM vault_accounts WHERE id = ?').get(id);
    if (!a) return null;
    if (decryptFull) {
      return {
        ...a,
        password:      decrypt(a.password),
        two_fa_secret: decrypt(a.two_fa_secret),
        access_token:  decrypt(a.access_token),
        refresh_token: decrypt(a.refresh_token),
        tags:          JSON.parse(a.tags || '[]'),
        cookies:       JSON.parse(a.cookies || '[]')
      };
    }
    return vault.getAccounts().find(x => x.id === id);
  },

  upsertAccount: (data) => {
    const id = data.id || `acc_${uuidv4().slice(0, 8)}`;
    const now = dayjs().toISOString();
    const existing = db.prepare('SELECT id FROM vault_accounts WHERE id = ?').get(id);

    const stmt = db.prepare(`
      INSERT INTO vault_accounts (
        id, provider, label, email, password, two_fa_secret, proxy_url, 
        cookies, access_token, refresh_token, status, notes, tags, 
        exported_to, exported_at, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
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
        updated_at    = excluded.updated_at
    `);

    stmt.run(
      id,
      data.provider || 'openai',
      data.label || '',
      data.email || '',
      data.password ? encrypt(data.password) : (existing ? undefined : null),
      data.two_fa_secret ? encrypt(data.two_fa_secret) : (existing ? undefined : null),
      data.proxy_url || null,
      JSON.stringify(data.cookies || []),
      data.access_token ? encrypt(data.access_token) : (existing ? undefined : null),
      data.refresh_token ? encrypt(data.refresh_token) : (existing ? undefined : null),
      data.status || 'idle',
      data.notes || '',
      JSON.stringify(data.tags || []),
      data.exported_to || null,
      data.exported_at || null,
      existing ? existing.created_at : now,
      now
    );
    return id;
  },

  deleteAccount: (id) => db.prepare('DELETE FROM vault_accounts WHERE id = ?').run(id),

  // CRUD PROXIES
  getProxies: () => db.prepare('SELECT * FROM vault_proxies ORDER BY created_at DESC').all(),
  
  upsertProxy: (data) => {
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
        notes       = excluded.notes
    `);
    stmt.run(
      id, data.label || '', data.url, data.type || 'http', data.country || null,
      data.provider || null, data.is_active ?? 1, data.last_tested || null,
      data.latency_ms || null, data.notes || '', now
    );
    return id;
  },

  deleteProxy: (id) => db.prepare('DELETE FROM vault_proxies WHERE id = ?').run(id),

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

  upsertApiKey: (data) => {
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
    stmt.run(
      id, data.provider, data.label || '', encrypt(data.key_value),
      data.base_url || null, data.is_active ?? 1, data.daily_limit || null,
      data.monthly_limit || null, data.notes || '', now
    );
    return id;
  },

  deleteApiKey: (id) => db.prepare('DELETE FROM vault_api_keys WHERE id = ?').run(id)
};
