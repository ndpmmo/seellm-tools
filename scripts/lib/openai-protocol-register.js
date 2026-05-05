/**
 * scripts/lib/openai-protocol-register.js
 *
 * Protocol (HTTP API-first) registration engine for ChatGPT.
 * Mirrors lxf746/any-auto-register register.py flow using native Node.js https.
 * No browser required. Falls back to browser if Sentinel PoW/turnstile is demanded.
 */

import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { checkSentinelWithVm, generateDatadogTraceHeaders, SentinelTokenGenerator, solveTurnstileDx } from './sentinel-vm.js';

// ============================================
// CONSTANTS
// ============================================
const OPENAI_AUTH = 'https://auth.openai.com';
const CHATGPT_APP = 'https://chatgpt.com';
const SENTINEL_REQ_URL = 'https://sentinel.openai.com/backend-api/sentinel/req';
const SENTINEL_SDK_URL = 'https://cdn.jsdelivr.net/npm/@cloudflare/turnstile@0.4.3/dist/vanilla.js';

const OAUTH_CLIENT_ID = 'app_X8zY6vW2pQ9tR3dE7nK1jL5gH';
const OAUTH_REDIRECT_URI = 'https://chatgpt.com/api/auth/callback/openai';
const OAUTH_SCOPE = 'openid email profile offline_access model.request model.read organization.read organization.write';

const ENDPOINTS = {
  sentinel: SENTINEL_REQ_URL,
  signup: `${OPENAI_AUTH}/api/accounts/authorize/continue`,
  register: `${OPENAI_AUTH}/api/accounts/user/register`,
  sendOtp: `${OPENAI_AUTH}/api/accounts/email-otp/send`,
  validateOtp: `${OPENAI_AUTH}/api/accounts/email-otp/validate`,
  createAccount: `${OPENAI_AUTH}/api/accounts/create_account`,
  selectWorkspace: `${OPENAI_AUTH}/api/accounts/workspace/select`,
};

const BLOCKED_IP_LOCATIONS = ['CN', 'HK', 'MO', 'TW'];

// ============================================
// PASSWORD & USER INFO GENERATORS
// ============================================
const PASSWORD_CHARSET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const SPECIALS = ',._!@#';

export function generatePassword(length = 16) {
  if (length < 10) length = 10;
  const core = Array.from({ length: length - 3 }, () =>
    PASSWORD_CHARSET[crypto.randomInt(PASSWORD_CHARSET.length)]
  ).join('');
  const lower = 'abcdefghijklmnopqrstuvwxyz'[crypto.randomInt(26)];
  const digit = '0123456789'[crypto.randomInt(10)];
  const special = SPECIALS[crypto.randomInt(SPECIALS.length)];
  const pwd = lower + digit + special + core;
  return pwd.slice(0, length);
}

const FIRST_NAMES = ['James','Emma','Liam','Olivia','Noah','Ava','Oliver','Sophia','Elijah','Isabella','Lucas','Mia','Mason','Charlotte','Ethan','Amelia'];
const LAST_NAMES = ['Smith','Johnson','Williams','Brown','Jones','Garcia','Miller','Davis','Rodriguez','Martinez','Hernandez','Lopez'];

export function generateRandomUserInfo() {
  const first = FIRST_NAMES[crypto.randomInt(FIRST_NAMES.length)];
  const last = LAST_NAMES[crypto.randomInt(LAST_NAMES.length)];
  const year = 1985 + crypto.randomInt(20);
  const month = 1 + crypto.randomInt(12);
  const day = 1 + crypto.randomInt(28);
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return {
    name: `${first} ${last}`,
    birthdate: `${year}-${mm}-${dd}`,
    age: new Date().getFullYear() - year,
  };
}

// ============================================
// LOW-LEVEL HTTPS REQUEST (with cookie jar)
// ============================================
function parseCookies(setCookieHeader, requestUrl = '') {
  const cookies = {};
  const cookieDetails = [];
  if (!setCookieHeader) return { cookies, cookieDetails };
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  const requestHost = requestUrl ? new URL(requestUrl).hostname : '';
  for (const line of raw) {
    const parts = String(line).split(';').map(part => part.trim()).filter(Boolean);
    const [nameValue, ...attrs] = parts;
    const idx = nameValue.indexOf('=');
    if (idx <= 0) continue;
    const name = nameValue.slice(0, idx).trim();
    const value = nameValue.slice(idx + 1).trim();
    cookies[name] = value;

    const detail = {
      name,
      value,
      domain: requestHost,
      path: '/',
      httpOnly: false,
      secure: false,
      sameSite: 'Lax',
    };

    for (const attr of attrs) {
      const [rawKey, ...rest] = attr.split('=');
      const key = String(rawKey || '').trim().toLowerCase();
      const attrValue = rest.join('=').trim();
      if (key === 'domain' && attrValue) detail.domain = attrValue;
      else if (key === 'path' && attrValue) detail.path = attrValue;
      else if (key === 'expires' && attrValue) {
        const ts = Date.parse(attrValue);
        if (!Number.isNaN(ts)) detail.expires = Math.floor(ts / 1000);
      } else if (key === 'max-age' && attrValue) {
        const maxAge = Number(attrValue);
        if (!Number.isNaN(maxAge)) detail.expires = Math.floor(Date.now() / 1000) + maxAge;
      } else if (key === 'httponly') detail.httpOnly = true;
      else if (key === 'secure') detail.secure = true;
      else if (key === 'samesite' && attrValue) {
        const normalized = attrValue.toLowerCase();
        detail.sameSite = normalized === 'none' ? 'None' : normalized === 'strict' ? 'Strict' : 'Lax';
      }
    }

    cookieDetails.push(detail);
  }
  return { cookies, cookieDetails };
}

function cookieJarToHeader(jar) {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}

