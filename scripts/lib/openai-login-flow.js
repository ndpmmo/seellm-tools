/**
 * scripts/lib/openai-login-flow.js
 * 
 * Shared OpenAI login flow helpers (eval-based DOM manipulation).
 * Consolidated from auto-connect-worker for reuse in auto-login-worker.
 */

import { evalJson } from './camofox.js';

/**
 * Get page state (logged in status, form inputs, etc.)
 * @param {string} tabId - Tab ID
 * @param {string} userId - User ID
 * @returns {Promise<object>} Page state object
 */
export async function getState(tabId, userId) {
  const state = await evalJson(tabId, userId, `
    (() => {
      const href  = location.href;
      const host  = location.hostname;
      const body  = (document.body?.innerText || '').toLowerCase();
      const lowerUrl = href.toLowerCase();

      // ── Logged-in indicators (phải đủ chặt) ──
      const hasProfileBtn = !!(
        document.querySelector('[data-testid="profile-button"]') ||
        document.querySelector('[data-testid="user-menu-button"]') ||
        document.querySelector('[aria-label="Open user menu"]') ||
        document.querySelector('[aria-label="User menu"]')
      );
      const hasSignUpInPage = body.includes('sign up for free') || body.includes('sign up') || body.includes('đăng ký');
      const hasLogInBtn     = body.includes('log in') && !hasProfileBtn;

      // Dấu hiệu dự phòng: có "new chat" hoặc "search chats" mà KHÔNG CÓ "log in" hay "sign up"
      // (ChatGPT đôi khi không expose profile-button selector ngay sau khi login)
      const hasNewChat      = body.includes('new chat') || body.includes('search chats') || body.includes('chatgpt plus');

      const isConversation  = href.includes('/c/') || href.includes('/g/');
      // Trên chatgpt.com root mà không có auth/signup → coi như logged in (cookie còn hạn)
      const isChatgptHome   = (host === 'chatgpt.com' || host.endsWith('.chatgpt.com')) && (href.endsWith('chatgpt.com/') || href.endsWith('chatgpt.com'));
      const looksLoggedIn   = ((hasProfileBtn || hasNewChat) && !hasSignUpInPage && !hasLogInBtn) || isConversation || (isChatgptHome && !hasSignUpInPage && !hasLogInBtn);

      // ── Auth pages (auth.openai.com hoặc /auth/*) ──
      const onAuthDomain    = host.includes('auth.openai.com') || href.includes('/auth/');
      const hasEmailInput   = !!document.querySelector(
        'input[type="email"], input[name="username"], input[id="username"], input[name="email"], input[autocomplete="email"]'
      );
      const hasPasswordInput = !!document.querySelector(
        'input[type="password"], input[name="password"], input[id="password"], input[autocomplete="current-password"]'
      );

      // ── MFA: URL chứa /mfa hoặc có input one-time-code ──
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
      const hasPhoneScreen = isAddPhonePage ||
        body.includes('phone number required') || body.includes('add a phone number') ||
        body.includes('verify your phone') || body.includes('enter your phone') ||
        body.includes('phone number') || body.includes('add phone');

      // ── Error screen ──
      const hasError = body.includes('something went wrong') || body.includes('try again') ||
        document.querySelector('[class*="error"]') !== null;

      // Inline consent screen logic (was referencing Node function)
      const isConsentScr = (lowerUrl.includes('consent') && !lowerUrl.includes('/log-in')) ||
                           ((body.includes('authorize') || body.includes('allow')) && body.includes('continue'));

      return {
        href, host,
        looksLoggedIn, hasProfileBtn, hasSignUpInPage, hasLogInBtn, isConversation,
        onAuthDomain, hasEmailInput, hasPasswordInput, hasMfaInput,
        hasCookieBanner, hasPhoneScreen, hasError,
        isConsentScreen: isConsentScr,
        isWorkspaceScreen: lowerUrl.includes('/workspace') || lowerUrl.includes('sign-in-with-chatgpt') || body.includes('select workspace') || body.includes('choose workspace'),
        isOrganizationScreen: lowerUrl.includes('/organization') || body.includes('select organization') || body.includes('choose organization'),
      };
    })()
  `, 5000);
  return state;
}

/**
 * Fill email input and submit
 * @param {string} tabId - Tab ID
 * @param {string} userId - User ID
 * @param {string} email - Email address
 * @returns {Promise<object>} Result object
 */
