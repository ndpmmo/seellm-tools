/**
 * SeeLLM Tools - Auto-Connect Worker v2 (Direct ChatGPT Login)
 *
 * Fix v2:
 *  - Điều hướng thẳng đến https://chatgpt.com/auth/login (bỏ bước click nút Login trên homepage)
 *  - Fix looksLoggedIn: ChatGPT hiển thị "New chat" kể cả khi CHƯA đăng nhập
 *    → Chỉ coi là logged in khi KHÔNG có "Sign up" và CÓ profile indicator hoặc URL đặc trưng
 *  - Log đầy đủ mọi state để dễ debug
 *  - Thêm fallback: nếu auth.openai.com redirect → phát hiện đúng email/password input
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import https from 'node:https';
import { createHmac } from 'node:crypto';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CAMOUFOX_API, POLL_INTERVAL_MS, MAX_THREADS } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IMAGES_DIR = path.join(__dirname, '..', 'data', 'screenshots');

// ================================================================
// OAUTH PKCE CONSTANTS (giống any-auto-register + Codex CLI)
// ================================================================
const OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const OAUTH_AUTH_URL = 'https://auth.openai.com/oauth/authorize';
const OAUTH_REDIRECT_URI = 'http://localhost:1455/auth/callback';
const OAUTH_SCOPE = 'openid email profile offline_access';

function generatePKCE() {
    const codeVerifier = crypto.randomBytes(48).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    const state = crypto.randomBytes(16).toString('base64url');
    return { codeVerifier, codeChallenge, state };
}

function buildOAuthURL(pkce) {
    const params = new URLSearchParams({
        client_id: OAUTH_CLIENT_ID,
        response_type: 'code',
        redirect_uri: OAUTH_REDIRECT_URI,
        scope: OAUTH_SCOPE,
        state: pkce.state,
        code_challenge: pkce.codeChallenge,
        code_challenge_method: 'S256',
        // ⚠️ KHÔNG dùng prompt=login (ép đăng nhập lại)
        // Dùng consent hoặc bỏ prompt để tận dụng session hiện có
    });
    return `${OAUTH_AUTH_URL}?${params.toString()}`;
}

async function exchangeCodeForTokens(code, pkce, proxyUrl = null) {
    const params = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: OAUTH_CLIENT_ID,
        code,
        redirect_uri: OAUTH_REDIRECT_URI,
        code_verifier: pkce.codeVerifier,
    });
    const postData = params.toString();

    // ── Nếu có proxy: dùng curl để đồng bộ IP với trình duyệt ──
    if (proxyUrl) {
        try {
            const { execSync } = await import('node:child_process');
            const curlCmd = [
                'curl', '-s', '-X', 'POST',
                '-H', '"Content-Type: application/x-www-form-urlencoded"',
                '-H', '"Accept: application/json"',
                '--proxy', `"${proxyUrl}"`,
                '--data', `"${postData}"`,
                `"${OAUTH_TOKEN_URL}"`
            ].join(' ');

            const responseText = execSync(curlCmd, { encoding: 'utf8', timeout: 15000 });
            const data = JSON.parse(responseText);
            if (data.error) throw new Error(data.error_description || JSON.stringify(data.error));
            console.log(`[Connect] [Technical: Proxy] Token exchange success via proxy.`);
            return data;
        } catch (err) {
            console.warn(`[Connect] [Technical: Proxy] Proxy exchange failed, falling back to direct: ${err.message}`);
        }
    }

    const res = await fetch(OAUTH_TOKEN_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json',
        },
        body: postData,
        signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
        const err = await res.text();
        throw new Error(`Token exchange failed: ${res.status} ${err.slice(0, 200)}`);
    }
    return res.json();
}

// ================================================================
// TOTP (2FA)
// ================================================================
function getTOTP(secret) {
    function base32tohex(base32) {
        const base32chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
        let bits = '', hex = '';
        const clean = base32.replace(/\s/g, '').toUpperCase();
        for (let i = 0; i < clean.length; i++) {
            const val = base32chars.indexOf(clean.charAt(i));
            if (val === -1) continue;
            bits += val.toString(2).padStart(5, '0');
        }
        for (let i = 0; i + 4 <= bits.length; i += 4) hex += parseInt(bits.substr(i, 4), 2).toString(16);
        return hex;
    }
    const key = base32tohex(secret);
    const epoch = Math.round(Date.now() / 1000);
    const time = Buffer.from(Math.floor(epoch / 30).toString(16).padStart(16, '0'), 'hex');
    const hmac = createHmac('sha1', Buffer.from(key, 'hex'));
    const h = hmac.update(time).digest();
    const offset = h[h.length - 1] & 0xf;
    const otp = (h.readUInt32BE(offset) & 0x7fffffff) % 1000000;
    return otp.toString().padStart(6, '0');
}

async function getFreshTOTP(secret, minSec = 8) {
    if (!secret) throw new Error('Missing TOTP secret');
    const remaining = () => 30 - (Math.floor(Date.now() / 1000) % 30);
    if (remaining() <= minSec) {
        console.log(`[Connect] ⏳ Đợi TOTP window mới (còn ${remaining()}s)...`);
        await new Promise(r => setTimeout(r, (remaining() + 1) * 1000));
    }
    const otp = getTOTP(secret);
    console.log(`[Connect] 🔑 TOTP: ${otp} (còn ${remaining()}s)`);
    return otp;
}

// ================================================================
// CAMOFOX HELPERS
// ================================================================
async function camofoxPost(endpoint, body, timeoutMs = 30000) {
    const res = await fetch(`${CAMOUFOX_API}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`Camofox ${endpoint} → ${res.status}: ${await res.text()}`);
    return res.json();
}

async function camofoxGet(endpoint, timeoutMs = 10000) {
    const res = await fetch(`${CAMOUFOX_API}${endpoint}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`Camofox GET ${endpoint} → ${res.status}`);
    return res.json();
}

async function camofoxDelete(endpoint) {
    await fetch(`${CAMOUFOX_API}${endpoint}`, { method: 'DELETE', signal: AbortSignal.timeout(8000) }).catch(() => { });
}

async function evalJson(tabId, userId, expression, timeoutMs = 8000) {
    try {
        const res = await camofoxPost(`/tabs/${tabId}/eval`, { userId, expression }, timeoutMs);
        return res?.result ?? null;
    } catch (e) {
        console.log(`[Connect] ⚠️ eval failed: ${e.message.slice(0, 80)}`);
        return null;
    }
}

async function navigate(tabId, userId, url, timeoutMs = 15000) {
    try {
        await camofoxPost(`/tabs/${tabId}/navigate`, { userId, url }, timeoutMs);
    } catch (e) {
        console.log(`[Connect] ⚠️ navigate failed: ${e.message.slice(0, 80)}`);
    }
}

function extractIpFromText(raw) {
    const text = String(raw || '').trim();
    if (!text) return null;
    try {
        const j = JSON.parse(text);
        if (j?.ip) return String(j.ip).trim();
        if (j?.query) return String(j.query).trim();
        if (j?.address) return String(j.address).trim();
    } catch (_) { }
    const ipv4 = text.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/);
    if (ipv4) return ipv4[0];
    const ipv6 = text.match(/\b(?:[A-Fa-f0-9]{1,4}:){2,7}[A-Fa-f0-9]{1,4}\b/);
    return ipv6 ? ipv6[0] : null;
}

function normalizeProxyUrl(input) {
    const s = String(input || '').trim();
    if (!s) return null;
    if (s.includes('://')) return s;
    return `http://${s}`;
}

let LOCAL_PUBLIC_IP_CACHE = null;

async function fetchTextNoProxy(url, timeoutMs = 12000) {
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

async function getLocalPublicIp() {
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
        } catch (_) { }
    }
    return null;
}

async function probeProxyExitIp(proxyUrl, parentUserId) {
    const probeUserId = `${parentUserId}_probe`;
    let probeTabId = null;
    try {
        const opened = await camofoxPost('/tabs', {
            userId: probeUserId,
            sessionKey: `probe_${Date.now()}`,
            url: 'https://api64.ipify.org/?format=json',
            proxy: proxyUrl || undefined,
            persistent: false,
            headless: false,
            humanize: true,
        }, 25000);
        probeTabId = opened.tabId;
        await new Promise(r => setTimeout(r, 3500));
        const bodyText = await evalJson(probeTabId, probeUserId, `document.body && document.body.innerText ? document.body.innerText : ''`, 20000);
        const ip = extractIpFromText(bodyText);
        if (!ip) return { error: `Không parse được IP từ nội dung: ${String(bodyText || '').slice(0, 120)}` };
        return { ip, source: 'https://api64.ipify.org/?format=json' };
    } catch (e) {
        return { error: e.message || String(e) };
    } finally {
        if (probeTabId) await camofoxDelete(`/tabs/${probeTabId}?userId=${probeUserId}`);
    }
}

// ================================================================
// PAGE STATE DETECTION
// ================================================================
/**
 * Detect trạng thái trang CHÍNH XÁC.
 *
 * KEY FIX: ChatGPT hiện tại hiển thị sidebar với "New chat", "Search chats"
 * ngay cả khi CHƯA đăng nhập (anonymous mode). Do đó KHÔNG dùng các text đó
 * để xác định loggedIn. Thay vào đó:
 *  - loggedIn = có profile/avatar button VÀ KHÔNG có "Sign up" button
 *  - HOẶC URL là /c/ (conversation đang mở)
 */
