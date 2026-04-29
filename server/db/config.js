import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';

const CONFIG_PATH = existsSync(path.resolve('tools.config.json')) 
  ? path.resolve('tools.config.json') 
  : path.resolve('config.json');

export function loadConfig() {
  const defaults = {
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
  };
  try {
    if (existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
      const p = raw.camofoxPort || defaults.camofoxPort;
      return { ...defaults, ...raw, camofoxApi: raw.camofoxApi || `http://localhost:${p}` };
    }
  } catch {}
  return defaults;
}

export function saveConfig(c) { 
  writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2)); 
}