function decompressBody(buffer, encoding = '') {
  const normalized = String(encoding || '').toLowerCase();
  if (!buffer || !buffer.length) return '';
  try {
    if (normalized.includes('br')) return zlib.brotliDecompressSync(buffer).toString('utf8');
    if (normalized.includes('gzip')) return zlib.gunzipSync(buffer).toString('utf8');
    if (normalized.includes('deflate')) return zlib.inflateSync(buffer).toString('utf8');
  } catch (_) {
    return buffer.toString('utf8');
  }
  return buffer.toString('utf8');
}

// ============================================
// DATADOG TRACE HEADERS (mirrors upstream Python)
// ============================================
function generateBrowserTraceId() {
  return crypto.randomBytes(16).toString('hex');
}

// ============================================
// CURL TRANSPORT (Chrome impersonation via system curl)
// ============================================
function requestViaCurl({ method, url, headers = {}, body = null, proxyUrl = null, timeoutMs = 15000 }) {
  return new Promise((resolve, reject) => {
    const args = [
      '--silent', '--show-error',
      '--compressed',
      '--location',
      '--max-redirs', '10',
      '-X', method,
    ];

    // macOS built-in curl may not support --http2 / --tlsv1.3
    // Let curl auto-negotiate HTTP version and TLS

    // Proxy
    if (proxyUrl) {
      args.push('--proxy', proxyUrl);
    }

    // Timeout
    args.push('--max-time', String(Math.ceil(timeoutMs / 1000)));
    args.push('--connect-timeout', String(Math.ceil(timeoutMs / 2000)));

    // Dump all response headers (including intermediate redirects) to stderr
    args.push('-D', '/dev/stderr');
    // Body to stdout
    args.push('-o', '-');

    // Headers
    for (const [k, v] of Object.entries(headers)) {
      const lowerKey = k.toLowerCase();
      if (lowerKey === 'cookie') continue; // handled via -b
      if (lowerKey === 'accept-encoding') continue; // let curl advertise only encodings it supports with --compressed
      args.push('-H', `${k}: ${v}`);
    }

    // Cookie jar (memory only for this request)
    if (headers['Cookie']) {
      args.push('-b', headers['Cookie']);
    }

    // Body
    if (body) {
      args.push('-d', body);
      if (!headers['Content-Type']) {
        args.push('-H', 'Content-Type: application/x-www-form-urlencoded');
      }
    }

    args.push(url);

    const proc = spawn('curl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdoutChunks = [];
    const stderrChunks = [];

    proc.stdout.on('data', chunk => stdoutChunks.push(chunk));
    proc.stderr.on('data', chunk => stderrChunks.push(chunk));
    proc.on('close', code => {
      if (code !== 0) {
        const err = Buffer.concat(stderrChunks).toString('utf8').slice(0, 500);
        return reject(new Error(`curl failed (${code}): ${err}`));
      }
      const bodyText = Buffer.concat(stdoutChunks).toString('utf8');

      // Parse ALL header blocks from stderr (curl -D /dev/stderr dumps every response including redirects)
      const headerText = Buffer.concat(stderrChunks).toString('utf8');
      const lines = headerText.split(/\r?\n/);
      let status = 200;
      const resHeaders = {};
      for (const line of lines) {
        const m = line.match(/^HTTP\/\d\.\d\s+(\d+)/i);
        if (m) {
          status = parseInt(m[1], 10);
        } else {
          const idx = line.indexOf(':');
          if (idx > 0) {
            const k = line.slice(0, idx).trim();
            const v = line.slice(idx + 1).trim();
            if (k.toLowerCase() === 'set-cookie') {
              if (!resHeaders['set-cookie']) resHeaders['set-cookie'] = [];
              resHeaders['set-cookie'].push(v);
            } else if (k.toLowerCase() !== 'location' || status >= 300) {
              // Keep Location from the final redirect response only
              resHeaders[k.toLowerCase()] = v;
            } else {
              resHeaders[k.toLowerCase()] = v;
            }
          }
        }
      }

      resolve({ status, headers: resHeaders, body: bodyText });
    });
    proc.on('error', err => reject(new Error(`curl spawn error: ${err.message}`)));
  });
}

let curlAvailable = null;
async function isCurlAvailable() {
  if (curlAvailable !== null) return curlAvailable;
  try {
    await new Promise((resolve, reject) => {
      const p = spawn('curl', ['--version'], { stdio: 'ignore' });
      p.on('close', c => c === 0 ? resolve() : reject());
      p.on('error', reject);
    });
    curlAvailable = true;
  } catch (_) {
    curlAvailable = false;
  }
  return curlAvailable;
}

function buildProxyAuthHeader(proxy) {
  if (!proxy.username && !proxy.password) return null;
  return `Basic ${Buffer.from(`${decodeURIComponent(proxy.username || '')}:${decodeURIComponent(proxy.password || '')}`).toString('base64')}`;
}

function openProxyTunnel(proxy, target, timeoutMs) {
  return new Promise((resolve, reject) => {
    const proxyClient = proxy.protocol === 'https:' ? https : http;
    const headers = { Host: `${target.hostname}:${target.port || 443}` };
    const proxyAuth = buildProxyAuthHeader(proxy);
    if (proxyAuth) headers['Proxy-Authorization'] = proxyAuth;
    const connectReq = proxyClient.request({
      host: proxy.hostname,
      port: proxy.port || (proxy.protocol === 'https:' ? 443 : 80),
      method: 'CONNECT',
      path: `${target.hostname}:${target.port || 443}`,
      headers,
      timeout: timeoutMs,
    });
    connectReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`proxy CONNECT failed: ${res.statusCode}`));
        return;
      }
      resolve(socket);
    });
    connectReq.on('timeout', () => connectReq.destroy(new Error('proxy connect timeout')));
    connectReq.on('error', reject);
    connectReq.end();
  });
}

