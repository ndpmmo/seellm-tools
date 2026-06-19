/**
 * scripts/lib/proxy-diag.js
 * 
 * Proxy diagnostics and IP detection helpers.
 * Consolidated from auto-login, auto-connect, and auto-register.
 */

import https from 'node:https';
import { exec } from 'node:child_process';
// NOTE: camofox imports removed in v0.3.179 — probeProxyExitIp now uses
// requestViaCurlCffi (direct Node.js fetch through proxy) instead of opening
// browser tabs. See CHANGELOG 0.3.179 for rationale.

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
  let s = String(input || '').trim();
  if (!s) return null;

  let protocol = 'http';
  const protoMatch = s.match(/^([a-zA-Z0-9+.-]+):\/\//);
  if (protoMatch) {
    protocol = protoMatch[1].toLowerCase();
    s = s.slice(protoMatch[0].length);
  }

  const parts = s.split(':');
  if (parts.length === 4) {
    const [host, port, user, pass] = parts;
    if (/^\d+$/.test(port)) {
      return `${protocol}://${user}:${pass}@${host}:${port}`;
    }
  }

  if (s.includes('@')) {
    return `${protocol}://${s}`;
  }

  return `${protocol}://${s}`;
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
  // v0.3.179: Direct fetch through proxy via curl_cffi daemon — no browser tabs needed.
  // This eliminates 20+ probe tabs per batch and reduces probe time from 30-60s to 3-5s.
  // `reuseExistingSession` param is kept for API compat but no longer affects behavior
  // (direct fetch always goes through the specified proxy).
  const ENDPOINTS = [
    'https://api64.ipify.org/?format=json',
    'https://api.myip.com',
    'https://ifconfig.me/all.json',
    'https://ipv4.icanhazip.com',
  ];
  const errors = [];
  try {
    const { requestViaCurlCffi } = await import('./openai-protocol-register.js');
    for (const url of ENDPOINTS) {
      try {
        const res = await requestViaCurlCffi({
          method: 'GET',
          url,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          },
          proxyUrl: proxyUrl || null,
          timeoutMs: 15000,
        });
        if (res.status === 200 && res.body) {
          const ip = extractIpFromText(res.body);
          if (ip) return { ip, source: url };
          errors.push(`${url}: no IP in body (${String(res.body || '').slice(0, 60)})`);
        } else {
          errors.push(`${url}: HTTP ${res.status}`);
        }
      } catch (e) {
        errors.push(`${url}: ${e.message?.slice(0, 80)}`);
      }
    }
    return { error: `Tất cả endpoint đều fail: ${errors.join(' | ')}` };
  } catch (e) {
    return { error: e.message || String(e) };
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
  return new Promise((resolve, reject) => {
    try {
      const escapedProxy = String(proxyUrl).replace(/'/g, "'\\''");
      const escapedUrl = String(url).replace(/'/g, "'\\''");
      const timeoutSec = Math.ceil(timeoutMs / 1000) || 10;
      const cmd = `curl -4 -sS --connect-timeout ${timeoutSec} -x '${escapedProxy}' '${escapedUrl}'`;
      
      exec(cmd, { timeout: timeoutMs }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message));
        } else {
          resolve(stdout);
        }
      });
    } catch (err) {
      reject(err);
    }
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
    const { requestViaCurlCffi } = await import('./openai-protocol-register.js');
    
    const endpoints = [
      {
        url: 'https://cloudflare.com/cdn-cgi/trace',
        parse: (text) => {
          const m = text.match(/loc=([A-Z]+)/);
          return m ? m[1] : null;
        }
      },
      {
        url: 'https://ipinfo.io/country',
        parse: (text) => text.trim().toUpperCase()
      },
      {
        url: 'https://ipapi.co/country/',
        parse: (text) => text.trim().toUpperCase()
      }
    ];

    const errors = [];
    for (const ep of endpoints) {
      try {
        const res = await requestViaCurlCffi({
          method: 'GET',
          url: ep.url,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          },
          proxyUrl,
          timeoutMs: 20000,
        });
        
        if (res.status === 200 && res.body) {
          const loc = ep.parse(res.body);
          if (loc && loc.length === 2 && /^[A-Z]+$/.test(loc)) {
            const blocked = ['CN', 'HK', 'MO', 'TW'];
            if (blocked.includes(loc)) {
              return { ok: false, loc, error: `IP location ${loc} is blocked for registration` };
            }
            return { ok: true, loc };
          }
        }
        errors.push(`${ep.url} (status ${res.status || 'unknown'})`);
      } catch (err) {
        errors.push(`${ep.url} (${err.message})`);
      }
    }
    
    return { ok: false, loc: null, error: `Tất cả geolocation endpoints đều thất bại: ${errors.join(' | ')}` };
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
