/**
 * SeeLLM Tools - Shared Config Loader
 * Đọc cấu hình từ tools.config.json (cùng thư mục gốc)
 */
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = join(ROOT_DIR, 'tools.config.json');

const defaults = {
  camofoxPath: '/Users/ndpmmo/Documents/Tools/camofox-browser',
  camofoxPort: 3000,
  camofoxApi: 'http://localhost:9377',
  gatewayUrl: 'http://localhost:20128',
  toolsApiUrl: 'http://localhost:4000',
  workerAuthToken: '',
  pollIntervalMs: 15000,
  maxThreads: 3,
  forceEnLocale: true,
  workerMode: 'auto', // 'auto' | 'direct-login' | 'pkce-login'
  protocolFirst: true, // default true — đã có curl transport + Datadog headers để impersonate Chrome
};

export function loadConfig() {
  try {
    if (existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
      const camofoxPort = raw.camofoxPort || defaults.camofoxPort;
      return {
        ...defaults,
        ...raw,
        // Derive camofoxApi from camofoxPort if not set
        camofoxApi: raw.camofoxApi || `http://localhost:${camofoxPort}`,
      };
    }
  } catch (e) { /* ignore */ }
  return defaults;
}

export const config = loadConfig();
export const CAMOUFOX_API = config.camofoxApi;
export const GATEWAY_URL = config.gatewayUrl;
export const TOOLS_API_URL = process.env.TOOLS_API_URL || config.toolsApiUrl;
export const WORKER_AUTH_TOKEN = process.env.WORKER_AUTH_TOKEN || config.workerAuthToken;
export const POLL_INTERVAL_MS = config.pollIntervalMs;
export const MAX_THREADS = config.maxThreads;
export const FORCE_EN_LOCALE = config.forceEnLocale !== false; // default true
export const WORKER_MODE = process.env.WORKER_MODE || config.workerMode || 'auto'; // 'auto' | 'direct-login' | 'pkce-login'
export const PROTOCOL_FIRST = process.env.PROTOCOL_FIRST !== undefined ? process.env.PROTOCOL_FIRST !== 'false' : (config.protocolFirst !== false);
/** Locale string truyền cho camofox khi bật forceEnLocale */
export const FORCE_LOCALE_STR = FORCE_EN_LOCALE ? 'en-US' : null;
