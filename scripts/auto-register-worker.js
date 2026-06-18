/**
 * SeeLLM Tools - Auto-Register Worker
 * 
 * Worker tự động tạo tài khoản ChatGPT qua trình duyệt (Camoufox).
 * Format Input yêu cầu: email|password|refresh_token|client_id
 * (Ví dụ: abc@hotmail.com|pass123|R_TOKEN|C_ID)
 * 
 * Sau khi đăng ký xong, Worker sẽ KIẾT KẾT bật tính năng 2FA (MFA)
 * để lấy Secret Key lưu lại, giúp các lần đăng nhập sau không cần lấy OTP từ Mail.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import { CAMOUFOX_API, GATEWAY_URL, WORKER_AUTH_TOKEN, TOOLS_API_URL, PROTOCOL_FIRST } from './config.js';
import { camofoxPost, camofoxGet, camofoxDelete, evalJson, navigate, waitForSelector, pressKey, checkProfileExists, getGlobalUsePersistent, actClick, actPress, actType } from './lib/camofox.js';
import { getTOTP, getFreshTOTP } from './lib/totp.js';
import { extractIpFromText, normalizeProxyUrl, getLocalPublicIp, probeProxyExitIp, assertProxyApplied, isLocalRelayProxy } from './lib/proxy-diag.js';
import { createStepRecorder } from './lib/screenshot.js';
import { waitForOTPCode } from './lib/ms-graph-email.js';
import { firstNames, lastNames } from './lib/names.js';
import { setupMFA } from './lib/mfa-setup.js';
import { generatePKCE, buildOAuthURL, exchangeCodeForTokens, CODEX_CONSENT_URL, decodeAuthSessionCookie, extractWorkspaceId, performWorkspaceConsentBypass } from './lib/openai-oauth.js';
import { getState, fillEmail, fillPassword, fillMfa, tryAcceptCookies, dismissGooglePopup, clickContinueWithPassword, tryDismissPasskeyEnrollment } from './lib/openai-login-flow.js';
import { checkIpLocation } from './lib/proxy-diag.js';
import { runProtocolRegistration, requestViaCurlCffi } from './lib/openai-protocol-register.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(__dirname, '..');
const IMAGES_DIR = path.join(ROOT_DIR, 'data', 'screenshots');

const OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const OAUTH_URL = 'https://auth.openai.com';
const OPENAI_AUTH = 'https://auth.openai.com';

// ============================================
// CONFIGURATION
// ============================================
const CONFIG = {
  // User info generation
  ageRange: { min: 18, max: 40 },
  passwordLength: 16,
  
  // Timeouts (seconds)
  emailInputTimeout: 15,
  emailInputTimeoutWithProxy: 25,
  otpWaitTimeout: 90,
  otpRetryTimeout: 30,
  
  // Retry counts
  otpMaxRetries: 2,
  mfaMaxRetries: 2,
  phoneBypassMaxRetries: 2,
  reloadMaxRetries: 2,
  welcomeModalMaxRetries: 3,
  
  // Proxy settings
  proxyStrictMode: process.env.PROXY_STRICT_MODE === 'true',
};

// ============================================
// OAUTH HELPERS
// ============================================

/**
 * Try to extract an OAuth code from a URL string.
 * @returns {string} code or empty string
 */
