/**
 * Profile Manager — handles launching/closing Camofox instances for browser profiles.
 * Owns port allocation, process spawning, health checks, and runtime state.
 */

import { spawn, execSync } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import path from 'path';
import os from 'os';
import { vault } from './db/vault.js';
import { loadConfig } from './db/config.js';

const CAMOFOX_BASE_PORT = 9377;
const MAX_PROFILES = 10;
const HEALTH_CHECK_INTERVAL_MS = 500;
const HEALTH_CHECK_MAX_ATTEMPTS = 30; // 15 seconds max

// In-memory map of profile processes: profileId -> { proc, port }
const profileProcesses = new Map();

/**
 * Check if a port is actually in use by the OS.
 */
function isPortBusy(port) {
  try {
    // Works on macOS and Linux
    execSync(`lsof -i :${port}`, { stdio: 'ignore' });
    return true; // if lsof found something, port is busy
  } catch (e) {
    return false; // if lsof failed, port is likely free
  }
}

/**
 * Find an available port for Camofox.
 */
export function findAvailablePort() {
  const activeProfiles = vault.getActiveProfiles();
  const usedPortsInDb = new Set(activeProfiles.map(p => p.camofox_port).filter(Boolean));

  for (let i = 0; i < MAX_PROFILES; i++) {
    const port = CAMOFOX_BASE_PORT + i;
    
    // Check both DB and actual OS ports
    if (!usedPortsInDb.has(port) && !isPortBusy(port)) {
      return port;
    }
  }
  return null;
}

/**
 * Get the profile-specific persistence directory.
 */
function getProfileDir(profileId) {
  const baseDir = path.join(os.homedir(), '.camofox', 'profiles');
  const dir = path.join(baseDir, profileId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Wait for Camofox instance to become healthy (respond to /health).
 */
async function waitForHealth(port, maxAttempts = HEALTH_CHECK_MAX_ATTEMPTS) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const r = await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return true;
    } catch { /* not ready yet */ }
    await new Promise(resolve => setTimeout(resolve, HEALTH_CHECK_INTERVAL_MS));
  }
  return false;
}

/**
 * Check if browser engine is ready.
 */
export function checkEngineStatus() {
  return { ok: true };
}

/**
 * Launch a Camofox instance for a browser profile.
 * Returns { ok, port, novncPort, pid, tabId } or { ok: false, error }.
 */
