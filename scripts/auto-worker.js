/**
 * SeeLLM Tools - Unified Auto Worker
 *
 * Gộp auto-login-worker + auto-connect-worker thành 1 script duy nhất:
 *  - 1 polling loop gộp (login task + connect task)
 *  - 1 thread pool chung (MAX_THREADS)
 *  - Mode selection: auto (tự động), direct-login (ChatGPT login), pkce-login (OAuth PKCE)
 *  - Gộp result reporting: gửi đúng endpoint theo source
 *
 * Usage:
 *  node scripts/auto-worker.js                    # auto mode (default)
 *  node scripts/auto-worker.js --mode direct-login # direct-login mode
 *  node scripts/auto-worker.js --mode pkce-login   # pkce-login mode
 *  WORKER_MODE=direct-login node scripts/auto-worker.js  # env var
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAMOUFOX_API, GATEWAY_URL, WORKER_AUTH_TOKEN, POLL_INTERVAL_MS, MAX_THREADS, WORKER_MODE } from './config.js';
import { camofoxPost, camofoxGet, camofoxDelete, camofoxGoto, evalJson, navigate, pressKey, tripleClick } from './lib/camofox.js';
import { getTOTP, getFreshTOTP } from './lib/totp.js';
import { extractIpFromText, normalizeProxyUrl, getLocalPublicIp, probeProxyExitIp, assertProxyApplied, isLocalRelayProxy } from './lib/proxy-diag.js';
import { createSaveStep } from './lib/screenshot.js';
import { decodeJwtPayload, extractAccountMeta } from './lib/openai-auth.js';
import { getState, fillEmail, fillPassword, fillMfa, tryAcceptCookies, dismissGooglePopupAndClickLogin, waitForState, isPhoneVerificationScreen, isConsentScreen, isAuthLoginLikeScreen, MULTILANG } from './lib/openai-login-flow.js';
import { generatePKCE, buildOAuthURL, exchangeCodeForTokens, CODEX_CONSENT_URL, decodeAuthSessionCookie, extractWorkspaceId, performWorkspaceConsentBypass } from './lib/openai-oauth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(__dirname, '..');
const IMAGES_DIR = path.join(ROOT_DIR, 'data', 'screenshots');
const CHATGPT_LOGIN_DEBUG = process.env.CHATGPT_LOGIN_DEBUG === '1';
const TOOLS_API = process.env.TOOLS_API_URL || 'http://localhost:4000';

// ═══════════════════════════════════════════════════════════════
// MODE RESOLVER
// ═══════════════════════════════════════════════════════════════
function resolveMode(argv = process.argv.slice(2), configMode = WORKER_MODE, silent = false) {
  // Check for --mode CLI arg
  const modeIndex = argv.indexOf('--mode');
  let source = 'default';
  let resolvedMode = 'auto';

  if (modeIndex !== -1 && argv[modeIndex + 1]) {
    const cliMode = String(argv[modeIndex + 1]).toLowerCase().trim();
    source = 'CLI';
    // New mode names
    if (['auto', 'both', 'all', 'unified'].includes(cliMode)) resolvedMode = 'auto';
    else if (['direct-login', 'connect', 'connect-only'].includes(cliMode)) resolvedMode = 'direct-login';
    else if (['pkce-login', 'login', 'login-only', 'worker'].includes(cliMode)) resolvedMode = 'pkce-login';
    else {
      console.warn(`[Mode] ⚠️ Invalid CLI mode: "${cliMode}". Falling back to 'auto'.`);
      resolvedMode = 'auto';
    }
  } else {
    // Fallback to config/env
    const configModeLower = String(configMode || 'auto').toLowerCase().trim();
    source = configMode ? 'config' : 'default';
    if (['auto', 'both', 'all', 'unified'].includes(configModeLower)) resolvedMode = 'auto';
    else if (['direct-login', 'connect', 'connect-only'].includes(configModeLower)) resolvedMode = 'direct-login';
    else if (['pkce-login', 'login', 'login-only', 'worker'].includes(configModeLower)) resolvedMode = 'pkce-login';
    else {
      console.warn(`[Mode] ⚠️ Invalid config mode: "${configMode}". Falling back to 'auto'.`);
      resolvedMode = 'auto';
    }
  }

  // Deprecation warnings for old names
  const oldNames = ['both', 'connect-only', 'login-only', 'connect', 'login', 'worker'];
  const input = modeIndex !== -1 && argv[modeIndex + 1] ? String(argv[modeIndex + 1]).toLowerCase().trim() : String(configMode || 'auto').toLowerCase().trim();
  if (oldNames.includes(input)) {
    console.warn(`[Mode] ⚠️ Deprecated mode name: "${input}". Please use new names: auto, direct-login, pkce-login.`);
  }

  if (!silent) {
    console.log(`[Mode] Mode resolved: ${resolvedMode} (source: ${source})`);
  }
  return resolvedMode;
}
const MODE = resolveMode();

// ═══════════════════════════════════════════════════════════════
// TIỆN ÍCH CHUNG
// ═══════════════════════════════════════════════════════════════
function getTaskTotpSecret(task) {
  return task?.totpSecret || task?.twoFaSecret || task?.two_fa_secret || task?.secret || null;
}

function maskSensitive(value) {
  const str = String(value ?? '');
  if (!str) return str;
  if (str.includes('@')) {
    const [name, domain] = str.split('@');
    return `${name.slice(0, 2)}***@${domain}`;
  }
  if (str.length <= 4) return '*'.repeat(str.length);
  return `${str.slice(0, 2)}***${str.slice(-2)}`;
}

function debugChatgptLogin(task, label, payload) {
  if (!CHATGPT_LOGIN_DEBUG) return;
  try {
    const safePayload = JSON.parse(JSON.stringify(payload, (key, value) => {
      if (['email', 'password', 'totp', 'totpSecret', 'twoFaSecret', 'two_fa_secret', 'secret'].includes(key)) return maskSensitive(value);
      if (typeof value === 'string' && value.includes(task?.email || '')) return value.replaceAll(task.email, maskSensitive(task.email));
      return value;
    }));
    console.log(`[${task.email}] 🐞 debug(${label}): ${JSON.stringify(safePayload).slice(0, 1600)}`);
  } catch {}
}

function isWorkspaceSessionError(url = '', snapshot = '') {
  const cleanText = snapshot.toLowerCase().replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');
  return cleanText.includes('workspaces not found in client auth session') ||
         cleanText.includes('oops, an error occurred');
}

function isGoogleDomainDrift(url = '') {
  return url.includes('accounts.google.com') || url.includes('google.com/account');
}

async function fetchSessionInPage(tabId, userId) {
  return evalJson(tabId, userId, `
    (async () => {
      try {
        const r = await fetch('https://chatgpt.com/api/auth/session', {
          credentials: 'include',
          headers: { 'Accept': 'application/json' },
        });
        const text = await r.text();
        return { ok: r.ok, status: r.status, body: text };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    })()
  `, 12000);
}

async function tryFetchInPage(tabId, userId, url, init = {}, timeoutMs = 8000) {
  const payload = JSON.stringify({ url, init });
  return evalJson(tabId, userId, `
    (async () => {
      const { url, init } = ${payload};
      try {
        const res = await fetch(url, {
          credentials: 'include',
          redirect: 'follow',
          ...init,
          headers: { 'content-type': 'application/json', ...(init.headers || {}) },
        });
        const text = await res.text();
        return { ok: res.ok, status: res.status, url: res.url, body: text.slice(0, 2000) };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    })()
  `, timeoutMs);
}

function parseUuidMatches(input = '') {
  return Array.from(new Set(String(input).match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi) || []));
}

async function extractWorkspaceCandidates(tabId, userId) {
  const out = new Set();
  try {
    const cookiesRes = await camofoxGet(`/tabs/${tabId}/cookies?userId=${userId}`, { timeoutMs: 5000 });
    const cookies = Array.isArray(cookiesRes?.cookies) ? cookiesRes.cookies : (Array.isArray(cookiesRes) ? cookiesRes : []);
    for (const c of cookies) {
      if (!c?.name) continue;
      if (String(c.name).includes('oai-client-auth-session') || String(c.name).includes('workspace') || String(c.name).includes('auth')) {
        parseUuidMatches(c.value || '').forEach(v => out.add(v));
      }
    }
  } catch (_) {}
  try {
    const pageData = await evalJson(tabId, userId, `
      (() => {
        const html = document.documentElement.outerHTML || '';
        const scripts = Array.from(document.scripts || []).map((s) => s.textContent || '').join('\\n');
        const body = document.body?.innerText || '';
        return { html: html.slice(0, 250000), scripts: scripts.slice(0, 250000), body: body.slice(0, 5000) };
      })()
    `, 10000);
    parseUuidMatches(pageData?.html).forEach(v => out.add(v));
    parseUuidMatches(pageData?.scripts).forEach(v => out.add(v));
    parseUuidMatches(pageData?.body).forEach(v => out.add(v));
  } catch (_) {}
  return Array.from(out);
}

async function trySelectWorkspaceAndOrganization({ task, userId, tabId, saveStep }) {
  const candidates = await extractWorkspaceCandidates(tabId, userId);
  console.log(`[${task.email}] 🗂️ Workspace candidates: ${JSON.stringify(candidates).slice(0, 800)}`);
  if (!candidates.length) return { ok: false, reason: 'no_workspace_candidates' };

  for (const workspaceId of candidates) {
    for (const payload of [{ workspace_id: workspaceId }, { workspaceId }, { id: workspaceId }]) {
      const res = await tryFetchInPage(tabId, userId, 'https://auth.openai.com/api/accounts/workspace/select', { method: 'POST', body: JSON.stringify(payload) }, 10000);
      console.log(`[${task.email}] 🧩 workspace/select ${JSON.stringify(payload)} => ${JSON.stringify(res).slice(0, 800)}`);
      const bodyText = String(res?.body || '');
      if (!res?.ok) { if (bodyText.includes('invalid_auth_step')) continue; continue; }
      await saveStep('workspace_selected');
      const orgCandidates = parseUuidMatches(res?.body || '');
      if (orgCandidates.length) {
        for (const orgId of orgCandidates.slice(0, 5)) {
          for (const orgPayload of [{ organization_id: orgId }, { organizationId: orgId }, { id: orgId }]) {
            const orgRes = await tryFetchInPage(tabId, userId, 'https://auth.openai.com/api/accounts/organization/select', { method: 'POST', body: JSON.stringify(orgPayload) }, 10000);
            if (orgRes?.ok) { await saveStep('organization_selected'); return { ok: true, workspaceId, orgId }; }
          }
        }
      }
      return { ok: true, workspaceId };
    }
  }
  return { ok: false, reason: 'workspace_select_failed', candidates };
}

async function clickBestMatchingAction(tabId, userId, options = {}) {
  const { exactTexts = [], includesTexts = [], excludeTexts = [], timeoutMs = 4000 } = options;
  try {
    const payload = JSON.stringify({ exactTexts, includesTexts, excludeTexts });
    return await evalJson(tabId, userId, `
      (() => {
        const { exactTexts, includesTexts, excludeTexts } = ${payload};
        const norm = (v) => (v || '').trim().toLowerCase();
        const isVisible = (el) => { if (!el) return false; const s = window.getComputedStyle(el); const r = el.getBoundingClientRect(); return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0; };
        const exact = exactTexts.map(norm); const includes = includesTexts.map(norm); const excludes = excludeTexts.map(norm);
        const candidates = Array.from(document.querySelectorAll('button, a, input[type="submit"], [role="button"]')).filter(isVisible).map(el => ({ el, text: norm(el.innerText || el.textContent || el.value || ''), testId: el.getAttribute('data-testid') || '' })).filter(x => x.text && !excludes.some(t => x.text.includes(t)));
        let winner = candidates.find(x => x.testId && exact.includes(x.testId)) || candidates.find(x => exact.includes(x.text)) || candidates.find(x => includes.some(t => x.text.includes(t)));
        if (!winner) return { ok: false, reason: 'no-match' };
        // Strengthen: mousedown + mouseup + click (like auto-register) for React pointer events
        try {
          winner.el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
          winner.el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
        } catch (_) {}
        winner.el.click();
        return { ok: true, text: winner.text, testId: winner.testId || null };
      })()
    `, timeoutMs);
  } catch (err) { return { ok: false, error: err.message }; }
}

async function tryFillChatgptLoginForm(tabId, userId, task) {
  try {
    const email = task.email;
    if (!email) return { ok: false, reason: 'no-email' };
    const r = await fillEmail(tabId, userId, email);
    if (r?.ok) { await pressKey(tabId, userId, 'Enter'); await new Promise(r2 => setTimeout(r2, 2000)); }
    return r;
  } catch (err) { return { ok: false, error: err.message }; }
}

async function tryFillChatgptMfaForm(tabId, userId, task) {
  try {
    const totpSecret = getTaskTotpSecret(task);
    if (!totpSecret) return { ok: false, reason: 'no-totp-secret' };
    const { otp } = await getFreshTOTP(totpSecret, 10);
    const r = await fillMfa(tabId, userId, otp);
    if (r?.ok) { await pressKey(tabId, userId, 'Enter'); await new Promise(r2 => setTimeout(r2, 2000)); }
    return r;
  } catch (err) { return { ok: false, error: err.message }; }
}

async function tryBootstrapWorkspaceSession({ task, userId, tabId, saveStep }) {
  try {
    const sessionRes = await tryFetchInPage(tabId, userId, 'https://chatgpt.com/api/auth/session', {}, 8000);
    if (sessionRes?.ok && sessionRes.body) {
      try {
        const sessionData = JSON.parse(sessionRes.body);
        if (sessionData?.accessToken) {
          const meta = extractAccountMeta(sessionData.accessToken);
          if (meta.accountId) return { ok: true, method: 'session_probe', accountId: meta.accountId };
        }
      } catch (_) {}
    }
  } catch (_) {}
  return { ok: false, reason: 'bootstrap_failed' };
}

// ═══════════════════════════════════════════════════════════════
// RESULT REPORTING (UNIFIED)
// ═══════════════════════════════════════════════════════════════
async function sendResult(task, status, message, result = null, tokens = null) {
  const taskId = task.id;
  const source = task.source || 'tools';
  const preview = String(message).slice(0, 100);
  console.log(`[Report] 📡 ${status.toUpperCase()}: ${preview}`);

  // 1. Gửi về Tools connect-result nếu có tokens (connect flow)
  if (tokens?.accessToken || tokens?.access_token) {
    try {
      const res = await fetch(`${TOOLS_API}/api/vault/accounts/connect-result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: taskId, status, message, tokens }),
        signal: AbortSignal.timeout(30000),
      });
      console.log(`[Report] 📡 connect-result HTTP ${res.status}`);
    } catch (e) {
      console.log(`[Report] ⚠️ connect-result failed: ${e.message}`);
    }
    return;
  }

  // 2. Gửi về Tools result endpoint (login PKCE flow)
  try {
    const toolsResult = (result && result.codeVerifier) ? result : (source === 'tools' ? result : null);
    const res = await fetch(`${TOOLS_API}/api/vault/accounts/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: taskId, status, message, result: toolsResult }),
      signal: AbortSignal.timeout(45000),
    });
    console.log(`[Report] 📡 result HTTP ${res.status}`);
  } catch (e) {
    console.log(`[Report] ⚠️ result failed: ${e.message}`);
  }

  // 3. Gửi về Gateway nếu source=gateway
  if (source === 'gateway') {
    try {
      const res = await fetch(`${GATEWAY_URL}/api/public/worker/result`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${WORKER_AUTH_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: taskId, status, message, result }),
      });
      console.log(`[Report] 📡 Gateway HTTP ${res.status}`);
    } catch (e) {
      console.error('[Report] Gateway error:', e.message);
    }
  } else if (source === 'd1') {
    try {
      const configRes = await fetch(`${TOOLS_API}/api/config`, { signal: AbortSignal.timeout(2000) });
      const cfg = await configRes.json();
      if (cfg.d1WorkerUrl && cfg.d1SyncSecret) {
        const d1Status = status === 'success' ? 'ready' : status;
        await fetch(`${cfg.d1WorkerUrl}/accounts/${taskId}`, {
          method: 'PATCH',
          headers: { 'x-sync-secret': cfg.d1SyncSecret, 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: d1Status, last_error: message, updated_at: new Date().toISOString() }),
          signal: AbortSignal.timeout(4000),
        });
      }
    } catch (_) {}
  }
}

// ═══════════════════════════════════════════════════════════════
// CONNECT FLOW (Direct ChatGPT login → PKCE token exchange)
// Ưu tiên: nhanh hơn vì login trực tiếp + exchange token ngay
// ═══════════════════════════════════════════════════════════════
async function runConnectFlow(task) {
  const USER_ID = `seellm_connect_${task.id}`;
  const effectiveProxy = normalizeProxyUrl(task.proxyUrl || task.proxy_url || task.proxy || null);
  if (effectiveProxy) { task.proxyUrl = effectiveProxy; task.proxy_url = effectiveProxy; task.proxy = effectiveProxy; }
  const { email, password } = task;
  const totpSecret = task.twoFaSecret || task.two_fa_secret || null;

  console.log(`\n[Connect] ════════════════════════════════`);
  console.log(`[Connect] 🔌 Bắt đầu: ${email}`);
  if (effectiveProxy) console.log(`[Connect] 🔌 Proxy: ${effectiveProxy}`);

  if (!email || !password) return sendResult(task, 'error', 'Thiếu email hoặc password');

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const runDir = path.join(IMAGES_DIR, `connect_${task.id}_${ts}`);
  await fs.mkdir(runDir, { recursive: true });

  let tabId = null;
  let saveStep = null;
  let preFlightResult = null;

  try {
    if (effectiveProxy) {
      console.log(`[Connect] 🔒 [PreFlight] Asserting proxy: ${effectiveProxy}`);
      try {
        let lastErr = null;
        for (let preflightAttempt = 0; preflightAttempt < 3; preflightAttempt++) {
          try {
            preFlightResult = await assertProxyApplied(effectiveProxy);
            lastErr = null;
            break;
          } catch (err) {
            lastErr = err;
            const msg = String(err?.message || err || '');
            const isTransient = msg.includes('fetch failed') || msg.includes('Không lấy được exit IP');
            if (!isTransient || preflightAttempt === 2) break;
            console.log(`[Connect] ⚠️ [PreFlight] Retry ${preflightAttempt + 1}/2 sau lỗi tạm thời: ${msg}`);
            await new Promise(r => setTimeout(r, 2000 + preflightAttempt * 1500));
          }
        }
        if (!preFlightResult && lastErr) throw lastErr;
        console.log(`[Connect] ✅ [PreFlight] Exit IP: ${preFlightResult.exitIp}`);
      } catch (err) { console.log(`[Connect] 🛑 [PreFlight] FAILED: ${err.message}`); throw err; }
    }

    const LOGIN_URL = 'https://chatgpt.com/auth/login';
    console.log(`[Connect] [1] Mở ${LOGIN_URL}...`);
    const opened = await camofoxPost('/tabs', {
      userId: USER_ID, sessionKey: `cg_connect_${task.id}`, url: LOGIN_URL,
      proxy: effectiveProxy || undefined, persistent: false, os: 'macos',
      screen: { width: 1440, height: 900 }, humanize: true, headless: false, randomFonts: true, canvas: 'random',
    }, { timeoutMs: 25000 });
    tabId = opened.tabId;
    saveStep = createSaveStep(runDir, { tabId, userId: USER_ID });
    await new Promise(r => setTimeout(r, 5000));

    if (effectiveProxy && preFlightResult) {
      const verifyCheck = await probeProxyExitIp(USER_ID, effectiveProxy, true);
      if (verifyCheck?.ip && verifyCheck.ip !== preFlightResult.exitIp) {
        console.log(`[Connect] ⚠️ [PostVerify] IP changed: ${preFlightResult.exitIp} → ${verifyCheck.ip} (rotating?)`);
      } else if (verifyCheck?.ip) {
        console.log(`[Connect] ✅ [PostVerify] IP consistent: ${verifyCheck.ip}`);
      }
    }
    await saveStep('01_login_page');

    let state = await getState(tabId, USER_ID);

    if (state?.looksLoggedIn) {
      console.log(`[Connect] ✅ Đã có session! Lấy token ngay...`);
      await captureAndReport(tabId, USER_ID, runDir, task, email, saveStep, effectiveProxy);
      return;
    }

    await tryAcceptCookies(tabId, USER_ID);
    await new Promise(r => setTimeout(r, 1500));

    console.log(`[Connect] [1b] Dismiss Google popup + bấm Log in...`);
    const loginClick = await dismissGooglePopupAndClickLogin(tabId, USER_ID);
    console.log(`[Connect] [1b] Result:`, JSON.stringify(loginClick));
    // Nếu form đã visible (UI mới sau click More options), giảm wait time
    const waitTime = loginClick?.formVisible ? 2000 : 4000;
    await new Promise(r => setTimeout(r, waitTime));
    await saveStep('01b_after_login_click');
    state = await getState(tabId, USER_ID);

    if (!state?.onAuthDomain && !state?.hasEmailInput && !state?.looksLoggedIn) {
      console.log(`[Connect] [1c] Chưa redirect, thử bấm Log in lần 2...`);
      await dismissGooglePopupAndClickLogin(tabId, USER_ID);
      await new Promise(r => setTimeout(r, 5000));
      await saveStep('01c_retry');
      state = await getState(tabId, USER_ID);
    }

    if (!state?.onAuthDomain && !state?.hasEmailInput && !state?.looksLoggedIn) {
      console.log(`[Connect] [1d] Fallback: authorize URL trực tiếp...`);
      await navigate(tabId, USER_ID,
        'https://auth.openai.com/authorize?client_id=DRivsnm2Mu42T3KOpqdtwB3NYviHYzwD&audience=https%3A%2F%2Fapi.openai.com%2Fv1&redirect_uri=https%3A%2F%2Fchatgpt.com%2Fapi%2Fauth%2Fcallback%2Flogin-web&scope=openid+email+profile+offline_access+model.request+model.read+organization.read+organization.write&response_type=code&response_mode=query&state=login&prompt=login',
        { timeoutMs: 15000 });
      await new Promise(r => setTimeout(r, 5000));
      await saveStep('01d_fallback');
      state = await getState(tabId, USER_ID);
    }

    // Email
    let emailDone = false;
    for (let attempt = 0; attempt < 8 && !emailDone; attempt++) {
      if (state?.looksLoggedIn || state?.hasPasswordInput) { emailDone = true; break; }
      if (state?.hasEmailInput) {
        console.log(`[Connect] [2] Điền email...`);
        const r = await fillEmail(tabId, USER_ID, email);
        await new Promise(r2 => setTimeout(r2, 3000));
        await saveStep(`02_email_${attempt + 1}`);
        state = await getState(tabId, USER_ID);
        if (r?.ok) emailDone = true;
      } else {
        await new Promise(r => setTimeout(r, 2500));
        state = await getState(tabId, USER_ID);
      }
    }
    if (!emailDone && !state?.hasPasswordInput && !state?.looksLoggedIn) {
      if (state?.hasPhoneScreen) return sendResult(task, 'error', 'NEED_PHONE: Tài khoản yêu cầu xác minh số điện thoại');
      return sendResult(task, 'error', `Không tìm thấy email input. URL: ${state?.href}`);
    }

    // Password
    let passDone = false;
    for (let attempt = 0; attempt < 5 && !passDone; attempt++) {
      if (state?.looksLoggedIn || state?.hasMfaInput) { passDone = true; break; }
      if (state?.hasPasswordInput) {
        console.log(`[Connect] [3] Điền password...`);
        const r = await fillPassword(tabId, USER_ID, password);
        await new Promise(r2 => setTimeout(r2, 3500));
        await saveStep(`03_password_${attempt + 1}`);
        state = await getState(tabId, USER_ID);
        if (r?.ok) passDone = true;
      } else {
        await new Promise(r => setTimeout(r, 2500));
        state = await getState(tabId, USER_ID);
      }
    }

    // MFA
    if (state?.hasMfaInput) {
      if (!totpSecret) return sendResult(task, 'error', 'MFA required nhưng account chưa có 2FA secret');
      console.log(`[Connect] [4] MFA → sinh TOTP...`);
      const { otp } = await getFreshTOTP(totpSecret, 8);
      await fillMfa(tabId, USER_ID, otp);
      await new Promise(r2 => setTimeout(r2, 4000));
      await saveStep('04_mfa');
      state = await getState(tabId, USER_ID);
      if (state?.hasMfaInput) {
        const { otp: otp2 } = await getFreshTOTP(totpSecret, 3);
        await fillMfa(tabId, USER_ID, otp2);
        await new Promise(r2 => setTimeout(r2, 4000));
        await saveStep('04b_mfa_retry');
        state = await getState(tabId, USER_ID);
      }
    }

    // Wait for login
    console.log(`[Connect] [5] Đợi redirect sau login...`);
    const finalState = await waitForState(tabId, USER_ID, { looksLoggedIn: true }, { timeoutMs: 60000, intervalMs: 2000 });
    if (!finalState) {
      const currentState = await getState(tabId, USER_ID);
      if (currentState?.hasPhoneScreen) return sendResult(task, 'error', 'NEED_PHONE: Tài khoản yêu cầu xác minh số điện thoại');
      return sendResult(task, 'error', `Timeout 60s. URL: ${currentState?.href}`);
    }
    console.log(`[Connect] ✅ Đã đăng nhập!`);
    await saveStep('05_post_login');
    await captureAndReport(tabId, USER_ID, runDir, task, email, saveStep, effectiveProxy);

  } catch (err) {
    console.error(`[Connect] ❌ Exception: ${err.message}`);
    if (saveStep) await saveStep('error').catch(() => {});
    const rawMsg = err?.message || String(err);
    const reportMsg = rawMsg.startsWith('NEED_PHONE') ? rawMsg : `Exception: ${rawMsg}`;
    await sendResult(task, 'error', reportMsg);
  } finally {
    if (tabId) { await camofoxDelete(`/tabs/${tabId}?userId=${USER_ID}`); console.log(`[Connect] 🧹 Đóng tab ${tabId}`); }
  }
}

// ═══════════════════════════════════════════════════════════════
// CAPTURE & REPORT (sau khi đã logged in → PKCE + token exchange)
// ═══════════════════════════════════════════════════════════════
async function captureAndReport(tabId, userId, runDir, task, email, saveStep, effectiveProxy) {
  console.log(`[Capture] 🔍 Bắt đầu lấy OAuth tokens (PKCE flow)...`);
  const pkce = generatePKCE();
  const authUrl = buildOAuthURL(pkce);
  console.log(`[Capture] [A] PKCE state=${pkce.state.slice(0, 12)}...`);

  // Set up interceptor
  await evalJson(tabId, userId, `
    (() => {
      window.__oauthCallbackUrl = null;
      try {
        const obs = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (entry.name && entry.name.includes('localhost:1455') && entry.name.includes('code=')) {
              window.__oauthCallbackUrl = entry.name;
            }
          }
        });
        obs.observe({ entryTypes: ['navigation', 'resource'] });
      } catch (_) {}
      return 'listener-set';
    })()
  `, 3000);

  await navigate(tabId, userId, authUrl, 20000);
  await new Promise(r => setTimeout(r, 3000));
  await saveStep('07_oauth_redirect');

  let authCode = '';
  let callbackState = '';
  const { password } = task;
  const totpSecret = task.twoFaSecret || task.two_fa_secret || null;
  let oauthLoginHandled = false;
  let consentAttempts = 0;
  const MAX_CONSENT_ATTEMPTS = 3;

  for (let i = 0; i < 30; i++) {
    const currentUrl = await evalJson(tabId, userId, 'location.href', 4000);
    if (currentUrl && currentUrl.includes('code=')) {
      try {
        const url = new URL(currentUrl);
        authCode = url.searchParams.get('code') || '';
        callbackState = url.searchParams.get('state') || '';
        if (authCode) { console.log(`[Capture] ✅ OAuth code: ${authCode.slice(0, 20)}...`); break; }
      } catch (_) {}
    }
    if (currentUrl && currentUrl.includes('localhost:1455')) {
      try {
        const url = new URL(currentUrl);
        authCode = url.searchParams.get('code') || '';
        if (authCode) { console.log(`[Capture] ✅ Code from localhost: ${authCode.slice(0, 20)}...`); break; }
      } catch (_) {}
    }
    if (currentUrl && (currentUrl.includes('about:neterror') || currentUrl.includes('about:blank') || currentUrl === '')) {
      const intercepted = await evalJson(tabId, userId, 'window.__oauthCallbackUrl || null', 2000);
      if (intercepted && intercepted.includes('code=')) {
        try { authCode = new URL(intercepted).searchParams.get('code') || ''; if (authCode) break; } catch (_) {}
      }
    }

    const oauthState = await getState(tabId, userId);

    if (oauthState?.hasPhoneScreen) {
      console.log(`[Capture] 📵 Phone screen → workspace API bypass...`);
      await saveStep('08b_skip_phone_consent');
      const codeResult = await performWorkspaceConsentBypass(evalJson, tabId, userId);
      if (codeResult?.code) { authCode = codeResult.code; console.log(`[Capture] ✅ Code via workspace API`); break; }
      return sendResult(task, 'error', 'NEED_PHONE: Tài khoản yêu cầu xác minh số điện thoại');
    }
    if (oauthState?.hasEmailInput && !oauthLoginHandled) {
      await fillEmail(tabId, userId, email);
      await new Promise(r => setTimeout(r, 3000));
      oauthLoginHandled = true; continue;
    }
    if (oauthState?.hasPasswordInput) {
      await fillPassword(tabId, userId, password);
      await new Promise(r => setTimeout(r, 3500)); continue;
    }
    if (oauthState?.hasMfaInput && totpSecret) {
      const { otp } = await getFreshTOTP(totpSecret, 8);
      await fillMfa(tabId, userId, otp);
      await new Promise(r => setTimeout(r, 4000)); continue;
    }

    if (currentUrl && currentUrl.includes('auth.openai.com') && !oauthState?.hasEmailInput && !oauthState?.hasPasswordInput && !oauthState?.hasMfaInput && !oauthState?.hasPhoneScreen) {
      if (consentAttempts >= MAX_CONSENT_ATTEMPTS) {
        console.log(`[Capture] Consent bypass reached max attempts (${MAX_CONSENT_ATTEMPTS}), skipping...`);
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }
      consentAttempts++;
      console.log(`[Capture] Consent bypass attempt (${consentAttempts}/${MAX_CONSENT_ATTEMPTS})...`);
      const codeResult = await performWorkspaceConsentBypass(evalJson, tabId, userId);
      if (codeResult?.code) { authCode = codeResult.code; break; }
      const clickResult = await clickBestMatchingAction(tabId, userId, { exactTexts: ['authorize', 'allow', 'continue'], excludeTexts: ['close'], timeoutMs: 4000 });
      if (clickResult?.ok) console.log(`[Capture] Clicked: ${clickResult.text}`);
    }
    await new Promise(r => setTimeout(r, 1500));
  }
  await saveStep('08_oauth_callback');

  // Exchange code → tokens
  if (authCode) {
    try {
      const tokenData = await exchangeCodeForTokens(authCode, pkce, effectiveProxy);
      const accessToken = tokenData.access_token || '';
      const refreshToken = tokenData.refresh_token || '';
      const idToken = tokenData.id_token || '';
      const expiresIn = tokenData.expires_in || 0;
      if (!accessToken) return sendResult(task, 'error', 'Token exchange không có access_token');
      const meta = extractAccountMeta(accessToken);
      let sessionToken = '', deviceId = '';
      try {
        const ck = await camofoxGet(`/tabs/${tabId}/cookies?userId=${userId}`, { timeoutMs: 6000 });
        const cookies = Array.isArray(ck?.cookies) ? ck.cookies : (Array.isArray(ck) ? ck : []);
        sessionToken = cookies.find(c => c.name?.includes('session-token'))?.value || '';
        deviceId = cookies.find(c => c.name === 'oai-device-id')?.value || '';
      } catch (_) {}
      return sendResult(task, 'success', 'OAuth PKCE login + token exchange thành công', null, {
        ...tokenData, accessToken, refreshToken, idToken, sessionToken, deviceId, expiresIn,
        accountId: meta.accountId, userId: meta.userId, organizationId: meta.organizationId,
        planType: meta.planType, expiredAt: meta.expiredAt, email: meta.email || email,
      });
    } catch (exchangeErr) {
      console.error(`[Capture] ❌ Token exchange lỗi: ${exchangeErr.message}`);
    }
  }

  // Fallback: session
  console.log(`[Capture] 🔄 Fallback: session endpoint...`);
  await navigate(tabId, userId, 'https://chatgpt.com', 10000);
  await new Promise(r => setTimeout(r, 2000));
  let accessToken = '';
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt === 2) { await navigate(tabId, userId, 'https://chatgpt.com', 10000); await new Promise(r => setTimeout(r, 2000)); }
    await new Promise(r => setTimeout(r, [1500, 2000, 3000, 4000, 5000][attempt]));
    const sessionRes = await fetchSessionInPage(tabId, userId);
    if (sessionRes?.ok && sessionRes.body?.length > 10) {
      try { const d = JSON.parse(sessionRes.body); accessToken = d?.accessToken || ''; if (accessToken) break; } catch (_) {}
    }
  }
  await saveStep('06_session_captured');
  if (!accessToken) return sendResult(task, 'error', 'Cả PKCE và session fallback đều thất bại');
  const meta = extractAccountMeta(accessToken);
  let sessionToken = '', deviceId = '';
  try {
    const ck = await camofoxGet(`/tabs/${tabId}/cookies?userId=${userId}`, 6000);
    const cookies = Array.isArray(ck?.cookies) ? ck.cookies : (Array.isArray(ck) ? ck : []);
    sessionToken = cookies.find(c => c.name?.includes('session-token'))?.value || '';
    deviceId = cookies.find(c => c.name === 'oai-device-id')?.value || '';
  } catch (_) {}
  await sendResult(task, 'success', 'Đăng nhập thành công (fallback - chỉ access_token)', null, {
    access_token: accessToken, refresh_token: '', accessToken, refreshToken: '',
    sessionToken, deviceId, accountId: meta.accountId, userId: meta.userId,
    organizationId: meta.organizationId, planType: meta.planType, email: meta.email || email,
  });
}

// ═══════════════════════════════════════════════════════════════
// LOGIN PKCE FLOW (Gateway-originated, chỉ có codeVerifier)
// ═══════════════════════════════════════════════════════════════
async function runLoginFlow(task) {
  const account = task;
  const effectiveProxy = normalizeProxyUrl(account.proxyUrl || account.proxy || null);
  if (effectiveProxy) { account.proxyUrl = effectiveProxy; account.proxy = effectiveProxy; }
  const USER_ID = `seellm_worker_${task.id}`;
  const SESSION_KEY = `codex_${task.id}`;
  let tabId;

  if (!account.email || account.email.trim() === '') throw new Error('Missing Email Address');

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const runDir = path.join(IMAGES_DIR, `run_${task.id}_${timestamp}`);
  await fs.mkdir(runDir, { recursive: true });
  let saveStep = null, preFlightResult = null;

  try {
    if (effectiveProxy) {
      try { preFlightResult = await assertProxyApplied(effectiveProxy); console.log(`✅ [PreFlight] Exit IP: ${preFlightResult.exitIp}`); }
      catch (err) { console.log(`🛑 [PreFlight] FAILED: ${err.message}`); throw err; }
    }

    const loginUrl = account.loginUrl || account.authUrl || 'https://chatgpt.com/auth/login';
    console.log(`[Login] [1] Mở URL: ${loginUrl}`);
    const { tabId: tid, userAgent } = await camofoxPost('/tabs', {
      userId: USER_ID, sessionKey: SESSION_KEY, url: loginUrl,
      proxy: effectiveProxy || undefined, persistent: false, os: 'macos',
      screen: { width: 1440, height: 900 }, humanize: true, headless: false, randomFonts: true, canvas: 'random',
    });
    tabId = tid;
    saveStep = createSaveStep(runDir, { tabId, userId: USER_ID });
    await new Promise(r => setTimeout(r, 2000));

    if (effectiveProxy && preFlightResult) {
      const verifyCheck = await probeProxyExitIp(USER_ID, effectiveProxy, true);
      if (verifyCheck?.ip && verifyCheck.ip !== preFlightResult.exitIp) {
        console.log(`⚠️ [PostVerify] IP changed (rotating proxy?)`);
      } else if (verifyCheck?.ip) {
        console.log(`✅ [PostVerify] IP consistent: ${verifyCheck.ip}`);
      }
    }
    await saveStep('khoi_dong');

    // Email
    console.log(`[Login] [2] Điền email: ${account.email}`);
    const emailInputSelector = 'input[name="username"], #username, input[type="email"], #email-input, input[name="email-input"], input[name="email"]';
    await camofoxPost(`/tabs/${tabId}/type`, { userId: USER_ID, selector: emailInputSelector, text: account.email });
    await saveStep('da_dien_email');
    await pressKey(tabId, USER_ID, 'Enter');
    try { await camofoxPost(`/tabs/${tabId}/click`, { userId: USER_ID, selector: 'button[type="submit"]' }); } catch (_) {}
    await new Promise(r => setTimeout(r, 1000));
    await saveStep('sau_email');

    // Password
    console.log(`[Login] [4] Điền password...`);
    await camofoxPost(`/tabs/${tabId}/type`, { userId: USER_ID, selector: 'input[type="password"], input[name="password"], #password', text: account.password });
    await saveStep('da_dien_password');
    await pressKey(tabId, USER_ID, 'Enter');
    try { await camofoxPost(`/tabs/${tabId}/click`, { userId: USER_ID, selector: 'button[type="submit"]' }); } catch (_) {}
    await new Promise(r => setTimeout(r, 2000));
    await saveStep('sau_password');

    // 2FA / Phone detection
    let redirectUrl = null, isAtMFA = false;
    for (let j = 0; j < 5; j++) {
      const snapData = await camofoxGet(`/tabs/${tabId}/snapshot?userId=${USER_ID}`);
      const snap2Url = (snapData.url || '').toLowerCase();
      const snapText = (snapData.snapshot || '').toLowerCase();
      const cleanMfaText = snapText.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');

      if (isPhoneVerificationScreen(snap2Url, snapText)) {
        redirectUrl = await tryBypassPhoneRequirement({ task, userId: USER_ID, tabId, sessionKey: SESSION_KEY, proxyUrl: account.proxyUrl || account.proxy || undefined, saveStep });
        if (redirectUrl) break;
        await saveStep('yeu_cau_so_dien_thoai');
        await sendResult(task, 'error', 'NEED_PHONE: Tài khoản yêu cầu xác minh số điện thoại');
        return;
      }
      isAtMFA = snap2Url.includes('mfa') || snap2Url.includes('/verify') || snapText.includes('one-time code') || snapText.includes('authenticator') || snapText.includes('enter the code');
      if (isAtMFA) break;
      if (snap2Url.includes('localhost:1455') || snap2Url.includes('code=')) break;
      await new Promise(r => setTimeout(r, 2000));
    }

    if (!redirectUrl && isAtMFA) {
      console.log(`[Login] 🛡️ MFA...`);
      if (!account.twoFaSecret) {
        console.log(`[Login] ⚠️ Cần 2FA nhưng không có secret`);
      } else {
        const mfaSelector = 'input[autocomplete="one-time-code"], input[name="code"], input[type="text"], input[inputmode="numeric"]';
        try { await camofoxPost(`/tabs/${tabId}/click`, { userId: USER_ID, selector: mfaSelector }); } catch (_) {}
        const { otp, remaining } = await getFreshTOTP(account.twoFaSecret, 5);
        await camofoxPost(`/tabs/${tabId}/type`, { userId: USER_ID, selector: mfaSelector, text: otp });
        await pressKey(tabId, USER_ID, 'Enter');
        await new Promise(r => setTimeout(r, 6000));

        // Check phone after OTP
        const afterSnap = await camofoxGet(`/tabs/${tabId}/snapshot?userId=${USER_ID}`);
        if (isPhoneVerificationScreen(afterSnap.url || '', (afterSnap.snapshot || '').toLowerCase())) {
          const bypassUrl = await tryBypassPhoneRequirement({ task, userId: USER_ID, tabId, sessionKey: SESSION_KEY, proxyUrl: account.proxyUrl || account.proxy || undefined, saveStep });
          if (bypassUrl) redirectUrl = bypassUrl;
          else { await sendResult(task, 'error', 'NEED_PHONE: Tài khoản yêu cầu xác minh số điện thoại'); return; }
        }

        // Retry MFA if still there
        const afterText = (afterSnap.snapshot || '').toLowerCase();
        if (afterText.includes('one-time code') || afterText.includes('authenticator') || (afterSnap.url || '').includes('mfa')) {
          const { otp: otp2, remaining: r2 } = await getFreshTOTP(account.twoFaSecret, 2);
          try { await tripleClick(tabId, USER_ID, mfaSelector); } catch (_) {}
          await camofoxPost(`/tabs/${tabId}/type`, { userId: USER_ID, selector: mfaSelector, text: otp2 });
          await pressKey(tabId, USER_ID, 'Enter');
          await new Promise(r => setTimeout(r, 4500));
        }
      }
      await saveStep('sau_2fa');
    }

    // Wait for redirect
    for (let i = 0; i < 20 && !redirectUrl; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const checkSnap = await camofoxGet(`/tabs/${tabId}/snapshot?userId=${USER_ID}`);
      const curUrl = checkSnap.url || '';
      const html = (checkSnap.snapshot || '').toLowerCase();

      if (isPhoneVerificationScreen(curUrl, html)) {
        redirectUrl = await tryBypassPhoneRequirement({ task, userId: USER_ID, tabId, sessionKey: SESSION_KEY, proxyUrl: account.proxyUrl || account.proxy || undefined, saveStep });
        if (!redirectUrl) { await sendResult(task, 'error', 'NEED_PHONE: Tài khoản yêu cầu xác minh số điện thoại'); return; }
        break;
      }
      if (curUrl.includes('consent') || html.includes('authorize') || html.includes('allow')) {
        try { await camofoxPost(`/tabs/${tabId}/click`, { userId: USER_ID, selector: 'button:has-text("Continue"), button.btn-primary, [type="submit"]' }); } catch (_) { await pressKey(tabId, USER_ID, 'Enter'); }
        await new Promise(r => setTimeout(r, 2000));
      }
      if (curUrl.includes('localhost:1455') || curUrl.includes('code=')) { redirectUrl = curUrl; break; }
      if (i > 5 && (curUrl.includes('login') || html.includes('forgot password'))) await pressKey(tabId, USER_ID, 'Enter');
    }
    await saveStep('ket_thuc_flow');

    if (redirectUrl && redirectUrl.includes('code=')) {
      const urlObj = new URL(redirectUrl);
      const code = urlObj.searchParams.get('code');
      await sendResult(task, 'success', 'Đã lấy được code thành công', {
        code, codeVerifier: task.codeVerifier || account.codeVerifier,
        userAgent, proxyUrl: account.proxyUrl || account.proxy || undefined, finalUrl: redirectUrl,
      });
    } else {
      try {
        const finalSnap = await camofoxGet(`/tabs/${tabId}/snapshot?userId=${USER_ID}`);
        if (isPhoneVerificationScreen(finalSnap.url || '', (finalSnap.snapshot || '').toLowerCase())) {
          await sendResult(task, 'error', 'NEED_PHONE: Tài khoản yêu cầu xác minh số điện thoại'); return;
        }
      } catch (_) {}
      await sendResult(task, 'error', 'Hết thời gian chờ hoặc không tìm thấy code trong URL redirect', { finalUrl: redirectUrl || 'unknown' });
    }
  } catch (err) {
    const rawMsg = err?.message || String(err);
    const reportMsg = rawMsg.startsWith('NEED_PHONE') ? rawMsg : `Lỗi Worker: ${rawMsg}`;
    await sendResult(task, 'error', reportMsg, null);
  } finally {
    if (tabId) { try { await camofoxDelete(`/tabs/${tabId}?userId=${USER_ID}`); } catch (_) {} }
  }
}

// tryBypassPhoneRequirement — extracted from login worker
async function tryBypassPhoneRequirement({ task, userId, tabId, sessionKey, proxyUrl, saveStep }) {
  console.log(`[${task.email}] 📵 tryBypassPhoneRequirement...`);
  let bypassTabId = tabId;
  let openedExtraTab = false;
  try {
    await camofoxGoto(tabId, userId, CODEX_CONSENT_URL, { timeoutMs: 15000 });
  } catch (gotoErr) {
    const opened = await camofoxPost('/tabs', {
      userId, sessionKey, url: CODEX_CONSENT_URL, proxy: proxyUrl || undefined,
      persistent: false, os: 'macos', screen: { width: 1440, height: 900 },
      humanize: true, headless: false, randomFonts: true, canvas: 'random',
    });
    bypassTabId = opened.tabId;
    openedExtraTab = true;
  }
  await new Promise(r => setTimeout(r, 3000));
  await saveStep('thu_consent_bypass');

  let bootstrapAttempts = 0;
  for (let i = 0; i < 20; i++) {
    const snap = await camofoxGet(`/tabs/${bypassTabId}/snapshot?userId=${userId}`);
    const currentUrl = snap.url || '';
    const snapshot = snap.snapshot || '';

    if (currentUrl.includes('localhost:1455') || currentUrl.includes('code=')) {
      await saveStep('bypass_thanh_cong');
      return currentUrl;
    }
    if (isWorkspaceSessionError(currentUrl, snapshot)) {
      if (bootstrapAttempts >= 2) break;
      bootstrapAttempts++;
      await tryBootstrapWorkspaceSession({ task, userId, tabId: bypassTabId, saveStep });
      const after = await camofoxGet(`/tabs/${bypassTabId}/snapshot?userId=${userId}`, { timeoutMs: 6000 });
      if ((after.url || '').includes('localhost:1455') || (after.url || '').includes('code=')) {
        await saveStep('workspace_bootstrap_success');
        return after.url;
      }
    }
    if (isPhoneVerificationScreen(currentUrl, snapshot)) return null;
    if (isAuthLoginLikeScreen(currentUrl, snapshot)) {
      const filledLogin = await tryFillChatgptLoginForm(bypassTabId, userId, task);
      if (filledLogin?.ok) { await new Promise(r => setTimeout(r, 2000)); continue; }
      const filledMfa = await tryFillChatgptMfaForm(bypassTabId, userId, task);
      if (filledMfa?.ok) { await new Promise(r => setTimeout(r, 2000)); continue; }
    }
    if (isConsentScreen(currentUrl, snapshot)) {
      await clickBestMatchingAction(bypassTabId, userId, { exactTexts: ['authorize', 'allow', 'continue', 'tiếp tục'], excludeTexts: ['close', 'đóng'], timeoutMs: 4000 });
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  if (openedExtraTab && bypassTabId !== tabId) {
    try { await camofoxDelete(`/tabs/${bypassTabId}?userId=${userId}`); } catch (_) {}
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════
// UNIFIED POLLING — 1 loop, 1 thread pool
// ═══════════════════════════════════════════════════════════════
let activeThreads = 0;
const processingIds = new Set();

async function fetchAnyTask() {
  const excludeParam = processingIds.size > 0 ? `?exclude=${[...processingIds].join(',')}` : '';

  // 1. Connect tasks (ưu tiên cao — nhanh hơn, trực tiếp)
  if (currentMode === 'auto' || currentMode === 'direct-login') {
    try {
      const res = await fetch(`${TOOLS_API}/api/vault/accounts/connect-task${excludeParam}`, { signal: AbortSignal.timeout(4000) });
      if (res.ok) {
        const d = await res.json();
        if (d?.task) { d.task._flow = 'connect'; d.task.source = d.task.source || 'tools'; return d.task; }
      }
    } catch (_) {}
  }

  // 2. Login tasks (Tools local)
  if (currentMode === 'auto' || currentMode === 'pkce-login') {
    try {
      const res = await fetch(`${TOOLS_API}/api/vault/accounts/task${excludeParam}`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const data = await res.json();
        if (data.task) { data.task._flow = 'login'; data.task.source = 'tools'; return data.task; }
      }
    } catch (_) {}

    // 3. Gateway tasks
    try {
      const res = await fetch(`${GATEWAY_URL}/api/public/worker/task`, {
        headers: { Authorization: `Bearer ${WORKER_AUTH_TOKEN}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(3000),
      });
      if (res.status === 200) {
        const data = await res.json();
        if (data.task) { data.task._flow = 'login'; data.task.source = 'gateway'; return data.task; }
      }
    } catch (_) {}

    // 4. D1 Cloud
    try {
      const configRes = await fetch(`${TOOLS_API}/api/config`, { signal: AbortSignal.timeout(2000) });
      const cfg = await configRes.json();
      if (cfg.d1WorkerUrl && cfg.d1SyncSecret) {
        const d1Res = await fetch(`${cfg.d1WorkerUrl}/inspect/accounts?limit=200`, {
          headers: { 'x-sync-secret': cfg.d1SyncSecret }, signal: AbortSignal.timeout(4000),
        });
        if (d1Res.ok) {
          const d1Data = await d1Res.json();
          const pending = (d1Data.items || []).find(a => !a.deleted_at && (a.status === 'pending' || a.status === 'relogin'));
          if (pending) { pending._flow = 'login'; pending.source = 'd1'; return pending; }
        }
      }
    } catch (_) {}
  }

  return null;
}

async function pollTasks() {
  if (activeThreads >= MAX_THREADS) return;
  try {
    const task = await fetchAnyTask();
    if (!task?.id) return;
    if (processingIds.has(task.id)) return;

    processingIds.add(task.id);
    activeThreads++;

    // Auto-select flow: connect nếu có password, login nếu chỉ có codeVerifier
    const flow = task._flow || (task.password ? 'connect' : 'login');
    console.log(`[Worker] 🚀 ${flow.toUpperCase()} flow: ${task.email} (mode: ${currentMode}, threads: ${activeThreads}/${MAX_THREADS})`);

    const runner = flow === 'connect' ? runConnectFlow : runLoginFlow;
    runner(task)
      .then(() => {
        activeThreads = Math.max(0, activeThreads - 1);
        processingIds.delete(task.id);
        console.log(`[Worker] ✅ Hoàn tất ${task.email}. Còn trống: ${MAX_THREADS - activeThreads}`);
        if (activeThreads < MAX_THREADS) setTimeout(pollTasks, 1000);
      })
      .catch(err => {
        activeThreads = Math.max(0, activeThreads - 1);
        processingIds.delete(task.id);
        console.error(`[Worker] ❌ Lỗi ${task.email}:`, err.message);
      });

    if (activeThreads < MAX_THREADS) setTimeout(pollTasks, 2000);
  } catch (err) {
    console.error('[Worker] Poll error:', err.message);
  }
}

// ═══════════════════════════════════════════════════════════════
// DYNAMIC MODE RELOAD
// ═══════════════════════════════════════════════════════════════
let currentMode = MODE;

async function checkModeReload() {
  try {
    const res = await fetch(`${TOOLS_API}/api/config`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return;
    const cfg = await res.json();
    const newConfigMode = cfg.workerMode || 'auto';

    // Re-resolve mode (CLI arg still takes priority), silent to avoid spam logs
    const newMode = resolveMode(process.argv.slice(2), newConfigMode, true);

    if (newMode !== currentMode) {
      console.log(`[Mode] 🔄 Mode changed from '${currentMode}' to '${newMode}' (config updated)`);
      currentMode = newMode;
      // Note: MODE is const, so we use currentMode in fetchAnyTask instead
    }
  } catch (err) {
    // Silent fail - config check is best-effort
  }
}

// Check for mode changes every 5 seconds
setInterval(checkModeReload, 5000);

// ═══════════════════════════════════════════════════════════════
// CLEANUP ON SHUTDOWN
// ═══════════════════════════════════════════════════════════════
process.on('SIGTERM', async () => {
  console.log('[Worker] SIGTERM received, cleaning up...');
  // Cleanup all Camofox tabs for this worker session
  try {
    const tabs = await camofoxGet('/tabs');
    if (tabs && tabs.length > 0) {
      for (const tab of tabs) {
        if (tab.userId && tab.userId.startsWith('seellm_worker_')) {
          try { await camofoxDelete(`/tabs/${tab.tabId}?userId=${tab.userId}`); } catch (_) {}
        }
      }
    }
  } catch (_) {}
  console.log('[Worker] Cleanup complete, exiting...');
  process.exit(0);
});

// ═══════════════════════════════════════════════════════════════
// KHỞI ĐỘNG
// ═══════════════════════════════════════════════════════════════
console.log(`\n====================================`);
console.log(`🤖 SEELLM UNIFIED AUTO WORKER`);
console.log(`====================================`);
console.log(`- GATEWAY: ${GATEWAY_URL}`);
console.log(`- CAMOFOX: ${CAMOUFOX_API}`);
console.log(`- MAX THREADS: ${MAX_THREADS}`);
console.log(`- POLL: mỗi ${POLL_INTERVAL_MS}ms`);
console.log(`- MODE: ${MODE}`);
console.log(`====================================\n`);

setInterval(pollTasks, POLL_INTERVAL_MS);
pollTasks();
