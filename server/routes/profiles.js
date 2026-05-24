/**
 * Profile API Router — CRUD + launch/close + runtime operations for browser profiles.
 */

import express from 'express';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import { vault } from '../db/vault.js';
import { loadConfig, saveConfig } from '../db/config.js';
import {
  launchProfile, closeProfile, getProfileApiUrl, getProfileVncUrl, findAvailablePort
} from '../profileManager.js';
import { FINGERPRINT_PRESETS, TIMEZONE_OPTIONS, LANGUAGE_OPTIONS, RESOLUTION_OPTIONS } from '../fingerprintPresets.js';
import { auditLog } from '../db/auditLog.js';
import { broadcastAudit } from './auditLog.js';

const router = express.Router();
router.use(express.json());

// SSE emitter — set from server.js
let emitSSE = null;
export function setProfileSSEEmitter(emitter) {
  emitSSE = emitter;
}

/** Helper: audit + broadcast realtime */
function logAudit(opts) {
  const entry = auditLog(opts);
  broadcastAudit({ ...opts, id: entry.id, createdAt: entry.createdAt });
  return entry;
}

// ─── CRUD ──────────────────────────────────────────────────────────────────

/** List all profiles */
router.get('/', (_, res) => {
  res.json(vault.getProfiles());
});

/** Get fingerprint presets + options (for UI dropdowns) */
router.get('/options', (_, res) => {
  res.json({
    presets: Object.entries(FINGERPRINT_PRESETS).map(([key, val]) => ({
      key,
      label: val.label,
      icon: val.icon,
    })),
    timezones: TIMEZONE_OPTIONS,
    languages: LANGUAGE_OPTIONS,
    resolutions: RESOLUTION_OPTIONS,
    proxies: vault.getProxies().map(p => ({ id: p.id, label: p.label || p.url, url: p.url })),
  });
});

/** Get active profiles */
router.get('/active', (_, res) => {
  res.json(vault.getActiveProfiles());
});

/** Get port usage info */
router.get('/ports', (_, res) => {
  const active = vault.getActiveProfiles();
  const usedPorts = active.map(p => ({ profileId: p.id, name: p.name, camofox_port: p.camofox_port, novnc_port: p.novnc_port }));
  const availablePort = findAvailablePort();
  res.json({ used: usedPorts, availablePort, maxProfiles: 10 });
});

/** Get single profile */
router.get('/:id', (req, res) => {
  const p = vault.getProfile(req.params.id);
  if (!p) return res.status(404).json({ error: 'Profile not found' });
  res.json(p);
});

/** Create profile */
router.post('/', (req, res) => {
  const data = req.body;
  if (!data.name) return res.status(400).json({ error: 'name is required' });

  // If preset specified, apply preset values first then override with explicit fields
  if (data.preset && FINGERPRINT_PRESETS[data.preset]) {
    const preset = FINGERPRINT_PRESETS[data.preset];
    data.user_agent = data.user_agent || preset.user_agent;
    data.screen_resolution = data.screen_resolution || preset.screen_resolution;
    data.language = data.language || preset.language;
    data.timezone = data.timezone || preset.timezone;
    data.webgl_vendor = data.webgl_vendor || preset.webgl_vendor;
    data.webgl_renderer = data.webgl_renderer || preset.webgl_renderer;
    data.canvas_noise = data.canvas_noise ?? preset.canvas_noise;
    data.font_masking = data.font_masking || preset.font_masking;
  }

  const record = vault.upsertProfile(data);
  res.json({ ok: true, profile: record });

  logAudit({
    action: 'create',
    entity: 'profile',
    entityId: record.id,
    entityLabel: record.name,
    details: { preset: data.preset, proxy: !!data.proxy_url },
    severity: 'success',
    source: 'ui',
  });
});

/** Update profile */
router.put('/:id', (req, res) => {
  const p = vault.getProfile(req.params.id);
  if (!p) return res.status(404).json({ error: 'Profile not found' });

  // Don't allow updating runtime fields directly via PUT
  const { status, camofox_port, novnc_port, camofox_pid, tab_id, ...safeData } = req.body;
  safeData.id = req.params.id;

  const record = vault.upsertProfile(safeData);
  res.json({ ok: true, profile: record });

  logAudit({
    action: 'update',
    entity: 'profile',
    entityId: req.params.id,
    entityLabel: p.name,
    severity: 'info',
    source: 'ui',
  });
});

