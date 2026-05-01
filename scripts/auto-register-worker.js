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
import { CAMOUFOX_API, GATEWAY_URL, WORKER_AUTH_TOKEN, TOOLS_API_URL } from './config.js';
import { camofoxPost, camofoxGet, camofoxDelete, evalJson, navigate, waitForSelector, pressKey } from './lib/camofox.js';
import { getTOTP, getFreshTOTP } from './lib/totp.js';
import { extractIpFromText, normalizeProxyUrl, getLocalPublicIp, probeProxyExitIp, assertProxyApplied, isLocalRelayProxy } from './lib/proxy-diag.js';
import { createSaveStep } from './lib/screenshot.js';
import { waitForOTPCode } from './lib/ms-graph-email.js';
import { firstNames, lastNames } from './lib/names.js';
import { setupMFA } from './lib/mfa-setup.js';
import { generatePKCE, buildOAuthURL, exchangeCodeForTokens, CODEX_CONSENT_URL, decodeAuthSessionCookie, extractWorkspaceId, performWorkspaceConsentBypass } from './lib/openai-oauth.js';
import { getState, fillEmail, fillPassword, fillMfa } from './lib/openai-login-flow.js';

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

async function performCodexOAuth(tabId, userId, proxyUrl, saveStep, creds = {}) {
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
  await saveStep('oauth_start');

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
      await saveStep('oauth_phone_bypass_attempt');
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
      await saveStep('oauth_email_filled');
      continue;
    }

    if (state?.hasPasswordInput && !passwordFilled && creds.password) {
      console.log(`[OAuth] 🔑 Password input detected, filling`);
      const r = await fillPassword(tabId, userId, creds.password);
      console.log(`[OAuth] fillPassword →`, JSON.stringify(r));
      passwordFilled = true;
      await new Promise(r2 => setTimeout(r2, 4000));
      await saveStep('oauth_password_filled');
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
        await saveStep('oauth_mfa_filled');
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
      await saveStep(`oauth_consent_attempt_${consentAttempts}`);
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
    const tokens = await exchangeCodeForTokens(authCode, pkce, proxyUrl);
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
// Wrapper for camofoxPost that injects sessionKey (auto-register specific)
async function camofoxPostWithSessionKey(endpoint, body, timeoutMs = 30000) {
  const payload = { ...body, sessionKey: WORKER_AUTH_TOKEN };
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
async function retryWithReload(tabId, userId, checkFn, stepName, maxRetries = 2) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const result = await checkFn();
    if (result) return true;

    console.log(`[${stepName}] ⚠️ UI không được nhận diện (lần ${attempt + 1}/${maxRetries + 1})`);

    if (attempt < maxRetries) {
      try {
        console.log(`[${stepName}] 🔄 Reload tab và thử lại...`);
        await camofoxPostWithSessionKey(`/tabs/${tabId}/navigate`, { userId, url: 'https://chatgpt.com/auth/login' });
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
  const chatGptPassword = Array.from({ length: CONFIG.passwordLength }, () => CHARS[Math.floor(Math.random() * CHARS.length)]).join('');

  console.log(`==========================================`);
  console.log(`🚀 [Auto-Register] Bắt đầu đăng ký: ${email}`);
  console.log(`==========================================`);

  const USER_ID = `register_${Date.now()}`;
  console.log(`SESSION_ID: ${USER_ID}`); // Quan trọng để frontend link ảnh chụp
  const runDir = path.join(IMAGES_DIR, USER_ID);
  await fs.mkdir(runDir, { recursive: true }).catch(() => { });

  let tabId = null;
  let saveStep = null;
  let preFlightResult = null;
  let phoneBypassAttempted = false;
  let phoneBypassSuccess = false;

  try {
    // 🔒 [PreFlight] Assert proxy applied BEFORE creating main tab
    if (proxyUrl) {
      console.log(`🔒 [PreFlight] Asserting proxy applied: ${proxyUrl}`);
      try {
        preFlightResult = await assertProxyApplied(proxyUrl);
        console.log(`✅ [PreFlight] OK — Exit IP: ${preFlightResult.exitIp} (${preFlightResult.networkType})${preFlightResult.isLocalRelay ? ' 🔒 LOCAL RELAY' : ''}`);
      } catch (err) {
        console.log(`🛑 [PreFlight] FAILED: ${err.message}`);
        if (CONFIG.proxyStrictMode) {
          throw err;  // hard abort in strict mode
        } else {
          console.log(`⚠️ [PreFlight] Continuing despite proxy failure (strict mode disabled)`);
        }
      }
    }

    // 1. Khởi động - Đi từ trang login để tránh bị blank page
    console.log(`🚀 [Phase 1] Truy cập trang Login...`);
    const tabRes = await camofoxPostWithSessionKey('/tabs', {
      userId: USER_ID,
      url: "https://chatgpt.com/auth/login",
      headless: false,
      humanize: true,
      ...(proxyUrl ? { proxy: proxyUrl } : {})
    });
    console.log(proxyUrl ? `🔌 Dùng proxy: ${proxyUrl}` : '🌐 Không dùng proxy');
    tabId = tabRes.tabId;
    console.log(`Tab ID: ${tabId}`);

    saveStep = createSaveStep(runDir, { tabId, userId: USER_ID });

    await new Promise(r => setTimeout(r, 5000));

    // 🔍 [PostVerify] Re-probe to confirm session inherited proxy
    if (proxyUrl && preFlightResult) {
      console.log(`🔍 [PostVerify] Verifying proxy applied after tab creation...`);
      const verifyCheck = await probeProxyExitIp(USER_ID, proxyUrl, true);  // reuse session
      if (!verifyCheck?.ip) {
        throw new Error(`[PostVerify] Không probe được sau khi tạo tab: ${verifyCheck?.error}`);
      }
      if (verifyCheck.ip !== preFlightResult.exitIp) {
        // For backconnect/rotating proxies this MAY be expected; for static proxies it indicates session leak
        console.log(`⚠️ [PostVerify] Exit IP changed: pre=${preFlightResult.exitIp} → post=${verifyCheck.ip} (rotating proxy?)`);
        // For local relay or static proxies, this is suspicious → warn but don't abort
      } else {
        console.log(`✅ [PostVerify] Exit IP consistent: ${verifyCheck.ip}`);
      }
    }

    await saveStep('01_login_page');

    // Domain guard — đảm bảo đang ở chatgpt.com/auth.openai.com
    await assertOnExpectedDomain(tabId, USER_ID, 'after-load-login');

    // Click "Sign up" — chỉ cần thiết với UI cũ. UI mới (unified "Log in or sign up")
    // đã có email input ngay → bỏ qua bước này tránh click nhầm.
    console.log(`🖱️  Chuyển sang luồng Đăng ký...`);
    const urlBeforeSignup = await evalJson(tabId, USER_ID, `location.href`);
    const signupClickResult = await evalJson(tabId, USER_ID, `(() => {
      // Nếu UI mới đã có email input → KHÔNG cần click Sign up
      const hasEmailInput = !!document.querySelector(
        'input[type="email"], input[name="email"], input[name="identifier"], input[autocomplete="email"]'
      );
      if (hasEmailInput) return { skipped: true, reason: 'unified-ui-email-input-present' };

      const isVisible = el => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const elements = Array.from(document.querySelectorAll('a, button, div[role="button"]')).filter(isVisible);
      const signup = elements.find(l => {
        const t = (l.innerText || l.textContent || '').toLowerCase().trim();
        return t === 'sign up' || t === 'sign up for free' || (t.startsWith('sign up') && !t.includes(' or '));
      });
      if (signup) {
        // Dispatch event native để qua mặt React pointer-events: none (nếu có)
        signup.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
        signup.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
        signup.click();
        return { clicked: true, text: signup.innerText.trim(), tag: signup.tagName };
      }
      return { skipped: true, reason: 'no-signup-button-found' };
    })()`);
    console.log(`[Sign-up step] →`, JSON.stringify(signupClickResult || {}));

    // Nếu không tìm thấy nút Sign up (ví dụ bị ẩn hoặc UI mới), thử click nút "Sign up for free" bằng data-testid
    if (signupClickResult?.skipped && signupClickResult.reason === 'no-signup-button-found') {
      console.log(`[Sign-up step] ⚠️ Không tìm thấy nút Đăng ký text-based, thử click bằng data-testid...`);
      const dataTestidClick = await evalJson(tabId, USER_ID, `
        (() => {
          const btn = document.querySelector('button[data-testid="signup-button"]');
          if (btn) {
            btn.click();
            return { clicked: true, method: 'data-testid' };
          }
          return { clicked: false, error: 'no-signup-button-by-testid' };
        })()
      `, 5000);
      console.log(`[Sign-up step] data-testid click →`, JSON.stringify(dataTestidClick));

      if (!dataTestidClick?.clicked) {
        console.log(`[Sign-up step] ⚠️ Không tìm thấy nút signup, thử navigate với action=signup...`);
        try {
          await camofoxPostWithSessionKey(`/tabs/${tabId}/navigate`, { userId: USER_ID, url: 'https://chatgpt.com/auth/login?action=signup' });
          await new Promise(r => setTimeout(r, 5000));
        } catch (e) {
          const msg = e?.message || String(e);
          if (msg.includes('NS_BINDING_ABORTED')) {
            console.log(`[Sign-up step] navigate bị abort — có thể browser đang tự chuyển trang, tiếp tục chờ...`);
          } else {
            throw e;
          }
        }
      } else {
        await new Promise(r => setTimeout(r, 4000));
      }
    } else if (signupClickResult?.clicked) {
      const signupUrlChanged = await waitForUrlChange(tabId, USER_ID, urlBeforeSignup, { timeoutMs: 8000, intervalMs: 500 });
      const emailInputCheck = await evalJson(tabId, USER_ID, `!!document.querySelector('input[type="email"], input[name="email"], input[name="identifier"], input[autocomplete="email"]')`);
      if (!emailInputCheck) {
        if (signupUrlChanged) {
          console.log(`[Sign-up step] URL đã đổi sang ${signupUrlChanged} nhưng ô Email chưa sẵn sàng, chờ thêm...`);
          await new Promise(r => setTimeout(r, 3000));
        } else {
          console.log(`[Sign-up step] ⚠️ Click không làm đổi URL, thử click bằng data-testid...`);
          const dataTestidClick = await evalJson(tabId, USER_ID, `
            (() => {
              const btn = document.querySelector('button[data-testid="signup-button"]');
              if (btn) {
                btn.click();
                return { clicked: true, method: 'data-testid' };
              }
              return { clicked: false, error: 'no-signup-button-by-testid' };
            })()
          `, 5000);
          if (dataTestidClick?.clicked) {
            await new Promise(r => setTimeout(r, 4000));
          }
        }
      }
    }

    // Chờ ô email input xuất hiện (tối đa CONFIG.emailInputTimeout) — tránh race condition khi trang auth load chậm
    // Dynamic timeout: CONFIG.emailInputTimeout default, CONFIG.emailInputTimeoutWithProxy nếu dùng proxy
    const emailInputTimeout = proxyUrl ? CONFIG.emailInputTimeoutWithProxy : CONFIG.emailInputTimeout;
    const emailInputMaxAttempts = Math.floor(emailInputTimeout / 1.5); // 1.5s per attempt
    console.log(`[Sign-up step] Email input timeout: ${emailInputTimeout}s (${emailInputMaxAttempts} attempts)`);
    
    let emailInputReady = false;
    for (let attempt = 0; attempt < emailInputMaxAttempts; attempt++) {
      const check = await evalJson(tabId, USER_ID, `!!document.querySelector('input[type="email"], input[name="email"], input[name="identifier"], input[autocomplete="email"]')`);
      if (check) { emailInputReady = true; break; }
      await new Promise(r => setTimeout(r, 1500));
    }

    // Nếu email input không xuất hiện, retry với reload
    if (!emailInputReady) {
      console.log(`[Sign-up step] ❌ Sau ${emailInputTimeout}s vẫn không thấy ô nhập Email. URL: ${await evalJson(tabId, USER_ID, 'location.href')}`);
      const retrySuccess = await retryWithReload(tabId, USER_ID, async () => {
        return await evalJson(tabId, USER_ID, `!!document.querySelector('input[type="email"], input[name="email"], input[name="identifier"], input[autocomplete="email"]')`);
      }, 'EmailInputRetry', CONFIG.reloadMaxRetries);
      if (retrySuccess) {
        emailInputReady = true;
        await new Promise(r => setTimeout(r, 3000));
      } else {
        throw new Error('Email input không xuất hiện sau retry với reload');
      }
    }

    await new Promise(r => setTimeout(r, 5000));
    await saveStep('02_register_page');
    await assertOnExpectedDomain(tabId, USER_ID, 'after-signup-click');

    // 2. Điền Email & Submit — selector ưu tiên submit-button-trong-form,
    //    LOẠI BỎ tuyệt đối các nút "Continue with Google/Apple/Microsoft/phone".
    console.log(`📝 [Phase 2] Đang điền Email: ${email}...`);
    const urlBeforeEmail = await evalJson(tabId, USER_ID, `location.href`);
    const emailClickInfo = await evalJson(tabId, USER_ID, `
      (() => {
        const typeReact = (input, text) => {
          if (!input) return false;
          const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          nativeSetter.call(input, text);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        };
        const isVisible = el => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };

        const emailInput = document.querySelector(
          'input[type="email"], input[name="email"], input[name="identifier"], input[autocomplete="email"]'
        );
        if (!emailInput) return { error: 'no-email-input' };
        typeReact(emailInput, "${email}");

        // Strategy 1: Submit button trong cùng form với email input (chính xác nhất)
        const form = emailInput.closest('form');
        let btn = null;
        let strategy = '';
        if (form) {
          btn = form.querySelector('button[type="submit"]');
          if (btn) strategy = 'form-submit';
          if (!btn) {
            // Submit button trong form mà KHÔNG chứa "with" (loại OAuth)
            btn = Array.from(form.querySelectorAll('button')).find(b => {
              const t = (b.innerText || b.textContent || '').trim().toLowerCase();
              return isVisible(b) && !t.includes('with') && (t === 'continue' || t === 'tiếp tục' || t.includes('continue') || t.includes('next'));
            });
            if (btn) strategy = 'form-text-no-with';
          }
        }
        // Strategy 2: Toàn page — exact text match, exclude "with"
        if (!btn) {
          btn = Array.from(document.querySelectorAll('button')).find(b => {
            const t = (b.innerText || b.textContent || '').trim();
            const tl = t.toLowerCase();
            return isVisible(b) && !tl.includes('with') && (t === 'Continue' || t === 'Tiếp tục' || tl === 'continue');
          });
          if (btn) strategy = 'global-exact-no-with';
        }

        if (!btn) {
          // Liệt kê các nút có sẵn để debug
          const all = Array.from(document.querySelectorAll('button')).filter(isVisible).map(b => (b.innerText || b.textContent || '').trim()).slice(0, 12);
          return { error: 'no-continue-button', available: all };
        }
        // GUARD: tuyệt đối từ chối nếu nút chứa "with" (Continue with Google/Apple/MS)
        const finalText = (btn.innerText || btn.textContent || '').trim();
        if (finalText.toLowerCase().includes('with')) {
          return { error: 'rejected-oauth-button', text: finalText };
        }
        btn.click();
        return { ok: true, strategy, text: finalText };
      })()
    `);
    console.log(`[Email-submit] →`, JSON.stringify(emailClickInfo || {}));
    if (emailClickInfo?.error) {
      throw new Error(`Email submit failed: ${emailClickInfo.error} (${JSON.stringify(emailClickInfo)})`);
    }

    // Đợi nhảy sang trang sau khi submit email — detect flow
    console.log("⏳ Chờ OpenAI xử lý Email và chuyển trang...");
    const newUrl = await waitForUrlChange(tabId, USER_ID, urlBeforeEmail, { timeoutMs: 12000 });
    if (!newUrl) {
      console.log(`[Email-submit] ⚠️ URL không đổi sau click — có thể click không hiệu lực`);
    }
    await assertOnExpectedDomain(tabId, USER_ID, 'after-email-submit');
    await saveStep('02_after_email_submit');

    // Detect flow sau khi submit email
    await new Promise(r => setTimeout(r, 3000));
    const flowDetection = await evalJson(tabId, USER_ID, `
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

    // If flow detection returns unknown, retry with reload
    if (flowDetection?.flow === 'unknown') {
      console.log(`[Flow Detection] ⚠️ Flow unknown, retry with reload...`);
      const retrySuccess = await retryWithReload(tabId, USER_ID, async () => {
        const detection = await evalJson(tabId, USER_ID, `
          (() => {
            const url = location.href;
            const body = document.body?.innerText?.toLowerCase() || '';
            const hasPasswordInput = !!document.querySelector('input[type="password"], input[name="password"], input[name="new-password"]');
            const hasEmailVerificationLink = !!document.querySelector('a[href*="create-account/password"]');
            const hasCodeInput = !!document.querySelector('input[name="code"], input[autocomplete="one-time-code"]');
            const isEmailVerification = url.includes('email-verification') || body.includes('check your inbox') || body.includes('verification code');
            const flow = hasEmailVerificationLink || isEmailVerification ? 'new' : (hasPasswordInput ? 'old' : 'unknown');
            return { flow };
          })()
        `);
        return detection?.flow !== 'unknown';
      }, 'FlowDetectionRetry', CONFIG.reloadMaxRetries);
      
      if (retrySuccess) {
        // Re-run flow detection after successful retry
        await new Promise(r => setTimeout(r, 3000));
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
        console.log(`[Flow Detection] After retry:`, JSON.stringify(flowDetection));
      }
    }

    // 3. Điền mật khẩu (flow cũ có password input sẵn, flow mới cần click link trước)
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
      await saveStep('03_continue_with_password_clicked');
    }

    // Điền password (cả 2 flow đều cần)
    const hasPwdInput = await evalJson(tabId, USER_ID, `!!document.querySelector('input[type="password"], input[name="password"], input[name="new-password"]')`);
    if (hasPwdInput) {
      console.log(`[3] Điền Password -> ${chatGptPassword}`);
      const urlBeforePwd = await evalJson(tabId, USER_ID, `location.href`);
      const pwdClickInfo = await evalJson(tabId, USER_ID, `
            (() => {
              const typeReact = (input, text) => {
                if (!input) return false;
                const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                nativeSetter.call(input, text);
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
                return true;
              };
              const isVisible = el => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };

              const pwdInput = document.querySelector('input[name="new-password"], input[name="password"], input[type="password"]');
              if (!pwdInput) return { error: 'no-password-input' };
              typeReact(pwdInput, "${chatGptPassword}");

              const form = pwdInput.closest('form');
              let btn = null;
              let strategy = '';
              if (form) {
                btn = form.querySelector('button[type="submit"]');
                if (btn) strategy = 'form-submit';
                if (!btn) {
                  btn = Array.from(form.querySelectorAll('button')).find(b => {
                    const t = (b.innerText || b.textContent || '').toLowerCase().trim();
                    return isVisible(b) && !t.includes('with') &&
                      (t.includes('continue') || t.includes('tiếp tục') || t.includes('create account') || t.includes('next'));
                  });
                  if (btn) strategy = 'form-text-no-with';
                }
              }
              if (!btn) {
                btn = Array.from(document.querySelectorAll('button')).find(b => {
                  const t = (b.innerText || b.textContent || '').toLowerCase().trim();
                  return isVisible(b) && !t.includes('with') &&
                    (t === 'continue' || t === 'tiếp tục' || t === 'create account' || t === 'next');
                });
                if (btn) strategy = 'global-exact-no-with';
              }

              if (!btn) {
                const all = Array.from(document.querySelectorAll('button')).filter(isVisible).map(b => (b.innerText || b.textContent || '').trim()).slice(0, 12);
                return { error: 'no-continue-button', available: all };
              }
              const finalText = (btn.innerText || btn.textContent || '').trim();
              if (finalText.toLowerCase().includes('with')) {
                return { error: 'rejected-oauth-button', text: finalText };
              }
              btn.click();
              return { ok: true, strategy, text: finalText };
            })()
          `);
      console.log(`[Password-submit] →`, JSON.stringify(pwdClickInfo || {}));
      if (pwdClickInfo?.error) {
        throw new Error(`Password submit failed: ${pwdClickInfo.error}`);
      }
      await waitForUrlChange(tabId, USER_ID, urlBeforePwd, { timeoutMs: 8000 });
      await assertOnExpectedDomain(tabId, USER_ID, 'after-password-submit');
      await saveStep('03_after_password_submit');
    }

    // 4. Giải OTP (giống bản gốc - luôn check)
    console.log(`[4] Đang phân tích luồng chờ mã Pin Verify...`);
    const otpScreenCheck = await evalJson(tabId, USER_ID, `
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

    // If OTP screen not detected but expected, retry with reload
    if (!otpScreenCheck.hasOtpInput && !otpScreenCheck.hasVerifyUrl && !otpScreenCheck.hasVerifyText) {
      console.log(`[4] ⚠️ OTP screen not detected, retry with reload...`);
      const retrySuccess = await retryWithReload(tabId, USER_ID, async () => {
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
            return {
              hasOtpInput,
              hasVerifyUrl: url.includes('email-verification') || url.includes('verify'),
              hasVerifyText: body.includes('verify') || body.includes('code') || body.includes('enter code')
            };
          })()
        `);
        return check.hasOtpInput || check.hasVerifyUrl || check.hasVerifyText;
      }, 'OTPScreenRetry', CONFIG.reloadMaxRetries);
      
      if (retrySuccess) {
        // Re-run OTP screen check after successful retry
        await new Promise(r => setTimeout(r, 3000));
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
        console.log(`[4] OTP screen check after retry:`, JSON.stringify(otpScreenCheck));
      }
    }

    if (otpScreenCheck.hasOtpInput || otpScreenCheck.hasVerifyUrl || otpScreenCheck.hasVerifyText) {
      console.log(`[4.1] Đã nhận diện được giao diện nhập mã PIN!`);
      const otpCode = await waitForOTPCode({ email, refreshToken, clientId, senderDomain: 'openai.com', maxWaitSecs: CONFIG.otpWaitTimeout });
      if (!otpCode) throw new Error("Thất bại: Không lấy được mã OTP từ Mail sau 90s.");

      console.log(`[4.2] Nhập mã PIN ${otpCode} lên web...`);
      await evalJson(tabId, USER_ID, `
              (() => {
                 const isVisible = el => el && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0;
                 const setValue = (el, text) => {
                   const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                   nativeSetter.call(el, text);
                   el.dispatchEvent(new Event('input', { bubbles: true }));
                   el.dispatchEvent(new Event('change', { bubbles: true }));
                   el.blur();
                   el.focus();
                 };

                 // Robust input finder - same logic as fillMfa in openai-login-flow.js
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
                 if (!input) return { error: 'no-otp-input', inputCount: document.querySelectorAll('input').length };
                 console.log('[OTP] Found input:', input.name, input.type, input.placeholder, input.maxLength);
                 setValue(input, "${otpCode}");

                 const btn = Array.from(document.querySelectorAll('button')).find(b =>
                    (b.textContent.includes('Continue') || b.textContent.includes('Tiếp tục') || b.textContent.includes('Next') || b.textContent.includes('Verify')) &&
                    !b.textContent.includes('with') && isVisible(b)
                 );
                 if (btn) {
                   console.log('[OTP] Clicking continue button');
                   btn.click();
                 } else {
                   console.log('[OTP] No continue button found, pressing Enter');
                   input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
                 }
                 return { ok: true, inputFound: !!input, buttonFound: !!btn };
              })()
            `);
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

      // Retry OTP entry if still on OTP screen (max CONFIG.otpMaxRetries retries)
      if (otpVerifyCheck.hasOtpInput || otpVerifyCheck.hasVerifyUrl || otpVerifyCheck.hasVerifyText) {
        console.log(`[OTP] ⚠️ Vẫn ở màn hình OTP, retry entry...`);
        for (let retry = 1; retry <= CONFIG.otpMaxRetries; retry++) {
          const otpRetryCode = await waitForOTPCode({ email, refreshToken, clientId, senderDomain: 'openai.com', maxWaitSecs: CONFIG.otpRetryTimeout });
          if (!otpRetryCode) {
            console.log(`[OTP] Retry ${retry}: Không lấy được OTP mới, skip retry`);
            continue;
          }
          console.log(`[OTP] Retry ${retry}: Nhập mã PIN ${otpRetryCode}...`);
          await evalJson(tabId, USER_ID, `
            (() => {
              const isVisible = el => el && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0;
              const setValue = (el, text) => {
                const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                nativeSetter.call(el, text);
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                el.blur();
                el.focus();
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
                setValue(input, "${otpRetryCode}");
                const btn = Array.from(document.querySelectorAll('button')).find(b =>
                  (b.textContent.includes('Continue') || b.textContent.includes('Tiếp tục') || b.textContent.includes('Next') || b.textContent.includes('Verify')) &&
                  !b.textContent.includes('with') && isVisible(b)
                );
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
              const hasOtpInput = !!document.querySelector('input[autocomplete="one-time-code"], input[inputmode="numeric"], input[name="code"], input[maxlength="6"]');
              return { hasOtpInput };
            })()
          `);
          if (!retryCheck.hasOtpInput) {
            console.log(`[OTP] ✅ Retry ${retry} thành công!`);
            break;
          } else {
            console.log(`[OTP] Retry ${retry}: vẫn ở màn hình OTP`);
          }
        }
      }

      await saveStep('04_pin_verified');
    }

    // 5. Cấp User Info (tên, ngày sinh)
    console.log(`[5] Bypass thông tin Form About...`);
    const userInfo = generateRandomUserInfo();
    await new Promise(r => setTimeout(r, 3000)); // đợi form render xong
    await saveStep('04b_before_about');

    const aboutFillInfo = await evalJson(tabId, USER_ID, `
          (() => {
             const typeReact = (el, text) => {
               if (!el) return false;
               const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
               nativeSetter.call(el, text);
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
                 typeReact(nameEl, '${userInfo.name}');
                 filled.name = 'fullname';
             } else {
                 // thử split first/last name
                 const firstName = document.querySelector('input[name="first_name"], input[placeholder*="first" i], input[placeholder*="First" i]');
                 const lastName  = document.querySelector('input[name="last_name"],  input[placeholder*="last" i],  input[placeholder*="Last" i]');
                 const parts = '${userInfo.name}'.split(' ');
                 if (firstName) { typeReact(firstName, parts[0] || ''); filled.name = 'first'; }
                 if (lastName)  { typeReact(lastName,  parts[1] || parts[0]); filled.name = filled.name + '+last'; }
             }

             // Điền ngày sinh / tuổi
            const ageEl = document.querySelector('input[name="age"], input[placeholder="Age"], input[placeholder*="age" i]') ||
                          document.querySelector('input[type="number"]');
            const dobEl = document.querySelector('input[name="birthday"], input[name="dob"], input[type="date"]') ||
                          document.querySelector('input[placeholder*="DD"], input[placeholder*="MM/DD"], input[placeholder*="MM/DD/YYYY"], input[placeholder*="YYYY"]') ||
                          document.querySelector('input[placeholder*="Birthday"], input[placeholder*="Date of birth"]');

            if (ageEl && ageEl.type !== 'date') {
                typeReact(ageEl, '${userInfo.age.toString()}');
                filled.bday = 'age';
            } else if (dobEl) {
                // Nếu input type="date", dùng format YYYY-MM-DD
                if (dobEl.type === 'date') {
                    typeReact(dobEl, '${userInfo.birthdate}');
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
                    typeReact(dobEl, dobStr);
                    filled.bday = 'dob-text';
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
          const dobEl = document.querySelector('input[name="birthday"], input[name="dob"], input[type="date"]') ||
                        document.querySelector('input[placeholder*="DD"], input[placeholder*="MM/DD"], input[placeholder*="MM/DD/YYYY"], input[placeholder*="YYYY"]');
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
            const typeReact = (el, text) => {
              if (!el) return false;
              const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
              nativeSetter.call(el, text);
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              return true;
            };
            const dobEl = document.querySelector('input[name="birthday"], input[name="dob"], input[type="date"]') ||
                          document.querySelector('input[placeholder*="DD"], input[placeholder*="MM/DD"], input[placeholder*="MM/DD/YYYY"], input[placeholder*="YYYY"]');
            if (dobEl && dobEl.type === 'date') {
              typeReact(dobEl, '${userInfo.birthdate}');
            } else if (dobEl) {
              const placeholder = dobEl.placeholder || '';
              let dobStr;
              if (placeholder.startsWith('MM')) {
                dobStr = '${userInfo.birthdate.slice(5, 7)}/${userInfo.birthdate.slice(8, 10)}/${userInfo.birthdate.slice(0, 4)}';
              } else {
                dobStr = '${userInfo.birthdate.slice(8, 10)}/${userInfo.birthdate.slice(5, 7)}/${userInfo.birthdate.slice(0, 4)}';
              }
              typeReact(dobEl, dobStr);
            }
            return { ok: !!dobEl };
          })()
        `);
        await new Promise(r => setTimeout(r, 2000));
        const retryValidation = await evalJson(tabId, USER_ID, `
          (() => {
            const dobEl = document.querySelector('input[name="birthday"], input[name="dob"], input[type="date"]') ||
                          document.querySelector('input[placeholder*="DD"], input[placeholder*="MM/DD"], input[placeholder*="MM/DD/YYYY"], input[placeholder*="YYYY"]');
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
        const btn = Array.from(document.querySelectorAll('button')).find(b => {
            const t = b.textContent.toLowerCase().trim();
            return t.includes('creating') || t.includes('finish') || t === 'continue' || t.includes('agree');
        });
        if (btn) btn.click();
        return btn?.textContent || 'still_not_found';
      `);
    }

    await new Promise(r => setTimeout(r, 6000)); // được redirect vào dashboard sau click
    await saveStep('05_about_completed');

    // 6. Nhẩy Bypass Phone & Nhẩy vào Workspace
    console.log(`[6] Tiến hành Bypass Screen (if Phone requested) và lấy Access Token...`);
    const pageUrl = await evalJson(tabId, USER_ID, `location.href`);
    if (pageUrl.includes('add-phone')) {
      console.log(`[6.1] Phát hiện add-phone → thử conditional bypass trước...`);
      phoneBypassAttempted = true;
      const bypassResult = await performWorkspaceConsentBypass(evalJson, tabId, USER_ID);
      if (bypassResult.ok && bypassResult.code) {
        console.log(`[6.1] ✅ Conditional bypass thành công! Code: ${bypassResult.code.slice(0, 20)}...`);
        phoneBypassSuccess = true;
        // Store code for later use if OAuth is enabled
        await saveStep('06b_phone_bypass_success');
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
            await saveStep('06b_phone_bypass_success');
            break;
          } else {
            console.log(`[6.1] Phone bypass retry ${retry} failed: ${retryResult.error}`);
          }
        }
        
        // If all retries failed, redirect to home
        if (!phoneBypassSuccess) {
          console.log(`[6.1] ❌ Hết retry, redirecting to home...`);
          await camofoxPostWithSessionKey(`/tabs/${tabId}/navigate`, { userId: USER_ID, url: 'https://chatgpt.com/' });
          await new Promise(r => setTimeout(r, 8000));
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
    await saveStep('06_skip_survey');

    // Thao tác đóng Welcome Modal (OK, let's go)
    console.log(`[6.1] Đóng Welcome Modal...`);
    await evalJson(tabId, USER_ID, `
      (() => {
        let retryCount = 0;
        const maxRetries = CONFIG.welcomeModalMaxRetries;
        const findAndClickOk = () => {
            if (retryCount >= maxRetries) return false;
            retryCount++;
            
            const buttons = Array.from(document.querySelectorAll('button'));
            const okBtn = buttons.find(b => {
                const t = b.textContent.toLowerCase();
                return t.includes('ok') || t.includes('tiến hành') || t.includes('let') || t.includes('xong') || t.includes('done');
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
    await new Promise(r => setTimeout(r, 5000));
    await saveStep('07_inside_chat');

    await saveStep('06_home_reached');

    // 7. SETUP 2FA (MFA) - dùng UI Automation thay vì API cũ (404)
    console.log(`==========================================`);
    console.log(`[7] BẬT BẢO MẬT 2FA / MFA CHO ACCOUNT NÀY...`);
    console.log(`==========================================`);

    // Domain guard trước khi setupMFA — tránh chạy trên trang lạ (Google/Apple/MS)
    let mfaResult;
    try {
      await assertOnExpectedDomain(tabId, USER_ID, 'before-mfa-setup');
      mfaResult = await setupMFA(tabId, USER_ID, camofoxPostWithSessionKey);

      // Retry MFA setup if toggle not found (max CONFIG.mfaMaxRetries retries)
      if (!mfaResult.success && mfaResult.error?.includes('not found')) {
        console.log(`[7] ⚠️ Toggle not found, retry MFA setup...`);
        for (let retry = 1; retry <= CONFIG.mfaMaxRetries; retry++) {
          console.log(`[7] MFA retry ${retry}: Navigate về Security page...`);
          await camofoxPostWithSessionKey(`/tabs/${tabId}/navigate`, { userId: USER_ID, url: 'https://chatgpt.com/#settings/Security' });
          await new Promise(r => setTimeout(r, 3000));
          
          const retryResult = await setupMFA(tabId, USER_ID, camofoxPostWithSessionKey);
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

    // 7.5. Codex OAuth flow (if enabled)
    let codexRefreshToken = null;
    if (enableOAuth) {
      console.log(`==========================================`);
      console.log(`[7.5] CODEX OAUTH FLOW...`);
      console.log(`==========================================`);
      
      const oauthResult = await performCodexOAuth(tabId, USER_ID, proxyUrl, saveStep, {
        email,
        password: chatGptPassword,
        mfaSecret: twoFaSecret,
      });
      if (oauthResult.success && oauthResult.tokens) {
        codexRefreshToken = oauthResult.tokens.refresh_token || null;
        console.log(`[7.5] 🟢 Codex OAuth thành công! Refresh token: ${codexRefreshToken ? 'YES' : 'NO'}`);
        await saveStep('oauth_success');
      } else {
        console.log(`[7.5] 🔴 Codex OAuth thất bại: ${oauthResult.error}. Account vẫn được lưu với session token.`);
        await saveStep('oauth_failed');
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

    // Lưu vào kho account (status=idle, chờ Deploy - KHÔNG phải sẽ được deploy ngay)
    const accRes = await fetch(`http://localhost:4000/api/vault/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        password: chatGptPassword,
        two_fa_secret: twoFaSecret || '',
        provider: 'openai',
        status: 'idle',
        skipSync: true,
        restore_deleted: true,
        tags: JSON.stringify(['auto-register', 'vault-register', ...(phoneBypassAttempted ? ['phone-verify'] : []), ...(phoneBypassSuccess ? ['phone-bypass-ok'] : []), ...(codexRefreshToken ? ['codex-oauth'] : [])]),
        notes: `[Auto-Register] Email Pool: ${email} | MS Pass: ${emailPassword} | ChatGPT Pass: ${chatGptPassword}${twoFaSecret ? ` | 2FA: ${twoFaSecret}` : ''}${phoneBypassAttempted ? ` | Phone Verify: ${phoneBypassSuccess ? 'Bypass OK' : 'Bypass Failed'}` : ''}${codexRefreshToken ? ` | Codex RT: ${codexRefreshToken.slice(0, 30)}...` : ''} | Tạo: ${new Date().toISOString()}`
      }),
    });
    const accData = await accRes.json();

    // Cập nhật pool status
    await updatePoolStatus(email, {
      chatgpt_status: 'done',
      linked_chatgpt_id: accData.id,
      notes: `Thành công | PID: ${process.pid} | Acc ID: ${accData.id}`
    });

    return {
      success: true, email, password: chatGptPassword, twoFaSecret, sessionToken, createdAt: new Date().toISOString()
    };

  } catch (err) {
    console.log(`==========================================`);
    console.log(`🔴 THẤT BẠI: ${email}`);
    console.log(`❌ Lỗi: ${err.message}`);
    
    // Enhanced error logging
    try {
      if (tabId) {
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

    if (tabId) { await camofoxPostWithSessionKey(`/tabs/${tabId}?userId=${USER_ID}`, {}, 5000).catch(() => { }); }
    return { success: false, email, error: err.message || String(err) };
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