export async function fillEmail(tabId, userId, email) {
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

/**
 * Fill password input and submit
 * @param {string} tabId - Tab ID
 * @param {string} userId - User ID
 * @param {string} password - Password
 * @returns {Promise<object>} Result object
 */
export async function fillPassword(tabId, userId, password) {
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

/**
 * Fill MFA/OTP input and submit
 * @param {string} tabId - Tab ID
 * @param {string} userId - User ID
 * @param {string} otp - 6-digit OTP code
 * @returns {Promise<object>} Result object
 */
export async function fillMfa(tabId, userId, otp) {
  const escaped = JSON.stringify(otp);
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

/**
 * Accept cookie banner if present
 * @param {string} tabId - Tab ID
 * @param {string} userId - User ID
 * @returns {Promise<boolean>} Whether button was clicked
 */
export async function tryAcceptCookies(tabId, userId) {
  return evalJson(tabId, userId, `
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

/**
 * Dismiss Google "Sign in with Google" popup overlay + click "Log in" button
 * @param {string} tabId - Tab ID
 * @param {string} userId - User ID
 * @returns {Promise<object>} Result object
 */
export async function dismissGooglePopupAndClickLogin(tabId, userId) {
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
        try { iframe.remove(); } catch (_) {}
      });
      if (googleIframes.length > 0) results.push('removed-google-iframes');

      // 2. Bấm nút "Log in" — ưu tiên data-testid="login-button" (UI mới)
      const allClickable = Array.from(document.querySelectorAll('button, a[role="button"], div[role="button"]')).filter(isVisible);
      const loginBtn =
        document.querySelector('button[data-testid="login-button"]') ||
        allClickable.find(el => {
          const t = (el.innerText || el.textContent || '').trim().toLowerCase();
          return t === 'log in' || t === 'login' || t === 'sign in';
        });
      if (loginBtn && isVisible(loginBtn)) {
        loginBtn.click();
        results.push('clicked-login-button');
      } else {
        results.push('no-login-button-found');
        results.push('visible-buttons: ' + allClickable.map(e => (e.innerText || '').trim()).filter(Boolean).slice(0, 10).join(' | '));
      }

      return { ok: results.some(r => r.startsWith('clicked')), actions: results };
    })()
  `, 5000);
}

/**
 * Wait for specific state flags to match expected values
 * @param {string} tabId - Tab ID
 * @param {string} userId - User ID
 * @param {object} expectedFlags - Object with expected state flags (e.g., { looksLoggedIn: true })
 * @param {object} options - { timeoutMs = 30000, intervalMs = 1500 }
 * @returns {Promise<object|null>} Final state object if match, null on timeout
 */
export async function waitForState(tabId, userId, expectedFlags, { timeoutMs = 30000, intervalMs = 1500 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = await getState(tabId, userId);
    const allMatch = Object.entries(expectedFlags).every(([key, expected]) => state[key] === expected);
    if (allMatch) return state;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return null;
}

/**
 * Normalize page text for comparison
 * @param {string} input - Raw HTML/text
 * @returns {string} Normalized lowercase text
 */
function normalizePageText(input = '') {
  return input.toLowerCase().replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');
}

/**
 * Check if current screen is phone verification screen
 * @param {string} url - Current URL
 * @param {string} snapshot - Page snapshot/text
 * @returns {boolean}
 */
export function isPhoneVerificationScreen(url = '', snapshot = '') {
  const cleanText = normalizePageText(snapshot);
  const lowerUrl = String(url || '').toLowerCase();
  return cleanText.includes('phone number required') ||
         cleanText.includes('add a phone number') ||
         cleanText.includes('verify your phone') ||
         cleanText.includes('enter your phone') ||
         (cleanText.includes('phone number') && cleanText.includes('one-time code')) ||
         (lowerUrl.includes('phone') && (cleanText.includes('verify') || cleanText.includes('continue')));
}

/**
 * Check if current screen is OAuth consent screen
 * @param {string} url - Current URL
 * @param {string} snapshot - Page snapshot/text
 * @returns {boolean}
 */
export function isConsentScreen(url = '', snapshot = '') {
  const lowerUrl = String(url || '').toLowerCase();
  const lowerHtml = String(snapshot || '').toLowerCase();
  if (lowerUrl.includes('/log-in') || lowerUrl.includes('/password') || lowerUrl.includes('/mfa-challenge')) {
    return false;
  }
  if (lowerUrl.includes('consent')) return true;
  return (lowerHtml.includes('authorize') || lowerHtml.includes('allow')) && lowerHtml.includes('continue');
}

/**
 * Check if current screen is auth/login-like screen
 * @param {string} url - Current URL
 * @param {string} snapshot - Page snapshot/text
 * @returns {boolean}
 */
export function isAuthLoginLikeScreen(url = '', snapshot = '') {
  const lowerUrl = String(url || '').toLowerCase();
  const cleanText = normalizePageText(snapshot);
  return lowerUrl.includes('/log-in') ||
         lowerUrl.includes('/password') ||
         lowerUrl.includes('/mfa-challenge') ||
         cleanText.includes('welcome back') ||
         cleanText.includes('enter your password') ||
         cleanText.includes('verify your identity');
}