/** Delete profile */
router.delete('/:id', async (req, res) => {
  const p = vault.getProfile(req.params.id);
  if (!p) return res.status(404).json({ error: 'Profile not found' });

  // Close profile if active
  if (p.status === 'active') {
    const closeResult = await closeProfile(p.id, emitSSE);
    if (!closeResult.ok) return res.status(400).json({ error: `Cannot close active profile: ${closeResult.error}` });
  }

  // Physical delete of profile data directory
  try {
    const profileDir = path.join(os.homedir(), '.camofox', 'profiles', p.id);
    if (fs.existsSync(profileDir)) {
      fs.rmSync(profileDir, { recursive: true, force: true });
    }
  } catch (e) {
    console.warn(`[Profiles] Failed to physically delete profile dir for ${p.id}:`, e.message);
  }

  vault.deleteProfile(p.id);
  res.json({ ok: true, deleted: p.id });

  logAudit({
    action: 'delete',
    entity: 'profile',
    entityId: p.id,
    entityLabel: p.name,
    severity: 'warning',
    source: 'ui',
  });
});

/** Clone profile */
router.post('/:id/clone', (req, res) => {
  const { name } = req.body || {};
  const cloned = vault.cloneProfile(req.params.id, name);
  if (!cloned) return res.status(404).json({ error: 'Source profile not found' });
  res.json({ ok: true, profile: cloned });

  logAudit({
    action: 'clone',
    entity: 'profile',
    entityId: cloned.id,
    entityLabel: cloned.name,
    details: { sourceId: req.params.id },
    severity: 'info',
    source: 'ui',
  });
});

// ─── Runtime Operations ────────────────────────────────────────────────────

/** Launch profile (start Camofox instance) */
router.post('/:id/launch', async (req, res) => {
  const p = vault.getProfile(req.params.id);
  if (!p) return res.status(404).json({ error: 'Profile not found' });
  if (p.status === 'active') return res.status(400).json({ error: 'Profile is already active', port: p.camofox_port, novncPort: p.novnc_port });

  const result = await launchProfile(req.params.id, emitSSE);
  if (!result.ok) return res.status(500).json(result);
  res.json(result);

  logAudit({
    action: 'launch',
    entity: 'profile',
    entityId: req.params.id,
    entityLabel: p.name,
    details: { port: result.port, novncPort: result.novncPort },
    severity: 'success',
    source: 'ui',
  });
});

/** Close profile (stop Camofox instance) */
router.post('/:id/close', async (req, res) => {
  const result = await closeProfile(req.params.id, emitSSE);
  if (!result.ok) return res.status(400).json(result);
  res.json(result);

  const p = vault.getProfile(req.params.id);
  logAudit({
    action: 'close',
    entity: 'profile',
    entityId: req.params.id,
    entityLabel: p?.name || req.params.id,
    severity: 'info',
    source: 'ui',
  });
});