function request({ method, url, headers = {}, body = null, proxyUrl = null, timeoutMs = 15000 }) {
  return new Promise(async (resolve, reject) => {
    try {
      const target = new URL(url);
      const isHttpsTarget = target.protocol === 'https:';
      let req;

      if (proxyUrl) {
        const proxy = new URL(proxyUrl);
        if (proxy.protocol !== 'http:' && proxy.protocol !== 'https:') {
          return reject(new Error(`Protocol mode only supports HTTP/HTTPS proxies, got ${proxy.protocol}`));
        }

        if (isHttpsTarget) {
          const tunnelSocket = await openProxyTunnel(proxy, target, timeoutMs);
          req = https.request({
            host: target.hostname,
            port: target.port || 443,
            path: target.pathname + target.search,
            method,
            headers,
            timeout: timeoutMs,
            createConnection: () => tls.connect({
              socket: tunnelSocket,
              servername: target.hostname,
            }),
            agent: false,
          });
        } else {
          const proxyClient = proxy.protocol === 'https:' ? https : http;
          const proxyHeaders = { Host: target.hostname, ...headers };
          const proxyAuth = buildProxyAuthHeader(proxy);
          if (proxyAuth) proxyHeaders['Proxy-Authorization'] = proxyAuth;
          req = proxyClient.request({
            host: proxy.hostname,
            port: proxy.port || (proxy.protocol === 'https:' ? 443 : 80),
            path: target.href,
            method,
            headers: proxyHeaders,
            timeout: timeoutMs,
          });
        }
      } else {
        const client = isHttpsTarget ? https : http;
        req = client.request({
          hostname: target.hostname,
          port: target.port || (isHttpsTarget ? 443 : 80),
          path: target.pathname + target.search,
          method,
          headers,
          timeout: timeoutMs,
        });
      }

      req.on('response', (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on('end', () => {
          const bodyBuffer = Buffer.concat(chunks);
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: decompressBody(bodyBuffer, res.headers['content-encoding']),
          });
        });
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    } catch (error) {
      reject(error);
    }
  });
}

// ============================================
// PROTOCOL SESSION
// ============================================
class ProtocolSession {
  constructor(proxyUrl = null) {
    this.proxyUrl = proxyUrl;
    this.cookies = {};
    this.cookieDetails = [];
    this.defaultHeaders = {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
      'Accept-Language': 'en-US,en;q=0.9',
      'Connection': 'keep-alive',
      'Sec-Ch-Ua': '"Chromium";v="136", "Google Chrome";v="136", "Not.A/Brand";v="99"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"macOS"',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1',
      'Priority': 'u=0, i',
      ...generateDatadogTraceHeaders(),
    };
    this._useCurl = false;
    this._curlChecked = false;
  }

  async _chooseTransport() {
    if (this._curlChecked) return;
    this._useCurl = await isCurlAvailable();
    this._curlChecked = true;
    console.log(`[Protocol] Transport: ${this._useCurl ? 'curl (Chrome impersonation)' : 'node:https (fallback)'}`);
  }

  async fetch(url, { method = 'GET', headers = {}, body = null, timeoutMs = 15000 } = {}) {
    await this._chooseTransport();
    const mergedHeaders = { ...this.defaultHeaders, ...headers };
    if (Object.keys(this.cookies).length) {
      mergedHeaders['Cookie'] = cookieJarToHeader(this.cookies);
    }

    const res = this._useCurl
      ? await requestViaCurl({ method, url, headers: mergedHeaders, body, proxyUrl: this.proxyUrl, timeoutMs })
      : await request({ method, url, headers: mergedHeaders, body, proxyUrl: this.proxyUrl, timeoutMs });

    // Update cookie jar from Set-Cookie headers
    const setCookie = res.headers['set-cookie'];
    if (setCookie) {
      const parsed = parseCookies(setCookie, url);
      Object.assign(this.cookies, parsed.cookies);
      for (const detail of parsed.cookieDetails) {
        const idx = this.cookieDetails.findIndex(c => c.name === detail.name && c.domain === detail.domain && c.path === detail.path);
        if (idx >= 0) this.cookieDetails[idx] = { ...this.cookieDetails[idx], ...detail };
        else this.cookieDetails.push(detail);
      }
    }

    // Try parse JSON, fallback to raw body
    let json = null;
    if (res.body) {
      try { json = JSON.parse(res.body); } catch (_) {}
    }

    return { status: res.status, headers: res.headers, body: res.body, json };
  }

  getCookie(name) {
    return this.cookies[name] || '';
  }

  exportCookies() {
    return this.cookieDetails.map(cookie => ({ ...cookie }));
  }
}

// ============================================
// SENTINEL (with VM-powered Turnstile solver)
// ============================================
async function checkSentinel(session, deviceId, flow = 'authorize_continue') {
  // Use SentinelVM to handle PoW and Turnstile challenges
  const vmResult = await checkSentinelWithVm(session, deviceId, flow, (...args) => console.log('[Protocol]', ...args));

  if (!vmResult) {
    console.log('[Protocol] Sentinel check failed, falling back to browser');
    return { token: '', demandsProofOfWork: true };
  }

  if (vmResult.demandsTurnstile && !vmResult.t) {
    console.log('[Protocol] Turnstile VM failed to solve, falling back to browser');
    return { token: vmResult.token, demandsProofOfWork: true };
  }

  console.log('[Protocol] Sentinel check passed', vmResult.demandsProofOfWork ? '(PoW solved)' : '', vmResult.demandsTurnstile ? '(Turnstile solved)' : '');

  return {
    token: vmResult.token,
    p: vmResult.p,
    t: vmResult.t,
    demandsProofOfWork: false,
  };
}