async function getState(tabId, userId) {
    const state = await evalJson(tabId, userId, `
    (() => {
      const href  = location.href;
      const host  = location.hostname;
      const body  = (document.body?.innerText || '').toLowerCase();

      // ── Logged-in indicators (phải đủ chặt) ──
      const hasProfileBtn = !!(
        document.querySelector('[data-testid="profile-button"]') ||
        document.querySelector('[data-testid="user-menu-button"]') ||
        document.querySelector('[aria-label="Open user menu"]') ||
        document.querySelector('[aria-label="User menu"]')
      );
      // Khi chưa đăng nhập: luôn có "Log in" và "Sign up"
      const hasSignUpInPage = body.includes('sign up for free') || body.includes('sign up') || body.includes('đăng ký');
      const hasLogInBtn     = body.includes('log in') && !hasProfileBtn;

      // Có thể ChatGPT đổi selector nên không tìm thấy profile button.
      // Dấu hiệu dự phòng: có "new chat" hoặc "search chats" mà KHÔNG CÓ "log in" hay "sign up"
      const hasNewChat      = body.includes('new chat') || body.includes('search chats') || body.includes('chatgpt plus');
      
      const isConversation  = href.includes('/c/') || href.includes('/g/');
      const looksLoggedIn   = ((hasProfileBtn || hasNewChat) && !hasSignUpInPage && !hasLogInBtn) || isConversation;

      // ── Auth pages (auth.openai.com hoặc /auth/*) ──
      const onAuthDomain    = host.includes('auth.openai.com') || href.includes('/auth/');
      const hasEmailInput   = !!document.querySelector(
        'input[type="email"], input[name="username"], input[id="username"], input[name="email"], input[autocomplete="email"]'
      );
      const hasPasswordInput = !!document.querySelector(
        'input[type="password"], input[name="password"], input[id="password"], input[autocomplete="current-password"]'
      );

      // ── MFA: URL chứa /mfa hoặc có input one-time-code ──
      // ⚠️ QUAN TRỌNG: PHẢI exclude /add-phone vì nó bị nhận nhầm là MFA
      const isAddPhonePage = href.includes('/add-phone');
      const hasMfaInput = !isAddPhonePage && !!(
        href.includes('/mfa') || href.includes('/totp') || href.includes('two-factor') ||
        body.includes('one-time code') || body.includes('authenticator app') || body.includes('6-digit') ||
        document.querySelector('input[autocomplete="one-time-code"], input[name="code"], input[name="otp"]')
      );

      // ── Cookie banner ──
      const hasCookieBanner = !!(
        document.querySelector('[aria-label*="cookie" i], [id*="cookie" i], [class*="cookie" i]') ||
        body.includes('accept all cookies') || body.includes('accept cookies')
      );

      // ── Phone verify ──
      // Bao gồm cả URL /add-phone (OpenAI OAuth yêu cầu thêm SĐT)
      const hasPhoneScreen = isAddPhonePage ||
        body.includes('phone number required') || body.includes('add a phone number') ||
        body.includes('verify your phone') || body.includes('enter your phone') ||
        body.includes('phone number') || body.includes('add phone');

      // ── Error screen ──
      const hasError = body.includes('something went wrong') || body.includes('try again') ||
        document.querySelector('[class*="error"]') !== null;

      return {
        href, host,
        looksLoggedIn, hasProfileBtn, hasSignUpInPage, hasLogInBtn, isConversation,
        onAuthDomain, hasEmailInput, hasPasswordInput, hasMfaInput,
        hasCookieBanner, hasPhoneScreen, hasError,
      };
    })()
  `, 6000);

    if (state) {
        console.log(`[Connect] 📍 State: ${state.href.slice(0, 70)}`);
        console.log(`[Connect]    loggedIn=${state.looksLoggedIn} | email=${state.hasEmailInput} | pass=${state.hasPasswordInput} | mfa=${state.hasMfaInput} | signUp=${state.hasSignUpInPage} | profile=${state.hasProfileBtn}`);
    } else {
        console.log(`[Connect] ⚠️ getState returned null`);
    }
    return state;
}

// ================================================================
// FORM FILL HELPERS
// ================================================================
async function fillEmail(tabId, userId, email) {
    const escaped = JSON.stringify(email);
    return evalJson(tabId, userId, `
    (() => {
      const val = ${escaped};
      const isVisible = el => {
        if (!el) return false;
        const s = window.getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0' && r.width > 0 && r.height > 0;
      };
      const setValue = (el, v) => {
        const nativeInput = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
        if (nativeInput) nativeInput.set.call(el, v);
        else el.value = v;
        el.dispatchEvent(new Event('input',  { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const selectors = [
        'input[autocomplete="email"]',
        'input[name="username"]',
        'input[type="email"]',
        'input[id="username"]',
        'input[name="email"]',
      ];
      let input = null;
      for (const s of selectors) {
        const el = document.querySelector(s);
        if (isVisible(el)) { input = el; break; }
      }
      if (!input) return { ok: false, reason: 'no-email-input', tried: selectors };
      input.focus();
      setValue(input, val);

      // Tìm nút Continue / Next
      const btn = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]'))
        .filter(isVisible)
        .find(el => {
          const t = (el.innerText || el.textContent || el.value || '').trim().toLowerCase();
          return t === 'continue' || t === 'next' || t === 'tiếp tục';
        });
      if (btn) btn.click();
      else {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      }
      return { ok: true, clicked: !!btn, value: input.value };
    })()
  `, 6000);
}

async function fillPassword(tabId, userId, password) {
    const escaped = JSON.stringify(password);
    return evalJson(tabId, userId, `
    (() => {
      const val = ${escaped};
      const isVisible = el => {
        if (!el) return false;
        const s = window.getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0' && r.width > 0 && r.height > 0;
      };
      const setValue = (el, v) => {
        const nativeInput = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
        if (nativeInput) nativeInput.set.call(el, v);
        else el.value = v;
        el.dispatchEvent(new Event('input',  { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const selectors = [
        'input[autocomplete="current-password"]',
        'input[type="password"]',
        'input[name="password"]',
        'input[id="password"]',
      ];
      let input = null;
      for (const s of selectors) {
        const el = document.querySelector(s);
        if (isVisible(el)) { input = el; break; }
      }
      if (!input) return { ok: false, reason: 'no-password-input', tried: selectors };
      input.focus();
      setValue(input, val);

      const btn = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]'))
        .filter(isVisible)
        .find(el => {
          const t = (el.innerText || el.textContent || el.value || '').trim().toLowerCase();
          return t === 'continue' || t === 'sign in' || t === 'log in' || t === 'next' || t === 'tiếp tục';
        });
      if (btn) btn.click();
      else {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      }
      return { ok: true, clicked: !!btn, value: '***' };
    })()
  `, 6000);
}

