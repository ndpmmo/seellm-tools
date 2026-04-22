/**
 * Deep Camoufox connectivity test:
 * 1) Health
 * 2) Exit IP via proxy (IPv6-capable endpoint)
 * 3) Access chatgpt.com/auth/login and inspect page state
 *
 * Usage:
 *   node scripts/test-camofox-proxy-ip.js <proxyUrl>
 */
import { CAMOUFOX_API } from './config.js';

const RAW_PROXY = (process.argv[2] || '').trim();
const USER_ID = `proxy_diag_${Date.now()}`;
const IP_CHECK_URL = 'https://api64.ipify.org/?format=json';
const CHATGPT_URL = 'https://chatgpt.com/auth/login';

if (!RAW_PROXY) {
  console.log('Usage: node scripts/test-camofox-proxy-ip.js <proxyUrl>');
  process.exit(1);
}

function normalizeProxyUrl(input) {
  const s = String(input || '').trim();
  if (!s) return '';
  if (s.includes('://')) return s;
  return `http://${s}`;
}
const PROXY_URL = normalizeProxyUrl(RAW_PROXY);

function extractIp(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  try {
    const j = JSON.parse(text);
    if (j?.ip) return String(j.ip).trim();
    if (j?.query) return String(j.query).trim();
    if (j?.address) return String(j.address).trim();
  } catch (_) {}
  const ipv4 = text.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/);
  if (ipv4) return ipv4[0];
  const ipv6 = text.match(/\b(?:[A-Fa-f0-9]{1,4}:){2,7}[A-Fa-f0-9]{1,4}\b/);
  return ipv6 ? ipv6[0] : '';
}

async function post(path, body, timeoutMs = 30000) {
  const res = await fetch(`${CAMOUFOX_API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (_) {}
  if (!res.ok) throw new Error(`${res.status} ${text || res.statusText}`);
  return data || {};
}

async function get(path, timeoutMs = 30000) {
  const res = await fetch(`${CAMOUFOX_API}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (_) {}
  if (!res.ok) throw new Error(`${res.status} ${text || res.statusText}`);
  return data || {};
}

async function del(path, timeoutMs = 10000) {
  await fetch(`${CAMOUFOX_API}${path}`, {
    method: 'DELETE',
    signal: AbortSignal.timeout(timeoutMs),
  }).catch(() => {});
}

async function getLocalIp() {
  try {
    const r = await fetch(IP_CHECK_URL, { signal: AbortSignal.timeout(12000) });
    const t = await r.text();
    return extractIp(t);
  } catch (_) {
    return '';
  }
}

async function openTabWithProxy(url) {
  return post('/tabs', {
    userId: USER_ID,
    sessionKey: USER_ID,
    url,
    proxy: PROXY_URL,
    persistent: false,
    headless: false,
    humanize: true,
    randomFonts: true,
    canvas: 'random',
  }, 30000);
}

async function evalInTab(tabId, expression, timeoutMs = 25000) {
  const r = await post(`/tabs/${tabId}/eval`, { userId: USER_ID, expression }, timeoutMs);
  return r?.result;
}

async function testIpPhase() {
  const opened = await openTabWithProxy(IP_CHECK_URL);
  const tabId = opened.tabId;
  if (!tabId) throw new Error('Missing tabId in IP phase');
  await new Promise(r => setTimeout(r, 5000));
  const bodyText = await evalInTab(tabId, `document.body && document.body.innerText ? document.body.innerText : ''`);
  const exitIp = extractIp(bodyText);
  await del(`/tabs/${tabId}?userId=${USER_ID}`);
  return { exitIp, raw: String(bodyText || '').slice(0, 220) };
}

async function testChatgptPhase() {
  const opened = await openTabWithProxy(CHATGPT_URL);
  const tabId = opened.tabId;
  if (!tabId) throw new Error('Missing tabId in ChatGPT phase');
  await new Promise(r => setTimeout(r, 7000));

  const state = await evalInTab(tabId, `
    (() => {
      const href = location.href;
      const title = document.title || '';
      const txt = (document.body && document.body.innerText ? document.body.innerText : '').toLowerCase();
      const hasLogin = txt.includes('log in') || txt.includes('đăng nhập');
      const hasSignup = txt.includes('sign up') || txt.includes('đăng ký');
      const hasChallenge = txt.includes('cloudflare') || txt.includes('checking your browser') || txt.includes('verify you are human');
      return {
        href,
        title,
        hasLogin,
        hasSignup,
        hasChallenge,
        snippet: txt.slice(0, 260)
      };
    })()
  `, 30000);

  const snap = await get(`/tabs/${tabId}/snapshot?userId=${USER_ID}`).catch(() => ({}));
  await del(`/tabs/${tabId}?userId=${USER_ID}`);
  return {
    state,
    snapshotSnippet: String(snap?.snapshot || '').slice(0, 280),
  };
}

async function main() {
  console.log(`\n[Diag] CAMOUFOX_API: ${CAMOUFOX_API}`);
  console.log(`[Diag] PROXY: ${PROXY_URL}`);

  try {
    const health = await get('/health', 8000);
    console.log(`[Diag] Health: ${JSON.stringify(health)}`);

    const localIp = await getLocalIp();
    console.log(`[Diag] Local IP (${IP_CHECK_URL}): ${localIp || '(unavailable)'}`);

    const ipPhase = await testIpPhase();
    console.log(`[Diag] Proxy Exit IP: ${ipPhase.exitIp || '(missing)'}`);
    console.log(`[Diag] IP Raw: ${ipPhase.raw}`);
    if (localIp && ipPhase.exitIp && localIp === ipPhase.exitIp) {
      console.log('[Diag] WARN: Exit IP trùng local IP -> khả năng proxy chưa được áp dụng.');
    } else if (ipPhase.exitIp) {
      console.log('[Diag] OK: Exit IP khác local IP.');
    }

    const chat = await testChatgptPhase();
    console.log(`[Diag] ChatGPT URL: ${chat.state?.href || '(missing)'}`);
    console.log(`[Diag] ChatGPT Title: ${chat.state?.title || '(missing)'}`);
    console.log(`[Diag] ChatGPT Flags: login=${!!chat.state?.hasLogin}, signup=${!!chat.state?.hasSignup}, challenge=${!!chat.state?.hasChallenge}`);
    console.log(`[Diag] ChatGPT Snippet: ${String(chat.state?.snippet || '').slice(0, 220)}`);
    console.log(`[Diag] Snapshot Snippet: ${chat.snapshotSnippet}`);
  } catch (e) {
    console.error(`[Diag] ERROR: ${e.message}`);
    process.exitCode = 1;
  }
}

main();