// ============================================
// OAUTH START
// ============================================
async function startOAuth(session) {
  // 1. Visit chatgpt.com root to seed cookies
  await session.fetch(`${CHATGPT_APP}/`, { timeoutMs: 10000 });

  // 2. Get CSRF token
  const csrfRes = await session.fetch(`${CHATGPT_APP}/api/auth/csrf`, { timeoutMs: 10000 });
  const csrfData = csrfRes.json || {};
  let csrfToken = csrfData.csrfToken || '';

  if (!csrfToken) {
    const raw = session.getCookie('__Host-next-auth.csrf-token');
    if (raw) {
      csrfToken = raw.includes('%7C') ? raw.split('%7C')[0] : raw.split('|')[0];
    }
  }

  // 3. Call signin/openai to get authorize URL
  const oaiDid = session.getCookie('oai-did');
  let signinUrl = `${CHATGPT_APP}/api/auth/signin/openai`;
  if (oaiDid) signinUrl += `?prompt=login&ext-oai-did=${oaiDid}`;

  const formData = `callbackUrl=${encodeURIComponent(`${CHATGPT_APP}/`)}&csrfToken=${encodeURIComponent(csrfToken)}&json=true`;
  const signinRes = await session.fetch(signinUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Origin': CHATGPT_APP,
      'Referer': `${CHATGPT_APP}/`,
      'Accept': 'application/json',
      ...generateDatadogTraceHeaders(),
    },
    body: formData,
    timeoutMs: 10000,
  });

  if (signinRes.status !== 200) {
    throw new Error(`signin/openai failed: ${signinRes.status} ${signinRes.body?.slice(0, 200)}`);
  }

  const signinData = signinRes.json || {};
  const authUrl = signinData.url || '';
  if (!authUrl) {
    throw new Error('signin/openai did not return authorize URL');
  }

  // 4. Visit authorize URL to obtain oai-did cookie if missing
  await session.fetch(authUrl, { timeoutMs: 10000 });
  const did = session.getCookie('oai-did');

  return { authUrl, deviceId: did };
}

// ============================================
// SIGNUP FORM
// ============================================
async function submitSignupForm(session, email, sentinelPayload) {
  const bodyObj = {
    username: { value: email, kind: 'email' },
    screen_hint: 'signup',
  };
  const headers = {
    'Referer': 'https://auth.openai.com/create-account',
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'Origin': OPENAI_AUTH,
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    ...generateDatadogTraceHeaders(),
  };

  // Include solved p and t values from SentinelVM
  if (sentinelPayload && sentinelPayload.token) {
    const sentinel = JSON.stringify({
      p: sentinelPayload.p || '',
      t: sentinelPayload.t || '',
      c: sentinelPayload.token,
      id: sentinelPayload.deviceId,
      flow: 'authorize_continue',
    });
    headers['openai-sentinel-token'] = sentinel;
  }

  const res = await session.fetch(ENDPOINTS.signup, {
    method: 'POST',
    headers,
    body: JSON.stringify(bodyObj),
    timeoutMs: 15000,
  });

  if (res.status !== 200) {
    throw new Error(`signup form failed: ${res.status} ${res.body?.slice(0, 200)}`);
  }

  const data = res.json || {};
  const pageType = data.page?.type || '';
  const isExisting = pageType === 'email_otp_verification';

  return { pageType, isExisting, responseData: data };
}

// ============================================
// PASSWORD REGISTRATION (with retry)
// ============================================
async function registerPassword(session, email, deviceId) {
  const candidates = [];
  while (candidates.length < 3) {
    const pwd = generatePassword();
    if (!candidates.includes(pwd)) candidates.push(pwd);
  }

  for (let i = 0; i < candidates.length; i++) {
    const password = candidates[i];
    console.log(`[Protocol] Password attempt ${i + 1}/${candidates.length}`);

    const headers = {
      'Origin': OPENAI_AUTH,
      'Referer': `${OPENAI_AUTH}/create-account/password`,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'Sec-Ch-Ua': '"Chromium";v="136", "Google Chrome";v="136", "Not.A/Brand";v="99"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"macOS"',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
      ...generateDatadogTraceHeaders(),
    };
    if (deviceId) headers['oai-device-id'] = deviceId;

    const res = await session.fetch(ENDPOINTS.register, {
      method: 'POST',
      headers,
      body: JSON.stringify({ password, username: email }),
      timeoutMs: 15000,
    });

    console.log(`[Protocol] registerPassword status: ${res.status}`);

    if (res.status === 200) {
      let pageType = '';
      try { pageType = res.json?.page?.type || ''; } catch (_) {}
      const isExisting = pageType === 'email_otp_verification';
      return { success: true, password, isExisting, pageType };
    }

    // Parse error
    let errMsg = '';
    let errCode = '';
    try {
      const errJson = JSON.parse(res.body || '{}');
      errMsg = errJson.error?.message || '';
      errCode = errJson.error?.code || '';
    } catch (_) {}

    if (/already|exists/.test(errMsg.toLowerCase()) || errCode === 'user_exists') {
      console.log(`[Protocol] Email ${email} already registered on OpenAI`);
      return { success: false, password: null, alreadyExists: true, error: 'email_already_registered' };
    }

    console.log(`[Protocol] Password attempt ${i + 1} failed: ${errMsg || res.body?.slice(0, 200)}`);
  }

  return { success: false, password: null, alreadyExists: false, error: 'all_password_attempts_failed' };
}

// ============================================
// OTP
// ============================================
async function sendVerificationCode(session) {
  const res = await session.fetch(ENDPOINTS.sendOtp, {
    method: 'GET',
    headers: {
      'Referer': `${OPENAI_AUTH}/create-account/password`,
      'Accept': 'application/json',
    },
    timeoutMs: 10000,
  });
  return res.status === 200;
}