function tryExtractCode(url) {
  if (!url || typeof url !== 'string' || !url.includes('code=')) return '';
  try {
    const u = new URL(url);
    return u.searchParams.get('code') || '';
  } catch (_) {
    // Some redirects may be relative or malformed → regex fallback
    const m = url.match(/[?&]code=([^&#]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  }
}

/**
 * Setup PerformanceObserver to capture localhost:1455 callback URL with ?code=
 * (Browser shows about:neterror because no server runs there, but URL is observed)
 */
async function setupCallbackInterceptor(tabId, userId) {
  return evalJson(tabId, userId, `
    (() => {
      try {
        if (window.__oauthInterceptorInstalled) return 'already-installed';
        window.__oauthCallbackUrl = null;
        window.__oauthInterceptorInstalled = true;
        const obs = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (entry.name && entry.name.includes('code=')) {
              window.__oauthCallbackUrl = entry.name;
            }
          }
        });
        obs.observe({ entryTypes: ['navigation', 'resource'] });
        return 'installed';
      } catch (e) { return 'error:' + e.message; }
    })()
  `, 3000);
}

/**
 * Try to click consent/authorize button OR call workspace-select API
 * (handles consent screen, workspace selection, organization selection)
 */
async function tryConsentOrWorkspaceFlow(tabId, userId) {
  // Reuse the shared bypass function which calls workspace/select + organization/select
  const bypassResult = await performWorkspaceConsentBypass(evalJson, tabId, userId);
  return bypassResult; // { code, error, ... }
}

async function performCodexOAuth(tabId, userId, proxyUrl, recorder, creds = {}, userAgent = null) {
  console.log(`[OAuth] Starting Codex OAuth PKCE flow...`);
  const pkce = generatePKCE();
  const authUrl = buildOAuthURL(pkce);
  console.log(`[OAuth] Navigating to: ${authUrl.slice(0, 80)}...`);

  // ── Setup callback interceptor BEFORE navigate (catches localhost:1455 redirect) ──
  await setupCallbackInterceptor(tabId, userId);

  await navigate(tabId, userId, authUrl, 20000);
  await new Promise(r => setTimeout(r, 3000));

  // Re-install interceptor after navigation (page reloads clear it)
  await setupCallbackInterceptor(tabId, userId);
  // OAuth Phase 1, Step 1: OAuth start
  await recorder.checkpoint(1, 1, 'oauth_start');

  // ── State tracking ──
  let emailFilled = false;
  let passwordFilled = false;
  let mfaFilled = false;
  let consentAttempted = false;
  let consentAttempts = 0;
  const MAX_CONSENT_ATTEMPTS = 3;
  let consecutiveEvalFailures = 0;
  const MAX_EVAL_FAILURES = 8;

  let authCode = '';
  for (let i = 0; i < 40; i++) {
    const currentUrl = await evalJson(tabId, userId, 'location.href', 4000);

    // ── Track eval failures (tab might be closed/crashed) ──
    if (currentUrl === null || currentUrl === undefined) {
      consecutiveEvalFailures++;
      console.log(`[OAuth] Poll #${i + 1}: <eval-failed ${consecutiveEvalFailures}/${MAX_EVAL_FAILURES}>`);
      if (consecutiveEvalFailures >= MAX_EVAL_FAILURES) {
        return { success: false, error: 'Tab eval failed repeatedly (tab may be closed)' };
      }
      await new Promise(r => setTimeout(r, 1500));
      continue;
    }
    consecutiveEvalFailures = 0;
    console.log(`[OAuth] Poll #${i + 1}: ${(currentUrl || '').slice(0, 80)}`);

    // ── 1. Code in current URL? ──
    authCode = tryExtractCode(currentUrl);
    if (authCode) {
      console.log(`[OAuth] ✅ Code received from URL: ${authCode.slice(0, 20)}...`);
      break;
    }

    // ── 2. about:neterror / about:blank → check intercepted callback URL ──
    const isErrorPage = currentUrl.startsWith('about:') || currentUrl === '' || currentUrl.includes('localhost:1455');
    if (isErrorPage) {
      const intercepted = await evalJson(tabId, userId, 'window.__oauthCallbackUrl || null', 2000);
      authCode = tryExtractCode(intercepted);
      if (authCode) {
        console.log(`[OAuth] ✅ Code recovered from interceptor: ${authCode.slice(0, 20)}...`);
        break;
      }
      // If still on neterror with no intercepted URL → wait and retry
      console.log(`[OAuth] Error page detected, waiting for interceptor data...`);
      await new Promise(r => setTimeout(r, 1500));
      continue;
    }

    // ── 3. Check page state ──
    const state = await getState(tabId, userId);

    // ── 4. Phone verification screen → workspace bypass ──
    if (state?.hasPhoneScreen) {
      console.log(`[OAuth] Phone screen detected, trying workspace bypass...`);
      // OAuth Phase 1, Step 2: Phone bypass attempt
      await recorder.before(1, 2, 'phone_bypass');
      const bypassResult = await tryConsentOrWorkspaceFlow(tabId, userId);
      if (bypassResult?.code) {
        authCode = bypassResult.code;
        console.log(`[OAuth] ✅ Phone bypassed via workspace API, code: ${authCode.slice(0, 20)}...`);
        break;
      }
      console.log(`[OAuth] Phone bypass failed: ${bypassResult?.error}`);
      return { success: false, error: 'NEED_PHONE', bypassResult };
    }

    // ── 5. Login form on auth.openai.com → fill credentials ──
    if (state?.hasEmailInput && !emailFilled && creds.email) {
      console.log(`[OAuth] 📧 Email input detected, filling: ${creds.email}`);
      const r = await fillEmail(tabId, userId, creds.email);
      console.log(`[OAuth] fillEmail →`, JSON.stringify(r));
      emailFilled = true;
      await new Promise(r2 => setTimeout(r2, 4000));
      // OAuth Phase 1, Step 3: Email filled
      await recorder.after(1, 3, 'email_filled');
      continue;
    }

    if (state?.hasPasswordInput && !passwordFilled && creds.password) {
      console.log(`[OAuth] 🔑 Password input detected, filling`);
      const r = await fillPassword(tabId, userId, creds.password);
      console.log(`[OAuth] fillPassword →`, JSON.stringify(r));
      passwordFilled = true;
      await new Promise(r2 => setTimeout(r2, 4000));
      // OAuth Phase 1, Step 4: Password filled
      await recorder.after(1, 4, 'password_filled');
      continue;
    }

    if (state?.hasMfaInput && !mfaFilled && creds.mfaSecret) {
      try {
        // Use getFreshTOTP to ensure code is valid for at least 8s
        // (avoids replay if same code was just used during MFA setup on chatgpt.com)
        const { otp } = await getFreshTOTP(creds.mfaSecret, 8);
        console.log(`[OAuth] 🔐 MFA input detected, filling fresh TOTP: ${otp}`);
        const r = await fillMfa(tabId, userId, otp);
        console.log(`[OAuth] fillMfa →`, JSON.stringify(r));
        mfaFilled = true;
        await new Promise(r2 => setTimeout(r2, 5000));
        // OAuth Phase 1, Step 5: MFA filled
        await recorder.after(1, 5, 'mfa_filled');
        continue;
      } catch (e) {
        console.log(`[OAuth] MFA fill error: ${e.message}`);
      }
    }

    // ── 6. Consent / workspace / organization screen ──
    // If on auth domain, no login form, no phone screen → likely consent or workspace
    const onAuthDomain = currentUrl.includes('auth.openai.com');
    const noFormVisible = !state?.hasEmailInput && !state?.hasPasswordInput && !state?.hasMfaInput;
    const isConsentLike = state?.isConsentScreen || state?.isWorkspaceScreen || state?.isOrganizationScreen ||
                          currentUrl.includes('/consent') || currentUrl.includes('/workspace') || currentUrl.includes('/organization');

    if (onAuthDomain && noFormVisible && (isConsentLike || (i >= 4 && !consentAttempted))) {
      if (consentAttempts >= MAX_CONSENT_ATTEMPTS) {
        console.log(`[OAuth] Consent bypass reached max attempts (${MAX_CONSENT_ATTEMPTS}), skipping...`);
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }
      console.log(`[OAuth] 🔓 Consent/workspace screen detected, attempting bypass (${consentAttempts + 1}/${MAX_CONSENT_ATTEMPTS})...`);
      consentAttempted = true;
      consentAttempts++;
      // OAuth Phase 1, Step 6: Consent bypass attempt
      await recorder.before(1, 6, `consent_attempt_${consentAttempts}`);
      const bypassResult = await tryConsentOrWorkspaceFlow(tabId, userId);
      if (bypassResult?.code) {
        authCode = bypassResult.code;
        console.log(`[OAuth] ✅ Consent bypassed, code: ${authCode.slice(0, 20)}...`);
        break;
      }
      console.log(`[OAuth] Consent bypass failed: ${bypassResult?.error || 'unknown'}, continuing to poll...`);
      // Don't fail hard — keep polling, browser may also redirect on its own
    }

    await new Promise(r => setTimeout(r, 1500));
  }

  if (!authCode) {
    return { success: false, error: 'No authorization code received (timeout)' };
  }

  // ── Exchange code for tokens ──
  console.log(`[OAuth] Exchanging code for tokens...`);
  try {
    const tokens = await exchangeCodeForTokens(authCode, pkce, proxyUrl, userAgent);
    if (!tokens?.refresh_token && !tokens?.access_token) {
      return { success: false, error: 'Token exchange returned empty tokens', tokens };
    }
    console.log(`[OAuth] ✅ Token exchange successful (refresh=${!!tokens.refresh_token}, access=${!!tokens.access_token})`);
    return { success: true, tokens };
  } catch (err) {
    console.log(`[OAuth] Token exchange failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}

// ============================================
// HELPERS
// ============================================
let WORKER_SESSION_KEY = WORKER_AUTH_TOKEN;

// Wrapper for camofoxPost that injects sessionKey (auto-register specific)
async function camofoxPostWithSessionKey(endpoint, body, timeoutMs = 90000) {
  const payload = { ...body, sessionKey: WORKER_SESSION_KEY };
  return camofoxPost(endpoint, payload, { timeoutMs });
}

/**
 * Retry với reload tab nếu UI không được nhận diện
 * @param {string} tabId - Tab ID
 * @param {string} userId - User ID
 * @param {Function} checkFn - Function trả về true nếu UI OK
 * @param {string} stepName - Tên step để logging
 * @param {number} maxRetries - Số lần retry tối đa
 * @returns {Promise<boolean>} - true nếu thành công, false nếu fail hết retry
 */
async function retryWithReload(tabId, userId, checkFn, stepName, maxRetries = 2, reloadUrl = null) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const result = await checkFn();
    if (result) return true;

    console.log(`[${stepName}] ⚠️ UI không được nhận diện (lần ${attempt + 1}/${maxRetries + 1})`);

    if (attempt < maxRetries) {
      try {
        if (reloadUrl) {
          // Chỉ điều hướng nếu được chỉ định rõ ràng URL đích
          console.log(`[${stepName}] 🔄 Reload tab đến ${reloadUrl} và thử lại...`);
          await camofoxPostWithSessionKey(`/tabs/${tabId}/navigate`, { userId, url: reloadUrl });
        } else {
          // Reload trang hiện tại (không navigate về login page) để tránh mất trạng thái session
          console.log(`[${stepName}] 🔄 Reload trang hiện tại và thử lại...`);
          await evalJson(tabId, userId, `(() => { location.reload(); return true; })()`).catch(() => {});
        }
        await new Promise(r => setTimeout(r, 5000));
      } catch (e) {
        console.log(`[${stepName}] ❌ Reload failed: ${e.message}`);
      }
    }
  }

  console.log(`[${stepName}] ❌ Hết retry (${maxRetries + 1} lần), UI vẫn không được nhận diện`);
  return false;
}

function generateRandomUserInfo() {
  // Độ tuổi ngẫu nhiên từ CONFIG.ageRange
  const age = Math.floor(Math.random() * (CONFIG.ageRange.max - CONFIG.ageRange.min + 1)) + CONFIG.ageRange.min;
  const currentYear = new Date().getFullYear();
  const year = currentYear - age;

  // Ngày, tháng ngẫu nhiên cho form cũ (Nếu bị bắt nhập DOB)
  const month = String(Math.floor(Math.random() * 12) + 1).padStart(2, '0');
  const day = String(Math.floor(Math.random() * 28) + 1).padStart(2, '0');

  const fName = firstNames[Math.floor(Math.random() * firstNames.length)];
  const lName = lastNames[Math.floor(Math.random() * lastNames.length)];

  return {
    name: `${fName} ${lName}`,
    birthdate: `${year}-${month}-${day}`, // Dùng cho input [DD/MM/YYYY] cổ điển
    age: age // Dùng cho input [Age] đời mới
  };
}


async function updatePoolStatus(email, data) {
  try {
    await fetch(`${TOOLS_API_URL}/api/vault/email-pool`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, ...data }),
    });
  } catch (err) {
    console.log(`[Pool] Update failed for ${email}: ${err.message}`);
  }
}

async function getCookies(tabId, userId) {
  const res = await fetch(`${CAMOUFOX_API}/tabs/${tabId}/cookies?userId=${userId}`);
  if (!res.ok) return [];
  const data = await res.json();
  const cookies = Array.isArray(data.cookies) ? data.cookies : (Array.isArray(data) ? data : []);

  // Handle chunked session token: combine .0 and .1 or use .0 alone
  const sessionToken0 = cookies.find(c => c.name === '__Secure-next-auth.session-token.0');
  const sessionToken1 = cookies.find(c => c.name === '__Secure-next-auth.session-token.1');
  const sessionTokenLegacy = cookies.find(c => c.name === '__Secure-next-auth.session-token');

  if (sessionToken0) {
    // Remove .0 and .1, add combined or .0 as legacy session token
    const filtered = cookies.filter(c => !c.name.startsWith('__Secure-next-auth.session-token'));
    const combinedValue = sessionToken1 ? (sessionToken0.value + sessionToken1.value) : sessionToken0.value;
    filtered.push({ name: '__Secure-next-auth.session-token', value: combinedValue, domain: sessionToken0.domain });
    return filtered;
  }

  return cookies;
}

async function importSessionCookies(userId, cookies) {
  const normalizedCookies = (Array.isArray(cookies) ? cookies : [])
    .filter(cookie => cookie?.name && typeof cookie.value === 'string' && cookie?.domain)
    .map(cookie => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path || '/',
      expires: cookie.expires,
      httpOnly: cookie.httpOnly === true,
      secure: cookie.secure !== false,
      sameSite: cookie.sameSite || 'Lax',
    }));

  if (!normalizedCookies.length) {
    throw new Error('No protocol cookies available to import');
  }

  const res = await fetch(`${CAMOUFOX_API}/sessions/${userId}/cookies`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cookies: normalizedCookies }),
  });
  if (!res.ok) {
    throw new Error(`Cookie import failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

// ─────────────────────────────────────────────────────────────────────────
// SAFETY GUARDS — domain check + URL-change watchdog
// ─────────────────────────────────────────────────────────────────────────

/** Whitelist các domain hợp lệ cho luồng register ChatGPT */
const ALLOWED_HOSTS = [
  'chatgpt.com', 'openai.com', 'auth.openai.com',
  'platform.openai.com', 'help.openai.com',
];

/** Hosts báo động drift sang OAuth provider (chỉ khi worker dùng email flow) */
const DRIFT_HOSTS = [
  'accounts.google.com', 'appleid.apple.com', 'login.live.com',
  'login.microsoftonline.com',
];

/**
 * Đảm bảo tab vẫn ở đúng domain ChatGPT/OpenAI.
 * Throw nếu drift sang Google/Apple/MS (sai luồng) hoặc domain hoàn toàn lạ.
 */
async function assertOnExpectedDomain(tabId, userId, label = '') {
  const url = await evalJson(tabId, userId, `location.href`).catch(() => '');
  if (!url) return null;
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch { return url; }
  if (DRIFT_HOSTS.some(h => host === h || host.endsWith('.' + h))) {
    throw new Error(`[DriftGuard] ${label}: Tab đã drift sang ${host} (mong đợi chatgpt.com). URL=${url}`);
  }
  if (!ALLOWED_HOSTS.some(h => host === h || host.endsWith('.' + h))) {
    console.log(`[DriftGuard] ${label}: ⚠️ Domain lạ (${host}) — vẫn tiếp tục nhưng cảnh báo`);
  }
  return url;
}

/**
 * Kiểm tra xem trang có bị lỗi Session Ended, invalid_state, hoặc Oops error hay không.
 * Nếu có, thực hiện phục hồi bằng cách quay lại login page, điền email, và điền password nếu được cung cấp.
 */
async function checkAndRecoverSessionEnded(tabId, userId, email, password = null) {
  const bodyText = await evalJson(tabId, userId, `document.body?.innerText || ''`).catch(() => '');
  const isSessionEnded = bodyText.toLowerCase().includes('session ended') || 
                         bodyText.toLowerCase().includes('invalid_state') || 
                         bodyText.toLowerCase().includes('start over to continue') ||
                         (bodyText.toLowerCase().includes('oops, an error occurred') && bodyText.toLowerCase().includes('try again'));
                         
  if (isSessionEnded) {
    console.log(`[Recover] ⚠️ Phát hiện màn hình lỗi (Session ended / Oops error). Tự động điều hướng quay lại login page...`);
    await camofoxPostWithSessionKey(`/tabs/${tabId}/navigate`, { userId, url: 'https://chatgpt.com/auth/login' });
    
    // Chờ email input xuất hiện
    const emailInputAppeared = await pollUntil(async () => {
      const hasInput = await evalJson(tabId, userId,
        `!!document.querySelector('input[type="email"], input[name="email"], input[name="username"]')`
      );
      return hasInput;
    }, `SessionEndedRecoveryEmail`, { intervalMs: 2000, maxWaitMs: 15000 });

    if (emailInputAppeared) {
      console.log(`[Recover] ✅ Đã quay lại login page, tiến hành điền lại email...`);
      await fillEmail(tabId, userId, email);
      
      if (password) {
        // Chờ password input xuất hiện
        console.log(`[Recover] ⏳ Đang chờ màn hình password xuất hiện...`);
        const pwdInputAppeared = await pollUntil(async () => {
          const hasInput = await evalJson(tabId, userId,
            `!!document.querySelector('input[type="password"], input[name="password"], input[name="new-password"]')`
          );
          return hasInput;
        }, `SessionEndedRecoveryPassword`, { intervalMs: 2000, maxWaitMs: 15000 });

        if (pwdInputAppeared) {
          console.log(`[Recover] ✅ Đã thấy ô password, tiến hành điền password...`);
          await fillPassword(tabId, userId, password);
          await new Promise(r => setTimeout(r, 3000));
        } else {
          console.log(`[Recover] ⚠️ Không xuất hiện ô password sau khi điền lại email.`);
        }
      } else {
        await new Promise(r => setTimeout(r, 3000));
      }
    } else {
      console.log(`[Recover] ❌ Không thể quay lại login page sau lỗi.`);
    }
    return true;
  }
  return false;
}

/**
 * Utility to assert tab is on one of the allowed URL patterns, fails fast if not.
 */
async function assertPageContext(tabId, userId, stepName, allowedPatterns) {
  const url = await evalJson(tabId, userId, `location.href`).catch(() => '');
  const matches = allowedPatterns.some(p => url?.includes(p));
  if (!matches) {
    throw new Error(`[${stepName}] Tab ở sai trang: ${url}. Cho phép: ${allowedPatterns.join(', ')}`);
  }
  return url;
}

/**
 * Utility to poll a condition function until it returns true or times out.
 */
async function pollUntil(checkFn, stepName, { intervalMs = 2000, maxWaitMs = 20000 } = {}) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const result = await checkFn();
    if (result) return true;
    console.log(`[${stepName}] Chờ... (còn ${Math.round((deadline - Date.now()) / 1000)}s)`);
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return false;
}


/**
 * Đợi URL thay đổi trong vòng N giây sau click — phát hiện click không có hiệu ứng.
 * Trả về URL mới hoặc null nếu URL không đổi (signal of click missed).
 */
async function waitForUrlChange(tabId, userId, oldUrl, { timeoutMs = 8000, intervalMs = 500 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const cur = await evalJson(tabId, userId, `location.href`).catch(() => oldUrl);
    if (cur && cur !== oldUrl) return cur;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return null;
}

function normalizeUiText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

async function collectSignupUiState(tabId, userId) {
  return evalJson(tabId, userId, `(() => {
    const isVisible = el => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const normalize = value => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const controls = Array.from(document.querySelectorAll('button, a, div[role="button"], [role="menuitem"]'))
      .filter(isVisible)
      .map(el => ({
        tag: el.tagName.toLowerCase(),
        text: normalize(el.innerText || el.textContent || ''),
        rawText: (el.innerText || el.textContent || '').trim().slice(0, 120),
        id: el.id || null,
        role: el.getAttribute('role') || null,
        type: el.getAttribute('type') || null,
        dataTestId: el.getAttribute('data-testid') || null,
        href: el.getAttribute('href') || null,
      }));
    const hasEmailInput = !!document.querySelector('input[type="email"], input[name="email"], input[name="identifier"], input[autocomplete="email"]');
    const hasPasswordInput = !!document.querySelector('input[type="password"], input[name="password"]');
    const bodyText = normalize(document.body?.innerText || document.body?.textContent || '');
    return {
      url: location.href,
      title: document.title || '',
      bodyText: bodyText.slice(0, 1000),
      hasEmailInput,
      hasPasswordInput,
      controls,
    };
  })()`, 6000);
}

function classifySignupUiState(state) {
  const controls = Array.isArray(state?.controls) ? state.controls : [];
  const texts = controls.map(c => normalizeUiText(c.text));
  const rawTexts = controls.map(c => normalizeUiText(c.rawText));
  const dataTestIds = controls.map(c => normalizeUiText(c.dataTestId));
  const has = (...needles) => needles.some(needle =>
    texts.some(t => t === needle || t.includes(needle)) ||
    rawTexts.some(t => t === needle || t.includes(needle)) ||
    dataTestIds.some(t => t === needle || t.includes(needle)) ||
    normalizeUiText(state?.url || '').includes(needle)
  );

  const actions = {
    signup: has('sign up for free', 'sign up') || dataTestIds.some(t => t.includes('signup-button')),
    moreOptions: has('more options'),
    emailOption: has('continue with email', 'use email', 'email address'),
    socialOnly: has('continue with google', 'continue with apple', 'continue with microsoft', 'continue with phone'),
    login: has('log in'),
  };

  let variant = 'unknown';
  if (state?.hasEmailInput) variant = 'email_ready';
  else if (actions.signup) variant = 'signup_button';
  else if (actions.moreOptions && actions.socialOnly) variant = 'more_options_social';
  else if (actions.moreOptions) variant = 'more_options';
  else if (actions.emailOption) variant = 'email_option';
  else if (actions.socialOnly) variant = 'social_only';
  else if (actions.login) variant = 'login_only';

  return {
    variant,
    actions,
    summary: {
      url: state?.url || '',
      title: state?.title || '',
      hasEmailInput: !!state?.hasEmailInput,
      hasPasswordInput: !!state?.hasPasswordInput,
      controls: controls.slice(0, 10).map(c => ({ text: c.rawText, dataTestId: c.dataTestId, role: c.role, tag: c.tag })),
    },
  };
}

async function clickSignupUiAction(tabId, userId, labels, actionName) {
  return evalJson(tabId, userId, `(() => {
    const normalize = value => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const isVisible = el => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const wanted = ${JSON.stringify(labels.map(normalizeUiText))};
    const candidates = Array.from(document.querySelectorAll('button, a, div[role="button"], [role="menuitem"]')).filter(isVisible);
    const match = candidates.find(el => {
      const text = normalize(el.innerText || el.textContent || '');
      const aria = normalize(el.getAttribute('aria-label') || '');
      const dataTestId = normalize(el.getAttribute('data-testid') || '');
      const role = normalize(el.getAttribute('role') || '');
      const href = normalize(el.getAttribute('href') || '');
      return wanted.some(label => {
        if (!label) return false;
        return text === label || text.includes(label) || aria === label || aria.includes(label) || dataTestId === label || dataTestId.includes(label) || role === label || href.includes(label.replace(/\s+/g, '-'));
      });
    });
    if (!match) {
      return {
        clicked: false,
        reason: 'no-match',
        action: ${JSON.stringify(actionName)},
        wanted,
        available: candidates.slice(0, 12).map(el => ({
          tag: el.tagName.toLowerCase(),
          text: normalize(el.innerText || el.textContent || ''),
          dataTestId: normalize(el.getAttribute('data-testid') || ''),
          role: normalize(el.getAttribute('role') || ''),
        })),
      };
    }
    match.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
    match.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
    match.click();
    return {
      clicked: true,
      action: ${JSON.stringify(actionName)},
      text: (match.innerText || match.textContent || '').trim(),
      tag: match.tagName.toLowerCase(),
      dataTestId: match.getAttribute('data-testid') || null,
    };
  })()`, 5000);
}

async function waitForSignupProgress(tabId, userId, baselineState, { timeoutMs = 12000, intervalMs = 600 } = {}) {
  const baselineSignature = JSON.stringify({
    url: baselineState?.url || '',
    title: baselineState?.title || '',
    bodyText: baselineState?.bodyText || '',
    controls: (baselineState?.controls || []).map(c => `${c.tag}|${c.text}|${c.dataTestId}|${c.role}`).slice(0, 12),
  });
  const start = Date.now();
  let lastState = baselineState || null;
  let navigationSeenAt = null;

  while (Date.now() - start < timeoutMs) {
    const state = await collectSignupUiState(tabId, userId);
    if (state) {
      lastState = state;
      if (state.hasEmailInput) {
        return { status: 'email_input', state };
      }

      const signature = JSON.stringify({
        url: state.url || '',
        title: state.title || '',
        bodyText: state.bodyText || '',
        controls: (state.controls || []).map(c => `${c.tag}|${c.text}|${c.dataTestId}|${c.role}`).slice(0, 12),
      });
      const uiChanged = signature !== baselineSignature;
      const classification = classifySignupUiState(state);
      const isAuthPage = normalizeUiText(state.url || '').includes('auth.openai.com');

      if (isAuthPage) {
        if (!navigationSeenAt) navigationSeenAt = Date.now();
        if (Date.now() - navigationSeenAt >= 2500) {
          return { status: 'navigated', state, variant: classification.variant };
        }
      }

      if (uiChanged && (classification.actions.moreOptions || classification.actions.emailOption || classification.actions.signup)) {
        return { status: 'ui_changed', state, variant: classification.variant };
      }
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }

  return { status: 'timeout', state: lastState };
}


// ============================================
// MAIN REGISTER FLOW
// ============================================

export async function runAutoRegister(taskInput) {
  const parts = taskInput.split('|');
  let email, emailPassword, authMethod, refreshToken, clientId, proxyUrl, oauthFlag;

  if (parts.length >= 5) {
    [email, emailPassword, authMethod, refreshToken, clientId, proxyUrl, oauthFlag] = parts;
  } else {
    // Fallback format cũ: email|password|refresh_token|client_id
    [email, emailPassword, refreshToken, clientId] = parts;
    authMethod = 'graph';
  }
  proxyUrl = normalizeProxyUrl(proxyUrl);

  // Parse stagger delay
  const staggerPart = parts.find(p => p.startsWith('stagger='));
  const staggerMs = staggerPart ? (parseInt(staggerPart.split('=')[1], 10) || 0) : 0;
  if (staggerMs > 0) {
    console.log(`⏳ [Stagger] Trì hoãn khởi chạy ${staggerMs}ms để tránh nghẽn luồng...`);
    await new Promise(r => setTimeout(r, staggerMs));
  }

  // Parse oauth flag (format: oauth=1 or oauth=true)
  const enableOAuth = oauthFlag && (oauthFlag.includes('oauth=1') || oauthFlag.includes('oauth=true'));
  console.log(`[Register] OAuth flow: ${enableOAuth ? 'ENABLED' : 'DISABLED'}`);

  if (!email || !refreshToken || !clientId) {
    throw new Error("Input string is invalid (expected email|pass|method|refresh_token|client_id[|proxyUrl])");
  }

  // Update pool status to processing
  await updatePoolStatus(email, { chatgpt_status: 'processing' });

  // Tạo mật khẩu ngẫu nhiên đủ mạnh (CONFIG.passwordLength ký tự: chữ thường, chữ hoa, số, ký tự đặc biệt)
  const CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
  let chatGptPassword = Array.from({ length: CONFIG.passwordLength }, () => CHARS[Math.floor(Math.random() * CHARS.length)]).join('');

  console.log(`==========================================`);
  console.log(`🚀 [Auto-Register] Bắt đầu đăng ký: ${email}`);
  console.log(`==========================================`);

  const USER_ID = `register_${email}`;
  WORKER_SESSION_KEY = `${WORKER_AUTH_TOKEN}_${email}`;
  console.log(`SESSION_ID: ${USER_ID}`); // Quan trọng để frontend link ảnh chụp
  const runDir = path.join(IMAGES_DIR, USER_ID);
  await fs.mkdir(runDir, { recursive: true }).catch(() => { });

  let tabId = null;
  let userAgent = null;
  let recorder = null;
  let preFlightResult = null;
  let phoneBypassAttempted = false;
  let phoneBypassSuccess = false;
  let oauthError = null;

  try {
    // 🔒 [PreFlight] Assert proxy applied BEFORE creating main tab
    if (proxyUrl) {
      console.log(`🔒 [PreFlight] Asserting proxy applied: ${proxyUrl}`);
      try {
        let lastErr = null;
        for (let preflightAttempt = 0; preflightAttempt < 3; preflightAttempt++) {
          try {
            preFlightResult = await assertProxyApplied(proxyUrl);
            lastErr = null;
            break;
          } catch (err) {
            lastErr = err;
            const msg = String(err?.message || err || '');
            const isTransient = msg.includes('fetch failed') || msg.includes('Không lấy được exit IP') || msg.includes('ECONNREFUSED') || msg.includes('connect ECONNREFUSED');
            if (!isTransient || preflightAttempt === 2) break;
            console.log(`⚠️ [PreFlight] Retry ${preflightAttempt + 1}/2 sau lỗi tạm thời: ${msg}`);
            await new Promise(r => setTimeout(r, 2000 + preflightAttempt * 1500));
          }
        }
        if (!preFlightResult && lastErr) throw lastErr;
        console.log(`✅ [PreFlight] OK — Exit IP: ${preFlightResult.exitIp} (${preFlightResult.networkType})${preFlightResult.isLocalRelay ? ' 🔒 LOCAL RELAY' : ''}`);
      } catch (err) {
        const errMsg = `[PreFlight Failed] Proxy validation failed: ${err.message}`;
        console.log(`🛑 ${errMsg}`);
        await updatePoolStatus(email, {
          chatgpt_status: 'failed',
          notes: errMsg
        });
        process.exit(1);
      }
    }

    // IP location guard (retry up to 2 times to handle transient proxy timeouts)
    console.log(`🌍 [IP Check] Checking IP location...`);
    let ipCheck = await checkIpLocation(proxyUrl);
    if (!ipCheck.ok) {
      console.log(`⚠️ [IP Check] Lần 1 thất bại: ${ipCheck.error} — Thử lại sau 3s...`);
      await new Promise(r => setTimeout(r, 3000));
      ipCheck = await checkIpLocation(proxyUrl);
    }
    if (!ipCheck.ok) {
      console.log(`🛑 [IP Check] FAILED sau 2 lần thử: ${ipCheck.error}`);
      throw new Error(`IP Check failed: ${ipCheck.error}`);
    }
    console.log(`✅ [IP Check] Location: ${ipCheck.loc}`);

    // Protocol-mode registration attempt (primary when PROTOCOL_FIRST is not false)
    let protocolResult = null;
    let isExistingAccount = false;
    let skipRegistrationSteps = false;
    if (PROTOCOL_FIRST) {
      console.log(`[Protocol] Attempting protocol-mode registration...`);
      try {
        const emailServiceAdapter = {
          getVerificationCode: async ({ email: em, timeout }) => {
            return waitForOTPCode({ email: em, refreshToken, clientId, senderDomain: 'openai.com', maxWaitSecs: timeout || 120 });
          }
        };
        protocolResult = await runProtocolRegistration({
          email,
          password: chatGptPassword,
          proxyUrl,
          emailService: emailServiceAdapter,
          logFn: (...args) => console.log(...args),
        });
      } catch (protocolErr) {
        console.log(`[Protocol] Error: ${protocolErr.message}`);
      }

      if (protocolResult?.success) {
        console.log(`✅ [Protocol] Registration successful via protocol mode!`);
        skipRegistrationSteps = true;
        if (protocolResult.password) {
          chatGptPassword = protocolResult.password;
          console.log(`[Protocol] Updated chatGptPassword to the registered password: ${chatGptPassword}`);
        }
      } else if (protocolResult?.isExistingAccount) {
        console.log(`[Protocol] Email already registered — will switch to login flow`);
        isExistingAccount = true;
        skipRegistrationSteps = false;
      } else {
        console.log(`[Protocol] Failed: ${protocolResult?.error || 'unknown'} — falling back to browser`);
        // Reset flags để browser flow detect lại từ đầu
        isExistingAccount = false;
        // Delay để OpenAI "quên" session từ protocol trước khi browser mở tab
        console.log(`[Protocol] Waiting 10s before browser fallback to avoid session contamination...`);
        await new Promise(r => setTimeout(r, 10000));
      }
    }

    const maxAttempts = 2;
    let runSuccess = false;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        phoneBypassAttempted = false;
        phoneBypassSuccess = false;
        oauthError = null;
        isExistingAccount = protocolResult?.isExistingAccount || false;

        // 1. Khởi động - Đi từ trang login để tránh bị blank page
        console.log(`🚀 [Phase 1] Truy cập trang Login...`);
        const usePersistent = (await getGlobalUsePersistent()) !== false || (await checkProfileExists(USER_ID));
        console.log(`[Register] Dynamic Hybrid Persistence: ${usePersistent ? 'ENABLED' : 'DISABLED'}`);

    // 🧹 Xóa session/cookies cũ trước khi tạo tab đăng ký mới để tránh persistent session redirect
    // Khi persistent=true, session cũ của email này có thể còn active → OpenAI redirect về /?slm=1
    if (usePersistent) {
      console.log(`🧹 [PreClean] Xóa session cũ của ${USER_ID} để tránh stale cookie redirect...`);
      await camofoxDelete(`/sessions/${USER_ID}`, { timeoutMs: 8000 }).catch(e => {
        console.log(`[PreClean] Session delete failed (có thể session chưa tồn tại): ${e.message}`);
      });
    }

    const tabRes = await camofoxPostWithSessionKey('/tabs', {
      userId: USER_ID,
      url: "about:blank",
      headless: false,
      humanize: true,
      persistent: usePersistent,
      ...(proxyUrl ? { proxy: proxyUrl } : {})
    });
    console.log(proxyUrl ? `🔌 Dùng proxy: ${proxyUrl}` : '🌐 Không dùng proxy');
    tabId = tabRes.tabId;
    userAgent = tabRes.userAgent || null;
    console.log(`Tab ID: ${tabId}`);

    recorder = createStepRecorder(runDir, { tabId, userId: USER_ID });

    console.log(`🌐 Mở trang chatgpt.com/auth/login...`);
    await camofoxPostWithSessionKey(`/tabs/${tabId}/navigate`, { userId: USER_ID, url: 'https://chatgpt.com/auth/login' });
    await new Promise(r => setTimeout(r, 5000));


    // If protocol succeeded, seed the browser session and skip registration UI steps
    if (skipRegistrationSteps && protocolResult?.success) {
      console.log(`[Protocol] Seeding browser session from protocol result...`);
      try {
        await importSessionCookies(USER_ID, protocolResult.cookies || []);
        await camofoxPostWithSessionKey(`/tabs/${tabId}/navigate`, { userId: USER_ID, url: 'https://chatgpt.com/' });
        await new Promise(r => setTimeout(r, 3000));

        const seededCookies = await getCookies(tabId, USER_ID).catch(() => []);
        const hasSessionCookie = seededCookies.some(cookie => cookie.name?.includes('session-token'));
        if (!hasSessionCookie) {
          throw new Error('Imported cookies did not produce a browser session token');
        }
        console.log(`[Protocol] Session import successful (${seededCookies.length} cookies)`);
      } catch (seedErr) {
        console.log(`[Protocol] Session seed warning: ${seedErr.message}`);
        skipRegistrationSteps = false;
      }
    }

    // 🔍 [PostVerify] Re-probe to confirm session inherited proxy
    if (proxyUrl && preFlightResult) {
      console.log(`🔍 [PostVerify] Verifying proxy applied after tab creation...`);
      let verifyCheck = null;
      let lastVerifyErr = null;
      for (let verifyAttempt = 0; verifyAttempt < 3; verifyAttempt++) {
        try {
          verifyCheck = await probeProxyExitIp(USER_ID, proxyUrl, true);  // reuse session
          if (verifyCheck?.ip) {
            lastVerifyErr = null;
            break;
          }
          lastVerifyErr = new Error(verifyCheck?.error || 'Empty IP');
        } catch (err) {
          lastVerifyErr = err;
        }
        if (verifyAttempt < 2) {
          console.log(`⚠️ [PostVerify] Retry ${verifyAttempt + 1}/2 after failure: ${lastVerifyErr.message}`);
          await new Promise(r => setTimeout(r, 2000 + verifyAttempt * 1500));
        }
      }

      if (!verifyCheck?.ip) {
        const errMsg = `[PostVerify Failed] Không probe được sau khi tạo tab: ${lastVerifyErr?.message}`;
        console.log(`🛑 ${errMsg}`);
        await updatePoolStatus(email, {
          chatgpt_status: 'failed',
          notes: errMsg
        });
        if (tabId) { await camofoxDelete(`/tabs/${tabId}?userId=${USER_ID}`, { timeoutMs: 5000 }).catch(() => { }); }
        process.exit(1);
      }

      // Compare with host local IP to detect fallback leaks
      const isLocalRelay = isLocalRelayProxy(proxyUrl);
      const localIp = isLocalRelay ? null : await getLocalPublicIp();
      if (localIp && String(localIp).toLowerCase() === String(verifyCheck.ip).toLowerCase()) {
        const errMsg = `[PostVerify Failed] Proxy bypassed: Exit IP (${verifyCheck.ip}) trùng với Host Public IP (${localIp})`;
        console.log(`🛑 ${errMsg}`);
        await updatePoolStatus(email, {
          chatgpt_status: 'failed',
          notes: errMsg
        });
        if (tabId) { await camofoxDelete(`/tabs/${tabId}?userId=${USER_ID}`, { timeoutMs: 5000 }).catch(() => { }); }
        process.exit(1);
      }

      if (verifyCheck.ip !== preFlightResult.exitIp) {
        // For backconnect/rotating proxies this MAY be expected; for static proxies it indicates session leak
        console.log(`⚠️ [PostVerify] Exit IP changed: pre=${preFlightResult.exitIp} → post=${verifyCheck.ip} (rotating proxy?)`);
      } else {
        console.log(`✅ [PostVerify] Exit IP consistent: ${verifyCheck.ip}`);
      }
    }

    if (!skipRegistrationSteps) {
      // Assert page context is correct before anything else
      await assertPageContext(tabId, USER_ID, 'after-load-login', ['chatgpt.com', 'openai.com']);

      // Domain guard — đảm bảo đang ở chatgpt.com/auth.openai.com
      await assertOnExpectedDomain(tabId, USER_ID, 'after-load-login');

      // Cloudflare challenge check (Fix #8)
      const isCfChallenge = await evalJson(tabId, USER_ID, `
        (() => {
          const body = document.body?.innerText?.toLowerCase() || '';
          return body.includes('checking your browser') || 
                 body.includes('just a moment') ||
                 !!document.querySelector('#cf-challenge-running, #cf-spinner, .cf-error-code');
        })()
      `).catch(() => false);
      if (isCfChallenge) {
        console.log(`[Cloudflare] ⚠️ Phát hiện Cloudflare challenge/interstitial page. Chờ Camoufox tự động bypass tối đa 25s...`);
        const cfBypassed = await pollUntil(async () => {
          const cfState = await evalJson(tabId, USER_ID, `
            (() => {
              const body = document.body?.innerText?.toLowerCase() || '';
              const hasEmailInput = !!document.querySelector('input[type="email"], input[name="email"], input[name="username"]');
              const hasPasswordInput = !!document.querySelector('input[type="password"], input[name="password"]');
              const hasCf = body.includes('checking your browser') || body.includes('just a moment') || !!document.querySelector('#cf-challenge-running, #cf-spinner');
              return { hasEmailInput, hasPasswordInput, hasCf };
            })()
          `).catch(() => null);
          return cfState && !cfState.hasCf && (cfState.hasEmailInput || cfState.hasPasswordInput);
        }, 'CloudflareBypass', { intervalMs: 2000, maxWaitMs: 25000 }).catch(() => false);
        
        if (cfBypassed) {
          console.log(`[Cloudflare] ✅ Đã vượt qua Cloudflare challenge thành công!`);
        } else {
          console.log(`[Cloudflare] ⚠️ Quá thời gian chờ Cloudflare bypass hoặc bị block cứng.`);
        }
      }

      // Dismiss Google One Tap / cookie consent trước khi thao tác
      console.log(`🧹 [Pre-flight] Đóng cookie banner và Google One Tap popup...`);
      await tryAcceptCookies(tabId, USER_ID).catch(e => console.log(`[Pre-flight] Cookie dismiss error: ${e.message}`));
      await dismissGooglePopup(tabId, USER_ID).catch(e => console.log(`[Pre-flight] Google popup dismiss error: ${e.message}`));

    // Detect the current signup UI variant before choosing an action.
    console.log(isExistingAccount ? `🖱️  Chuyển sang luồng Đăng nhập (Account đã tồn tại)...` : `🖱️  Chuyển sang luồng Đăng ký...`);
    const urlBeforeSignup = await evalJson(tabId, USER_ID, `location.href`);
    console.log(`[Sign-up step] Starting URL: ${urlBeforeSignup}`);
    let signupUiState = await collectSignupUiState(tabId, USER_ID);
    let signupVariant = classifySignupUiState(signupUiState);
    console.log(`[Sign-up step] UI variant → ${JSON.stringify(signupVariant.summary)}`);
    // Phase 1, Step 1: Login page — ghi nhận variant UI hiện tại
    await recorder.checkpoint(1, 1, `login_page_${signupVariant.variant}`);


    const signupStrategies = [];
    if (isExistingAccount) {
      // Nếu là tài khoản đã tồn tại, ta ưu tiên click Đăng nhập (Log in) thay vì Đăng ký (Sign up)
      signupStrategies.push({ name: 'log_in', labels: ['Log in', 'Login', 'Đăng nhập'] });
      // Thêm nút phụ đề phòng nút Log in chính không có mặt
      if (signupVariant.actions.emailOption) {
        signupStrategies.push({ name: 'continue_with_email', labels: ['Continue with email', 'Use email', 'Email address', 'Email'] });
      }
    } else {
      if (signupVariant.actions.signup) {
        signupStrategies.push({ name: 'sign_up_for_free', labels: ['Sign up for free', 'Sign up'] });
      }
      if (signupVariant.actions.moreOptions) {
        signupStrategies.push({ name: 'more_options', labels: ['More options'] });
      }
      if (signupVariant.actions.emailOption) {
        signupStrategies.push({ name: 'continue_with_email', labels: ['Continue with email', 'Use email', 'Email address', 'Email'] });
      }
    }
    if (!signupStrategies.length) {
      signupStrategies.push({ name: 'direct_log_in_or_create_account', directNavigate: 'https://auth.openai.com/log-in-or-create-account' });
    }

    let signupResolved = false;
    if (signupUiState?.hasEmailInput) {
      console.log(`[Sign-up step] Email input already present on load, skipping signup strategies.`);
      signupResolved = true;
    } else {
      for (const strategy of signupStrategies) {
        if (strategy.directNavigate) {
          console.log(`[Sign-up step] Strategy ${strategy.name}: direct navigate → ${strategy.directNavigate}`);
          try {
            await camofoxPostWithSessionKey(`/tabs/${tabId}/navigate`, { userId: USER_ID, url: strategy.directNavigate });
          } catch (e) {
            const msg = e?.message || String(e);
            if (!msg.includes('NS_BINDING_ABORTED')) throw e;
            console.log(`[Sign-up step] direct navigate bị abort — có thể browser đang tự chuyển trang, tiếp tục chờ...`);
          }
        } else {
          const clickResult = await clickSignupUiAction(tabId, USER_ID, strategy.labels, strategy.name);
          console.log(`[Sign-up step] ${strategy.name} →`, JSON.stringify(clickResult || {}));
          if (!clickResult?.clicked) continue;
        }

        const progress = await waitForSignupProgress(tabId, USER_ID, signupUiState, {
          timeoutMs: (proxyUrl ? CONFIG.emailInputTimeoutWithProxy : CONFIG.emailInputTimeout) * 1000,
          intervalMs: 600,
        });
        console.log(`[Sign-up step] progress after ${strategy.name} →`, JSON.stringify(progress || {}));
        signupUiState = progress?.state || await collectSignupUiState(tabId, USER_ID);
        signupVariant = classifySignupUiState(signupUiState);

        if (signupUiState?.hasEmailInput) {
          signupResolved = true;
          break;
        }

        if (progress?.status === 'navigated') {
          await new Promise(r => setTimeout(r, 2000));
          signupUiState = await collectSignupUiState(tabId, USER_ID);
          if (signupUiState?.hasEmailInput) {
            signupResolved = true;
            break;
          }
        }
      }
    }

    if (!signupResolved) {
      for (let i = 0; i < 4 && !signupResolved; i++) {
        await new Promise(r => setTimeout(r, 1000));
        signupUiState = await collectSignupUiState(tabId, USER_ID);
        if (signupUiState?.hasEmailInput) {
          signupResolved = true;
          break;
        }
      }
    }

    if (!signupResolved) {
      const availableControls = (signupUiState?.controls || []).map(c => c.rawText || c.text).filter(Boolean).slice(0, 12);
      throw new Error(`Email input không xuất hiện sau khi thử các chiến lược đăng ký (${signupVariant.variant}). URL=${await evalJson(tabId, USER_ID, 'location.href')}. Controls=${JSON.stringify(availableControls)}`);
    }

    await new Promise(r => setTimeout(r, 3000));

    // Phase 1, Step 2: Register page loaded
    await recorder.checkpoint(1, 2, 'register_page');
    await assertOnExpectedDomain(tabId, USER_ID, 'after-signup-click');

    // 2. Điền Email & Submit — selector ưu tiên submit-button-trong-form,
    //    LOẠI BỎ tuyệt đối các nút "Continue with Google/Apple/Microsoft/phone".
    console.log(`📝 [Phase 2] Đang điền Email: ${email}...`);
    // Phase 2, Step 1: Before email submit
    await recorder.before(2, 1, 'email_submit');
    const urlBeforeEmail = await evalJson(tabId, USER_ID, `location.href`);
    let emailClickInfo = await fillEmail(tabId, USER_ID, email);
    console.log(`[Email-submit] →`, JSON.stringify(emailClickInfo || {}));
    if (!emailClickInfo || !emailClickInfo.ok) {
      throw new Error(`Email submit failed: ${emailClickInfo?.reason || 'Unknown error'} (${JSON.stringify(emailClickInfo)})`);
    }

    // Đợi nhảy sang trang sau khi submit email — detect flow
    console.log("⏳ Chờ OpenAI xử lý Email và chuyển trang...");
    let newUrl = await waitForUrlChange(tabId, USER_ID, urlBeforeEmail, { timeoutMs: 12000 });
    let emailSuccess = false;

    // Vòng lặp retry thông minh (lên tới 2 lần) nếu URL không đổi và không có màn hình password/OTP
    for (let attempt = 1; attempt <= 2 && !emailSuccess; attempt++) {
      if (newUrl) {
        if (newUrl.includes('auth/login?email=') || newUrl.includes('auth/login/?email=')) {
          console.log(`[Email-submit] ❌ Bị redirect ngược lại về login landing page (Proxy/Reputation block). URL: ${newUrl}`);
        } else {
          emailSuccess = true;
          break;
        }
      }

      // Check for inline "already exists" error
      const bodyCheck = await evalJson(tabId, USER_ID, `(document.body?.innerText || '').toLowerCase()`);
      const isAlreadyRegistered = bodyCheck.includes('user already exists') || 
                                  bodyCheck.includes('already registered') || 
                                  bodyCheck.includes('already have an account') ||
                                  bodyCheck.includes('email is registered') ||
                                  bodyCheck.includes('tài khoản đã tồn tại') ||
                                  bodyCheck.includes('đã đăng ký');
      if (isAlreadyRegistered) {
        throw new Error(`ACCOUNT_EXISTS: Email ${email} đã được đăng ký trước đó trên OpenAI. Giao diện: ${bodyCheck.slice(0, 150)}`);
      }

      const hasPasswordInputAlready = await evalJson(tabId, USER_ID,
        `!!document.querySelector('input[type="password"], input[name="password"], input[name="new-password"]')`
      );
      if (hasPasswordInputAlready) {
        emailSuccess = true;
        break;
      }

      const hasVerify = bodyCheck?.includes('email-verification') || bodyCheck?.includes('check your inbox') || bodyCheck?.includes('verification code');
      if (hasVerify) {
        emailSuccess = true;
        break;
      }

      console.log(`[Email-submit] ⚠️ Thao tác submit email chưa chuyển trang (Thử lại ${attempt}/2). Điều hướng lại về auth/login để nhận session mới...`);
      await camofoxPostWithSessionKey(`/tabs/${tabId}/navigate`, { userId: USER_ID, url: 'https://chatgpt.com/auth/login' });

      // Chờ email input xuất hiện sau khi navigate
      const emailInputAppeared = await pollUntil(async () => {
        const hasInput = await evalJson(tabId, USER_ID,
          `!!document.querySelector('input[type="email"], input[name="email"], input[name="username"]')`
        );
        return hasInput;
      }, `EmailRetryNavigate-${attempt}`, { intervalMs: 2000, maxWaitMs: 15000 });

      if (emailInputAppeared) {
        // Dọn dẹp pop-up chào mừng nếu có sau khi reload/navigate
        await evalJson(tabId, USER_ID, `
          (() => {
            const dismissBtn = document.querySelector('[data-testid="dismiss-welcome"]');
            if (dismissBtn) dismissBtn.click();
          })()
        `).catch(() => {});

        // Điền email và click submit lại
        emailClickInfo = await fillEmail(tabId, USER_ID, email);
        console.log(`[Email-submit] Retry ${attempt} →`, JSON.stringify(emailClickInfo || {}));
        newUrl = await waitForUrlChange(tabId, USER_ID, urlBeforeEmail, { timeoutMs: 12000 });
      } else {
        console.log(`[Email-submit] ⚠️ Không tìm thấy ô email sau khi quay lại login page.`);
      }
    }

    // Kiểm tra kết quả cuối cùng sau khi hoàn tất retry
    if (!emailSuccess) {
      const currentUrl = await evalJson(tabId, USER_ID, `location.href`).catch(() => '');
      const bodyCheck = await evalJson(tabId, USER_ID, `(document.body?.innerText || '').toLowerCase()`);
      const isAlreadyRegistered = bodyCheck.includes('user already exists') || 
                                  bodyCheck.includes('already registered') || 
                                  bodyCheck.includes('already have an account') ||
                                  bodyCheck.includes('email is registered') ||
                                  bodyCheck.includes('tài khoản đã tồn tại') ||
                                  bodyCheck.includes('đã đăng ký');
      if (isAlreadyRegistered) {
        throw new Error(`ACCOUNT_EXISTS: Email ${email} đã được đăng ký trước đó trên OpenAI. Giao diện: ${bodyCheck.slice(0, 150)}`);
      }
      if (currentUrl.includes('auth/login?email=') || currentUrl.includes('auth/login/?email=')) {
        throw new Error(`BLOCKED_BY_OPENAI: Bị redirect ngược lại về login landing page (Proxy/Reputation block). URL: ${currentUrl}`);
      }
      if (!newUrl) {
        console.log(`[Email-submit] ⚠️ URL vẫn không đổi sau click — kiểm tra xem trang có chuyển in-page không...`);
        const hasPasswordInputAlready = await evalJson(tabId, USER_ID,
          `!!document.querySelector('input[type="password"], input[name="password"], input[name="new-password"]')`
        );
        if (!hasPasswordInputAlready) {
          if (!bodyCheck.includes('email-verification') && !bodyCheck.includes('check your inbox') && !bodyCheck.includes('verification code')) {
            throw new Error(`[Email-submit] URL không đổi và không có màn hình mật khẩu/OTP — submit email có thể bị thất bại`);
          }
        }
      }
    }

    await assertOnExpectedDomain(tabId, USER_ID, 'after-email-submit');
    // Phase 2, Step 1: After email submit
    await recorder.after(2, 1, 'email_submit');

    // Kiểm tra và khôi phục nếu bị Session ended / invalid_state trước khi kiểm thử flow
    await checkAndRecoverSessionEnded(tabId, USER_ID, email);

    // Detect flow sau khi submit email
    await assertPageContext(tabId, USER_ID, 'before-flow-detection', ['chatgpt.com', 'openai.com']);
    await new Promise(r => setTimeout(r, 500));
    let flowDetection = await evalJson(tabId, USER_ID, `
      (() => {
        const url = location.href;
        const body = document.body?.innerText?.toLowerCase() || '';
        const hasPasswordInput = !!document.querySelector('input[type="password"], input[name="password"], input[name="new-password"]');
        const hasEmailVerificationLink = !!document.querySelector('a[href*="create-account/password"]');
        const hasCodeInput = !!document.querySelector('input[name="code"], input[autocomplete="one-time-code"]');
        const isEmailVerification = url.includes('email-verification') || body.includes('check your inbox') || body.includes('verification code');
        const flow = hasEmailVerificationLink || isEmailVerification ? 'new' : (hasPasswordInput ? 'old' : 'unknown');
        return { url, hasPasswordInput, hasEmailVerificationLink, hasCodeInput, isEmailVerification, flow };
      })()
    `, 5000);

    console.log(`[Flow Detection]:`, JSON.stringify(flowDetection));

    // Email-exists detection: nếu vào OTP screen mà không hề thấy password input
    // → account đã tồn tại, chuyển sang existing-account flow
    if ((flowDetection?.isEmailVerification || flowDetection?.hasCodeInput) && !flowDetection?.hasPasswordInput && !flowDetection?.hasEmailVerificationLink) {
      console.log(`[Flow] Email already registered — switching to existing-account flow`);
      isExistingAccount = true;
    }

    // If flow detection returns unknown, retry with pollUntil
    if (flowDetection?.flow === 'unknown') {
      console.log(`[Flow Detection] ⚠️ Flow unknown, waiting via pollUntil...`);
      const pollSuccess = await pollUntil(async () => {
        const detection = await evalJson(tabId, USER_ID, `
          (() => {
            const url = location.href.toLowerCase();
            const body = document.body?.innerText?.toLowerCase() || '';
            const hasPasswordInput = !!document.querySelector('input[type="password"], input[name="password"], input[name="new-password"]');
            const hasEmailVerificationLink = !!document.querySelector('a[href*="create-account/password"]');
            const hasCodeInput = !!document.querySelector('input[name="code"], input[autocomplete="one-time-code"]');
            const isEmailVerification = url.includes('email-verification') || body.includes('check your inbox') || body.includes('verification code');
            const flow = hasEmailVerificationLink || isEmailVerification ? 'new' : (hasPasswordInput ? 'old' : 'unknown');
            const isBlocked = url.includes('auth/login?email=') || url.includes('auth/login/?email=');
            const isAlreadyRegistered = body.includes('user already exists') || 
                                        body.includes('already registered') || 
                                        body.includes('already have an account') ||
                                        body.includes('email is registered') ||
                                        body.includes('tài khoản đã tồn tại') ||
                                        body.includes('đã đăng ký');
            return { flow, isBlocked, isAlreadyRegistered };
          })()
        `);
        if (detection?.isAlreadyRegistered) {
          throw new Error(`ACCOUNT_EXISTS: Email ${email} đã được đăng ký trước đó trên OpenAI.`);
        }
        if (detection?.isBlocked) {
          throw new Error(`BLOCKED_BY_OPENAI: Bị redirect ngược lại về login landing page (Proxy/Reputation block) trong FlowDetectionPoll.`);
        }
        return detection?.flow !== 'unknown';
      }, 'FlowDetectionPoll', { intervalMs: 2000, maxWaitMs: 20000 });
      
      if (pollSuccess) {
        // Re-run flow detection after successful poll
        await new Promise(r => setTimeout(r, 1000));
        flowDetection = await evalJson(tabId, USER_ID, `
          (() => {
            const url = location.href;
            const body = document.body?.innerText?.toLowerCase() || '';
            const hasPasswordInput = !!document.querySelector('input[type="password"], input[name="password"], input[name="new-password"]');
            const hasEmailVerificationLink = !!document.querySelector('a[href*="create-account/password"]');
            const hasCodeInput = !!document.querySelector('input[name="code"], input[autocomplete="one-time-code"]');
            const isEmailVerification = url.includes('email-verification') || body.includes('check your inbox') || body.includes('verification code');
            const flow = hasEmailVerificationLink || isEmailVerification ? 'new' : (hasPasswordInput ? 'old' : 'unknown');
            return { url, hasPasswordInput, hasEmailVerificationLink, hasCodeInput, isEmailVerification, flow };
          })()
        `, 5000);
        console.log(`[Flow Detection] After poll:`, JSON.stringify(flowDetection));
      } else {
        // ─── Phân tích URL để xác định lý do flow vẫn unknown ───
        const stuckUrl = flowDetection?.url || '';
        const isRedirectedToHome = stuckUrl.includes('chatgpt.com/?slm=') || 
                                   (stuckUrl.includes('chatgpt.com') && !stuckUrl.includes('auth') && !stuckUrl.includes('openai.com'));

        if (isRedirectedToHome) {
          // Trường hợp: Persistent session cũ vẫn còn → OpenAI redirect về trang chủ thay vì login page.
          // Fix: Điều hướng lại về /auth/login và thử submit email lại từ đầu.
          console.log(`[Flow Detection] 🔄 Tab đang ở trang chủ ChatGPT (${stuckUrl.slice(0, 60)}) — có thể persistent session cũ. Điều hướng lại về auth/login...`);
          try {
            await camofoxPostWithSessionKey(`/tabs/${tabId}/navigate`, { userId: USER_ID, url: 'https://chatgpt.com/auth/login' });
          } catch (e) {
            const msg = e?.message || String(e);
            if (!msg.includes('NS_BINDING_ABORTED')) throw e;
          }
          await new Promise(r => setTimeout(r, 5000));
          
          // Chờ email input xuất hiện
          const recoveryState = await collectSignupUiState(tabId, USER_ID);
          if (recoveryState?.hasEmailInput) {
            console.log(`[Flow Detection] ✅ Email input xuất hiện sau khi re-navigate — thử fillEmail lại...`);
            const recoveryFill = await fillEmail(tabId, USER_ID, email);
            console.log(`[Flow Detection] Recovery fillEmail →`, JSON.stringify(recoveryFill || {}));
            await new Promise(r => setTimeout(r, 8000));
            // Re-evaluate flow
            flowDetection = await evalJson(tabId, USER_ID, `
              (() => {
                const url = location.href;
                const body = document.body?.innerText?.toLowerCase() || '';
                const hasPasswordInput = !!document.querySelector('input[type="password"], input[name="password"], input[name="new-password"]');
                const hasEmailVerificationLink = !!document.querySelector('a[href*="create-account/password"]');
                const hasCodeInput = !!document.querySelector('input[name="code"], input[autocomplete="one-time-code"]');
                const isEmailVerification = url.includes('email-verification') || body.includes('check your inbox') || body.includes('verification code');
                const flow = hasEmailVerificationLink || isEmailVerification ? 'new' : (hasPasswordInput ? 'old' : 'unknown');
                return { url, hasPasswordInput, hasEmailVerificationLink, hasCodeInput, isEmailVerification, flow };
              })()
            `, 5000);
            console.log(`[Flow Detection] After home-redirect recovery:`, JSON.stringify(flowDetection));
            if (flowDetection?.flow === 'unknown') {
              throw new Error(`[FlowDetectionPoll] Flow vẫn là 'unknown' sau khi re-navigate từ trang chủ. URL=${flowDetection?.url}`);
            }
          } else {
            // Email input chưa có — có thể trang đang load, thử poll thêm 15s
            console.log(`[Flow Detection] ⏳ Trang re-navigate chưa có email input, chờ thêm...`);
            const recoveryPoll = await pollUntil(async () => {
              const s = await collectSignupUiState(tabId, USER_ID);
              return s?.hasEmailInput === true;
            }, 'RenavigateEmailPoll', { intervalMs: 2000, maxWaitMs: 15000 });
            if (recoveryPoll) {
              const recoveryFill = await fillEmail(tabId, USER_ID, email);
              console.log(`[Flow Detection] Recovery (delayed) fillEmail →`, JSON.stringify(recoveryFill || {}));
              await new Promise(r => setTimeout(r, 8000));
              flowDetection = await evalJson(tabId, USER_ID, `
                (() => {
                  const url = location.href;
                  const body = document.body?.innerText?.toLowerCase() || '';
                  const hasPasswordInput = !!document.querySelector('input[type="password"], input[name="password"], input[name="new-password"]');
                  const hasEmailVerificationLink = !!document.querySelector('a[href*="create-account/password"]');
                  const hasCodeInput = !!document.querySelector('input[name="code"], input[autocomplete="one-time-code"]');
                  const isEmailVerification = url.includes('email-verification') || body.includes('check your inbox') || body.includes('verification code');
                  const flow = hasEmailVerificationLink || isEmailVerification ? 'new' : (hasPasswordInput ? 'old' : 'unknown');
                  return { url, hasPasswordInput, hasEmailVerificationLink, hasCodeInput, isEmailVerification, flow };
                })()
              `, 5000);
              console.log(`[Flow Detection] After delayed re-navigate:`, JSON.stringify(flowDetection));
              if (flowDetection?.flow === 'unknown') {
                throw new Error(`[FlowDetectionPoll] Flow vẫn là 'unknown' sau khi re-navigate và poll. URL=${flowDetection?.url}`);
              }
            } else {
              throw new Error(`[FlowDetectionPoll] Email input không xuất hiện sau khi re-navigate từ trang chủ. URL=${stuckUrl}`);
            }
          }
        } else {
          // Kiểm tra nếu trang có Application Error (JS crash phía OpenAI) → reload và thử lại 1 lần
          const pageBodyCheck = await evalJson(tabId, USER_ID, `
            (() => {
              const body = document.body?.innerText || '';
              const hasAppError = body.toLowerCase().includes('application error') || body.toLowerCase().includes('chunkloaderror');
              return { hasAppError, url: location.href, bodyLen: body.length };
            })()
          `);
          if (pageBodyCheck?.hasAppError) {
            console.log(`[Flow Detection] 🔄 Phát hiện Application Error trên trang (OpenAI JS crash). Điều hướng lại về auth/login...`);
            await camofoxPostWithSessionKey(`/tabs/${tabId}/navigate`, { userId: USER_ID, url: 'https://chatgpt.com/auth/login' });

            // Chờ email input xuất hiện sau khi navigate
            await pollUntil(async () => {
              const hasInput = await evalJson(tabId, USER_ID,
                `!!document.querySelector('input[type="email"], input[name="email"], input[name="username"]')`
              );
              return hasInput;
            }, `AppErrorNavigate`, { intervalMs: 2000, maxWaitMs: 15000 });
            // Điền lại email sau khi reload
            const reloadFlowCheck = await evalJson(tabId, USER_ID, `
              (() => {
                const url = location.href;
                const hasEmailInput = !!document.querySelector('input[type="email"], input[name="email"], input[name="username"]');
                return { url, hasEmailInput };
              })()
            `);
            if (reloadFlowCheck?.hasEmailInput) {
              console.log(`[Flow Detection] ✅ Trang đã reload thành công, tiếp tục điền email lại...`);
              // Re-submit email sau reload — sử dụng helper fillEmail
              const emailClickInfo = await fillEmail(tabId, USER_ID, email);
              console.log(`[Flow Detection] Reload fillEmail →`, JSON.stringify(emailClickInfo || {}));
              await new Promise(r => setTimeout(r, 8000));
              // Re-evaluate flow after reload+resubmit
              flowDetection = await evalJson(tabId, USER_ID, `
                (() => {
                  const url = location.href;
                  const body = document.body?.innerText?.toLowerCase() || '';
                  const hasPasswordInput = !!document.querySelector('input[type="password"], input[name="password"], input[name="new-password"]');
                  const hasEmailVerificationLink = !!document.querySelector('a[href*="create-account/password"]');
                  const hasCodeInput = !!document.querySelector('input[name="code"], input[autocomplete="one-time-code"]');
                  const isEmailVerification = url.includes('email-verification') || body.includes('check your inbox') || body.includes('verification code');
                  const flow = hasEmailVerificationLink || isEmailVerification ? 'new' : (hasPasswordInput ? 'old' : 'unknown');
                  return { url, hasPasswordInput, hasEmailVerificationLink, hasCodeInput, isEmailVerification, flow };
                })()
              `, 5000);
              console.log(`[Flow Detection] After App-Error reload:`, JSON.stringify(flowDetection));
              if (flowDetection?.flow === 'unknown') {
                throw new Error(`[FlowDetectionPoll] Flow vẫn là 'unknown' sau khi reload Application Error. Email submit có thể đã thất bại.`);
              }
            } else {
              // hasEmailInput = false sau reload — trang có thể chưa render xong, poll thêm
              console.log(`[Flow Detection] ⏳ Sau App-Error reload nhưng chưa có email input, poll thêm 15s...`);
              const postReloadPoll = await pollUntil(async () => {
                const s = await collectSignupUiState(tabId, USER_ID);
                return s?.hasEmailInput === true;
              }, 'AppErrorReloadPoll', { intervalMs: 2000, maxWaitMs: 15000 });
              if (postReloadPoll) {
                const emailClickInfo = await fillEmail(tabId, USER_ID, email);
                console.log(`[Flow Detection] App-Error delayed fillEmail →`, JSON.stringify(emailClickInfo || {}));
                await new Promise(r => setTimeout(r, 8000));
                flowDetection = await evalJson(tabId, USER_ID, `
                  (() => {
                    const url = location.href;
                    const body = document.body?.innerText?.toLowerCase() || '';
                    const hasPasswordInput = !!document.querySelector('input[type="password"], input[name="password"], input[name="new-password"]');
                    const hasEmailVerificationLink = !!document.querySelector('a[href*="create-account/password"]');
                    const hasCodeInput = !!document.querySelector('input[name="code"], input[autocomplete="one-time-code"]');
                    const isEmailVerification = url.includes('email-verification') || body.includes('check your inbox') || body.includes('verification code');
                    const flow = hasEmailVerificationLink || isEmailVerification ? 'new' : (hasPasswordInput ? 'old' : 'unknown');
                    return { url, hasPasswordInput, hasEmailVerificationLink, hasCodeInput, isEmailVerification, flow };
                  })()
                `, 5000);
                console.log(`[Flow Detection] After App-Error delayed reload:`, JSON.stringify(flowDetection));
                if (flowDetection?.flow === 'unknown') {
                  throw new Error(`[FlowDetectionPoll] Flow vẫn là 'unknown' sau khi App-Error reload + poll.`);
                }
              } else {
                throw new Error(`[FlowDetectionPoll] Flow vẫn là 'unknown' sau khi poll. Email submit có thể đã thất bại hoặc trang chưa chuyển sang bước tiếp theo.`);
              }
            }
          } else {
            // Sau khi hết poll mà vẫn không nhận dạng được flow — dừng lại
            throw new Error(`[FlowDetectionPoll] Flow vẫn là 'unknown' sau khi poll. Email submit có thể đã thất bại hoặc trang chưa chuyển sang bước tiếp theo.`);
          }
        }
      }

    }

    // 3. Điền mật khẩu — chỉ skip nếu account đã tồn tại và màn hình OTP hiển thị trực tiếp
    if (isExistingAccount && flowDetection?.isEmailVerification && flowDetection?.hasCodeInput) {
      console.log(`[3] Smart Skip: Màn hình OTP đã hiển thị trực tiếp cho account đã tồn tại. Bỏ qua điền password.`);
    } else {
    // Flow mới: click "Continue with password" link trước
    if (flowDetection?.flow === 'new') {
      // Flow mới: click "Continue with password" link trước
      console.log(`[3] Flow mới: Click "Continue with password"...`);
      const pwdLinkResult = await evalJson(tabId, USER_ID, `
        (() => {
          let link = document.querySelector('a[href*="create-account/password"]');
          if (link) {
            link.click();
            return { clicked: true, method: 'href', text: link.textContent.trim() };
          }
          link = Array.from(document.querySelectorAll('a')).find(a => {
            const t = (a.textContent || '').trim().toLowerCase();
            return t === 'continue with password';
          });
          if (link) {
            link.click();
            return { clicked: true, method: 'text', text: link.textContent.trim() };
          }
          return { clicked: false, error: 'no-continue-with-password-link' };
        })()
      `, 5000);
      console.log(`[3.1] Click "Continue with password" →`, JSON.stringify(pwdLinkResult));
      await new Promise(r => setTimeout(r, 5000));
      // Phase 2, Step 2: Continue with password clicked
      await recorder.after(2, 2, 'continue_with_password');
    }

    // Điền password (cả 2 flow đều cần) — retry với tối đa 3 candidates
    console.log(`[3] Đang chờ password input xuất hiện...`);
    const pwdSelector = 'input[type="password"], input[name="password"], input[name="new-password"]';
    let hasPwdInput = await waitForSelector(tabId, USER_ID, pwdSelector, { timeoutMs: 12000 }).catch(() => false);
    if (!hasPwdInput) {
      // Fallback check via evalJson in case Playwright selector matching had issues
      hasPwdInput = await evalJson(tabId, USER_ID, `!!document.querySelector('input[type="password"], input[name="password"], input[name="new-password"]')`);
    }

    if (!hasPwdInput) {
      throw new Error(`[Password] Không tìm thấy ô nhập mật khẩu trên trang. URL hiện tại: ${await evalJson(tabId, USER_ID, 'location.href').catch(() => '?')}`);
    }

    if (hasPwdInput) {
      let pwdCandidates = [];

      // Smart detection for incomplete accounts (email registered but password not set)
      const currentUrl = await evalJson(tabId, USER_ID, `location.href`);
      const isOnCreatePage = currentUrl?.includes('create-account/password');
      const pageBodyText = await evalJson(tabId, USER_ID, `(document.body?.innerText || '').toLowerCase()`);
      const isCreatePasswordPage = isOnCreatePage || pageBodyText.includes('create a password') || pageBodyText.includes('you\'ll use this password to log in');

      if (isExistingAccount && isCreatePasswordPage) {
        console.log(`[3] Smart Detection: Incomplete Account detected (URL/body indicates password creation) — generating new password instead of using Vault password`);
        isExistingAccount = false; // Switch to registration flow to generate new password and proceed with OTP/about forms
      }

      if (isExistingAccount) {
        // Nếu là account đã tồn tại, dùng mật khẩu cũ đã được cấu hình trong Vault
        pwdCandidates = [chatGptPassword];
        console.log(`[3] Luồng Account đã tồn tại: Sử dụng mật khẩu hiện tại...`);
      } else {
        // Sinh tối đa 3 password candidates cho account mới
        const PWD_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
        while (pwdCandidates.length < 3) {
          const candidate = Array.from({ length: CONFIG.passwordLength }, () =>
            PWD_CHARS[Math.floor(Math.random() * PWD_CHARS.length)]
          ).join('');
          if (!pwdCandidates.includes(candidate)) pwdCandidates.push(candidate);
        }
      }

      let passwordSuccess = false;
      let usedPassword = '';

      for (let attempt = 0; attempt < pwdCandidates.length; attempt++) {
        const tryPassword = pwdCandidates[attempt];
        await assertPageContext(tabId, USER_ID, `before-password-fill-${attempt}`, ['chatgpt.com', 'openai.com']);
        console.log(`[3] Điền Password [${attempt + 1}/${pwdCandidates.length}] -> ${tryPassword.slice(0, 3)}...`);

        const urlBeforePwd = await evalJson(tabId, USER_ID, `location.href`);
        let pwdClickInfo = await fillPassword(tabId, USER_ID, tryPassword);
        console.log(`[Password-submit] [${attempt + 1}] →`, JSON.stringify(pwdClickInfo || {}));
        if (!pwdClickInfo || !pwdClickInfo.ok) {
          console.log(`[Password] Attempt ${attempt + 1} UI error: ${pwdClickInfo?.reason || 'Unknown error'}`);
          if (attempt < pwdCandidates.length - 1) {
            await new Promise(r => setTimeout(r, 2000));
            continue;
          }
          throw new Error(`Password submit failed: ${pwdClickInfo?.reason || 'Unknown error'}`);
        }

        await waitForUrlChange(tabId, USER_ID, urlBeforePwd, { timeoutMs: 8000 });
        await assertOnExpectedDomain(tabId, USER_ID, 'after-password-submit');

        // Kiểm tra xem password có được chấp nhận không (không còn ở password page)
        let stillOnPasswordPage = await evalJson(tabId, USER_ID, `
          !!document.querySelector('input[name="new-password"], input[name="password"], input[type="password"], input[autocomplete="new-password"]')
        `);

        // --- KIỂM TRA MÀN HÌNH PASSWORD SAU KHI SUBMIT ---
        if (stillOnPasswordPage) {
          const pageError = await evalJson(tabId, USER_ID, `
            (() => {
              const errEl = document.querySelector('[class*="error"], [class*="alert"], [role="alert"], [aria-live], .error-message');
              return errEl ? (errEl.innerText || '').trim() : null;
            })()
          `).catch(() => null);

          if (pageError) {
            console.log(`[Password] Mật khẩu bị từ chối với lỗi hiển thị trên trang: "${pageError}"`);
            if (pageError.toLowerCase().includes('already') || pageError.toLowerCase().includes('exists') || pageError.toLowerCase().includes('user_exists')) {
              throw new Error(`ACCOUNT_EXISTS: Email ${email} đã được đăng ký trước đó trên OpenAI. (Phát hiện lỗi: ${pageError})`);
            }
          } else {
            // Không có lỗi hiển thị nhưng vẫn ở màn hình password -> Có thể do tải chậm hoặc Turnstile bị block
            const currentUrl = await evalJson(tabId, USER_ID, `location.href.toLowerCase()`).catch(() => '');
            if (currentUrl.includes('auth/login?email=') || currentUrl.includes('auth/login/?email=')) {
              throw new Error(`BLOCKED_BY_OPENAI: Bị redirect ngược lại về login landing page sau khi submit password (Proxy/Reputation block). URL: ${currentUrl}`);
            }

            console.log(`[Password] Vẫn ở màn hình Password và không có lỗi hiển thị. Chờ thêm 5 giây kiểm tra tải trang...`);
            await new Promise(r => setTimeout(r, 5000));

            stillOnPasswordPage = await evalJson(tabId, USER_ID, `
              !!document.querySelector('input[name="new-password"], input[name="password"], input[type="password"], input[autocomplete="new-password"]')
            `).catch(() => false);

            if (stillOnPasswordPage) {
              const finalUrl = await evalJson(tabId, USER_ID, `location.href.toLowerCase()`).catch(() => '');
              if (finalUrl.includes('auth/login?email=') || finalUrl.includes('auth/login/?email=')) {
                throw new Error(`BLOCKED_BY_OPENAI: Bị redirect ngược lại về login landing page sau khi submit password (Proxy/Reputation block). URL: ${finalUrl}`);
              }
              // Thực sự bị chặn submit (Turnstile/IP reputation block)
              throw new Error(`BLOCKED_BY_OPENAI: Form submission bị chặn ở màn hình Password (Turnstile/Proxy reputation block). URL: ${finalUrl}`);
            }
          }
        }

        if (!stillOnPasswordPage) {
          const currentUrl = await evalJson(tabId, USER_ID, `location.href.toLowerCase()`).catch(() => '');
          if (currentUrl.includes('auth/login?email=') || currentUrl.includes('auth/login/?email=')) {
            throw new Error(`BLOCKED_BY_OPENAI: Bị redirect ngược lại về login landing page sau khi submit password (Proxy/Reputation block). URL: ${currentUrl}`);
          }
          passwordSuccess = true;
          usedPassword = tryPassword;
          console.log(`✅ [Password] Attempt ${attempt + 1} accepted`);
          break;
        }

        // Kiểm tra lỗi "already exists" trong page text
        const errorCheck = await evalJson(tabId, USER_ID, `
          (() => {
            const body = (document.body?.innerText || '').toLowerCase();
            return { hasAlreadyError: body.includes('already') || body.includes('exists') || body.includes('user_exists') };
          })()
        `);
        if (errorCheck?.hasAlreadyError) {
          throw new Error(`ACCOUNT_EXISTS: Email ${email} đã được đăng ký trước đó trên OpenAI. (Phát hiện lỗi already exists tại password page)`);
        }

        console.log(`[Password] Attempt ${attempt + 1} rejected, trying next...`);
        await new Promise(r => setTimeout(r, 2000));
      }

      if (!passwordSuccess) {
        throw new Error('All 3 password attempts rejected');
      }

      // Cập nhật chatGptPassword thành password đã được chấp nhận
      chatGptPassword = usedPassword;

      // Phase 2, Step 3: After password submit
      await recorder.after(2, 3, 'password_submit');
    }
    } // end if (!isExistingAccount)

    // 4. Giải OTP (giống bản gốc - luôn check)
    console.log(`[4] Đang phân tích luồng chờ mã Pin Verify...`);
    await checkAndRecoverSessionEnded(tabId, USER_ID, email, chatGptPassword);

    await assertPageContext(tabId, USER_ID, 'before-otp-check', ['chatgpt.com', 'openai.com']);
    const otpCheckStartTime = Date.now();
    let otpScreenCheck = await evalJson(tabId, USER_ID, `
      (() => {
        const url = location.href.toLowerCase();
        const body = (document.body?.innerText || '').toLowerCase();
        const hasOtpInput = !!(
          document.querySelector('input[autocomplete="one-time-code"]') ||
          document.querySelector('input[inputmode="numeric"]') ||
          document.querySelector('input[name="code"]') ||
          document.querySelector('input[maxlength="6"]')
        );
        return {
          url,
          body: body.slice(0, 200),
          hasOtpInput,
          hasVerifyUrl: url.includes('email-verification') || url.includes('verify'),
          hasVerifyText: body.includes('verify') || body.includes('code') || body.includes('enter code')
        };
      })()
    `);
    console.log(`[4] OTP screen check:`, JSON.stringify(otpScreenCheck));

    // Case 1: The page is still loading and we don't see anything yet (neither inputs nor verification indicators)
    if (!otpScreenCheck.hasOtpInput && !otpScreenCheck.hasVerifyUrl && !otpScreenCheck.hasVerifyText) {
      const pollSuccess = await pollUntil(async () => {
        await checkAndRecoverSessionEnded(tabId, USER_ID, email, chatGptPassword);
        const check = await evalJson(tabId, USER_ID, `
          (() => {
            const url = location.href.toLowerCase();
            const body = (document.body?.innerText || '').toLowerCase();
            const hasOtpInput = !!(
              document.querySelector('input[autocomplete="one-time-code"]') ||
              document.querySelector('input[inputmode="numeric"]') ||
              document.querySelector('input[name="code"]') ||
              document.querySelector('input[maxlength="6"]')
            );
            const isBlocked = url.includes('auth/login?email=') || url.includes('auth/login/?email=');
            return {
              hasOtpInput,
              hasVerifyUrl: url.includes('email-verification') || url.includes('verify'),
              hasVerifyText: body.includes('verify') || body.includes('code') || body.includes('enter code'),
              isBlocked
            };
          })()
        `);
        if (check.isBlocked) {
          throw new Error(`BLOCKED_BY_OPENAI: Bị redirect ngược lại về login landing page (Proxy/Reputation block) trong OTPScreenPoll.`);
        }
        return check.hasOtpInput || check.hasVerifyUrl || check.hasVerifyText;
      }, 'OTPScreenPoll', { intervalMs: 2000, maxWaitMs: proxyUrl ? 30000 : 20000 });
      
      if (pollSuccess) {
        // Re-run OTP screen check after successful poll
        await new Promise(r => setTimeout(r, 1000));
        otpScreenCheck = await evalJson(tabId, USER_ID, `
          (() => {
            const url = location.href.toLowerCase();
            const body = (document.body?.innerText || '').toLowerCase();
            const hasOtpInput = !!(
              document.querySelector('input[autocomplete="one-time-code"]') ||
              document.querySelector('input[inputmode="numeric"]') ||
              document.querySelector('input[name="code"]') ||
              document.querySelector('input[maxlength="6"]')
            );
            return {
              url,
              body: body.slice(0, 200),
              hasOtpInput,
              hasVerifyUrl: url.includes('email-verification') || url.includes('verify'),
              hasVerifyText: body.includes('verify') || body.includes('code') || body.includes('enter code')
            };
          })()
        `);
        console.log(`[4] OTP screen check after poll:`, JSON.stringify(otpScreenCheck));
      } else {
        // Sau khi hết poll vẫn không phát hiện bất kỳ tín hiệu nào của OTP screen — dừng lại
        throw new Error(`[OTPScreenPoll] Màn hình OTP không xuất hiện sau khi poll. URL hiện tại: ${await evalJson(tabId, USER_ID, 'location.href').catch(() => '?')}`);
      }
    }

    // Case 2: We have OTP page indicators (URL or text) but the input element itself is not rendered yet (React loading)
    if (!otpScreenCheck.hasOtpInput && (otpScreenCheck.hasVerifyUrl || otpScreenCheck.hasVerifyText)) {
      console.log(`[4] ⚠️ OTP page detected but input not rendered yet, waiting for input element...`);
      const inputPollSuccess = await pollUntil(async () => {
        const check = await evalJson(tabId, USER_ID, `
          (() => {
            return !!(
              document.querySelector('input[autocomplete="one-time-code"]') ||
              document.querySelector('input[inputmode="numeric"]') ||
              document.querySelector('input[name="code"]') ||
              document.querySelector('input[maxlength="6"]')
            );
          })()
        `);
        return check;
      }, 'OTPInputPoll', { intervalMs: 1500, maxWaitMs: 15000 });

      if (inputPollSuccess) {
        console.log(`[4] ✅ OTP input element appeared!`);
        otpScreenCheck.hasOtpInput = true;
      } else {
        throw new Error(`[OTPInputPoll] Ô nhập mã OTP không hiển thị dù đang ở trang xác thực. URL hiện tại: ${await evalJson(tabId, USER_ID, 'location.href').catch(() => '?')}`);
      }
    }

    const isOnOtpScreen = otpScreenCheck.hasOtpInput && (otpScreenCheck.hasVerifyUrl || otpScreenCheck.hasVerifyText);
    if (isOnOtpScreen) {
      console.log(`[4.1] Đã nhận diện được giao diện nhập mã PIN!`);
      // Lần đầu chờ OTP trong 50 giây
      let otpCode = await waitForOTPCode({ email, refreshToken, clientId, senderDomain: 'openai.com', maxWaitSecs: 50, minTime: otpCheckStartTime });
      
      if (!otpCode) {
        console.log(`[OTP] ⚠️ Không nhận được mã OTP sau 50s. Tiến hành click "Resend email" và thử lại...`);
        const resendRes = await evalJson(tabId, USER_ID, `
          (() => {
            const isVisible = el => {
              if (!el) return false;
              const s = window.getComputedStyle(el);
              const r = el.getBoundingClientRect();
              return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0' && r.width > 0 && r.height > 0;
            };
            const btn = Array.from(document.querySelectorAll('button, [role="button"], a'))
              .filter(isVisible)
              .find(el => {
                const t = (el.innerText || el.textContent || '').trim().toLowerCase();
                return t.includes('resend email') || t.includes('resend code') || t.includes('gửi lại');
              });
            if (btn) {
              btn.click();
              return true;
            }
            return false;
          })()
        `).catch(() => null);
        console.log(`[OTP] Resend email click result:`, resendRes);
        await new Promise(r => setTimeout(r, 5000));
        
        // Chờ OTP thêm 60 giây (tổng cộng ~115s) với mốc thời gian mới để tránh nhận mã cũ
        const newMinTime = Date.now();
        otpCode = await waitForOTPCode({ email, refreshToken, clientId, senderDomain: 'openai.com', maxWaitSecs: 60, minTime: newMinTime });
      }

      if (!otpCode) throw new Error(`Thất bại: Không lấy được mã OTP từ Mail sau khi gửi lại.`);

      console.log(`[4.2] Nhập mã PIN ${otpCode} lên web...`);
      await recorder.before(4, 2, 'otp_entry');
      const otpInputSelector = 'input[autocomplete="one-time-code"], input[inputmode="numeric"], input[name="code"], input[maxlength="6"]';
      await actClick(tabId, USER_ID, { selector: otpInputSelector }).catch(() => {});
      await new Promise(r => setTimeout(r, 600));
      for (const char of otpCode) {
        await actPress(tabId, USER_ID, { key: char });
        await new Promise(r => setTimeout(r, 100));
      }
      await new Promise(r => setTimeout(r, 800));

      let submitted = false;
      try {
        const clickResult = await evalJson(tabId, USER_ID, `
          (() => {
            const input = document.querySelector('input[autocomplete="one-time-code"], input[inputmode="numeric"], input[name="code"], input[maxlength="6"]');
            if (!input) return { ok: false, reason: 'code-input-not-found' };
            const form = input.closest('form');
            if (!form) return { ok: false, reason: 'form-not-found' };
            
            const buttons = Array.from(form.querySelectorAll('button[type="submit"], input[type="submit"]'));
            let btn = buttons.find(b => b.getAttribute('value') === 'validate') ||
                      buttons.find(b => {
                        const t = (b.innerText || b.textContent || '').trim().toLowerCase();
                        return t === 'continue' || t === 'next' || t === 'tiếp tục';
                      }) ||
                      buttons[0];
                      
            if (btn) {
              btn.focus?.();
              btn.click();
              return { ok: true, clicked: true, text: (btn.innerText || btn.textContent || '').trim() };
            }
            return { ok: false, reason: 'submit-button-not-found' };
          })()
        `);
        console.log(`[4.2] Click Continue result:`, JSON.stringify(clickResult));

        console.log(`[4.2] Đợi 5s xem page có chuyển hướng không...`);
        await new Promise(r => setTimeout(r, 5000));
        const stillOnOtp = await evalJson(tabId, USER_ID, `!!document.querySelector('input[name="code"]')`);
        if (!stillOnOtp) {
          submitted = true;
          console.log(`[4.2] Page đã chuyển hướng hoặc đang load (code input biến mất).`);
        }
      } catch (err) {
        console.log(`[4.2] Click Continue lỗi: ${err.message}`);
      }

      if (!submitted) {
        console.log(`[4.2] Vẫn ở trang OTP, thử bấm phím Enter...`);
        await actPress(tabId, USER_ID, { key: 'Enter' }).catch(() => {});
        await new Promise(r => setTimeout(r, 4000));
        const stillOnOtp = await evalJson(tabId, USER_ID, `!!document.querySelector('input[name="code"]')`);
        if (!stillOnOtp) {
          submitted = true;
          console.log(`[4.2] Page chuyển hướng sau khi bấm Enter.`);
        }
      }

      if (!submitted) {
        // Force submit using DOM submit as fallback
        console.log(`[4.2] Vẫn ở trang OTP, thực hiện fallback DOM submit...`);
        await evalJson(tabId, USER_ID, `
          (() => {
            const input = document.querySelector('input[name="code"]');
            if (input && input.form) {
              let intentInput = input.form.querySelector('input[name="intent"]');
              if (!intentInput) {
                intentInput = document.createElement('input');
                intentInput.type = 'hidden';
                intentInput.name = 'intent';
                intentInput.value = 'validate';
                input.form.appendChild(intentInput);
              }
              input.form.submit();
              return { ok: true, msg: 'form-submitted' };
            }
            return { ok: false, error: 'form-not-found' };
          })()
        `).catch(e => console.log(`[4.2] Lỗi DOM submit: ${e.message}`));
      }

      await new Promise(r => setTimeout(r, 6000));
      
      // Verify OTP entry success - check if still on OTP screen
      const otpVerifyCheck = await evalJson(tabId, USER_ID, `
        (() => {
          const hasOtpInput = !!(
            document.querySelector('input[autocomplete="one-time-code"]') ||
            document.querySelector('input[inputmode="numeric"]') ||
            document.querySelector('input[name="code"]') ||
            document.querySelector('input[maxlength="6"]')
          );
          const url = location.href.toLowerCase();
          const hasVerifyUrl = url.includes('email-verification') || url.includes('verify');
          const body = (document.body?.innerText || '').toLowerCase();
          const hasVerifyText = body.includes('verify') || body.includes('code') || body.includes('enter code');
          return { hasOtpInput, hasVerifyUrl, hasVerifyText, url: url.slice(0, 80) };
        })()
      `);
      console.log(`[OTP] Verify check:`, JSON.stringify(otpVerifyCheck));

      // BUG FIX: Chỉ coi là "vẫn ở màn hình OTP" khi vừa khớp URL/Text xác minh VÀ vừa phải có ô nhập mã OTP (hasOtpInput)
      // Điều này ngăn chặn việc ngộ nhận khi trang đang chuyển hướng (hasOtpInput=false nhưng URL chưa đổi) hoặc khi đã chuyển sang form khác.
      const isStillOnOtp = (otpVerifyCheck.hasVerifyUrl || otpVerifyCheck.hasVerifyText) && otpVerifyCheck.hasOtpInput;
      if (isStillOnOtp) {
        console.log(`[OTP] ⚠️ Vẫn ở màn hình OTP, retry entry...`);
        for (let retry = 1; retry <= CONFIG.otpMaxRetries; retry++) {
          // Use fresh timestamp for each retry to avoid receiving already-seen/expired codes
          const otpRetryMinTime = Date.now();
          const otpRetryCode = await waitForOTPCode({ email, refreshToken, clientId, senderDomain: 'openai.com', maxWaitSecs: CONFIG.otpRetryTimeout, minTime: otpRetryMinTime });
          if (!otpRetryCode) {
            console.log(`[OTP] Retry ${retry} failed: Không lấy được mã OTP mới.`);
            continue;
          }

          console.log(`[OTP] Retry ${retry}: Nhập mã PIN ${otpRetryCode}...`);
          await evalJson(tabId, USER_ID, `
            (() => {
              const typeReact = (el, text) => {
                if (!el) return false;
                const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                nativeSetter.call(el, text);
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                return true;
              };
              const isVisible = (el) => {
                return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
              };
              const input = Array.from(document.querySelectorAll('input')).find(el =>
                isVisible(el) && (
                  el.autocomplete === 'one-time-code' ||
                  el.getAttribute('autocomplete') === 'one-time-code' ||
                  el.inputMode === 'numeric' ||
                  el.getAttribute('inputmode') === 'numeric' ||
                  (el.name || '').toLowerCase().includes('code') ||
                  (el.name || '').toLowerCase().includes('otp') ||
                  (el.placeholder || '').toLowerCase().includes('code') ||
                  el.maxLength === 6
                )
              );
              if (input) {
                typeReact(input, '${otpRetryCode}');
                const btn = Array.from(document.querySelectorAll('button')).find(b => {
                  const t = b.textContent.toLowerCase().trim();
                  return t === 'continue' || t === 'verify' || t.includes('verify') || t.includes('ti\u1ebfp t\u1ee5c');
                });
                if (btn) btn.click();
                else input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
                return { ok: true };
              }
              return { ok: false, error: 'no-otp-input' };
            })()
          `);
          await new Promise(r => setTimeout(r, 5000));
          
          // Check if retry succeeded
          const retryCheck = await evalJson(tabId, USER_ID, `
            (() => {
              const url = location.href.toLowerCase();
              const body = (document.body?.innerText || '').toLowerCase();
              const hasOtpInput = !!document.querySelector('input[autocomplete="one-time-code"], input[inputmode="numeric"], input[name="code"], input[maxlength="6"]');
              const hasVerifyUrl = url.includes('email-verification') || url.includes('verify');
              const hasVerifyText = body.includes('verify') || body.includes('code') || body.includes('enter code');
              return { hasOtpInput, hasVerifyUrl, hasVerifyText };
            })()
          `);
          // Dùng cùng logic đã fix: Phải có cả ô nhập OTP và URL/Text xác thực mới coi là vẫn ở màn hình OTP
          const isStillOnOtpAfterRetry = (retryCheck.hasVerifyUrl || retryCheck.hasVerifyText) && retryCheck.hasOtpInput;
          if (!isStillOnOtpAfterRetry) {
            console.log(`[OTP] ✅ Retry ${retry} thành công!`);
            break;
          } else {
            console.log(`[OTP] Retry ${retry}: vẫn ở màn hình OTP`);
          }
        }
      }


      // Check if URL successfully transitioned away from email-verification page
      let finalUrlCheck = await evalJson(tabId, USER_ID, `location.href.toLowerCase()`);
      if (finalUrlCheck.includes('email-verification')) {
        console.log(`[OTP] ⚠️ Vẫn ở trang email-verification sau khi submit. Kiểm tra xem trang có bị đơ/trắng không...`);
        const pageStatus = await evalJson(tabId, USER_ID, `
          (() => {
            const body = document.body?.innerText || '';
            const inputs = document.querySelectorAll('input').length;
            return { bodyLength: body.length, inputs };
          })()
        `);
        
        if (pageStatus.bodyLength < 100 || pageStatus.inputs === 0) {
          console.log(`[OTP] 🔄 Trang bị trống hoặc đơ (Độ dài body: ${pageStatus.bodyLength}, Số input: ${pageStatus.inputs}). Quay lại login page để khôi phục...`);
          await camofoxPostWithSessionKey(`/tabs/${tabId}/navigate`, { userId: USER_ID, url: 'https://chatgpt.com/auth/login' });
          await new Promise(r => setTimeout(r, 6000));
          finalUrlCheck = await evalJson(tabId, USER_ID, `location.href.toLowerCase()`);
        }
      }

      if (finalUrlCheck.includes('email-verification')) {
        throw new Error('OTP verification submitted but page failed to transition away from email-verification');
      }

      if (finalUrlCheck.includes('auth/login') || finalUrlCheck.includes('google.com') || finalUrlCheck.includes('apple.com')) {
        throw new Error(`[OTP] Xác minh OTP thất bại hoặc bị điều hướng sai URL. URL hiện tại: ${finalUrlCheck}`);
      }

      // Phase 3, Step 1: Pin verified
      await recorder.after(3, 1, 'pin_verified');
    }

    // Check if password setup is required after OTP validation (e.g. on /create-account/password)
    const hasPwdInputAfterOtp = await evalJson(tabId, USER_ID, `
      !!document.querySelector('input[type="password"], input[name="password"], input[name="new-password"]')
    `);
    if (hasPwdInputAfterOtp) {
      console.log(`[4.3] Phát hiện màn hình tạo mật khẩu sau khi giải OTP. Tiến hành điền mật khẩu...`);
      let pwdCandidates = [];
      const PWD_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
      while (pwdCandidates.length < 3) {
        const candidate = Array.from({ length: CONFIG.passwordLength }, () =>
          PWD_CHARS[Math.floor(Math.random() * PWD_CHARS.length)]
        ).join('');
        if (!pwdCandidates.includes(candidate)) pwdCandidates.push(candidate);
      }

      let passwordSuccess = false;
      let usedPassword = '';

      for (let attempt = 0; attempt < pwdCandidates.length; attempt++) {
        const tryPassword = pwdCandidates[attempt];
        console.log(`[4.3] Điền Password [${attempt + 1}/${pwdCandidates.length}] -> ${tryPassword.slice(0, 3)}...`);

        const urlBeforePwd = await evalJson(tabId, USER_ID, `location.href`);
        const pwdClickInfo = await fillPassword(tabId, USER_ID, tryPassword);
        console.log(`[Password-submit-after-otp] [${attempt + 1}] →`, JSON.stringify(pwdClickInfo || {}));
        if (!pwdClickInfo || !pwdClickInfo.ok) {
          console.log(`[Password-after-otp] Attempt ${attempt + 1} UI error: ${pwdClickInfo?.reason || 'Unknown error'}`);
          if (attempt < pwdCandidates.length - 1) {
            await new Promise(r => setTimeout(r, 2000));
            continue;
          }
          throw new Error(`Password submit failed after OTP: ${pwdClickInfo?.reason || 'Unknown error'}`);
        }

        await waitForUrlChange(tabId, USER_ID, urlBeforePwd, { timeoutMs: 8000 });
        await assertOnExpectedDomain(tabId, USER_ID, 'after-password-submit');

        const stillOnPasswordPage = await evalJson(tabId, USER_ID, `
          !!document.querySelector('input[name="new-password"], input[name="password"], input[type="password"], input[autocomplete="new-password"]')
        `);

        if (!stillOnPasswordPage) {
          passwordSuccess = true;
          usedPassword = tryPassword;
          console.log(`✅ [Password-after-otp] Attempt ${attempt + 1} accepted`);
          break;
        }

        console.log(`[Password-after-otp] Attempt ${attempt + 1} rejected, trying next...`);
        await new Promise(r => setTimeout(r, 2000));
      }

      if (!passwordSuccess) {
        throw new Error('All 3 password attempts after OTP rejected');
      }

      chatGptPassword = usedPassword;
      await recorder.after(2, 3, 'password_submit_after_otp');
    }

    // 5. Cấp User Info (tên, ngày sinh) — chạy nếu là account mới hoặc nếu page có yêu cầu
    const currentUrlBeforeAbout = await evalJson(tabId, USER_ID, `location.href.toLowerCase()`).catch(() => '');
    if (currentUrlBeforeAbout.includes('auth/login')) {
      throw new Error(`[AboutForm] Vẫn ở trang login page sau khi qua bước OTP. URL: ${currentUrlBeforeAbout}`);
    }

    const hasAboutInputs = await evalJson(tabId, USER_ID, `
      (() => {
        const url = location.href.toLowerCase();
        if (url.includes('about-you') || url.includes('onboarding') || url.includes('aboutyou')) return true;
        const input = document.querySelector('input[name="name"], input[placeholder*="name" i], input[name="birthday"], input[name="dob"], input[name="age"], input[placeholder*="age" i]');
        return !!input;
      })()
    `);
    if (!isExistingAccount || hasAboutInputs) {
      console.log(`[5] Bypass thông tin Form About...`);
      await assertPageContext(tabId, USER_ID, 'before-about-form', ['chatgpt.com', 'openai.com']);
      const userInfo = generateRandomUserInfo();
      await new Promise(r => setTimeout(r, 3000)); // đợi form render xong
      // Phase 3, Step 1: Before about form
      await recorder.before(3, 1, 'about_form');

      const aboutFillInfo = await evalJson(tabId, USER_ID, `
            (() => {
               const fillFieldReact = (el, val) => {
                 if (!el) return false;
                 if (el.tagName === 'SELECT') {
                   el.value = val;
                   el.dispatchEvent(new Event('change', { bubbles: true }));
                   return true;
                 }
                 const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                 nativeSetter.call(el, val);
                 el.dispatchEvent(new Event('input', { bubbles: true }));
                 el.dispatchEvent(new Event('change', { bubbles: true }));
                 return true;
               };

               const filled = { name: false, bday: false, btn: false };

               // Điền Name — thử nhiều selector
               const nameSelectors = [
                 'input[name="name"]',
                 'input[name="fullname"]', 
                 'input[name="full_name"]',
                 'input[autocomplete="name"]',
                 'input[placeholder="Full name"]',
                 'input[placeholder="Name"]',
               ];
               let nameEl = null;
               for (const s of nameSelectors) {
                 nameEl = document.querySelector(s);
                 if (nameEl) break;
               }
               if (nameEl) {
                   fillFieldReact(nameEl, '${userInfo.name}');
                   filled.name = 'fullname';
               } else {
                   // thử split first/last name
                   const firstName = document.querySelector('input[name="first_name"], input[placeholder*="first" i], input[placeholder*="First" i]');
                   const lastName  = document.querySelector('input[name="last_name"],  input[placeholder*="last" i],  input[placeholder*="Last" i]');
                   const parts = '${userInfo.name}'.split(' ');
                   if (firstName) { fillFieldReact(firstName, parts[0] || ''); filled.name = 'first'; }
                   if (lastName)  { fillFieldReact(lastName,  parts[1] || parts[0]); filled.name = filled.name + '+last'; }
               }

               // Điền ngày sinh / tuổi
               const birthMonthEl = document.querySelector('input[aria-label="Month" i], input[placeholder="MM"], input[name="birth_month"], input[name="month"], select[aria-label="Month" i], select[name="month"]');
               const birthDayEl = document.querySelector('input[aria-label="Day" i], input[placeholder="DD"], input[name="birth_day"], input[name="day"], select[aria-label="Day" i], select[name="day"]');
               const birthYearEl = document.querySelector('input[aria-label="Year" i], input[placeholder="YYYY"], input[name="birth_year"], input[name="year"], select[aria-label="Year" i], select[name="year"]');

               if ((birthMonthEl && birthYearEl) || (birthMonthEl && birthDayEl && birthYearEl)) {
                   if (birthMonthEl) fillFieldReact(birthMonthEl, '${userInfo.birthdate.slice(5, 7)}');
                   if (birthDayEl) fillFieldReact(birthDayEl, '${userInfo.birthdate.slice(8, 10)}');
                   if (birthYearEl) fillFieldReact(birthYearEl, '${userInfo.birthdate.slice(0, 4)}');
                   const hiddenDobEl = document.querySelector('input[type="date"]');
                   if (hiddenDobEl) fillFieldReact(hiddenDobEl, '${userInfo.birthdate}');
                   filled.bday = 'dob-segmented';
               } else {
                   const ageEl = document.querySelector('input[name="age"], input[placeholder="Age"], input[placeholder*="age" i], input[aria-label="Age" i]');
                   const dobEl = document.querySelector('input[name="birthday"], input[name="dob"], input[type="date"]') ||
                                 document.querySelector('input[placeholder*="DD"], input[placeholder*="MM/DD"], input[placeholder*="MM/DD/YYYY"], input[placeholder*="YYYY"]') ||
                                 document.querySelector('input[placeholder*="Birthday"], input[placeholder*="Date of birth"]');

                   if (ageEl && ageEl.type !== 'date') {
                       fillFieldReact(ageEl, '${userInfo.age.toString()}');
                       filled.bday = 'age';
                   } else if (dobEl) {
                       // Nếu input type="date", dùng format YYYY-MM-DD
                       if (dobEl.type === 'date') {
                           fillFieldReact(dobEl, '${userInfo.birthdate}');
                           filled.bday = 'dob-date';
                       } else {
                           // format DD/MM/YYYY hoặc MM/DD/YYYY dựa trên placeholder
                           const placeholder = dobEl.placeholder || '';
                           let dobStr;
                           if (placeholder.startsWith('MM')) {
                               dobStr = '${userInfo.birthdate.slice(5, 7)}/${userInfo.birthdate.slice(8, 10)}/${userInfo.birthdate.slice(0, 4)}';
                           } else {
                               dobStr = '${userInfo.birthdate.slice(8, 10)}/${userInfo.birthdate.slice(5, 7)}/${userInfo.birthdate.slice(0, 4)}';
                           }
                           fillFieldReact(dobEl, dobStr);
                           filled.bday = 'dob-text';
                       }
                   }
               }

               // Click nút Agree / Continue / Finish creating account
               const btn = Array.from(document.querySelectorAll('button')).find(b => {
                   const txt = b.textContent.toLowerCase().trim();
                   return txt === 'agree' || txt === 'i agree' || txt === 'continue' || 
                          txt === 'finish' || txt.includes('creating account') ||
                          txt.includes('create account') || txt.includes('finish creating') ||
                          txt.includes('ti\u1ebfp t\u1ee5c') || txt.includes('\u0111\u1ed3ng \u00fd');
               });
               if (btn) { btn.click(); filled.btn = btn.textContent.trim(); }
               else { filled.btn = 'NOT_FOUND: ' + Array.from(document.querySelectorAll('button')).map(b => b.textContent.trim()).join(' | '); }

               return filled;
            })()
          `);
      console.log(`[5.1] Kết quả điền About: ${JSON.stringify(aboutFillInfo || {})}`);

      // Validate birthday input - check if value was actually filled
      if (aboutFillInfo?.bday) {
        const birthdayValidation = await evalJson(tabId, USER_ID, `
          (() => {
            const birthMonthEl = document.querySelector('input[aria-label="Month" i], input[placeholder="MM"], input[name="birth_month"], input[name="month"], select[aria-label="Month" i], select[name="month"]');
            const birthYearEl = document.querySelector('input[aria-label="Year" i], input[placeholder="YYYY"], input[name="birth_year"], input[name="year"], select[aria-label="Year" i], select[name="year"]');
            const dobEl = document.querySelector('input[name="birthday"], input[name="dob"], input[type="date"]') ||
                          document.querySelector('input[placeholder*="DD"], input[placeholder*="MM/DD"], input[placeholder*="MM/DD/YYYY"], input[placeholder*="YYYY"]');
            
            if (birthMonthEl && birthYearEl) {
              return { found: true, value: (birthMonthEl.value && birthYearEl.value) ? 'segmented-filled' : '', type: 'segmented' };
            }
            if (!dobEl) return { found: false, value: null };
            return { found: true, value: dobEl.value, type: dobEl.type };
          })()
        `);
        console.log(`[5.1] Birthday validation:`, JSON.stringify(birthdayValidation));

        // Retry birthday fill if empty
        if (birthdayValidation?.found && !birthdayValidation?.value) {
          console.log(`[5.1] ⚠️ Birthday input trống sau khi điền, retry...`);
          await evalJson(tabId, USER_ID, `
            (() => {
               const fillFieldReact = (el, text) => {
                 if (!el) return false;
                 if (el.tagName === 'SELECT') {
                   el.value = text;
                   el.dispatchEvent(new Event('change', { bubbles: true }));
                   return true;
                 }
                 const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                 nativeSetter.call(el, text);
                 el.dispatchEvent(new Event('input', { bubbles: true }));
                 el.dispatchEvent(new Event('change', { bubbles: true }));
                 return true;
               };

              const birthMonthEl = document.querySelector('input[aria-label="Month" i], input[placeholder="MM"], input[name="birth_month"], input[name="month"], select[aria-label="Month" i], select[name="month"]');
              const birthDayEl = document.querySelector('input[aria-label="Day" i], input[placeholder="DD"], input[name="birth_day"], input[name="day"], select[aria-label="Day" i], select[name="day"]');
              const birthYearEl = document.querySelector('input[aria-label="Year" i], input[placeholder="YYYY"], input[name="birth_year"], input[name="year"], select[aria-label="Year" i], select[name="year"]');

              if (birthMonthEl && birthYearEl) {
                if (birthMonthEl) fillFieldReact(birthMonthEl, '${userInfo.birthdate.slice(5, 7)}');
                if (birthDayEl) fillFieldReact(birthDayEl, '${userInfo.birthdate.slice(8, 10)}');
                if (birthYearEl) fillFieldReact(birthYearEl, '${userInfo.birthdate.slice(0, 4)}');
                const hiddenDobEl = document.querySelector('input[type="date"]');
                if (hiddenDobEl) fillFieldReact(hiddenDobEl, '${userInfo.birthdate}');
              } else {
                const dobEl = document.querySelector('input[name="birthday"], input[name="dob"], input[type="date"]') ||
                              document.querySelector('input[placeholder*="DD"], input[placeholder*="MM/DD"], input[placeholder*="MM/DD/YYYY"], input[placeholder*="YYYY"]');
                if (dobEl && dobEl.type === 'date') {
                  fillFieldReact(dobEl, '${userInfo.birthdate}');
                } else if (dobEl) {
                  const placeholder = dobEl.placeholder || '';
                  let dobStr;
                  if (placeholder.startsWith('MM')) {
                    dobStr = '${userInfo.birthdate.slice(5, 7)}/${userInfo.birthdate.slice(8, 10)}/${userInfo.birthdate.slice(0, 4)}';
                  } else {
                    dobStr = '${userInfo.birthdate.slice(8, 10)}/${userInfo.birthdate.slice(5, 7)}/${userInfo.birthdate.slice(0, 4)}';
                  }
                  fillFieldReact(dobEl, dobStr);
                }
              }
              return { ok: true };
            })()
          `);
          await new Promise(r => setTimeout(r, 2000));
          const retryValidation = await evalJson(tabId, USER_ID, `
            (() => {
              const birthMonthEl = document.querySelector('input[aria-label="Month" i], input[placeholder="MM"], input[name="birth_month"], input[name="month"], select[aria-label="Month" i], select[name="month"]');
              const birthYearEl = document.querySelector('input[aria-label="Year" i], input[placeholder="YYYY"], input[name="birth_year"], input[name="year"], select[aria-label="Year" i], select[name="year"]');
              const dobEl = document.querySelector('input[name="birthday"], input[name="dob"], input[type="date"]') ||
                            document.querySelector('input[placeholder*="DD"], input[placeholder*="MM/DD"], input[placeholder*="MM/DD/YYYY"], input[placeholder*="YYYY"]');
              
              if (birthMonthEl && birthYearEl) {
                return { found: true, value: (birthMonthEl.value && birthYearEl.value) ? 'segmented-filled' : '' };
              }
              return { found: !!dobEl, value: dobEl?.value || null };
            })()
          `);
          console.log(`[5.1] Birthday retry validation:`, JSON.stringify(retryValidation));
        }
      }

      // Nếu btn bị NOT_FOUND, thử thêm 1 lần nữa
      if (typeof aboutFillInfo?.btn === 'string' && aboutFillInfo.btn.startsWith('NOT_FOUND')) {
        console.log(`[5.2] Btn không tìm thấy, thử lại sau 2s...`);
        await new Promise(r => setTimeout(r, 2000));
        await evalJson(tabId, USER_ID, `
          (() => {
            const btn = Array.from(document.querySelectorAll('button')).find(b => {
                const t = b.textContent.toLowerCase().trim();
                return t.includes('creating') || t.includes('finish') || t === 'continue' || t.includes('agree');
            });
            if (btn) btn.click();
            return btn?.textContent || 'still_not_found';
          })()
        `);
      }

      console.log(`[5.2] Đang chờ trình duyệt hoàn tất callback và chuyển hướng vào dashboard...`);
      let redirectOk = false;
      for (let attempt = 1; attempt <= 20; attempt++) {
        const currentUrl = await evalJson(tabId, USER_ID, `location.href`).catch(() => 'unknown');
        const hasNav = await evalJson(tabId, USER_ID, `!!document.querySelector('nav, [data-testid="navigation"], [data-testid="profile-button"], main, input[name="phone"]')`).catch(() => false);
        
        console.log(`[5.2] [Chờ redirect] Lần thử ${attempt}/20 | URL: ${currentUrl} | HasNav: ${hasNav}`);
        
        if (currentUrl.includes('chatgpt.com') && 
            !currentUrl.includes('api/auth/callback') && 
            !currentUrl.includes('auth/login')) {
          if (hasNav || currentUrl.includes('add-phone')) {
            redirectOk = true;
            break;
          }
        }
        await new Promise(r => setTimeout(r, 1500));
      }
      if (!redirectOk) {
        console.log(`[5.2] ⚠️ Cảnh báo: Trình duyệt chưa chuyển hướng hoàn toàn ra khỏi callback URL.`);
      }
      // Phase 3, Step 2: About form completed
      await recorder.after(3, 2, 'about_completed');
    } // end if (!isExistingAccount)
    } // end if (!skipRegistrationSteps)

    // 6. Nhẩy Bypass Phone & Nhẩy vào Workspace
    console.log(`[6] Tiến hành Bypass Screen (if Phone requested) và lấy Access Token...`);
    for (let check = 0; check < 3; check++) {
      const checkState = await getState(tabId, USER_ID).catch(() => null);
      const curUrl = checkState?.href || '';
      if (checkState?.hasPasskeyEnrollScreen || curUrl.includes('login-enroll-passkey') || curUrl.includes('enroll-passkey')) {
        console.log(`[6] 🔑 Passkey enrollment screen detected (check ${check + 1}/3). Dismissing...`);
        await tryDismissPasskeyEnrollment(tabId, USER_ID);
        await new Promise(r => setTimeout(r, 3000));
      } else {
        break;
      }
    }
    const pageUrl = await evalJson(tabId, USER_ID, `location.href`);
    if (pageUrl.includes('add-phone')) {
      console.log(`[6.1] Phát hiện add-phone → thử conditional bypass trước...`);
      phoneBypassAttempted = true;
      const bypassResult = await performWorkspaceConsentBypass(evalJson, tabId, USER_ID);
      if (bypassResult.ok && bypassResult.code) {
        console.log(`[6.1] ✅ Conditional bypass thành công! Code: ${bypassResult.code.slice(0, 20)}...`);
        phoneBypassSuccess = true;
        // Store code for later use if OAuth is enabled
        // Phase 4, Step 1: Phone bypass success
        await recorder.after(4, 1, 'phone_bypass_success');
      } else {
        console.log(`[6.1] ❌ Conditional bypass thất bại: ${bypassResult.error}. Retry với navigation...`);
        
        // Retry phone bypass (max CONFIG.phoneBypassMaxRetries times)
        for (let retry = 1; retry <= CONFIG.phoneBypassMaxRetries; retry++) {
          console.log(`[6.1] Phone bypass retry ${retry}: Navigate về trang trước...`);
          await camofoxPostWithSessionKey(`/tabs/${tabId}/navigate`, { userId: USER_ID, url: 'https://chatgpt.com/' });
          await new Promise(r => setTimeout(r, 2000));
          
          // Navigate back to add-phone
          await camofoxPostWithSessionKey(`/tabs/${tabId}/navigate`, { userId: USER_ID, url: pageUrl });
          await new Promise(r => setTimeout(r, 3000));
          
          const retryResult = await performWorkspaceConsentBypass(evalJson, tabId, USER_ID);
          if (retryResult.ok && retryResult.code) {
            console.log(`[6.1] ✅ Phone bypass retry ${retry} thành công! Code: ${retryResult.code.slice(0, 20)}...`);
            phoneBypassSuccess = true;
            // Phase 4, Step 1: Phone bypass success (retry)
            await recorder.after(4, 1, 'phone_bypass_success_retry');
            break;
          } else {
            console.log(`[6.1] Phone bypass retry ${retry} failed: ${retryResult.error}`);
          }
        }
        
        // If all retries failed, fail early
        if (!phoneBypassSuccess) {
          console.log(`[6.1] ❌ Hết retry, tài khoản yêu cầu xác minh số điện thoại.`);
          throw new Error("NEED_PHONE: Tài khoản yêu cầu xác minh số điện thoại");
        }
      }
    }

    // Thao tác các bước cuối
    console.log(`[6] Hoàn tất và bỏ qua form khảo sát...`);
    await evalJson(tabId, USER_ID, `
      (() => {
        const skipElements = Array.from(document.querySelectorAll('button, a, div[role="button"]'));
        const skipBtn = skipElements.find(b => {
            const txt = b.textContent.toLowerCase().trim();
            return txt === 'skip' || txt === 'bỏ qua' || txt === 'skip for now' || txt === 'maybe later' || txt === 'not now';
        });
        
        if (skipBtn) {
            skipBtn.click();
        } else {
            const personalUse = skipElements.find(e => {
                const txt = e.textContent.toLowerCase();
                return txt.includes('personal') || txt.includes('cá nhân') || txt.includes('other') || txt.includes('khác');
            });
            if (personalUse) personalUse.click();
            
            setTimeout(() => {
                const nextBtn = Array.from(document.querySelectorAll('button')).find(b => {
                    const txt = b.textContent.toLowerCase();
                    return txt.includes('next') || txt.includes('tiếp theo') || txt.includes('continue');
                });
                if (nextBtn) nextBtn.click();
            }, 800);
        }
      })()
    `);
    await new Promise(r => setTimeout(r, 6000));
    // Phase 4, Step 2: Survey skipped
    await recorder.after(4, 2, 'survey_skipped');

    // Thao tác đóng Welcome Modal (OK, let's go)
    console.log(`[6.1] Đóng Welcome Modal...`);
    await evalJson(tabId, USER_ID, `
      (() => {
        let retryCount = 0;
        const maxRetries = ${CONFIG.welcomeModalMaxRetries};
        const findAndClickOk = () => {
            if (retryCount >= maxRetries) return false;
            retryCount++;
            
            const buttons = Array.from(document.querySelectorAll('button'));
            const okBtn = buttons.find(b => {
                const t = b.textContent.toLowerCase();
                return t.includes('ok') || t.includes('tiến hành') || t.includes('let') || t.includes('xong') || t.includes('done') || t.includes('continue') || t.includes('tiếp tục');
            });
            if (okBtn) {
                okBtn.click();
                return true;
            }
            return false;
        };
        
        if (!findAndClickOk()) {
            setTimeout(findAndClickOk, 2000);
        }
        return { attempts: retryCount, found: retryCount <= maxRetries };
      })()
    `);
    await new Promise(r => setTimeout(r, 4000));

    // Verify success home reached
    console.log(`[5] Kiểm tra trang chủ ChatGPT...`);
    const homeCheck = await evalJson(tabId, USER_ID, `(() => {
      const url = location.href;
      const isChatgpt = url.includes('chatgpt.com') && !url.includes('auth/login') && !url.includes('accounts.google');
      const hasNav = !!document.querySelector('nav, [data-testid="navigation"], [data-testid="profile-button"], main');
      return { ok: isChatgpt && hasNav, url };
    })()`).catch(() => ({ ok: false, url: '' }));

    console.log(`[5] Home check result:`, JSON.stringify(homeCheck));
    if (!homeCheck || !homeCheck.ok) {
      throw new Error(`[SuccessDetection] Giao diện trang chủ ChatGPT không được phát hiện. URL hiện tại: ${homeCheck?.url || '?'}`);
    }

    // Phase 5, Step 1: Inside chat home (survey dismissed, welcome closed)
    await recorder.checkpoint(5, 1, 'home_reached');

    // 7. SETUP 2FA (MFA) - dùng UI Automation thay vì API cũ (404)
    console.log(`==========================================`);
    console.log(`[7] BẬT BẢO MẬT 2FA / MFA CHO ACCOUNT NÀY...`);
    console.log(`==========================================`);

    // Domain guard trước khi setupMFA — tránh chạy trên trang lạ (Google/Apple/MS)
    let mfaResult;
    try {
      await assertOnExpectedDomain(tabId, USER_ID, 'before-mfa-setup');
      mfaResult = await setupMFA(tabId, USER_ID, camofoxPostWithSessionKey, { stepRecorder: recorder });

      // Retry MFA setup if toggle not found (max CONFIG.mfaMaxRetries retries)
      if (!mfaResult.success && mfaResult.error?.includes('not found')) {
        console.log(`[7] ⚠️ Toggle not found, retry MFA setup...`);
        for (let retry = 1; retry <= CONFIG.mfaMaxRetries; retry++) {
          console.log(`[7] MFA retry ${retry}: Navigate về Security page...`);
          await evalJson(tabId, USER_ID, `window.location.hash = '#settings/Security'`).catch(() => {});
          await new Promise(r => setTimeout(r, 3000));
          
          const retryResult = await setupMFA(tabId, USER_ID, camofoxPostWithSessionKey, { stepRecorder: recorder });
          if (retryResult.success) {
            console.log(`[7] ✅ MFA retry ${retry} thành công!`);
            mfaResult = retryResult;
            break;
          } else {
            console.log(`[7] MFA retry ${retry} failed: ${retryResult.error}`);
          }
        }
      }
    } catch (driftErr) {
      // Drift đã xảy ra → log rõ ràng và bỏ qua MFA, không hang
      console.log(`[7] ⚠️ ${driftErr.message} → BỎ QUA setup 2FA, tiếp tục lưu account.`);
      mfaResult = { success: false, secret: null, totp: null, error: driftErr.message };
    }
    let twoFaSecret = null;

    if (mfaResult.success) {
      twoFaSecret = mfaResult.secret;
      console.log(`[7.1] 🟢 Bật 2FA Thành Công! Secret: ${twoFaSecret}`);
    } else {
      console.log(`[7.1] 🔴 Lỗi MFA: ${mfaResult.error || 'Unknown'}. Account vẫn hoạt động bình thường.`);
    }

    // 7.2. Double-Check & Self-Healing 2FA (Kiểm tra chắc chắn 2FA đã được bật thực tế trên DOM)
    console.log(`[7.2] 🔍 Đang tiến hành Double-Check trạng thái 2FA trên giao diện DOM...`);
    try {
      // Navigate về trang Security để check DOM ổn định
      await evalJson(tabId, USER_ID, `window.location.hash = '#settings/Security'`).catch(() => {});
      await new Promise(r => setTimeout(r, 4000));

      const is2FaEnabledActual = await evalJson(tabId, USER_ID, `
        (() => {
          const elements = Array.from(document.querySelectorAll('*'));
          const authTextEl = elements.find(el => {
            const text = el.textContent || '';
            if (!/authenticator\\s+app/i.test(text) && !/authenticator/i.test(text)) return false;
            return !Array.from(el.children).some(child => /authenticator/i.test(child.textContent || ''));
          });
          if (authTextEl) {
            let par = authTextEl;
            for (let d = 0; d < 8; d++) {
              if (!par) break;
              const sw = par.querySelector('button[role="switch"], [role="switch"], input[type="checkbox"]');
              if (sw) {
                return sw.getAttribute('aria-checked') === 'true' || sw.checked === true;
              }
              par = par.parentElement;
            }
          }
          return false;
        })()
      `).catch(() => false);

      if (is2FaEnabledActual) {
        console.log(`[7.2] ✅ XÁC NHẬN CHẮC CHẮN: Kiểm tra DOM thực tế cho thấy 2FA đã kích hoạt hoạt động tốt!`);
      } else {
        console.log(`[7.2] ⚠️ CẢNH BÁO: Phát hiện 2FA thực tế CHƯA BẬT (hoặc bật bị hụt)! Bắt đầu Self-Healing kích hoạt lại...`);
        // Tiến hành chạy setupMFA một lần nữa để khắc phục
        const healResult = await setupMFA(tabId, USER_ID, camofoxPostWithSessionKey, { stepRecorder: recorder });
        if (healResult.success) {
          twoFaSecret = healResult.secret;
          mfaResult = healResult;
          console.log(`[7.2] 🟢 Self-Healing thành công! 2FA đã được kích hoạt lại. Secret: ${twoFaSecret}`);
        } else {
          console.log(`[7.2] 🔴 Self-Healing kích hoạt lại thất bại: ${healResult.error || 'Unknown'}`);
        }
      }
    } catch (checkErr) {
      console.warn(`[7.2] ⚠️ Gặp lỗi khi chạy Double-Check 2FA: ${checkErr.message}`);
    }

    // 7.5. Codex OAuth flow (if enabled)
    let codexRefreshToken = null;
    if (enableOAuth) {
      console.log(`==========================================`);
      console.log(`[7.5] CODEX OAUTH FLOW...`);
      console.log(`==========================================`);
      
      const oauthResult = await performCodexOAuth(tabId, USER_ID, proxyUrl, recorder, {
        email,
        password: chatGptPassword,
        mfaSecret: twoFaSecret,
      }, userAgent);
      if (oauthResult.success && oauthResult.tokens) {
        codexRefreshToken = oauthResult.tokens.refresh_token || null;
        console.log(`[7.5] 🟢 Codex OAuth thành công! Refresh token: ${codexRefreshToken ? 'YES' : 'NO'}`);
        // OAuth Phase 2, Step 1: OAuth success
        await recorder.after(2, 1, 'oauth_success');
      } else {
        oauthError = oauthResult.error || 'Unknown';
        console.log(`[7.5] 🔴 Codex OAuth thất bại: ${oauthError}. Account vẫn được lưu với session token.`);
        if (oauthError === 'NEED_PHONE') {
          phoneBypassAttempted = true;
          phoneBypassSuccess = false;
        }
        // OAuth Phase 2, Step 1: OAuth failed
        await recorder.error(2, 1, 'oauth_failed');
        // Graceful fallback - continue with session token
      }
    }

    // 8. TỔNG KẾT
    const tokens = await getCookies(tabId, USER_ID);
    const sessionToken = tokens.find(t => t.name === '__Secure-next-auth.session-token')?.value || null;

    // Session token validation
    if (!sessionToken) {
      console.log(`[8] 🔴 Báo lỗi: Không tìm thấy session token.`);
      console.log(`[8] Cookies: ${tokens.length} total, names: ${tokens.map(c => c.name).join(', ')}`);
      
      // Try fallback tokens
      const fallbackToken = tokens.find(t => t.name === 'oai-client-auth-session')?.value ||
                           tokens.find(t => t.name === 'oai-client-auth-info')?.value || null;
      if (fallbackToken) {
        console.log(`[8] ⚠️ Using fallback token: ${fallbackToken.slice(0, 20)}...`);
      } else {
        throw new Error('Registration failed (No Auth session). Check screenshots.');
      }
    } else if (sessionToken.length < 20) {
      console.log(`[8] ⚠️ Session token quá ngắn (${sessionToken.length} chars), có thể invalid.`);
    }

    console.log(`==========================================`);
    console.log(`✅ ĐĂNG KÝ HOÀN TẤT THÀNH CÔNG: ${email}`);
    console.log(`🔑 Secret 2FA (MFA): ${twoFaSecret || 'None'}`);
    console.log(`🔑 Mật khẩu ChatGPT: ${chatGptPassword}`);
    if (codexRefreshToken) {
      console.log(`🔑 Codex Refresh Token: ${codexRefreshToken.slice(0, 20)}...`);
    }
    console.log(`==========================================`);

    let accountId = null;
    let sessionData = null;
    let deviceId = '';
    
    // Đảm bảo trình duyệt điều hướng về trang chủ và ổn định trước khi capture session
    try {
      console.log(`[Capture] 🔄 Đưa trình duyệt về trang chủ https://chatgpt.com để ổn định session...`);
      await evalJson(tabId, USER_ID, `window.location.hash = ''`).catch(() => {});
      await new Promise(r => setTimeout(r, 4000));
    } catch (navErr) {
      console.log(`[Capture] ⚠️ Không thể điều hướng về trang chủ: ${navErr.message}`);
    }

    // Vòng lặp retry 5 lần để đảm bảo lấy được session metadata ổn định
    for (let attempt = 0; attempt < 5; attempt++) {
      console.log(`[Capture] 🔄 Thử lấy session metadata từ browser (Lần thử ${attempt + 1}/5)...`);
      
      try {
        const checkState = await getState(tabId, USER_ID).catch(() => null);
        if (checkState?.hasPasskeyEnrollScreen) {
          console.log(`[Capture] 🔑 Passkey enrollment screen detected during capture. Dismissing...`);
          await tryDismissPasskeyEnrollment(tabId, USER_ID);
          await new Promise(r => setTimeout(r, 2000));
        }
      } catch (checkErr) {
        console.log(`[Capture] ⚠️ Check/dismiss passkey error: ${checkErr.message}`);
      }
      
      if (attempt === 1) {
        console.log(`[Capture] 🔄 Reloading chatgpt.com to refresh session...`);
        try {
          await evalJson(tabId, USER_ID, `window.location.reload()`).catch(() => {});
          await new Promise(r => setTimeout(r, 3000));
        } catch (reloadErr) {
          console.log(`[Capture] ⚠️ Reload failed: ${reloadErr.message}`);
        }
      }

      try {
        const sessionRes = await evalJson(tabId, USER_ID, `
          (async () => {
            try {
              const r = await fetch('https://chatgpt.com/api/auth/session', {
                credentials: 'include',
                headers: { 'Accept': 'application/json' },
              });
              return r.ok ? r.json() : null;
            } catch (e) {
              return null;
            }
          })()
        `);
        
        if (sessionRes && typeof sessionRes === 'object' && sessionRes.user) {
          sessionData = sessionRes;
          deviceId = tokens.find(c => c.name === 'oai-did')?.value || '';
          console.log(`[Capture] 👤 Lấy session thành công qua browser context (UserId: ${sessionData?.user?.id || 'n/a'}, Plan: ${sessionData?.account?.planType || 'n/a'})`);
          break;
        } else {
          console.log(`[Capture] ⚠️ Lần thử ${attempt + 1} chưa lấy được session data (định dạng rỗng hoặc null)`);
        }
      } catch (err) {
        console.warn(`[Capture] ⚠️ Lỗi trong lúc fetch session ở tab: ${err.message}`);
      }

      await new Promise(r => setTimeout(r, [1500, 2000, 3000, 4000, 5000][attempt]));
    }

    // 🌐 FALLBACK: Node-based HTTP probing method if browser-side fetch fails
    if (!sessionData) {
      console.log(`[Capture] 🌐 Browser-side fetch failed/empty. Chạy Node-based HTTP fallback...`);
      try {
        const cookieString = tokens.map(c => `${c.name}=${c.value}`).join('; ');
        const nodeRes = await requestViaCurlCffi({
          method: 'GET',
          url: 'https://chatgpt.com/api/auth/session',
          headers: {
            'Cookie': cookieString,
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            'Accept': 'application/json',
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer': 'https://chatgpt.com/',
          },
          proxyUrl: proxyUrl || null,
          timeoutMs: 15000,
        });

        if (nodeRes.status === 200) {
          const nodeData = JSON.parse(nodeRes.body);
          if (nodeData && typeof nodeData === 'object' && nodeData.user) {
            sessionData = nodeData;
            deviceId = tokens.find(c => c.name === 'oai-did')?.value || '';
            console.log(`[Capture] 👤 Node-based HTTP fallback THÀNH CÔNG! (UserId: ${sessionData?.user?.id || 'n/a'}, Plan: ${sessionData?.account?.planType || 'n/a'})`);
          }
        } else {
          console.log(`[Capture] ⚠️ Node-based fallback HTTP error: ${nodeRes.status}`);
        }
      } catch (nodeErr) {
        console.log(`[Capture] ⚠️ Node-based fallback thất bại: ${nodeErr.message}`);
      }
    }

    if (!sessionData) {
      console.log(`[Capture] ❌ Thất bại hoàn toàn khi lấy session metadata (cả browser và Node fallback)`);
    }

    // Lưu vào kho account (status=idle, chờ Deploy - KHÔNG phải sẽ được deploy ngay)
    const accRes = await fetch(`http://localhost:4000/api/vault/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        password: chatGptPassword,
        two_fa_secret: twoFaSecret || '',
        provider: 'openai',
        status: twoFaSecret ? 'idle' : 'mfa_pending',
        skipSync: true,
        restore_deleted: true,
        cookies: tokens,
        proxy_url: proxyUrl || null,
        tags: JSON.stringify([
          'auto-register',
          'vault-register',
          ...(!twoFaSecret ? ['mfa-pending'] : []),
          ...(phoneBypassAttempted ? ['phone-verify'] : []),
          ...(phoneBypassSuccess ? ['phone-bypass-ok'] : []),
          ...(codexRefreshToken ? ['codex-oauth'] : []),
          ...(oauthError ? ['oauth-failed'] : [])
        ]),
        notes: `[Auto-Register] Email Pool: ${email} | MS Pass: ${emailPassword} | ChatGPT Pass: ${chatGptPassword}${twoFaSecret ? ` | 2FA: ${twoFaSecret}` : ''}${phoneBypassAttempted ? ` | Phone Verify: ${phoneBypassSuccess ? 'Bypass OK' : 'Bypass Failed'}` : ''}${codexRefreshToken ? ` | Codex RT: ${codexRefreshToken.slice(0, 30)}...` : ''}${oauthError ? ` | OAuth Error: ${oauthError}` : ''} | Tạo: ${new Date().toISOString()}`,
        plan: sessionData?.account?.planType || 'free',
        workspace_id: sessionData?.account?.id || null,
        device_id: deviceId || null,
        providerSpecificData: {
          sessionData,
          chatgptUserId: sessionData?.user?.id || null,
          proxyUrl: proxyUrl || null,
        }
      }),
    });
    const accData = await accRes.json();

    // Cập nhật pool status
    await updatePoolStatus(email, {
      chatgpt_status: 'done',
      mail_status: 'active',
      linked_chatgpt_id: accData.id,
      notes: `Thành công | PID: ${process.pid} | Acc ID: ${accData.id}`
    });

        runSuccess = true;
        return {
          success: true, email, password: chatGptPassword, twoFaSecret, sessionToken, createdAt: new Date().toISOString()
        };
      } catch (err) {
        const msg = String(err.message || err || '').toLowerCase();
        const isRetriable = (
          msg.includes('browser_restarted') ||
          msg.includes('session_expired') ||
          msg.includes('tab no longer exists') ||
          msg.includes('browser was restarted') ||
          msg.includes('browser session expired') ||
          msg.includes('target page, context or browser has been closed') ||
          msg.includes('context closed') ||
          msg.includes('browser closed') ||
          msg.includes('net_timeout') ||
          msg.includes('aborted due to timeout')
        );
        
        if (isRetriable && attempt < maxAttempts) {
          console.warn(`\n⚠️ [Register] Phát hiện lỗi liên quan đến trình duyệt/session ở lượt thử ${attempt}/${maxAttempts}: ${err.message}. Sẽ khởi động lại tab mới và thử lại sau 5 giây...`);
          if (tabId) {
            console.log(`[Register] 🧹 Đóng tab cũ: ${tabId}`);
            await camofoxDelete(`/tabs/${tabId}?userId=${USER_ID}`, { timeoutMs: 5000 }).catch(() => {});
            tabId = null;
          }
          await new Promise(r => setTimeout(r, 5000));
          continue;
        }
        throw err;
      } finally {
        if (tabId && !runSuccess && attempt < maxAttempts) {
          console.log(`[Register] 🧹 Đóng tab của lượt thử thất bại...`);
          await camofoxDelete(`/tabs/${tabId}?userId=${USER_ID}`, { timeoutMs: 5000 }).catch(() => {});
          tabId = null;
        }
      }
    }

  } catch (err) {
    console.log(`==========================================`);
    console.log(`🔴 THẤT BẠI: ${email}`);
    console.log(`❌ Lỗi: ${err.message}`);
    
    // Enhanced error logging
    try {
      if (tabId) {
        // Capture screenshot on error
        if (recorder) {
          await recorder.after(9, 9, 'error_occurred').catch(() => {});
        }
        const currentUrl = await evalJson(tabId, USER_ID, `location.href`).catch(() => 'unknown');
        console.log(`[Error] Current URL: ${currentUrl}`);
        
        const pageState = await evalJson(tabId, USER_ID, `
          (() => {
            const hasEmailInput = !!document.querySelector('input[type="email"], input[name="email"]');
            const hasPasswordInput = !!document.querySelector('input[type="password"], input[name="password"]');
            const hasOtpInput = !!document.querySelector('input[autocomplete="one-time-code"], input[inputmode="numeric"], input[name="code"]');
            const bodyText = (document.body?.innerText || '').slice(0, 200);
            return { hasEmailInput, hasPasswordInput, hasOtpInput, bodyText };
          })()
        `).catch(() => ({ error: 'page-state-failed' }));
        console.log(`[Error] Page state:`, JSON.stringify(pageState));
        
        // Log latest screenshot filename
        const screenshots = await fs.readdir(runDir).catch(() => []);
        if (screenshots.length > 0) {
          const latestScreenshot = screenshots.sort().pop();
          console.log(`[Error] Latest screenshot: ${latestScreenshot}`);
        }
      }
    } catch (logErr) {
      console.log(`[Error] Failed to log enhanced error info: ${logErr.message}`);
    }
    
    console.log(`[Error] Stack trace:`, err.stack);
    console.log(`==========================================`);

    // Update pool status to failed
    await updatePoolStatus(email, {
      chatgpt_status: 'failed',
      notes: `Error: ${err.message} at ${new Date().toISOString()}`
    });

    return { success: false, email, error: err.message || String(err) };
  } finally {
    if (tabId) {
      console.log(`🧹 [Cleanup] Đóng tab Camofox ${tabId} cho ${email}...`);
      await camofoxDelete(`/tabs/${tabId}?userId=${USER_ID}`, { timeoutMs: 5000 }).catch(() => { });
    }
  }
}

// Nếu chạy từ Command Line
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const input = process.argv[2];
  if (!input) {
    console.error("Usage: node auto-register-worker.js <email|pass|ref_token|cli_id>");
    process.exit(1);
  }
  runAutoRegister(input).then((res) => {
    if (res?.success) {
      console.log(`\n🎉 HOÀN TẤT: ${res.email}`);
      process.exit(0);
    } else {
      console.error(`\n❌ THẤT BẠI: ${res?.error || 'Unknown error'}`);
      process.exit(1);
    }
  }).catch((err) => {
    console.error(`\n❌ THẤT BẠI: ${err?.message || String(err)}`);
    process.exit(1);
  });
}