/** Get cookies from profile's Camofox instance */
router.get('/:id/cookies', async (req, res) => {
  const p = vault.getProfile(req.params.id);
  if (!p) return res.status(404).json({ error: 'Profile not found' });
  if (p.status !== 'active' || !p.camofox_port) return res.status(400).json({ error: 'Profile not active' });

  try {
    const userId = `profile-${p.id}`;
    const r = await fetch(`http://localhost:${p.camofox_port}/sessions/${userId}/cookies`, {
      signal: AbortSignal.timeout(5000),
    });
    const data = await r.json();
    res.json({ ok: true, cookies: data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/** Get tab snapshot */
router.get('/:id/snapshot', async (req, res) => {
  const p = vault.getProfile(req.params.id);
  if (!p) return res.status(404).json({ error: 'Profile not found' });
  if (p.status !== 'active' || !p.camofox_port || !p.tab_id) return res.status(400).json({ error: 'Profile not active or no tab' });

  try {
    const userId = `profile-${p.id}`;
    const r = await fetch(`http://localhost:${p.camofox_port}/tabs/${p.tab_id}/snapshot?userId=${userId}&screenshot=true`, {
      signal: AbortSignal.timeout(10000),
    });
    const data = await r.json();
    res.json({ ok: true, snapshot: data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/** Navigate profile tab */
router.post('/:id/navigate', async (req, res) => {
  const p = vault.getProfile(req.params.id);
  if (!p) return res.status(404).json({ error: 'Profile not found' });
  if (p.status !== 'active' || !p.camofox_port || !p.tab_id) return res.status(400).json({ error: 'Profile not active or no tab' });

  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'url is required' });

  try {
    const userId = `profile-${p.id}`;
    const r = await fetch(`http://localhost:${p.camofox_port}/tabs/${p.tab_id}/navigate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, url }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await r.json();
    res.json({ ok: true, result: data });

    logAudit({
      action: 'navigate',
      entity: 'profile',
      entityId: req.params.id,
      entityLabel: p.name,
      details: { url },
      severity: 'info',
      source: 'ui',
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/** Get storage state (cookies + localStorage) */
router.get('/:id/storage-state', async (req, res) => {
  const p = vault.getProfile(req.params.id);
  if (!p) return res.status(404).json({ error: 'Profile not found' });
  if (p.status !== 'active' || !p.camofox_port) return res.status(400).json({ error: 'Profile not active' });

  try {
    const userId = `profile-${p.id}`;
    const r = await fetch(`http://localhost:${p.camofox_port}/sessions/${userId}/storage_state`, {
      signal: AbortSignal.timeout(5000),
    });
    const data = await r.json();
    res.json({ ok: true, storageState: data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── Camofox Storage & Housekeeping Management ─────────────────────────────

function getDirSize(dirPath) {
  let size = 0;
  try {
    const files = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const file of files) {
      const filePath = path.join(dirPath, file.name);
      if (file.isDirectory()) {
        size += getDirSize(filePath);
      } else if (file.isFile()) {
        const stats = fs.statSync(filePath);
        size += stats.size;
      }
    }
  } catch (e) {}
  return size;
}

function getSha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

function getProfilesDir() {
  const homeDir = process.env.HOME || process.env.USERPROFILE || os.homedir() || '';
  return process.env.CAMOFOX_PROFILE_DIR || path.join(homeDir, '.camofox', 'profiles');
}

/** Get physical storage space info and list of profiles */
router.get('/storage/info', (req, res) => {
  try {
    const profilesDir = getProfilesDir();
    let subdirs = [];
    if (fs.existsSync(profilesDir)) {
      subdirs = fs.readdirSync(profilesDir);
    }

    // Load accounts from local database
    let accounts = [];
    try {
      accounts = vault.db.prepare('SELECT id, email, status, is_active FROM vault_accounts').all();
    } catch (e) {
      // If table doesn't exist yet, handle gracefully
    }

    // Build hash mapping
    const hashMap = new Map();
    for (const acc of accounts) {
      const email = acc.email || '';
      const id = acc.id || '';
      const status = acc.status || '';
      const isActive = acc.is_active !== 0;

      const variations = [
        `seellm_connect_${id}`,
        `register_${email}`,
        `warmup_${id}`,
        `seellm_${id}`,
        `seellm_${email}`,
        `seellm_worker_${id}`,
        id,
        email,
      ];

      for (const val of variations) {
        if (val) {
          hashMap.set(getSha256(val), { email, id, status, isActive });
        }
      }
    }

    let totalSizeBytes = 0;
    const profilesList = [];

    for (const dirName of subdirs) {
      const fullPath = path.join(profilesDir, dirName);
      let sizeBytes = 0;
      let mtime = new Date();

      try {
        const stat = fs.statSync(fullPath);
        if (!stat.isDirectory()) continue;
        sizeBytes = getDirSize(fullPath);
        mtime = stat.mtime;
      } catch (e) {
        continue;
      }

      totalSizeBytes += sizeBytes;

      const matched = hashMap.get(dirName);
      profilesList.push({
        folderName: dirName,
        sizeBytes,
        email: matched ? matched.email : null,
        status: matched ? (matched.isActive ? matched.status : 'inactive') : 'orphaned',
        isOrphaned: !matched,
        updatedAt: mtime.toISOString(),
      });
    }

    // Sort by size desc
    profilesList.sort((a, b) => b.sizeBytes - a.sizeBytes);

    const cfg = loadConfig();

    res.json({
      ok: true,
      profiles: profilesList,
      totalSizeBytes,
      folderCount: profilesList.length,
      usePersistentProfiles: cfg.usePersistentProfiles !== false,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/** Delete a specific physical profile folder */
router.delete('/storage/:folderName', (req, res) => {
  const { folderName } = req.params;
  if (!folderName || !/^[a-zA-Z0-9_\-]+$/.test(folderName)) {
    return res.status(400).json({ error: 'Invalid folder name' });
  }

  const profilesDir = getProfilesDir();
  const targetDir = path.join(profilesDir, folderName);

  if (!fs.existsSync(targetDir)) {
    return res.status(404).json({ error: 'Folder not found' });
  }

  try {
    fs.rmSync(targetDir, { recursive: true, force: true });
    res.json({ ok: true, message: `Successfully deleted folder ${folderName}` });

    logAudit({
      action: 'delete_storage_profile',
      entity: 'storage',
      entityId: folderName,
      entityLabel: `Physical Profile: ${folderName}`,
      severity: 'warning',
      source: 'ui',
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/** Toggle persistent profiles setting locally */
router.post('/storage/toggle-persistence', (req, res) => {
  const { usePersistentProfiles } = req.body;
  if (typeof usePersistentProfiles !== 'boolean') {
    return res.status(400).json({ error: 'usePersistentProfiles must be a boolean' });
  }

  try {
    const cfg = loadConfig();
    cfg.usePersistentProfiles = usePersistentProfiles;
    saveConfig(cfg);
    res.json({ ok: true, usePersistentProfiles });

    logAudit({
      action: 'toggle_persistence',
      entity: 'config',
      entityId: 'usePersistentProfiles',
      entityLabel: 'Persistent Profiles Toggle',
      details: { usePersistentProfiles },
      severity: 'info',
      source: 'ui',
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/** Run Smart Housekeeping instantly with customized options */
router.post('/storage/cleanup', (req, res) => {
  const {
    cleanOrphans = true,
    cleanDead = true,
    cleanInactive = true,
    minAgeHours = 0
  } = req.body;

  try {
    const profilesDir = getProfilesDir();
    if (!fs.existsSync(profilesDir)) {
      return res.json({ ok: true, cleanedCount: 0, recoveredBytes: 0 });
    }

    const subdirs = fs.readdirSync(profilesDir);

    // Load accounts from SQLite
    let accounts = [];
    try {
      accounts = vault.db.prepare('SELECT id, email, status, is_active, deleted_at FROM vault_accounts').all();
    } catch (e) {}

    const hashMap = new Map();
    for (const acc of accounts) {
      const email = acc.email || '';
      const id = acc.id || '';
      const status = acc.status || '';
      const isActive = acc.is_active !== 0;
      const deletedAt = acc.deleted_at || null;

      const variations = [
        `seellm_connect_${id}`,
        `register_${email}`,
        `warmup_${id}`,
        `seellm_${id}`,
        `seellm_${email}`,
        `seellm_worker_${id}`,
        id,
        email,
      ];

      for (const val of variations) {
        if (val) {
          hashMap.set(getSha256(val), { email, id, status, isActive, deletedAt });
        }
      }
    }

    let cleanedCount = 0;
    let recoveredBytes = 0;
    const now = Date.now();

    for (const dirName of subdirs) {
      // Only clean folder names that look like sha256 hashes
      if (!/^[a-f0-9]{64}$/i.test(dirName)) continue;

      const fullPath = path.join(profilesDir, dirName);
      let sizeBytes = 0;
      let mtimeMs = 0;
      try {
        const stat = fs.statSync(fullPath);
        if (!stat.isDirectory()) continue;
        sizeBytes = getDirSize(fullPath);
        mtimeMs = stat.mtimeMs;
      } catch (e) {
        continue;
      }

      // Check minAgeHours guard
      if (minAgeHours > 0) {
        const ageHours = (now - mtimeMs) / (1000 * 60 * 60);
        if (ageHours < minAgeHours) {
          continue; // Skip because it is too young
        }
      }

      const matched = hashMap.get(dirName);
      let shouldDelete = false;
      let reason = '';

      if (!matched) {
        if (cleanOrphans) {
          shouldDelete = true;
          reason = 'Orphaned';
        }
      } else if (matched.deletedAt) {
        shouldDelete = true;
        reason = 'Account deleted';
      } else if (matched.status === 'dead') {
        if (cleanDead) {
          shouldDelete = true;
          reason = 'Account is dead';
        }
      } else if (!matched.isActive || matched.status === 'inactive') {
        if (cleanInactive) {
          shouldDelete = true;
          reason = 'Account is inactive';
        }
      }

      if (shouldDelete) {
        try {
          fs.rmSync(fullPath, { recursive: true, force: true });
          cleanedCount++;
          recoveredBytes += sizeBytes;
        } catch (err) {
          console.error(`[Housekeeping] Failed to prune ${fullPath}:`, err.message);
        }
      }
    }

    res.json({ ok: true, cleanedCount, recoveredBytes });

    logAudit({
      action: 'smart_housekeeping',
      entity: 'storage',
      entityLabel: 'Smart Housekeeping Cleanup',
      details: { cleanedCount, recoveredBytes, cleanOrphans, cleanDead, cleanInactive, minAgeHours },
      severity: 'success',
      source: 'ui',
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/** Delete multiple physical profile folders at once */
router.post('/storage/bulk-delete', (req, res) => {
  const { folderNames } = req.body;
  if (!Array.isArray(folderNames)) {
    return res.status(400).json({ error: 'folderNames must be an array of strings' });
  }

  const profilesDir = getProfilesDir();
  let deletedCount = 0;
  let recoveredBytes = 0;

  try {
    for (const folderName of folderNames) {
      if (!folderName || !/^[a-zA-Z0-9_\-]+$/.test(folderName)) continue;
      const targetDir = path.join(profilesDir, folderName);
      if (fs.existsSync(targetDir)) {
        let sizeBytes = getDirSize(targetDir);
        fs.rmSync(targetDir, { recursive: true, force: true });
        deletedCount++;
        recoveredBytes += sizeBytes;
      }
    }

    res.json({ ok: true, deletedCount, recoveredBytes });

    logAudit({
      action: 'bulk_delete_storage_profiles',
      entity: 'storage',
      entityLabel: 'Bulk Delete Storage Profiles',
      details: { deletedCount, recoveredBytes, folderNames },
      severity: 'warning',
      source: 'ui',
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
