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
  workerAuthToken: '',
  pollIntervalMs: 15000,
  maxThreads: 3,
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
export const WORKER_AUTH_TOKEN = process.env.WORKER_AUTH_TOKEN || config.workerAuthToken;
export const POLL_INTERVAL_MS = config.pollIntervalMs;
export const MAX_THREADS = config.maxThreads;