async function fillMfa(tabId, userId, otp) {
    const escaped = JSON.stringify(otp);
    return evalJson(tabId, userId, `
    (() => {
      const val = ${escaped};
      const isVisible = el => {
        if (!el) return false;
        const s = window.getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
      };
      const setValue = (el, v) => {
        const nativeInput = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
        if (nativeInput) nativeInput.set.call(el, v);
        else el.value = v;
        el.dispatchEvent(new Event('input',  { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
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
      if (!input) return { ok: false, reason: 'no-mfa-input' };
      input.focus();
      setValue(input, val);

      const btn = Array.from(document.querySelectorAll('button, [role="button"]'))
        .filter(isVisible)
        .find(el => {
          const t = (el.innerText || el.textContent || '').trim().toLowerCase();
          return t.includes('continue') || t.includes('verify') || t.includes('confirm') || t.includes('xác nhận');
        });
      if (btn) btn.click();
      else input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      return { ok: true, clicked: !!btn };
    })()
  `, 6000);
}

async function tryAcceptCookies(tabId, userId) {
    await evalJson(tabId, userId, `
    (() => {
      const isVisible = el => { if (!el) return false; const s = window.getComputedStyle(el); const r = el.getBoundingClientRect(); return s.display !== 'none' && r.width > 0; };
      const btn = Array.from(document.querySelectorAll('button'))
        .filter(isVisible)
        .find(el => {
          const t = (el.innerText || el.textContent || '').toLowerCase();
          return t.includes('accept all') || t.includes('accept cookies') || t.includes('agree') || t.includes('chấp nhận');
        });
      if (btn) btn.click();
      return !!btn;
    })()
  `, 3000);
}

/** Dismiss Google "Sign in with Google" popup overlay + bấm nút "Log in" trên landing page */
async function dismissGooglePopupAndClickLogin(tabId, userId) {
    return evalJson(tabId, userId, `
    (() => {
      const isVisible = el => {
        if (!el) return false;
        const s = window.getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0' && r.width > 0 && r.height > 0;
      };
      const results = [];

      // 1. Đóng popup "Sign in with Google" (bấm nút X / Close)
      const closeButtons = Array.from(document.querySelectorAll(
        '[aria-label="Close"], [aria-label="close"], button[id*="close"], [data-dismiss], .close-button'
      )).filter(isVisible);
      // Cũng tìm nút X trong iframe hoặc overlay
      const xButtons = Array.from(document.querySelectorAll('button, div[role="button"]'))
        .filter(el => isVisible(el) && (el.innerText || '').trim() === '✕' || (el.innerText || '').trim() === '×' || (el.innerText || '').trim() === 'X');
      const googleClose = closeButtons[0] || xButtons[0];
      if (googleClose) {
        googleClose.click();
        results.push('dismissed-google-popup');
      }

      // Cũng tìm Google iframe overlay và xóa nó
      const googleIframes = document.querySelectorAll('iframe[src*="accounts.google.com"]');
      googleIframes.forEach(iframe => {
        const container = iframe.closest('div[style], div[class]');
        if (container && container !== document.body) container.remove();
        else iframe.remove();
      });
      if (googleIframes.length > 0) results.push('removed-google-iframe');

      // 2. Bấm nút "Log in" (có thể là <button> hoặc <a>)
      const allClickable = Array.from(document.querySelectorAll('button, a, [role="button"]')).filter(isVisible);
      const loginBtn = allClickable.find(el => {
        const t = (el.innerText || el.textContent || '').trim().toLowerCase();
        return t === 'log in' || t === 'đăng nhập';
      });

      if (loginBtn) {
        loginBtn.click();
        results.push('clicked-login: ' + (loginBtn.innerText || '').trim());
      } else {
        // Fallback: tìm bất kỳ link nào dẫn đến /auth
        const authLink = allClickable.find(el => {
          const href = el.getAttribute('href') || '';
          return href.includes('/auth') || href.includes('login');
        });
        if (authLink) {
          authLink.click();
          results.push('clicked-auth-link: ' + (authLink.getAttribute('href') || ''));
        } else {
          results.push('no-login-button-found');
          results.push('visible-buttons: ' + allClickable.map(e => (e.innerText || '').trim()).filter(Boolean).slice(0, 10).join(' | '));
        }
      }

      return { ok: results.some(r => r.startsWith('clicked')), actions: results };
    })()
  `, 5000);
}

// ================================================================
// JWT DECODE
// ================================================================
function decodeJwtPayload(token) {
    try {
        const parts = String(token || '').split('.');
        if (parts.length < 2) return {};
        let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        while (b64.length % 4) b64 += '=';
        return JSON.parse(Buffer.from(b64, 'base64').toString('utf-8'));
    } catch { return {}; }
}

function extractAccountMeta(accessToken) {
    const payload = decodeJwtPayload(accessToken);
    const auth = payload['https://api.openai.com/auth'] || {};
    const profile = payload['https://api.openai.com/profile'] || {};
    return {
        accountId: auth.chatgpt_account_id || auth.account_id || payload.sub || '',
        userId: auth.chatgpt_user_id || auth.user_id || payload.sub || '',
        organizationId: auth.organization_id || '',
        planType: auth.chatgpt_plan_type || 'free',
        expiredAt: payload.exp ? new Date(payload.exp * 1000).toISOString() : '',
        email: profile.email || payload.email || '',
    };
}

// ================================================================
// FETCH SESSION IN-PAGE
// ================================================================
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

// ================================================================
// SCREENSHOT HELPER
// ================================================================
let _stepCount = 0;
async function saveStep(tabId, userId, runDir, label) {
    _stepCount++;
    const filename = `${String(_stepCount).padStart(2, '0')}_${label}.png`;
    try {
        const res = await fetch(`${CAMOUFOX_API}/tabs/${tabId}/screenshot?userId=${userId}&fullPage=true`, {
            signal: AbortSignal.timeout(8000),
        });
        if (res.ok) {
            await fs.writeFile(path.join(runDir, filename), Buffer.from(await res.arrayBuffer()));
            console.log(`[Connect] 📸 ${filename}`);
        }
    } catch (_) { }
}