async function validateVerificationCode(session, code) {
  const res = await session.fetch(ENDPOINTS.validateOtp, {
    method: 'POST',
    headers: {
      'Referer': `${OPENAI_AUTH}/email-verification`,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ code }),
    timeoutMs: 15000,
  });

  if (res.status !== 200) {
    return { success: false, error: `HTTP ${res.status} ${res.body?.slice(0, 200)}` };
  }

  const data = res.json || {};
  return {
    success: true,
    continueUrl: data.continue_url || '',
    pageType: data.page?.type || '',
    responseData: data,
  };
}

// ============================================
// CREATE USER ACCOUNT
// ============================================
async function createUserAccount(session, userInfo, deviceId) {
  const headers = {
    'Referer': `${OPENAI_AUTH}/about-you`,
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'Origin': OPENAI_AUTH,
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    ...generateDatadogTraceHeaders(),
  };
  if (deviceId) headers['oai-device-id'] = deviceId;

  // Optional: call client_auth_session_dump to push server state machine
  try {
    await session.fetch(`${OPENAI_AUTH}/api/accounts/client_auth_session_dump`, {
      method: 'GET',
      headers: {
        'Referer': `${OPENAI_AUTH}/email-verification`,
        'Accept': 'application/json',
      },
      timeoutMs: 10000,
    });
  } catch (_) {}

  const res = await session.fetch(ENDPOINTS.createAccount, {
    method: 'POST',
    headers,
    body: JSON.stringify(userInfo),
    timeoutMs: 15000,
  });

  if (res.status !== 200) {
    return { success: false, error: `HTTP ${res.status} ${res.body?.slice(0, 200)}` };
  }

  const data = res.json || {};
  return { success: true, continueUrl: data.continue_url || '', responseData: data };
}

