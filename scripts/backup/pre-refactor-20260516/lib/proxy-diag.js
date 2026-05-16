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
  // Multiple endpoints with fallback — protects against CF challenges, timeouts, regional blocks
  const ENDPOINTS = [
    'https://api64.ipify.org/?format=json',
    'https://api.myip.com',
    'https://ifconfig.me/all.json',
    'https://ipv4.icanhazip.com',
  ];
  let probeTabId = null;
  const errors = [];
  try {
    const opened = await camofoxPost('/tabs', {
      userId,
      sessionKey: `probe_${Date.now()}`,
      url: ENDPOINTS[0],
      ...(reuseExistingSession ? {} : { proxy: proxyUrl || undefined }),
      persistent: false,
      headless: false,
      humanize: true,
    }, { timeoutMs: 25000 });
    probeTabId = opened.tabId;
    await new Promise(r => setTimeout(r, 3500));

    for (let i = 0; i < ENDPOINTS.length; i++) {
      const url = ENDPOINTS[i];
      try {
        if (i > 0) {
          await camofoxPost(`/tabs/${probeTabId}/navigate`, { userId, url }, { timeoutMs: 15000 });
          await new Promise(r => setTimeout(r, 2500));
        }
        const bodyText = await evalJson(probeTabId, userId, `document.body && document.body.innerText ? document.body.innerText : ''`, { timeoutMs: 15000 });
        const ip = extractIpFromText(bodyText);
        if (ip) return { ip, source: url };
        errors.push(`${url}: no IP in body (${String(bodyText || '').slice(0, 60)})`);
      } catch (e) {
        errors.push(`${url}: ${e.message?.slice(0, 80)}`);
      }
    }
    return { error: `Tất cả endpoint đều fail: ${errors.join(' | ')}` };
  } catch (e) {
    return { error: e.message || String(e) };
  } finally {
    if (probeTabId) await camofoxDelete(`/tabs/${probeTabId}?userId=${userId}`);
  }
}

/**
 * Detect loopback proxy URL (any port)
 * @param {string} proxyUrl - Proxy URL
 * @returns {boolean} True if loopback (127.0.0.1, ::1, localhost)
 */
export function isLocalRelayProxy(proxyUrl) {
  if (!proxyUrl) return false;
  try {
    const u = new URL(proxyUrl.includes('://') ? proxyUrl : `http://${proxyUrl}`);
    const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h.startsWith('127.');
  } catch { return false; }
}

/**
 * Strict proxy URL syntax validator
 * @param {string} proxyUrl - Proxy URL to validate
 * @returns {string|null} Error message or null if valid
 */
export function validateProxyUrl(proxyUrl) {
  if (!proxyUrl) return null;  // empty = no proxy = OK
  const s = String(proxyUrl).trim();
  if (!s) return null;
  const normalized = s.includes('://') ? s : `http://${s}`;
  let u;
  try { u = new URL(normalized); }
  catch { return `Proxy URL không parse được: ${s}`; }
  const allowed = ['http:', 'https:', 'socks4:', 'socks5:'];
  if (!allowed.includes(u.protocol)) return `Protocol không hỗ trợ: ${u.protocol}`;
  if (!u.hostname) return 'Proxy URL thiếu hostname';
  if (!u.port && u.protocol !== 'socks5:') return 'Proxy URL thiếu port';
  return null;
}

/**
 * Validate diagnostic result
 * @param {Object} params - Validation parameters
 * @param {string} params.proxyUrl - Proxy URL
 * @param {string} params.exitIp - Exit IP from proxy
 * @param {string} params.localIp - Local public IP (optional)
 * @returns {string|null} Error message or null if valid
 */
export function validateDiagnosticResult({ proxyUrl, exitIp, localIp }) {
  if (!proxyUrl) return null;
  if (!exitIp) return 'Không lấy được Exit IP khi đã gán proxy';
  if (isLocalRelayProxy(proxyUrl)) return null;  // local relay: skip equality check
  if (!localIp) return 'Không thể xác định Host Public IP để xác thực proxy';
  if (String(localIp).toLowerCase() === String(exitIp).toLowerCase()) {
    return 'Proxy chưa được áp dụng (Exit IP trùng Host Public IP)';
  }
  return null;
}

/**
 * Fetch text via HTTP proxy using native https module (no extra deps)
 * @param {string} url - Target URL
 * @param {string} proxyUrl - Proxy URL (e.g. http://host:port)
 * @param {number} timeoutMs - Timeout
 * @returns {Promise<string>} Response text
 */
export async function fetchTextViaProxy(url, proxyUrl, timeoutMs = 10000) {
  const proxy = new URL(proxyUrl);
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = https.get({
      host: proxy.hostname,
      port: proxy.port || (proxy.protocol === 'https:' ? 443 : 80),
      path: target.href,
      headers: { Host: target.hostname },
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += String(chunk); });
      res.on('end', () => resolve(data));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

/**
 * Check IP geographic location via Cloudflare trace endpoint.
 * Blocks CN/HK/MO/TW to avoid wasting emails on unsupported regions.
 * @param {string|null} proxyUrl - Optional proxy URL
 * @returns {Promise<{ok: boolean, loc: string|null, error?: string}>}
 */
export async function checkIpLocation(proxyUrl = null) {
  try {
    const traceText = proxyUrl
      ? await fetchTextViaProxy('https://cloudflare.com/cdn-cgi/trace', proxyUrl, 10000)
      : await fetchTextNoProxy('https://cloudflare.com/cdn-cgi/trace', 10000);

    const locMatch = traceText.match(/loc=([A-Z]+)/);
    const loc = locMatch ? locMatch[1] : null;

    const blocked = ['CN', 'HK', 'MO', 'TW'];
    if (loc && blocked.includes(loc)) {
      return { ok: false, loc, error: `IP location ${loc} is blocked for registration` };
    }

    return { ok: true, loc };
  } catch (e) {
    return { ok: false, loc: null, error: e.message };
  }
}

/**
 * STRICT PRE-FLIGHT: validate syntax → spawn dedicated probe session with EXPLICIT proxy → verify exit IP
 * Throws on any failure. Only call BEFORE main tab creation.
 * @param {string} proxyUrl - Proxy URL (already normalized)
 * @returns {Promise<{exitIp: string, networkType: 'IPv4'|'IPv6', isLocalRelay: boolean}>}
 */
export async function assertProxyApplied(proxyUrl) {
  const syntaxErr = validateProxyUrl(proxyUrl);
  if (syntaxErr) throw new Error(`[ProxyAssert] ${syntaxErr}`);
  if (!proxyUrl) return null;  // no proxy = nothing to assert

  const probeUserId = `__proxy_assert_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
  // Force fresh session, EXPLICIT proxy
  const result = await probeProxyExitIp(probeUserId, proxyUrl, false);
  if (!result?.ip) {
    throw new Error(`[ProxyAssert] Không lấy được exit IP: ${result?.error || 'unknown'}`);
  }

  const isLocalRelay = isLocalRelayProxy(proxyUrl);
  const localIp = isLocalRelay ? null : await getLocalPublicIp();
  const failReason = validateDiagnosticResult({ proxyUrl, exitIp: result.ip, localIp });
  if (failReason) throw new Error(`[ProxyAssert] ${failReason}`);

  const networkType = String(result.ip).includes(':') ? 'IPv6' : 'IPv4';
  return { exitIp: result.ip, networkType, isLocalRelay };
}