// ================================================================
// CORE CONNECT FLOW
// ================================================================
async function runConnectFlow(task) {
    _stepCount = 0;
    const USER_ID = `seellm_connect_${task.id}`;
    const effectiveProxy = normalizeProxyUrl(task.proxyUrl || task.proxy_url || null);
    if (effectiveProxy) {
        task.proxyUrl = effectiveProxy;
        task.proxy_url = effectiveProxy;
    }
    const { email, password } = task;
    const totpSecret = task.twoFaSecret || task.two_fa_secret || null;

    console.log(`\n[Connect] ════════════════════════════════`);
    console.log(`[Connect] 🔌 Bắt đầu: ${email}`);
    console.log(`[Connect] ════════════════════════════════`);
    if (effectiveProxy) console.log(`[Connect] 🔌 Proxy: ${effectiveProxy}`);

    if (!email || !password) {
        return sendConnectResult(task, 'error', 'Thiếu email hoặc password');
    }

    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const runDir = path.join(IMAGES_DIR, `connect_${task.id}_${ts}`);
    await fs.mkdir(runDir, { recursive: true });

    let tabId = null;
    try {
        // ── BƯỚC 1: Mở thẳng trang ĐĂNG NHẬP (không qua homepage) ──────
        // Auth URL trực tiếp để tránh bấm nút "Log in" trên homepage
        const LOGIN_URL = 'https://chatgpt.com/auth/login';
        console.log(`[Connect] [1] Mở ${LOGIN_URL}...`);
        const opened = await camofoxPost('/tabs', {
            userId: USER_ID,
            sessionKey: `cg_connect_${task.id}`,
            url: LOGIN_URL,
            proxy: effectiveProxy || undefined,
            persistent: false,
            os: 'macos',
            screen: { width: 1440, height: 900 },
            humanize: true,
            headless: false,
            randomFonts: true,
            canvas: 'random',
        }, 25000);
        tabId = opened.tabId;
        console.log(`[Connect] [1] Tab: ${tabId}`);

        // Đợi trang tải hoàn toàn (chatgpt landing page chậm)
        await new Promise(r => setTimeout(r, 5000));
        
        // 🔍 [Diagnostic] Kiểm tra IP thoát của Proxy bằng tab probe riêng (tránh false-fail do CORS)
        try {
          console.log(`[Connect] 🔍 [Diagnostic] Đang kiểm tra IP thoát qua Proxy...`);
          const ipCheck = await probeProxyExitIp(effectiveProxy || null, USER_ID);
          if (ipCheck && ipCheck.ip) {
            console.log(`[Connect] ✅ [Diagnostic] Exit IP: ${ipCheck.ip}`);
            if (effectiveProxy) {
              const localIp = await getLocalPublicIp();
              if (localIp) {
                console.log(`[Connect] ℹ️ [Diagnostic] Host Public IP: ${localIp}`);
                if (String(localIp).toLowerCase() === String(ipCheck.ip).toLowerCase()) {
                  throw new Error(`Proxy chưa được áp dụng (Exit IP trùng Host Public IP).`);
                }
              } else {
                throw new Error(`Không thể xác định Host Public IP để xác thực proxy.`);
              }
            }
          } else if (ipCheck && ipCheck.error) {
            console.log(`[Connect] ⚠️ [Diagnostic] Lỗi kiểm tra IP: ${ipCheck.error}`);
            // [HARD-FAIL]
            if (effectiveProxy) {
              throw new Error(`Proxy không hoạt động. Dừng tiến trình.`);
            }
          } else if (effectiveProxy) {
            throw new Error(`Không lấy được Exit IP khi đã gán proxy.`);
          }
        } catch (err) {
          console.log(`[Connect] ⚠️ [Diagnostic] Không thể kiểm tra IP: ${err.message}`);
          if (effectiveProxy) throw err;
        }

        await saveStep(tabId, USER_ID, runDir, '01_login_page');

        let state = await getState(tabId, USER_ID);

        // ── Nếu đã logged in (cookie còn hạn) ────────────────────────────
        if (state?.looksLoggedIn) {
            console.log(`[Connect] ✅ Đã có session trước! Lấy token ngay...`);
            await captureAndReport(tabId, USER_ID, runDir, task, email);
            return;
        }

        // ── Accept cookies banner nếu có ────────────────────────────────
        console.log(`[Connect] 🍪 Accept cookie banner...`);
        await tryAcceptCookies(tabId, USER_ID);
        await new Promise(r => setTimeout(r, 1500));

        // ── Dismiss Google popup + bấm nút "Log in" ──────────────────────
        // Trang chatgpt.com/auth/login hiện ra landing page với:
        //   - Popup "Sign in with Google" overlay
        //   - Nút "Log in" (xanh dương)
        //   - Nút "Sign up for free"
        // Phải dismiss popup rồi bấm "Log in" để redirect sang auth.openai.com
        console.log(`[Connect] [1b] Dismiss Google popup + bấm Log in...`);
        const loginClick = await dismissGooglePopupAndClickLogin(tabId, USER_ID);
        console.log(`[Connect] [1b] Result:`, JSON.stringify(loginClick));
        await new Promise(r => setTimeout(r, 4000));
        await saveStep(tabId, USER_ID, runDir, '01b_after_login_click');
        state = await getState(tabId, USER_ID);

        // ── Retry: nếu vẫn chưa ở auth domain ────────────────────────────
        if (!state?.onAuthDomain && !state?.hasEmailInput && !state?.looksLoggedIn) {
            console.log(`[Connect] [1c] Chưa redirect, thử bấm Log in lần 2...`);
            await dismissGooglePopupAndClickLogin(tabId, USER_ID);
            await new Promise(r => setTimeout(r, 5000));
            await saveStep(tabId, USER_ID, runDir, '01c_retry');
            state = await getState(tabId, USER_ID);
        }

        // ── Fallback cuối: nếu chưa redirect → navigate bằng auth0 authorize URL ─
        if (!state?.onAuthDomain && !state?.hasEmailInput && !state?.looksLoggedIn) {
            console.log(`[Connect] [1d] Fallback: dùng auth.openai.com/authorize URL trực tiếp...`);
            await navigate(tabId, USER_ID,
                'https://auth.openai.com/authorize?client_id=DRivsnm2Mu42T3KOpqdtwB3NYviHYzwD' +
                '&audience=https%3A%2F%2Fapi.openai.com%2Fv1' +
                '&redirect_uri=https%3A%2F%2Fchatgpt.com%2Fapi%2Fauth%2Fcallback%2Flogin-web' +
                '&scope=openid+email+profile+offline_access+model.request+model.read+organization.read+organization.write' +
                '&response_type=code&response_mode=query&state=login&prompt=login',
                15000);
            await new Promise(r => setTimeout(r, 5000));
            await saveStep(tabId, USER_ID, runDir, '01d_fallback');
            state = await getState(tabId, USER_ID);
        }

        // ── BƯỚC 2: Điền EMAIL ───────────────────────────────────────────
        let emailDone = false;
        for (let attempt = 0; attempt < 8 && !emailDone; attempt++) {
            if (state?.looksLoggedIn) { emailDone = true; break; }
            if (state?.hasPasswordInput) { emailDone = true; break; }

            if (state?.hasEmailInput) {
                console.log(`[Connect] [2] [Technical: DOM Manipulation] Đang điền email nhanh (gán giá trị trực tiếp vào ô input)...`);
                const r = await fillEmail(tabId, USER_ID, email);
                console.log(`[Connect] [2] fillEmail result:`, JSON.stringify(r));
                await new Promise(r2 => setTimeout(r2, 3000));
                await saveStep(tabId, USER_ID, runDir, `02_email_${attempt + 1}`);
                state = await getState(tabId, USER_ID);
                if (r?.ok) emailDone = true;
            } else {
                console.log(`[Connect] [2] Chưa thấy email input, đợi thêm...`);
                await new Promise(r => setTimeout(r, 2500));
                state = await getState(tabId, USER_ID);
            }
        }

        if (!emailDone && !state?.hasPasswordInput && !state?.looksLoggedIn) {
            await saveStep(tabId, USER_ID, runDir, '02_failed');
            return sendConnectResult(task, 'error', `Không tìm thấy email input sau 8 lần thử. URL: ${state?.href}`);
        }

        // ── BƯỚC 3: Điền PASSWORD ────────────────────────────────────────
        let passDone = false;
        for (let attempt = 0; attempt < 5 && !passDone; attempt++) {
            if (state?.looksLoggedIn) { passDone = true; break; }
            if (state?.hasMfaInput) { passDone = true; break; }

            if (state?.hasPasswordInput) {
                console.log(`[Connect] [3] [Technical: DOM Manipulation] Điền password (lần ${attempt + 1})`);
                const r = await fillPassword(tabId, USER_ID, password);
                console.log(`[Connect] [3] fillPassword →`, JSON.stringify(r));
                await new Promise(r2 => setTimeout(r2, 3500));
                await saveStep(tabId, USER_ID, runDir, `03_password_${attempt + 1}`);
                state = await getState(tabId, USER_ID);
                if (r?.ok) passDone = true;
            } else {
                console.log(`[Connect] [3] Chưa thấy password input, đợi...`);
                await new Promise(r => setTimeout(r, 2500));
                state = await getState(tabId, USER_ID);
            }
        }

        // ── BƯỚC 4: MFA ──────────────────────────────────────────────────
        if (state?.hasMfaInput) {
            if (!totpSecret) {
                await saveStep(tabId, USER_ID, runDir, '04_mfa_no_secret');
                return sendConnectResult(task, 'error', 'MFA required nhưng account chưa có 2FA secret');
            }
            console.log(`[Connect] [4] [Technical: DOM Manipulation] Màn hình MFA → sinh TOTP...`);
            const otp = await getFreshTOTP(totpSecret, 8);
            const r = await fillMfa(tabId, USER_ID, otp);
            console.log(`[Connect] [4] fillMfa →`, JSON.stringify(r));
            await new Promise(r2 => setTimeout(r2, 4000));
            await saveStep(tabId, USER_ID, runDir, '04_mfa');
            state = await getState(tabId, USER_ID);

            // Retry MFA nếu vẫn còn ở màn MFA
            if (state?.hasMfaInput) {
                console.log(`[Connect] [4] MFA retry...`);
                const otp2 = await getFreshTOTP(totpSecret, 3);
                await fillMfa(tabId, USER_ID, otp2);
                await new Promise(r2 => setTimeout(r2, 4000));
                await saveStep(tabId, USER_ID, runDir, '04b_mfa_retry');
                state = await getState(tabId, USER_ID);
            }
        }

        // ── BƯỚC 5: Đợi login hoàn tất (poll tối đa 60s) ─────────────────
        console.log(`[Connect] [5] Đợi redirect về chatgpt.com sau login...`);
        let loggedIn = !!state?.looksLoggedIn;
        for (let i = 0; i < 30 && !loggedIn; i++) {
            await new Promise(r => setTimeout(r, 2000));
            state = await getState(tabId, USER_ID);

            if (state?.hasCookieBanner) await tryAcceptCookies(tabId, USER_ID);

            if (state?.hasPhoneScreen) {
                await saveStep(tabId, USER_ID, runDir, '05_phone_required');
                return sendConnectResult(task, 'error', 'NEED_PHONE: Tài khoản yêu cầu xác minh số điện thoại');
            }

            // Phát hiện email/password input xuất hiện lại (có thể trang bounce về)
            if (state?.hasEmailInput && i > 2) {
                console.log(`[Connect] ↩️ Bounce → email input lại, điền lại email...`);
                await fillEmail(tabId, USER_ID, email);
                await new Promise(r => setTimeout(r, 3000));
                state = await getState(tabId, USER_ID);
            } else if (state?.hasPasswordInput && i > 2) {
                console.log(`[Connect] ↩️ Bounce → password input lại, điền lại password...`);
                await fillPassword(tabId, USER_ID, password);
                await new Promise(r => setTimeout(r, 3500));
                state = await getState(tabId, USER_ID);
            }

            loggedIn = !!state?.looksLoggedIn;
            if (loggedIn) {
                console.log(`[Connect] ✅ Đã đăng nhập! (poll ${i + 1})`);
                break;
            }
        }

        await saveStep(tabId, USER_ID, runDir, '05_post_login');

        if (!loggedIn) {
            return sendConnectResult(task, 'error', `Timeout 60s: Không đăng nhập được. URL cuối: ${state?.href}`);
        }

        await captureAndReport(tabId, USER_ID, runDir, task, email);

    } catch (err) {
        console.error(`[Connect] ❌ Exception: ${err.message}`);
        if (tabId) await saveStep(tabId, USER_ID, runDir, 'error').catch(() => { });
        await sendConnectResult(task, 'error', `Exception: ${err.message}`);
    } finally {
        if (tabId) {
            await camofoxDelete(`/tabs/${tabId}?userId=${USER_ID}`);
            console.log(`[Connect] 🧹 Đóng tab ${tabId}`);
        }
    }
}

