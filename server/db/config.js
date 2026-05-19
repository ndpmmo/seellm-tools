import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';

const CONFIG_PATH = existsSync(path.resolve('tools.config.json')) 
  ? path.resolve('tools.config.json') 
  : path.resolve('config.json');

export const CONFIG_DEFAULTS = {
  camofoxPath:   '/Users/ndpmmo/Documents/Tools/camofox-browser',
  camofoxNodePath: '/usr/local/bin/node',
  camofoxPort:   3000,
  camofoxApi:    'http://localhost:9377',
  gatewayUrl:    'http://localhost:20128',
  workerAuthToken: '',
  d1WorkerUrl:    '',
  d1SyncSecret:   '',
  pollIntervalMs: 15000,
  maxThreads:    3,
  forceEnLocale: true,
  workerMode: 'auto', // 'auto' | 'direct-login' | 'pkce-login'
  protocolFirst: true, // 'true' | 'false' — bật/tắt protocol-mode registration
};

// In-memory cache to avoid reading from disk on every call
let _cachedConfig = null;

export function loadConfig() {
  if (_cachedConfig) return _cachedConfig;
  try {
    if (existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
      const p = raw.camofoxPort || CONFIG_DEFAULTS.camofoxPort;
      _cachedConfig = { ...CONFIG_DEFAULTS, ...raw, camofoxApi: raw.camofoxApi || `http://localhost:${p}` };
      return _cachedConfig;
    }
  } catch {}
  _cachedConfig = { ...CONFIG_DEFAULTS };
  return _cachedConfig;
}

export function saveConfig(c) { 
  writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2));
  _cachedConfig = null; // invalidate cache so next loadConfig() re-reads from disk
}
