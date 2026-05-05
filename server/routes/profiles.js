/**
 * Profile API Router — CRUD + launch/close + runtime operations for browser profiles.
 */

import express from 'express';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { vault } from '../db/vault.js';
import {
  launchProfile, closeProfile, getProfileApiUrl, getProfileVncUrl, findAvailablePort
} from '../profileManager.js';
import { FINGERPRINT_PRESETS, TIMEZONE_OPTIONS, LANGUAGE_OPTIONS, RESOLUTION_OPTIONS } from '../fingerprintPresets.js';

const router = express.Router();
router.use(express.json());

// SSE emitter — set from server.js
let emitSSE = null;
export function setProfileSSEEmitter(emitter) {
  emitSSE = emitter;
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
});

/** Clone profile */
router.post('/:id/clone', (req, res) => {
  const { name } = req.body || {};
  const cloned = vault.cloneProfile(req.params.id, name);
  if (!cloned) return res.status(404).json({ error: 'Source profile not found' });
  res.json({ ok: true, profile: cloned });
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
});

/** Close profile (stop Camofox instance) */
router.post('/:id/close', async (req, res) => {
  const result = await closeProfile(req.params.id, emitSSE);
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
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

export default router;