// ================================================================
// CAPTURE SESSION & REPORT
// ================================================================
async function captureAndReport(tabId, userId, runDir, task, email) {
    console.log(`[Connect] 🔍 Bắt đầu lấy OAuth tokens (PKCE flow)...`);

    // ── BƯỚC A: Tạo OAuth PKCE params ──────────────────────────────────
    const pkce = generatePKCE();
    const authUrl = buildOAuthURL(pkce);
    console.log(`[Connect] [A] PKCE state=${pkce.state.slice(0, 12)}...`);
    console.log(`[Connect] [A] Navigating đến OAuth authorize URL...`);

    // ── BƯỚC B: Mở OAuth URL trong tab browser (user đã logged in → auto-approve) ──
    // Trước khi navigate, set up listener để bắt redirect URL
    // (vì localhost:1455 không có server, browser sẽ báo connection refused
    //  nhưng ta vẫn cần bắt được URL chứa ?code=)
    await evalJson(tabId, userId, `
    (() => {
        // Intercept navigation bằng cách listen beforeunload và lưu URL
        window.__oauthCallbackUrl = null;
        const origFetch = window.fetch;
        const origOpen = XMLHttpRequest.prototype.open;
        
        // Override window.location setter to intercept redirects
        // Lưu ý: không thể override location trực tiếp, nhưng có thể dùng
        // navigation performance entries hoặc MutationObserver
        
        // Dùng PerformanceObserver để bắt navigation
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
    await saveStep(tabId, userId, runDir, '07_oauth_redirect');

    // ── BƯỚC C: Đợi redirect callback với ?code= ──────────────────────
    let authCode = '';
    let callbackState = '';
    const { password } = task;
    const totpSecret = task.twoFaSecret || task.two_fa_secret || null;
    let oauthLoginHandled = false;

    for (let i = 0; i < 30; i++) {
        const currentUrl = await evalJson(tabId, userId, 'location.href', 4000);
        console.log(`[Connect] [C] Poll oauth #${i + 1}: ${(currentUrl || '').slice(0, 100)}`);

        // ── Kiểm tra đã nhận được ?code= chưa ──
        if (currentUrl && currentUrl.includes('code=')) {
            try {
                const url = new URL(currentUrl);
                authCode = url.searchParams.get('code') || '';
                callbackState = url.searchParams.get('state') || '';
                if (authCode) {
                    console.log(`[Connect] ✅ OAuth code received: ${authCode.slice(0, 20)}...`);
                    break;
                }
            } catch (e) {
                console.log(`[Connect] ⚠️ URL parse error: ${e.message}`);
            }
        }

        // ── Nếu redirect về localhost:1455 (callback URL) ──
        if (currentUrl && currentUrl.includes('localhost:1455')) {
            try {
                const url = new URL(currentUrl);
                authCode = url.searchParams.get('code') || '';
                callbackState = url.searchParams.get('state') || '';
                if (authCode) {
                    console.log(`[Connect] ✅ OAuth code intercepted from localhost redirect: ${authCode.slice(0, 20)}...`);
                    break;
                }
            } catch (_) { }
        }

        // ── Browser lỗi connection (about:neterror / ERR_CONNECTION_REFUSED) ──
        // Khi localhost:1455 không chạy, Firefox/Chrome có thể hiển thị trang lỗi
        // Thử lấy URL từ interceptor hoặc từ browser address bar qua window.__oauthCallbackUrl
        if (currentUrl && (currentUrl.includes('about:neterror') || currentUrl.includes('about:blank') || currentUrl === '')) {
            const intercepted = await evalJson(tabId, userId, 'window.__oauthCallbackUrl || null', 2000);
            if (intercepted && intercepted.includes('code=')) {
                try {
                    const url = new URL(intercepted);
                    authCode = url.searchParams.get('code') || '';
                    if (authCode) {
                        console.log(`[Connect] ✅ OAuth code recovered from interceptor: ${authCode.slice(0, 20)}...`);
                        break;
                    }
                } catch (_) { }
            }
        }

        // ── Nếu auth.openai.com yêu cầu login lại → điền email/password/MFA ──
        const oauthState = await getState(tabId, userId);

        // ── /add-phone: Bỏ qua, dùng API để lấy workspace và lấy code (giống any-auto-register) ──
        if (oauthState?.hasPhoneScreen) {
            console.log(`[Connect] [C] [Technical: Background API Calls] Phát hiện màn hình yêu cầu SĐT → Đang thực hiện luồng gọi API ngầm (Fetch) để lấy workspaceId và vượt qua bằng lệnh workspace/select...`);
            await saveStep(tabId, userId, runDir, '08b_skip_phone_consent');

            // Thực hiện toàn bộ consent + workspace select qua browser fetch API
            // Vì cookies đang có trong browser, dùng fetch() trong trang để gọi API với cookies đó
            const codeResult = await evalJson(tabId, userId, `
            (async () => {
                const AUTH_BASE = 'https://auth.openai.com';
                const CONSENT_URL = AUTH_BASE + '/sign-in-with-chatgpt/codex/consent';

                try {
                    // BƯỚC 1: Tải consent page để set cookie oai-client-auth-session
                    const consentRes = await fetch(CONSENT_URL, {
                        credentials: 'include',
                        headers: { 'accept': 'text/html,application/xhtml+xml,*/*' },
                        redirect: 'follow',
                    });
                    const consentHtml = await consentRes.text();

                    // BƯỚC 2: Đọc dữ liệu từ cookie
                    const getAllCookies = () => {
                        const result = {};
                        document.cookie.split(';').forEach(c => {
                            const [k, ...v] = c.trim().split('=');
                            if (k) result[k.trim()] = v.join('=');
                        });
                        return result;
                    };
                    const cookies = getAllCookies();
                    const authSession = cookies['oai-client-auth-session'] || '';
                    const deviceId = cookies['oai-did'] || '';

                    let workspaceId = '';

                    // Thử decode từ cookie
                    if (authSession) {
                        try {
                            const segments = authSession.split('.');
                            const payload = segments[0];
                            const pad = '='.repeat((4 - (payload.length % 4)) % 4);
                            const decoded = atob(payload.replace(/-/g, '+').replace(/_/g, '/') + pad);
                            const parsed = JSON.parse(decoded);
                            const ws = (parsed.workspaces || [])[0];
                            workspaceId = (ws && ws.id) ? ws.id : '';
                        } catch(e) { }
                    }

                    // Fallback: parse từ HTML consent page (Regex tìm UUID)
                    if (!workspaceId) {
                        const matches = consentHtml.match(/"id"\\s*[:|,]\\s*"([0-9a-f-]{36})"/gi) || [];
                        for (const m of matches) {
                            const idMatch = m.match(/([0-9a-f-]{36})/i);
                            if (idMatch && idMatch[1]) { workspaceId = idMatch[1]; break; }
                        }
                    }

                    if (!workspaceId) {
                        return { ok: false, error: 'No workspace found in cookie or HTML', cookieKeys: Object.keys(cookies).join(',') };
                    }

                    const commonHeaders = {
                        'content-type': 'application/json',
                        'accept': 'application/json',
                        'referer': CONSENT_URL,
                        'origin': AUTH_BASE,
                        'oai-device-id': deviceId
                    };

                    // BƯỚC 3: POST workspace/select
                    const wsRes = await fetch(AUTH_BASE + '/api/accounts/workspace/select', {
                        method: 'POST',
                        credentials: 'include',
                        headers: commonHeaders,
                        body: JSON.stringify({ workspace_id: workspaceId }),
                        redirect: 'manual',
                    });

                    let continueUrl = '';
                    let wsData = {};
                    if (wsRes.status >= 300 && wsRes.status < 400) {
                        continueUrl = wsRes.headers.get('location') || '';
                    } else {
                        try {
                            wsData = await wsRes.json();
                            continueUrl = wsData.continue_url || wsData.redirect_uri || '';
                        } catch(_) { }
                    }

                    // BƯỚC 4: Nếu chưa có URL hoặc cần chọn Organization (giống any-auto-register)
                    const orgs = (wsData?.data?.orgs) || [];
                    if (!continueUrl && orgs.length > 0 && orgs[0].id) {
                        const orgId = orgs[0].id;
                        const orgBody = { org_id: orgId };
                        if (orgs[0].projects && orgs[0].projects[0]) {
                            orgBody.project_id = orgs[0].projects[0].id;
                        }

                        const orgRes = await fetch(AUTH_BASE + '/api/accounts/organization/select', {
                            method: 'POST',
                            credentials: 'include',
                            headers: commonHeaders,
                            body: JSON.stringify(orgBody),
                            redirect: 'manual'
                        });

                        if (orgRes.status >= 300 && orgRes.status < 400) {
                            continueUrl = orgRes.headers.get('location') || '';
                        } else {
                            try {
                                const orgData = await orgRes.json();
                                continueUrl = orgData.continue_url || orgData.redirect_uri || '';
                            } catch(_) { }
                        }
                    }

                    // BƯỚC 5: Follow redirects để tìm ?code=
                    let code = '';
                    let currentUrl = continueUrl;
                    if (currentUrl && !currentUrl.startsWith('http')) {
                        currentUrl = AUTH_BASE + currentUrl;
                    }

                    for (let i = 0; i < 10 && currentUrl; i++) {
                        if (currentUrl.includes('code=')) {
                            const u = new URL(currentUrl);
                            code = u.searchParams.get('code') || '';
                            if (code) break;
                        }
                        const rRes = await fetch(currentUrl, {
                            credentials: 'include',
                            redirect: 'manual',
                            headers: { 'accept': 'text/html,*/*' },
                        });
                        const loc = rRes.headers.get('location') || '';
                        if (!loc) {
                             // Thử parse body nếu là JSON
                             try {
                                 const b = await rRes.json();
                                 currentUrl = b.continue_url || b.redirect_uri || '';
                             } catch(_) { break; }
                        } else {
                            currentUrl = loc.startsWith('http') ? loc : AUTH_BASE + loc;
                        }
                    }

                    return { ok: !!code, code, workspaceId, wsStatus: wsRes.status, continueUrl, finalUrl: currentUrl };
                } catch(e) {
                    return { ok: false, error: e.message };
                }
            })();
            `, 40000);

            console.log(`[Connect] [C] [Technical: Background API Calls] Kết quả xử lý API ngầm:`, JSON.stringify(codeResult));

            if (codeResult?.code) {
                authCode = codeResult.code;
                console.log(`[Connect] ✅ OAuth code via workspace API: ${authCode.slice(0, 20)}...`);
                break;
            } else {
                console.log(`[Connect] ⚠️ Workspace API thất bại: ${codeResult?.error || JSON.stringify(codeResult)}`);
                await saveStep(tabId, userId, runDir, '08_error_need_phone');
                return sendConnectResult(task, 'error', 'NEED_PHONE: Tài khoản yêu cầu xác minh số điện thoại');
            }
        }

        if (oauthState?.hasEmailInput && !oauthLoginHandled) {
            console.log(`[Connect] [C] [Technical: DOM Manipulation] OAuth yêu cầu login lại → đang gán giá trị email nhanh vào ô input...`);
            const emailResult = await fillEmail(tabId, userId, email);
            console.log(`[Connect] [C] fillEmail result:`, JSON.stringify(emailResult));
            await new Promise(r => setTimeout(r, 3000));
            oauthLoginHandled = true;
            continue;
        }

        if (oauthState?.hasPasswordInput) {
            console.log(`[Connect] [C] [Technical: DOM Manipulation] Đang điền mật khẩu nhanh (thao tác trực tiếp vào cây DOM)...`);
            const passResult = await fillPassword(tabId, userId, password);
            console.log(`[Connect] [C] fillPassword result:`, JSON.stringify(passResult));
            await new Promise(r => setTimeout(r, 3500));
            continue;
        }

        if (oauthState?.hasMfaInput) {
            if (totpSecret) {
                console.log(`[Connect] [C] [Technical: DOM Manipulation] Đang sinh mã TOTP và điền mã 2FA nhanh vào ô input...`);
                const otp = await getFreshTOTP(totpSecret, 8);
                const mfaResult = await fillMfa(tabId, userId, otp);
                console.log(`[Connect] [C] fillMfa result:`, JSON.stringify(mfaResult));
                await new Promise(r => setTimeout(r, 4000));
                continue;
            } else {
                console.log(`[Connect] [C] ⚠️ MFA required nhưng không có secret`);
            }
        }

        // ── Nếu có nút consent/authorize → click ──
        if (currentUrl && currentUrl.includes('auth.openai.com') && !oauthState?.hasEmailInput && !oauthState?.hasPasswordInput && !oauthState?.hasMfaInput && !oauthState?.hasPhoneScreen) {
            console.log(`[Connect] [C] [Technical: Programmatic Click] Đang tìm và nhấn nút Allow/Authorize qua mã lệnh (hoặc API fallback)...`);

            // Inject script to extract exact workspace & org IDs and call API via fetch IF click doesn't redirect
            const codeResult = await evalJson(tabId, userId, `
            (async () => {
                const AUTH_BASE = 'https://auth.openai.com';
                const CONSENT_URL = AUTH_BASE + '/sign-in-with-chatgpt/codex/consent';

                const getAllCookies = () => {
                    const result = {};
                    document.cookie.split(';').forEach(c => {
                        const [k, ...v] = c.trim().split('=');
                        if (k) result[k.trim()] = v.join('=');
                    });
                    return result;
                };

                // THỬ CLICK BUTTON TRƯỚC (Cách 1)
                const isVisible = el => {
                    if (!el) return false;
                    const s = window.getComputedStyle(el);
                    const r = el.getBoundingClientRect();
                    return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
                };
                const btn = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]'))
                    .filter(isVisible)
                    .find(el => {
                        const t = (el.innerText || el.textContent || '').trim().toLowerCase();
                        return t.includes('allow') || t.includes('authorize') || t.includes('continue') || t.includes('accept') || t.includes('cho phép') || t.includes('chấp nhận');
                    });
                
                if (btn) { 
                    btn.click();
                    // Đợi 1 chút xem có redirect không, browser sẽ ngắt script này nếu page unload
                    await new Promise(r => setTimeout(r, 2000));
                }

                // NẾU VẪN Ở ĐÂY, THỬ GỌI API (Cách 2)
                try {
                    const cookies = getAllCookies();
                    const authSession = cookies['oai-client-auth-session'] || '';
                    const deviceId = cookies['oai-did'] || '';
                    let workspaceId = '';

                    // NẾU LÀ MÀN HÌNH WORKSPACE SELECTION HOẶC CONSENT
                    if (authSession) {
                        try {
                            const segments = authSession.split('.');
                            const payload = segments[0];
                            const pad = '='.repeat((4 - (payload.length % 4)) % 4);
                            const decoded = atob(payload.replace(/-/g, '+').replace(/_/g, '/') + pad);
                            const parsed = JSON.parse(decoded);
                            const ws = (parsed.workspaces || [])[0];
                            workspaceId = (ws && ws.id) ? ws.id : '';
                        } catch(e) { }
                    }

                    if (!workspaceId) {
                        const html = document.documentElement.innerHTML;
                        const matches = html.match(/"id"\\s*[:|,]\\s*"([0-9a-f-]{36})"/gi) || [];
                        for (const m of matches) {
                            const idMatch = m.match(/([0-9a-f-]{36})/i);
                            if (idMatch && idMatch[1]) { workspaceId = idMatch[1]; break; }
                        }
                    }

                    if (!workspaceId) {
                        return { ok: false, error: 'No workspace found to bypass consent manually' };
                    }

                    const commonHeaders = {
                        'content-type': 'application/json',
                        'accept': 'application/json',
                        'referer': location.href,
                        'origin': AUTH_BASE,
                        'oai-device-id': deviceId
                    };

                    const wsRes = await fetch(AUTH_BASE + '/api/accounts/workspace/select', {
                        method: 'POST',
                        credentials: 'include',
                        headers: commonHeaders,
                        body: JSON.stringify({ workspace_id: workspaceId }),
                        redirect: 'manual',
                    });

                    let continueUrl = wsRes.headers.get('location') || '';
                    let wsData = {};
                    if (!continueUrl) {
                        try {
                            wsData = await wsRes.json();
                            continueUrl = wsData.continue_url || wsData.redirect_uri || '';
                        } catch(_) {}
                    }

                    const orgs = (wsData?.data?.orgs) || [];
                    if (!continueUrl && orgs.length > 0 && orgs[0].id) {
                        let orgBody = { org_id: orgs[0].id };
                        if (orgs[0].projects && orgs[0].projects[0]) {
                            orgBody.project_id = orgs[0].projects[0].id;
                        }

                        const orgRes = await fetch(AUTH_BASE + '/api/accounts/organization/select', {
                            method: 'POST',
                            credentials: 'include',
                            headers: commonHeaders,
                            body: JSON.stringify(orgBody),
                            redirect: 'manual'
                        });
                        continueUrl = orgRes.headers.get('location') || '';
                        if (!continueUrl) {
                            try {
                                const orgData = await orgRes.json();
                                continueUrl = orgData.continue_url || orgData.redirect_uri || '';
                            } catch(_) {}
                        }
                    }

                    let code = '';
                    let tempUrl = continueUrl;
                    if (tempUrl && !tempUrl.startsWith('http')) tempUrl = AUTH_BASE + tempUrl;

                    for (let i = 0; i < 5 && tempUrl; i++) {
                        if (tempUrl.includes('code=')) {
                            code = new URL(tempUrl).searchParams.get('code') || '';
                            if (code) break;
                        }
                        const rRes = await fetch(tempUrl, { credentials: 'include', redirect: 'manual' });
                        const loc = rRes.headers.get('location');
                        if (!loc) {
                             // Thử parse body nếu là JSON
                             try {
                                 const b = await rRes.json();
                                 tempUrl = b.continue_url || b.redirect_uri || '';
                             } catch(_) { break; }
                        } else {
                            tempUrl = loc.startsWith('http') ? loc : AUTH_BASE + loc;
                        }
                    }

                    return { ok: !!code, code, method: btn ? 'click+api' : 'api_only' };
                } catch(e) {
                    return { ok: false, error: e.message, clicked: !!btn };
                }
            })();
            `, 15000);

            if (codeResult?.code) {
                authCode = codeResult.code;
                console.log(`[Connect] ✅ OAuth code extracted via injected API fallback: ${authCode.slice(0, 20)}...`);
                break;
            } else if (codeResult?.clicked || codeResult?.method === 'click+api') {
                console.log(`[Connect] [C] Clicked authorize/continue button.`);
            } else {
                console.log(`[Connect] [C] Failed auto-consent:`, JSON.stringify(codeResult));
            }
        }

        await new Promise(r => setTimeout(r, 1500));
    }

    await saveStep(tabId, userId, runDir, '08_oauth_callback');

    // ── BƯỚC D: Exchange code → tokens ──────────────────────────────────
    if (authCode) {
        console.log(`[Connect] [D] Exchanging code for tokens...`);
        try {
            const tokenData = await exchangeCodeForTokens(authCode, pkce, effectiveProxy);
            const accessToken = tokenData.access_token || '';
            const refreshToken = tokenData.refresh_token || '';
            const idToken = tokenData.id_token || '';
            const expiresIn = tokenData.expires_in || 0;

            console.log(`[Connect] ✅ Token exchange thành công!`);
            console.log(`[Connect]    access_token: ${accessToken ? accessToken.slice(0, 30) + '...' : 'MISSING'}`);
            console.log(`[Connect]    refresh_token: ${refreshToken ? refreshToken.slice(0, 20) + '...' : 'MISSING'}`);
            console.log(`[Connect]    id_token: ${idToken ? 'present' : 'MISSING'}`);
            console.log(`[Connect]    expires_in: ${expiresIn}s`);

            if (!accessToken) {
                return sendConnectResult(task, 'error', 'Token exchange trả về nhưng không có access_token');
            }

            const meta = extractAccountMeta(accessToken);
            console.log(`[Connect] ✅ Meta: id=${meta.accountId} plan=${meta.planType} email=${meta.email}`);

            // Lấy cookies (deviceId, sessionToken)
            let sessionToken = '';
            let deviceId = '';
            try {
                const ck = await camofoxGet(`/tabs/${tabId}/cookies?userId=${userId}`, 6000);
                const cookies = Array.isArray(ck?.cookies) ? ck.cookies : (Array.isArray(ck) ? ck : []);
                const sessC = cookies.find(c =>
                    c.name === '__Secure-next-auth.session-token' ||
                    c.name === 'next-auth.session-token' ||
                    (c.name && c.name.includes('session-token'))
                );
                sessionToken = sessC?.value || '';
                const deviceC = cookies.find(c => c.name === 'oai-device-id');
                deviceId = deviceC?.value || '';
            } catch (_) { }

            return sendConnectResult(task, 'success', 'OAuth PKCE login + token exchange thành công', {
                ...tokenData,        // Truyền full raw response: access_token, refresh_token, id_token, token_type, v.v..
                accessToken,         // Fallback cho backend cũ (tạm thời)
                refreshToken,
                idToken,
                sessionToken,
                deviceId,
                expiresIn,
                accountId: meta.accountId,
                userId: meta.userId,
                organizationId: meta.organizationId,
                planType: meta.planType,
                expiredAt: meta.expiredAt,
                email: meta.email || email,
            });

        } catch (exchangeErr) {
            console.error(`[Connect] ❌ Token exchange lỗi: ${exchangeErr.message}`);
            // Fallback: thử lấy từ session nếu exchange thất bại
            console.log(`[Connect] 🔄 Fallback: lấy token từ /api/auth/session...`);
        }
    } else {
        console.log(`[Connect] ⚠️ Không lấy được OAuth code, fallback lấy session token...`);
    }

    // ── FALLBACK: Lấy access token từ /api/auth/session (không có refresh_token) ──
    console.log(`[Connect] 🔄 Fallback: Dùng session endpoint...`);
    // Navigate về ChatGPT trước
    await navigate(tabId, userId, 'https://chatgpt.com', 10000);
    await new Promise(r => setTimeout(r, 2000));

    let accessToken = '';
    let sessionData = null;

    for (let attempt = 0; attempt < 5; attempt++) {
        if (attempt === 2) {
            await navigate(tabId, userId, 'https://chatgpt.com', 10000);
            await new Promise(r => setTimeout(r, 2000));
        }

        const delay = [1500, 2000, 3000, 4000, 5000][attempt];
        await new Promise(r => setTimeout(r, delay));

        const sessionRes = await fetchSessionInPage(tabId, userId);
        console.log(`[Connect] 🔍 Session probe #${attempt + 1}: status=${sessionRes?.status}, ok=${sessionRes?.ok}`);

        if (sessionRes?.ok && sessionRes.body && sessionRes.body.length > 10) {
            try {
                sessionData = JSON.parse(sessionRes.body);
                accessToken = sessionData?.accessToken || '';
                if (accessToken) {
                    console.log(`[Connect] ✅ Fallback: Lấy được access_token (no refresh_token)`);
                    break;
                }
            } catch (_) { }
        }
    }

    await saveStep(tabId, userId, runDir, '06_session_captured');

    if (!accessToken) {
        return sendConnectResult(task, 'error',
            `Cả OAuth PKCE và session fallback đều thất bại. SessionData keys: ${Object.keys(sessionData || {}).join(',') || 'empty'}`
        );
    }

    const meta = extractAccountMeta(accessToken);
    console.log(`[Connect] ⚠️ Fallback mode: CHỈ có access_token, KHÔNG có refresh_token`);

    // Lấy cookies
    let sessionToken = '';
    let deviceId = '';
    try {
        const ck = await camofoxGet(`/tabs/${tabId}/cookies?userId=${userId}`, 6000);
        const cookies = Array.isArray(ck?.cookies) ? ck.cookies : (Array.isArray(ck) ? ck : []);
        const sessC = cookies.find(c =>
            c.name === '__Secure-next-auth.session-token' ||
            c.name === 'next-auth.session-token' ||
            (c.name && c.name.includes('session-token'))
        );
        sessionToken = sessC?.value || '';
        const deviceC = cookies.find(c => c.name === 'oai-device-id');
        deviceId = deviceC?.value || '';
    } catch (_) { }

    await sendConnectResult(task, 'success', 'Đăng nhập thành công (fallback - chỉ access_token, không refresh_token)', {
        access_token: accessToken,
        refresh_token: '',
        accessToken,
        refreshToken: '', // ⚠️ Không có refresh_token trong fallback mode
        sessionToken,
        deviceId,
        accountId: meta.accountId,
        userId: meta.userId,
        organizationId: meta.organizationId,
        planType: meta.planType,
        expiredAt: meta.expiredAt,
        email: meta.email || email,
    });
}