// ============================================
// FOLLOW REDIRECTS FOR CALLBACK
// ============================================
async function followRedirectsForCallback(session, startUrl) {
  let currentUrl = startUrl;
  const maxRedirects = 10;

  for (let i = 0; i < maxRedirects && currentUrl; i++) {
    if (currentUrl.includes('code=') && currentUrl.includes('state=')) {
      const u = new URL(currentUrl);
      return { success: true, code: u.searchParams.get('code') || '', url: currentUrl };
    }

    const res = await session.fetch(currentUrl, {
      method: 'GET',
      headers: { 'Accept': 'text/html,*/*' },
      timeoutMs: 10000,
    });

    // Check for code in response body (some callbacks embed in JS or meta)
    if (res.body) {
      const codeMatch = res.body.match(/[?&]code=([^&#"\s]+)/);
      if (codeMatch) return { success: true, code: decodeURIComponent(codeMatch[1]), url: currentUrl };
    }

    // Follow Location header manually
    let nextUrl = '';
    const loc = res.headers.location;
    if (loc) {
      nextUrl = loc.startsWith('http') ? loc : new URL(loc, currentUrl).href;
    } else {
      // Try extract continue_url from JSON
      try {
        const j = JSON.parse(res.body || '{}');
        nextUrl = j.continue_url || j.redirect_uri || '';
      } catch (_) {}
    }

    if (!nextUrl) break;
    currentUrl = nextUrl;
  }

  return { success: false, code: '', url: currentUrl, error: 'max_redirects_reached_or_no_code' };
}

// ============================================
// MAIN ENTRY POINT
// ============================================
export async function runProtocolRegistration({ email, password, proxyUrl = null, emailService = null, logFn = console.log }) {
  const log = (...args) => logFn('[Protocol]', ...args);

  log('Starting protocol registration for', email);

  // 1. Create session
  const session = new ProtocolSession(proxyUrl);

  // 2. Start OAuth & get device ID
  log('Starting OAuth flow...');
  let deviceId;
  let authUrl;
  try {
    const oauth = await startOAuth(session);
    deviceId = oauth.deviceId;
    authUrl = oauth.authUrl;
    log('OAuth started, deviceId:', deviceId?.slice(0, 20));
  } catch (e) {
    return { success: false, error: `OAuth start failed: ${e.message}`, needsBrowserFallback: true };
  }

  if (!deviceId) {
    return { success: false, error: 'Failed to obtain device ID', needsBrowserFallback: true };
  }

  // 3. Check Sentinel (minimal — fallback on PoW demand)
  log('Checking Sentinel...');
  const sentinel = await checkSentinel(session, deviceId);
  if (sentinel?.demandsProofOfWork) {
    return { success: false, error: 'Sentinel PoW/turnstile required', needsBrowserFallback: true };
  }

  // 4. Submit signup form
  log('Submitting signup form...');
  let signupResult;
  try {
    signupResult = await submitSignupForm(session, email, { token: sentinel?.token || '', p: sentinel?.p || '', t: sentinel?.t || '', deviceId });
  } catch (e) {
    return { success: false, error: `Signup form failed: ${e.message}`, needsBrowserFallback: true };
  }

  log('Signup page type:', signupResult.pageType);

  // 5. Existing account detection
  if (signupResult.isExisting) {
    log('Email already registered — will switch to login flow');
    return { success: false, isExistingAccount: true, email, session, deviceId, needsBrowserFallback: false };
  }

  // 6. Register password (with retry)
  log('Registering password...');
  const pwdResult = await registerPassword(session, email, deviceId);
  if (pwdResult.alreadyExists) {
    return { success: false, isExistingAccount: true, email, session, deviceId, needsBrowserFallback: false };
  }
  if (!pwdResult.success) {
    return { success: false, error: pwdResult.error, needsBrowserFallback: true };
  }

  const usedPassword = pwdResult.password;

  // 7. Send verification code
  log('Sending verification code...');
  const sent = await sendVerificationCode(session);
  if (!sent) {
    return { success: false, error: 'Failed to send OTP', needsBrowserFallback: true };
  }

  // 8. Wait for and validate OTP (caller provides the code via email service)
  if (!emailService || !emailService.getVerificationCode) {
    return { success: false, error: 'emailService.getVerificationCode required for protocol OTP flow', needsBrowserFallback: true };
  }

  log('Waiting for OTP...');
  const otpCode = await emailService.getVerificationCode({ email, timeout: 120, pattern: /(?<!\d)(\d{6})(?!\d)/ });
  if (!otpCode) {
    return { success: false, error: 'OTP timeout', needsBrowserFallback: true };
  }
  log('OTP received:', otpCode);

  const validateResult = await validateVerificationCode(session, otpCode);
  if (!validateResult.success) {
    return { success: false, error: `OTP validation failed: ${validateResult.error}`, needsBrowserFallback: true };
  }

  log('OTP validated, page type:', validateResult.pageType);

  // 9. Create user account (if about-you page)
  let createResult = { success: true, continueUrl: validateResult.continueUrl };
  if (validateResult.pageType === 'about_you' || !validateResult.continueUrl) {
    const userInfo = generateRandomUserInfo();
    log('Creating user account...');
    createResult = await createUserAccount(session, userInfo, deviceId);
    if (!createResult.success) {
      return { success: false, error: `Account creation failed: ${createResult.error}`, needsBrowserFallback: true };
    }
  }

  // 10. Follow callback
  const callbackUrl = createResult.continueUrl || validateResult.continueUrl;
  if (!callbackUrl) {
    return { success: false, error: 'No continue_url for callback', needsBrowserFallback: true };
  }

  log('Following callback redirects...');
  const callbackResult = await followRedirectsForCallback(session, callbackUrl);
  if (!callbackResult.success) {
    return { success: false, error: `Callback failed: ${callbackResult.error}`, needsBrowserFallback: true };
  }

  // 11. Extract session token from chatgpt.com cookies
  log('Fetching chatgpt.com session...');
  await session.fetch(`${CHATGPT_APP}/api/auth/session`, {
    headers: { 'Accept': 'application/json' },
    timeoutMs: 10000,
  });

  const sessionToken = session.getCookie('__Secure-next-auth.session-token');
  const accountCookie = session.getCookie('_account');
  const accessToken = session.getCookie('oai-client-auth-session');

  log('Session extraction complete');

  return {
    success: true,
    email,
    password: usedPassword,
    accountId: accountCookie,
    sessionToken,
    accessToken,
    deviceId,
    source: 'register',
    cookies: session.exportCookies(),
  };
}

// ============================================
// CODEX CLI OAUTH CALLBACK (mirrors upstream _acquire_codex_callback)
// Pure HTTP API flow to get callback URL without browser phone screen
// ============================================
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CODEX_REDIRECT_URI = 'http://localhost:1455/auth/callback';
const CODEX_SCOPE = 'openid email profile offline_access';

function generateCodexPKCE() {
  const codeVerifier = crypto.randomBytes(48).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  const state = crypto.randomBytes(16).toString('base64url');
  return { codeVerifier, codeChallenge, state };
}

function buildCodexOAuthURL(pkce) {
  const params = new URLSearchParams({
    client_id: CODEX_CLIENT_ID,
    response_type: 'code',
    redirect_uri: CODEX_REDIRECT_URI,
    scope: CODEX_SCOPE,
    state: pkce.state,
    code_challenge: pkce.codeChallenge,
    code_challenge_method: 'S256',
    prompt: 'login',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
  });
  return `${OPENAI_AUTH}/oauth/authorize?${params.toString()}`;
}

function parseCallbackUrl(callbackUrl) {
  let candidate = (callbackUrl || '').trim();
  if (!candidate) return { code: '', state: '', error: '', error_description: '' };
  if (!candidate.includes('://')) {
    if (candidate.startsWith('?')) candidate = `http://localhost${candidate}`;
    else if (/[/?#]/.test(candidate) || candidate.includes(':')) candidate = `http://${candidate}`;
    else if (candidate.includes('=')) candidate = `http://localhost/?${candidate}`;
  }
  const u = new URL(candidate);
  const params = new URLSearchParams(u.search || '');
  const fragment = new URLSearchParams((u.hash || '').replace(/^#/, ''));
  for (const [k, v] of fragment.entries()) {
    if (!params.get(k)) params.set(k, v);
  }
  const code = params.get('code') || '';
  const state = params.get('state') || '';
  const error = params.get('error') || '';
  const error_description = params.get('error_description') || '';
  return { code, state, error, error_description };
}

function normalizeUrl(url, baseUrl = `${OPENAI_AUTH}/sign-in-with-chatgpt/codex/consent`) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  try {
    return new URL(raw, baseUrl).toString();
  } catch (_) {
    return raw;
  }
}

function extractFlowState(data, currentUrl = '') {
  const result = { continueUrl: '', currentUrl: normalizeUrl(currentUrl) };
  if (!data || typeof data !== 'object') return result;
  const directContinue = normalizeUrl(data.continue_url || data.continueUrl || '', currentUrl);
  if (directContinue) result.continueUrl = directContinue;
  const directCurrent = normalizeUrl(data.current_url || data.currentUrl || data.url || '', currentUrl);
  if (directCurrent) result.currentUrl = directCurrent;
  const nested = data.data && typeof data.data === 'object' ? data.data : null;
  if (!result.continueUrl && nested) {
    result.continueUrl = normalizeUrl(nested.continue_url || nested.continueUrl || '', currentUrl);
  }
  if (!result.currentUrl && nested) {
    result.currentUrl = normalizeUrl(nested.current_url || nested.currentUrl || nested.url || '', currentUrl);
  }
  return result;
}

async function fetchSentinelPayload(session, did, flow, log) {
  const ua = session.defaultHeaders['User-Agent'] || '';
  const generator = new SentinelTokenGenerator(did, ua);
  const initialP = generator.generateRequirementsToken();
  let sentP = initialP;
  const senReqBody = JSON.stringify({ p: sentP, id: did, flow });
  const senRes = await session.fetch(SENTINEL_REQ_URL, {
    method: 'POST',
    headers: {
      'Origin': 'https://sentinel.openai.com',
      'Referer': 'https://sentinel.openai.com/backend-api/sentinel/frame.html',
      'Content-Type': 'text/plain;charset=UTF-8',
      'Accept': '*/*',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-site',
      ...generateDatadogTraceHeaders(),
    },
    body: senReqBody,
    timeoutMs: 10000,
  });
  if (senRes.status !== 200) {
    log(`Sentinel failed: flow=${flow} status=${senRes.status}`);
    return null;
  }
  const data = senRes.json || {};
  const powMeta = data.proofofwork || {};
  if (powMeta.required && powMeta.seed) {
    sentP = generator.generateToken(String(powMeta.seed || ''), String(powMeta.difficulty || '0'));
    log(`Sentinel PoW solved: flow=${flow}`);
  }
  let tValue = '';
  const dxB64 = String((data.turnstile || {}).dx || '');
  if (dxB64) {
    try {
      tValue = solveTurnstileDx(dxB64, initialP, ua, SENTINEL_SDK_URL);
      log(`Sentinel VM solved: flow=${flow} t_len=${tValue.length}`);
    } catch (err) {
      log(`Sentinel VM failed: flow=${flow} error=${err?.message || err}`);
    }
  }
  return { p: sentP, t: tValue, c: String(data.token || ''), flow };
}

async function followRedirectsForCallbackUrl(session, startUrl, log) {
  let currentUrl = normalizeUrl(startUrl);
  if (!currentUrl) return '';
  for (let i = 0; i < 10; i++) {
    const parsedCurrent = parseCallbackUrl(currentUrl);
    if (parsedCurrent.code) return currentUrl;
    const res = await session.fetch(currentUrl, {
      method: 'GET',
      headers: { 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      timeoutMs: 15000,
    });
    const location = normalizeUrl(res.headers.location || '', currentUrl);
    log(`Redirect follow[${i + 1}] status=${res.status} location=${location || '(none)'}`);
    if (location) {
      const parsed = parseCallbackUrl(location);
      if (parsed.code) return location;
      currentUrl = location;
      continue;
    }
    const bodyText = String(res.body || '');
    const bodyMatch = bodyText.match(/https?:\/\/[^"'\s>]+[?&]code=[^"'\s>]+/i);
    if (bodyMatch) return bodyMatch[0];
    const flowState = extractFlowState(res.json || {}, currentUrl);
    const nextUrl = flowState.continueUrl || flowState.currentUrl || '';
    if (!nextUrl || nextUrl === currentUrl) break;
    currentUrl = nextUrl;
  }
  return '';
}

export async function acquireCodexCallbackViaProtocol({ email, password, proxyUrl = null, emailService = null, logFn = console.log }) {
  const log = (...args) => logFn('[CodexProtocol]', ...args);
  const session = new ProtocolSession(proxyUrl);
  const pkce = generateCodexPKCE();
  const authUrl = buildCodexOAuthURL(pkce);
  const consentUrl = `${OPENAI_AUTH}/sign-in-with-chatgpt/codex/consent`;
  log('Auth URL:', authUrl.slice(0, 80) + '...');

  const authRes = await session.fetch(authUrl, { timeoutMs: 15000 });
  log(`Authorize GET status=${authRes.status}`);
  const did = session.getCookie('oai-did');
  const cookieNames = Object.keys(session.cookies);
  log(`Cookies after authorize: [${cookieNames.join(', ')}] (total: ${cookieNames.length})`);
  log('Device ID:', did?.slice(0, 20) || 'none');
  if (!did) {
    log('⚠️ oai-did cookie missing — authorize URL may not have set it through redirect chain');
    return { success: false, error: 'Codex login: failed to get device_id' };
  }

  const senPayload = await fetchSentinelPayload(session, did, 'authorize_continue', log);
  if (senPayload) log(`Sentinel acquired: flow=${senPayload.flow}`);

  const signupHeaders = {
    'Referer': `${OPENAI_AUTH}/log-in`,
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    ...generateDatadogTraceHeaders(),
  };
  if (senPayload) {
    signupHeaders['openai-sentinel-token'] = JSON.stringify({
      p: senPayload.p,
      t: senPayload.t,
      c: senPayload.c,
      id: did,
      flow: senPayload.flow,
    });
  }

  const contRes = await session.fetch(`${OPENAI_AUTH}/api/accounts/authorize/continue`, {
    method: 'POST',
    headers: signupHeaders,
    body: JSON.stringify({ username: { value: email, kind: 'email' }, screen_hint: 'login' }),
    timeoutMs: 15000,
  });
  log(`authorize/continue status=${contRes.status}`);
  if (contRes.status !== 200) {
    return { success: false, error: `authorize/continue failed: ${contRes.status}` };
  }

  const contData = contRes.json || {};
  let pageType = contData.page?.type || '';
  log(`authorize/continue page_type=${pageType || '(empty)'}`);

  if (pageType === 'email_otp_verification') {
    if (!emailService?.getVerificationCode) {
      return { success: false, error: 'Codex login: OTP required but no email service' };
    }
    const otpCode = await emailService.getVerificationCode({ email, timeout: 120, pattern: /(?<!\d)(\d{6})(?!\d)/ });
    if (!otpCode) {
      return { success: false, error: 'Codex login: OTP timeout' };
    }
    log('OTP acquired for authorize/continue');
    const otpRes = await session.fetch(`${OPENAI_AUTH}/api/accounts/email-otp/validate`, {
      method: 'POST',
      headers: {
        'Referer': `${OPENAI_AUTH}/email-verification`,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        ...generateDatadogTraceHeaders(),
      },
      body: JSON.stringify({ code: otpCode }),
      timeoutMs: 15000,
    });
    log(`OTP validate status=${otpRes.status}`);
    if (otpRes.status !== 200) {
      return { success: false, error: `Codex login OTP validate failed: ${otpRes.status}` };
    }
    pageType = otpRes.json?.page?.type || '';
    log(`OTP validate page_type=${pageType || '(empty)'}`);
    if (pageType === 'add_phone') {
      return { success: false, error: 'Codex login: still requires add_phone after OTP' };
    }
  } else if (pageType === 'login_password' || pageType === 'create_account_password') {
    if (!password) {
      return { success: false, error: 'Codex login: password required but not provided' };
    }
    await session.fetch(`${OPENAI_AUTH}/log-in/password`, { timeoutMs: 15000 });
    const pwdSent = await fetchSentinelPayload(session, did, 'login_password', log);
    const pwdHeaders = {
      'Origin': OPENAI_AUTH,
      'Referer': `${OPENAI_AUTH}/log-in/password`,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      ...generateDatadogTraceHeaders(),
    };
    if (did) pwdHeaders['oai-device-id'] = did;
    if (pwdSent) {
      pwdHeaders['openai-sentinel-token'] = JSON.stringify({
        p: pwdSent.p,
        t: pwdSent.t,
        c: pwdSent.c,
        id: did,
        flow: pwdSent.flow,
      });
    }
    const pwdRes = await session.fetch(`${OPENAI_AUTH}/api/accounts/user/register`, {
      method: 'POST',
      headers: pwdHeaders,
      body: JSON.stringify({ password, username: email }),
      timeoutMs: 15000,
    });
    log(`Password submit status=${pwdRes.status}`);
    if (pwdRes.status !== 200) {
      return { success: false, error: `Codex login password failed: ${pwdRes.status}` };
    }
    pageType = pwdRes.json?.page?.type || '';
    log(`Password page_type=${pageType || '(empty)'}`);

    if (pageType === 'email_otp_send') {
      const sendRes = await session.fetch(`${OPENAI_AUTH}/api/accounts/email-otp/send`, {
        method: 'GET',
        headers: { 'Referer': `${OPENAI_AUTH}/email-verification` },
        timeoutMs: 15000,
      });
      log(`OTP send after password status=${sendRes.status}`);
      pageType = 'email_otp_verification';
    }
    if (pageType === 'email_otp_verification') {
      if (!emailService?.getVerificationCode) {
        return { success: false, error: 'Codex login: OTP required after password but no email service' };
      }
      const code2 = await emailService.getVerificationCode({ email, timeout: 120, pattern: /(?<!\d)(\d{6})(?!\d)/ });
      if (!code2) return { success: false, error: 'Codex login: OTP timeout after password' };
      log('OTP acquired after password');
      const otp2Res = await session.fetch(`${OPENAI_AUTH}/api/accounts/email-otp/validate`, {
        method: 'POST',
        headers: {
          'Referer': `${OPENAI_AUTH}/email-verification`,
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          ...generateDatadogTraceHeaders(),
        },
        body: JSON.stringify({ code: code2 }),
        timeoutMs: 15000,
      });
      log(`OTP validate after password status=${otp2Res.status}`);
      if (otp2Res.status !== 200) {
        return { success: false, error: `Codex login OTP after password failed: ${otp2Res.status}` };
      }
      pageType = otp2Res.json?.page?.type || '';
      log(`OTP after password page_type=${pageType || '(empty)'}`);
      if (pageType === 'add_phone') {
        return { success: false, error: 'Codex login: still requires add_phone after password+OTP' };
      }
    }
  }

  if (pageType === 'add_phone') {
    return { success: false, error: 'Codex login: phone verification required (add_phone)' };
  }

  let nextUrl = '';
  const flowState = extractFlowState(contData, consentUrl);
  nextUrl = flowState.continueUrl || flowState.currentUrl || '';
  if (!nextUrl) {
    nextUrl = authUrl;
  }
  log(`Callback candidate URL: ${nextUrl.slice(0, 140)}`);

  let callbackUrl = '';
  const directCandidate = parseCallbackUrl(nextUrl);
  if (directCandidate.code) {
    callbackUrl = nextUrl;
  } else {
    callbackUrl = await followRedirectsForCallbackUrl(session, nextUrl, log);
  }

  if (!callbackUrl) {
    callbackUrl = await followRedirectsForCallbackUrl(session, authUrl, log);
  }
  if (!callbackUrl) {
    return { success: false, error: 'Codex login: no callback URL in redirect chain' };
  }

  const parsedCallback = parseCallbackUrl(callbackUrl);
  if (parsedCallback.error) {
    return { success: false, error: `Codex login oauth error: ${parsedCallback.error}: ${parsedCallback.error_description || ''}`.trim() };
  }
  if (!parsedCallback.code) {
    return { success: false, error: 'Codex login: callback URL missing code' };
  }
  if (parsedCallback.state && parsedCallback.state !== pkce.state) {
    return { success: false, error: `Codex login: state mismatch (${parsedCallback.state} !== ${pkce.state})` };
  }

  log(`Callback URL acquired: ${callbackUrl.slice(0, 140)}`);
  log(`Callback code acquired: ${parsedCallback.code.slice(0, 20)}...`);
  return {
    success: true,
    callbackUrl,
    code: parsedCallback.code,
    state: parsedCallback.state,
    pkce,
    source: 'codex_protocol',
  };
}
