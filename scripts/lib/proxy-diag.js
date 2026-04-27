/**
 * scripts/lib/proxy-diag.js
 * 
 * Proxy diagnostics and IP detection helpers.
 * Consolidated from auto-login, auto-connect, and auto-register.
 */

import https from 'node:https';
import { camofoxPost, camofoxGet, camofoxDelete, evalJson } from './camofox.js';
import { CAMOUFOX_API } from '../config.js';

let LOCAL_PUBLIC_IP_CACHE = null;

/**
 * Extract IP address from text (supports JSON and raw text)
 * @param {string} raw - Text containing IP address
 * @returns {string|null} Extracted IP or null
 */
export function extractIpFromText(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  try {
    const j = JSON.parse(text);
    if (j?.ip) return String(j.ip).trim();
    if (j?.query) return String(j.query).trim();
    if (j?.address) return String(j.address).trim();
  } catch (_) {}
  const ipv4 = text.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/);
  if (ipv4) return ipv4[0];
  const ipv6 = text.match(/\b(?:[A-Fa-f0-9]{1,4}:){2,7}[A-Fa-f0-9]{1,4}\b/);
  return ipv6 ? ipv6[0] : null;
}

/**
 * Normalize proxy URL to include protocol
 * @param {string} input - Proxy URL (with or without protocol)
 * @returns {string|null} Normalized proxy URL or null
 */
export function normalizeProxyUrl(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  if (s.includes('://')) return s;
  return `http://${s}`;
}

/**
 * Fetch text from URL without proxy (for local IP check)
 * @param {string} url - URL to fetch
 * @param {number} timeoutMs - Timeout in milliseconds
 * @returns {Promise<string>} Response text
 */
export async function fetchTextNoProxy(url, timeoutMs = 12000) {
  return await new Promise((resolve, reject) => {
    try {
      const req = https.get(url, { timeout: timeoutMs }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += String(chunk); });
        res.on('end', () => resolve(data));
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Get local public IP (cached for process lifetime)
 * @returns {Promise<string|null>} Public IP or null
 */
export async function getLocalPublicIp() {
  if (LOCAL_PUBLIC_IP_CACHE) return LOCAL_PUBLIC_IP_CACHE;
  const urls = [
    'https://api64.ipify.org/?format=json',
    'https://ifconfig.co/json',
    'https://ident.me/.json',
  ];
  for (const url of urls) {
    try {
      const t = await fetchTextNoProxy(url, 12000);
      const ip = extractIpFromText(t);
      if (ip) {
        LOCAL_PUBLIC_IP_CACHE = ip;
        return ip;
      }
    } catch (_) {}
  }
  return null;
}

/**
 * Probe proxy exit IP by opening a tab with proxy and checking IP
 * @param {string} userId - Camoufox user ID
 * @param {string} proxyUrl - Proxy URL to test
 * @param {boolean} reuseExistingSession - Whether to reuse existing session
 * @returns {Promise<{ip?: string, source?: string, error?: string}>} Result object
 */
export async function probeProxyExitIp(userId, proxyUrl, reuseExistingSession = false) {
  let probeTabId = null;
  try {
    const opened = await camofoxPost('/tabs', {
      userId,
      sessionKey: `probe_${Date.now()}`,
      url: 'https://api64.ipify.org/?format=json',
      ...(reuseExistingSession ? {} : { proxy: proxyUrl || undefined }),
      persistent: false,
      headless: false,
      humanize: true,
    }, { timeoutMs: 25000 });
    probeTabId = opened.tabId;
    await new Promise(r => setTimeout(r, 3500));
    const bodyText = await evalJson(probeTabId, userId, `document.body && document.body.innerText ? document.body.innerText : ''`, { timeoutMs: 20000 });
    const ip = extractIpFromText(bodyText);
    if (!ip) return { error: `Không parse được IP từ nội dung: ${String(bodyText || '').slice(0, 120)}` };
    return { ip, source: 'https://api64.ipify.org/?format=json' };
  } catch (e) {
    return { error: e.message || String(e) };
  } finally {
    if (probeTabId) await camofoxDelete(`/tabs/${probeTabId}?userId=${userId}`);
  }
}