// ================================================================
// SEND RESULT
// ================================================================
async function sendConnectResult(task, status, message, tokens = null) {
    const preview = message.slice(0, 100);
    console.log(`[Connect] 📡 ${status.toUpperCase()}: ${preview}`);
    try {
        const res = await fetch('http://localhost:4000/api/vault/accounts/connect-result', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: task.id, status, message, tokens }),
            signal: AbortSignal.timeout(30000),
        });
        console.log(`[Connect] 📡 Tools HTTP ${res.status}`);
    } catch (e) {
        console.log(`[Connect] ⚠️ sendResult failed: ${e.message}`);
    }
}

// ================================================================
// POLLING
// ================================================================
let activeConnect = 0;
const connectingIds = new Set();

async function fetchConnectTask() {
    try {
        const exclude = [...connectingIds].join(',');
        const res = await fetch(
            `http://localhost:4000/api/vault/accounts/connect-task${exclude ? `?exclude=${exclude}` : ''}`,
            { signal: AbortSignal.timeout(4000) }
        );
        if (res.ok) {
            const d = await res.json();
            return d?.task || null;
        }
    } catch (_) { }
    return null;
}

async function pollConnect() {
    if (activeConnect >= MAX_THREADS) return;
    try {
        const task = await fetchConnectTask();
        if (!task?.id || connectingIds.has(task.id)) return;

        connectingIds.add(task.id);
        activeConnect++;
        console.log(`[Connect] 🚀 Bắt đầu luồng: ${task.email} (${activeConnect}/${MAX_THREADS})`);

        runConnectFlow(task).finally(() => {
            activeConnect = Math.max(0, activeConnect - 1);
            connectingIds.delete(task.id);
            console.log(`[Connect] 🏁 Kết thúc luồng: ${task.email}`);
            if (activeConnect < MAX_THREADS) setTimeout(pollConnect, 1000);
        });

        if (activeConnect < MAX_THREADS) setTimeout(pollConnect, 2000);
    } catch (e) {
        console.error(`[Connect] Poll error: ${e.message}`);
    }
}

// ================================================================
// STARTUP
// ================================================================
console.log(`\n====================================`);
console.log(`🔌 SEELLM AUTO-CONNECT WORKER v2`);
console.log(`====================================`);
console.log(`CAMOFOX : ${CAMOUFOX_API}`);
console.log(`THREADS : ${MAX_THREADS}`);
console.log(`POLL    : ${POLL_INTERVAL_MS}ms`);
console.log(`====================================\n`);

setInterval(pollConnect, POLL_INTERVAL_MS);
pollConnect();