export async function launchProfile(profileId, emitSSE) {
  const profile = vault.getProfile(profileId);
  if (!profile) return { ok: false, error: 'Profile not found' };
  if (profile.status === 'active') return { ok: false, error: 'Profile is already active' };

  const port = findAvailablePort();
  if (!port) return { ok: false, error: 'No available port (max profiles reached)' };

  const cfg = loadConfig();
  const profileDir = getProfileDir(profileId);

  // Set status to launching
  vault.updateProfileRuntime(profileId, { status: 'launching', camofox_port: port });
  if (emitSSE) emitSSE('profile:status', { id: profileId, status: 'launching' });

  // Spawn Camofox process
  const isMac = process.platform === 'darwin';
  const env = {
    ...process.env,
    CAMOFOX_PORT: String(port),
    CAMOFOX_PROFILE_DIR: profileDir,
    PROFILE_NAME: profile.name, // Pass profile name to identify window
    ENABLE_VNC: '0', 
  };

  if (!isMac) {
    env.VNC_RESOLUTION = `${profile.screen_resolution}x24`;
    env.ENABLE_VNC = '1';
  } else {
    // On Mac, ensure window size matches resolution
    const [w, h] = profile.screen_resolution.split('x');
    env.HEADLESS = '0';
    env.BROWSER_WIDTH = w;
    env.BROWSER_HEIGHT = h;
    // Also pass as CLI args to force window size
    env.CAMOFOX_ARGS = `--width=${w} --height=${h}`;
  }

  if (profile.proxy_url) {
    try {
      const proxyUrl = new URL(profile.proxy_url);
      env.PROXY_HOST = proxyUrl.hostname;
      env.PROXY_PORT = proxyUrl.port || '1080';
      if (proxyUrl.username) env.PROXY_USERNAME = proxyUrl.username;
      if (proxyUrl.password) env.PROXY_PASSWORD = proxyUrl.password;
    } catch { /* invalid proxy URL, skip */ }
  }

  const camofoxNode = cfg.camofoxNodePath || 'node';
  const proc = spawn(camofoxNode, ['server.js'], {
    cwd: cfg.camofoxPath,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const pid = proc.pid;
  profileProcesses.set(profileId, { proc, port });

  proc.stdout.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg) console.log(`[Profile:${profileId}] ${msg}`);
  });

  proc.stderr.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg) console.error(`[Profile:${profileId}] ${msg}`);
  });

  proc.on('exit', (code, signal) => {
    console.log(`[Profile:${profileId}] Exited with code=${code} signal=${signal}`);
    const current = vault.getProfile(profileId);
    if (current && current.status === 'active') {
      vault.updateProfileRuntime(profileId, { status: 'idle', camofox_port: null, novnc_port: null, camofox_pid: null, tab_id: null });
      if (emitSSE) emitSSE('profile:status', { id: profileId, status: 'idle', reason: 'process_exited' });
    }
  });

  // Wait for health check
  const healthy = await waitForHealth(port);
  if (!healthy) {
    proc.kill('SIGKILL');
    vault.updateProfileRuntime(profileId, { status: 'error', camofox_port: null, novnc_port: null, camofox_pid: null, tab_id: null });
    if (emitSSE) emitSSE('profile:status', { id: profileId, status: 'error', error: 'Health check failed' });
    return { ok: false, error: 'Camofox health check failed' };
  }

  // Create tab
  let tabId = null;
  const launchUrl = profile.last_url || profile.start_url || 'https://www.google.com';
  
  try {
    const tabRes = await fetch(`http://localhost:${port}/tabs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: `profile-${profileId}`,
        sessionKey: `profile-${profileId}`,
        url: launchUrl,
        locale: profile.language || undefined,
      }),
      signal: AbortSignal.timeout(10000),
    });
    const tabData = await tabRes.json();
    tabId = tabData.tabId || tabData.id || null;
  } catch (e) {
    console.warn(`[Profile:${profileId}] Tab creation failed:`, e.message);
  }

  // Update profile runtime state
  vault.updateProfileRuntime(profileId, { status: 'active', camofox_port: port, camofox_pid: pid, tab_id: tabId });
  if (emitSSE) emitSSE('profile:launched', { id: profileId, port, pid, tabId });

  return { ok: true, port, pid, tabId };
}

/**
 * Close a Camofox instance for a browser profile.
 */
export async function closeProfile(profileId, emitSSE) {
  const profile = vault.getProfile(profileId);
  if (!profile) return { ok: false, error: 'Profile not found' };
  if (profile.status !== 'active' && profile.status !== 'launching') {
    return { ok: false, error: 'Profile is not active' };
  }

  const port = profile.camofox_port;
  const userId = `profile-${profileId}`;

  if (port) {
    // Try to get and save current URL before closing
    try {
      if (profile.tab_id) {
        const snapRes = await fetch(`http://localhost:${port}/tabs/${profile.tab_id}/snapshot?userId=${userId}`, {
          signal: AbortSignal.timeout(3000),
        });
        const snapData = await snapRes.json();
        if (snapData.url && snapData.url !== 'about:blank') {
          vault.updateProfileLastUrl(profileId, snapData.url);
        }
      }
    } catch (e) { /* ignore snapshot failure on close */ }

    try {
      await fetch(`http://localhost:${port}/sessions/${userId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId }),
        signal: AbortSignal.timeout(5000),
      });
    } catch (e) {
      console.warn(`[Profile:${profileId}] Session close failed:`, e.message);
    }
  }

  const entry = profileProcesses.get(profileId);
  if (entry?.proc) {
    try {
      entry.proc.kill('SIGTERM');
    } catch (e) {
      console.warn(`[Profile:${profileId}] Process kill failed:`, e.message);
    }
    profileProcesses.delete(profileId);
  }

  vault.updateProfileRuntime(profileId, { status: 'idle', camofox_port: null, camofox_pid: null, tab_id: null });
  if (emitSSE) emitSSE('profile:closed', { id: profileId });

  return { ok: true };
}


/**
 * Close all active profiles (used on server shutdown).
 */
export async function closeAllProfiles(emitSSE) {
  const active = vault.getActiveProfiles();
  const results = [];
  for (const p of active) {
    const r = await closeProfile(p.id, emitSSE);
    results.push({ id: p.id, ...r });
  }
  return results;
}

/**
 * Recover profiles on server startup — mark any "active" profiles as idle
 * since their Camofox processes are gone after restart.
 */
export function recoverProfilesOnStartup() {
  const active = vault.getActiveProfiles();
  for (const p of active) {
    console.log(`[ProfileManager] Recovering profile ${p.id} (was active before restart)`);
    vault.updateProfileRuntime(p.id, { status: 'idle', camofox_port: null, novnc_port: null, camofox_pid: null, tab_id: null });
  }
  return active.length;
}

/**
 * Get the Camofox API URL for a profile.
 */
export function getProfileApiUrl(profileId) {
  const profile = vault.getProfile(profileId);
  if (!profile || !profile.camofox_port) return null;
  return `http://localhost:${profile.camofox_port}`;
}

/**
 * Get the noVNC URL for a profile.
 */
export function getProfileVncUrl(profileId) {
  return null; // VNC legacy removed
}
