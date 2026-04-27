/**
 * SeeLLM Tools - Auto-Login Worker (Multi-thread)
 * 
 * Worker tự động poll task từ SeeLLM Gateway và thực hiện
 * Codex/OpenAI OAuth login thông qua Camofox Browser.
 * 
 * Flow:
 *  1. Poll task từ Gateway API
 *  2. Mở tab Camofox với proxy riêng
 *  3. Điều hướng đến OAuth URL
 *  4. Điền email → password → 2FA (nếu có) → Consent
 *  5. Bắt authorization code từ redirect URL
 *  6. Gửi kết quả về Gateway
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import { CAMOUFOX_API, GATEWAY_URL, WORKER_AUTH_TOKEN, POLL_INTERVAL_MS, MAX_THREADS } from './config.js';
import { camofoxPost, camofoxGet, camofoxDelete, evalJson, navigate, camofoxGoto, pressKey, tripleClick } from './lib/camofox.js';
import { getTOTP, getFreshTOTP } from './lib/totp.js';
import { extractIpFromText, normalizeProxyUrl, getLocalPublicIp, probeProxyExitIp, assertProxyApplied, isLocalRelayProxy } from './lib/proxy-diag.js';
import { createSaveStep } from './lib/screenshot.js';
import { getState, fillEmail, fillPassword, fillMfa, tryAcceptCookies, dismissGooglePopupAndClickLogin, waitForState, isPhoneVerificationScreen, isConsentScreen, isAuthLoginLikeScreen } from './lib/openai-login-flow.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR   = path.join(__dirname, '..');
const IMAGES_DIR = path.join(ROOT_DIR, 'data', 'screenshots');
const CHATGPT_LOGIN_DEBUG = process.env.CHATGPT_LOGIN_DEBUG === '1';

// ============================================
// TIỆN ÍCH
// ============================================

const CODEX_CONSENT_URL = 'https://auth.openai.com/sign-in-with-chatgpt/codex/consent';

function getTaskTotpSecret(task) {
  return task?.totpSecret || task?.twoFaSecret || task?.two_fa_secret || task?.secret || null;
}

function getFreshAuthBootstrapUrl(task) {
  return task?.loginUrl || task?.authUrl || CODEX_CONSENT_URL;
}

function isWorkspaceSessionError(url = '', snapshot = '') {
  const cleanText = snapshot.toLowerCase().replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');
  return cleanText.includes('workspaces not found in client auth session') ||
         cleanText.includes('oops, an error occurred');
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
  let safePayload = payload;
  try {
    safePayload = JSON.parse(JSON.stringify(payload, (key, value) => {
      if (['email', 'password', 'totp', 'totpSecret', 'twoFaSecret', 'two_fa_secret', 'secret'].includes(key)) return maskSensitive(value);
      if (typeof value === 'string' && value.includes(task?.email || '')) return value.replaceAll(task.email, maskSensitive(task.email));
      return value;
    }));
  } catch {}
  console.log(`[${task.email}] 🐞 ChatGPT login debug(${label}): ${JSON.stringify(safePayload).slice(0, 1600)}`);
}

async function captureChatgptLoginDialog(tabId, userId) {
  try {
    return await evalJson(tabId, userId, `
      (() => {
        const norm = (v) => (v || '').trim();
        const isVisible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        };
        const dialogs = Array.from(document.querySelectorAll('div[role=\"dialog\"]')).filter(isVisible);
        const mapped = dialogs.map((dialog) => ({
          text: norm((dialog.innerText || dialog.textContent || '').slice(0, 300)),
          fields: Array.from(dialog.querySelectorAll('input, button, a, [role=\"button\"]'))
            .filter(isVisible)
            .map((el) => ({
              tag: el.tagName.toLowerCase(),
              type: el.getAttribute('type'),
              name: el.getAttribute('name'),
              placeholder: el.getAttribute('placeholder'),
              aria: el.getAttribute('aria-label'),
              testId: el.getAttribute('data-testid'),
              text: norm(el.innerText || el.textContent || el.value || ''),
            }))
            .slice(0, 20),
        }));
        return { href: location.href, title: document.title, dialogs: mapped.slice(0, 4) };
      })()
    `, 5000);
  } catch (err) {
    return { error: err.message };
  }
}

async function captureWorkspaceDebugState(tabId, userId) {
  try {
    return await evalJson(tabId, userId, `
      (async () => {
        const sliceObj = (obj) => {
          const out = {};
          for (const [k, v] of Object.entries(obj || {}).slice(0, 30)) {
            out[k] = typeof v === 'string' ? v.slice(0, 300) : String(v).slice(0, 300);
          }
          return out;
        };

        const textOf = (el) => (el?.innerText || el?.textContent || '').trim();
        const buttons = Array.from(document.querySelectorAll('button, a, input[type="submit"]'))
          .map((el) => textOf(el))
          .filter(Boolean)
          .slice(0, 20);
        const forms = Array.from(document.forms || []).map((form) => ({
          action: form.action || '',
          method: form.method || 'get',
          inputNames: Array.from(form.querySelectorAll('input')).map((i) => i.name || i.id || i.type || '').slice(0, 20),
        })).slice(0, 10);
        const scripts = Array.from(document.scripts || [])
          .map((s) => (s.textContent || '').slice(0, 1200))
          .filter(Boolean)
          .slice(0, 8);
        const bodyText = (document.body?.innerText || '').slice(0, 2000);

        let authSession = null;
        try {
          const r = await fetch('https://chatgpt.com/api/auth/session', { credentials: 'include' });
          const txt = await r.text();
          authSession = { status: r.status, body: txt.slice(0, 2000) };
        } catch (e) {
          authSession = { error: String(e) };
        }

        return {
          href: location.href,
          title: document.title,
          bodyText,
          buttons,
          forms,
          localStorage: sliceObj(localStorage),
          sessionStorage: sliceObj(sessionStorage),
          authSession,
          scripts,
        };
      })()
    `, 8000);
  } catch (err) {
    return { error: err.message };
  }
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
          headers: {
            'content-type': 'application/json',
            ...(init.headers || {}),
          },
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

function extractOrganizationCandidates(payload = '') {
  const uuids = parseUuidMatches(payload);
  return uuids;
}

async function trySelectWorkspaceAndOrganization({ task, userId, tabId, saveStep }) {
  const candidates = await extractWorkspaceCandidates(tabId, userId);
  console.log(`[${task.email}] 🗂️ Workspace candidates: ${JSON.stringify(candidates).slice(0, 800)}`);

  if (!candidates.length) {
    return { ok: false, reason: 'no_workspace_candidates' };
  }

  for (const workspaceId of candidates) {
    const payloadVariants = [
      { workspace_id: workspaceId },
      { workspaceId },
      { id: workspaceId },
    ];

    for (const payload of payloadVariants) {
      const res = await tryFetchInPage(
        tabId,
        userId,
        'https://auth.openai.com/api/accounts/workspace/select',
        { method: 'POST', body: JSON.stringify(payload) },
        10000,
      );
      console.log(`[${task.email}] 🧩 workspace/select ${JSON.stringify(payload)} => ${JSON.stringify(res).slice(0, 800)}`);

      const bodyText = String(res?.body || '');
      if (!res?.ok) {
        if (bodyText.includes('invalid_auth_step')) {
          continue;
        }
        if (!bodyText.trim()) continue;
        continue;
      }

      await saveStep('workspace_selected');

      const orgCandidates = extractOrganizationCandidates(res?.body || '');
      if (orgCandidates.length) {
        for (const orgId of orgCandidates.slice(0, 5)) {
          for (const orgPayload of [{ organization_id: orgId }, { organizationId: orgId }, { id: orgId }]) {
            const orgRes = await tryFetchInPage(
              tabId,
              userId,
              'https://auth.openai.com/api/accounts/organization/select',
              { method: 'POST', body: JSON.stringify(orgPayload) },
              10000,
            );
            console.log(`[${task.email}] 🏢 organization/select ${JSON.stringify(orgPayload)} => ${JSON.stringify(orgRes).slice(0, 800)}`);
            if (orgRes?.ok) {
              await saveStep('organization_selected');
              return { ok: true, workspaceId, orgId, workspaceResponse: res, organizationResponse: orgRes };
            }
          }
        }
      }

      return { ok: true, workspaceId, workspaceResponse: res };
    }
  }

  return { ok: false, reason: 'workspace_select_failed', candidates };
}

async function inspectChatgptWebState(tabId, userId) {
  return evalJson(tabId, userId, `
    (() => {
      const bodyText = (document.body?.innerText || '').toLowerCase();
      const buttonTexts = Array.from(document.querySelectorAll('button, a, input[type="submit"]'))
        .map((el) => (el.innerText || el.textContent || '').trim())
        .filter(Boolean)
        .slice(0, 20);
      return {
        href: location.href,
        title: document.title,
        hasLoginButton: bodyText.includes('log in') || bodyText.includes('đăng nhập'),
        hasSignupButton: bodyText.includes('sign up') || bodyText.includes('đăng ký'),
        looksLoggedIn: !bodyText.includes('log in') && (
          bodyText.includes('new chat') ||
          bodyText.includes('search chats') ||
          bodyText.includes('what\\'s on your mind today')
        ),
        hasContinuePrompt: bodyText.includes('continue') || bodyText.includes('tiếp tục') || bodyText.includes('sử dụng tài khoản google'),
        buttonTexts,
      };
    })()
  `, 5000);
}

async function clickPreferredChatgptLogin(tabId, userId) {
  try {
    const evalRes = await evalJson(tabId, userId, `
      (() => {
        const isVisible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        };

        const preferred =
          document.querySelector('[data-testid="login-button"]') ||
          document.querySelector('header button[data-testid]') ||
          Array.from(document.querySelectorAll('button, a')).find((el) => {
            const txt = (el.innerText || el.textContent || '').trim().toLowerCase();
            return isVisible(el) && txt === 'log in';
          });

        if (!preferred) return { ok: false, reason: 'no-login-button' };
        preferred.click();
        return {
          ok: true,
          text: (preferred.innerText || preferred.textContent || '').trim(),
          testId: preferred.getAttribute('data-testid') || null,
        };
      })()
    `, 4000);
    return evalRes;
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function clickBestMatchingAction(tabId, userId, options = {}) {
  const {
    exactTexts = [],
    includesTexts = [],
    excludeTexts = [],
    timeoutMs = 4000,
  } = options;

  try {
    const payload = JSON.stringify({ exactTexts, includesTexts, excludeTexts });
    const result = await evalJson(tabId, userId, `
      (() => {
        const { exactTexts, includesTexts, excludeTexts } = ${payload};
        const norm = (v) => (v || '').trim().toLowerCase();
        const isVisible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        };

        const exact = exactTexts.map(norm);
        const includes = includesTexts.map(norm);
        const excludes = excludeTexts.map(norm);

        const candidates = Array.from(document.querySelectorAll('button, a, input[type="submit"], [role="button"]'))
          .filter(isVisible)
          .map((el) => {
            const text = norm(el.innerText || el.textContent || el.value || '');
            return { el, text, testId: el.getAttribute('data-testid') || '' };
          })
          .filter((x) => x.text && !excludes.some((t) => x.text.includes(t)));

        let winner =
          candidates.find((x) => x.testId && exact.includes(x.testId)) ||
          candidates.find((x) => exact.includes(x.text)) ||
          candidates.find((x) => includes.some((t) => x.text.includes(t)));

        if (!winner) {
          return { ok: false, reason: 'no-match', candidates: candidates.map((x) => ({ text: x.text, testId: x.testId })).slice(0, 20) };
        }

        winner.el.click();
        return { ok: true, text: winner.text, testId: winner.testId || null };
      })()
    `, timeoutMs);
    return result;
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function tryFillChatgptMfaForm(tabId, userId, task) {
  try {
    const totpSecret = getTaskTotpSecret(task);
    if (!totpSecret) return { ok: false, reason: 'no-totp-secret' };
    const { otp, remaining } = await getFreshTOTP(totpSecret, 10);
    const payload = JSON.stringify({ otp });
    const result = await evalJson(tabId, userId, `
      (() => {
        const { otp } = ${payload};
        const norm = (v) => (v || '').trim().toLowerCase();
        const isVisible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        };
        const setValue = (el, value) => {
          if (!el) return;
          el.focus();
          el.value = value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        };
        const bodyText = norm(document.body?.innerText || '');
        const pageUrl = norm(location.href);
        const pageTitle = norm(document.title);
        const isMfaStage = pageUrl.includes('/mfa-challenge') || pageTitle.includes('verify your identity') || bodyText.includes('one-time code');
        if (!isMfaStage) {
          return { ok: false, reason: 'not-mfa-stage', pageUrl, pageTitle };
        }
        const input = Array.from(document.querySelectorAll('input'))
          .find((el) => isVisible(el) && (
            (el.getAttribute('autocomplete') || '').toLowerCase() === 'one-time-code' ||
            (el.getAttribute('inputmode') || '').toLowerCase() === 'numeric' ||
            (el.getAttribute('type') || '').toLowerCase() === 'tel' ||
            (el.getAttribute('type') || '').toLowerCase() === 'text' ||
            norm(el.getAttribute('name') || '').includes('otp') ||
            norm(el.getAttribute('name') || '').includes('code') ||
            norm(el.getAttribute('placeholder') || '').includes('code') ||
            norm(el.getAttribute('aria-label') || '').includes('code')
          ));
        if (!input) {
          return { ok: false, reason: 'no-mfa-input', pageUrl, pageTitle };
        }
        setValue(input, otp);
        const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], [role="button"]'))
          .filter(isVisible)
          .map((el) => ({ el, text: norm(el.innerText || el.textContent || el.value || '') }));
        const continueBtn = buttons.find((x) => x.text === 'continue' || x.text.includes('continue') || x.text.includes('tiếp tục'));
        if (continueBtn) continueBtn.el.click();
        return {
          ok: true,
          stage: 'mfa',
          clicked: !!continueBtn,
          continueText: continueBtn?.text || null,
          inputName: input.getAttribute('name') || null,
          inputType: input.getAttribute('type') || null,
          pageUrl,
          pageTitle,
          remaining,
        };
      })()
    `, 5000);
    return result;
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function tryFillChatgptLoginForm(tabId, userId, task) {
  try {
    const payload = JSON.stringify({ email: task.email || '', password: task.password || '' });
    const result = await evalJson(tabId, userId, `
      (() => {
        const { email, password } = ${payload};
        const norm = (v) => (v || '').trim().toLowerCase();
        const isVisible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        };
        const setValue = (el, value) => {
          if (!el) return;
          el.focus();
          el.value = value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        };
        const dialogs = Array.from(document.querySelectorAll('div[role="dialog"]')).filter(isVisible);
        const loginDialog = dialogs.find((dialog) => {
          const text = norm(dialog.innerText || dialog.textContent || '');
          return dialog.querySelector('input[type="email"], input[name="email"], input[name="username"], input[type="password"]') || text.includes('log in or sign up');
        });
        const root = loginDialog || document;
        const pageUrl = norm(location.href);
        const pageTitle = norm(document.title);
        const pageText = norm(root.innerText || root.textContent || '');
        const isPasswordStage = pageUrl.includes('/password') || pageTitle.includes('enter your password') || pageText.includes('enter your password');
        const pick = (selectors) => selectors
          .map((selector) => root.querySelector(selector))
          .find((el) => isVisible(el));
        const buttons = Array.from(root.querySelectorAll('button, [role="button"], input[type="submit"]'))
          .filter(isVisible)
          .map((el) => ({
            el,
            text: norm(el.innerText || el.textContent || el.value || ''),
            testId: el.getAttribute('data-testid') || '',
          }));
        const pickContinue = () =>
          buttons.find((x) => x.testId === 'continue-button') ||
          buttons.find((x) => x.text === 'continue' || x.text === 'tiếp tục') ||
          buttons.find((x) => x.text.includes('continue')) ||
          buttons.find((x) => x.text.includes('tiếp tục'));

        const passwordInput = pick([
          'input[type="password"]',
          'input[name="password"]',
          'input[autocomplete="current-password"]'
        ]);
        const emailInput = !isPasswordStage ? pick([
          'input[type="email"]',
          'input[name="email"]',
          'input[name="username"]',
          'input[placeholder*="mail" i]',
          'input[autocomplete="username"]'
        ]) : null;

        if (passwordInput && password) {
          setValue(passwordInput, password);
          const continueBtn = pickContinue();
          if (continueBtn) continueBtn.el.click();
          return {
            ok: true,
            stage: 'password',
            clicked: !!continueBtn,
            continueText: continueBtn?.text || null,
            inputType: passwordInput.getAttribute('type') || null,
            pageUrl,
            pageTitle,
            rootText: pageText.slice(0, 120),
          };
        }

        if (emailInput && email) {
          setValue(emailInput, email);
          const continueBtn = pickContinue();
          if (continueBtn) continueBtn.el.click();
          return {
            ok: true,
            stage: 'email',
            clicked: !!continueBtn,
            continueText: continueBtn?.text || null,
            inputType: emailInput.getAttribute('type') || null,
            pageUrl,
            pageTitle,
            rootText: pageText.slice(0, 120),
          };
        }

        return {
          ok: false,
          reason: 'no-form-fields',
          pageUrl,
          pageTitle,
          isPasswordStage,
          buttons: buttons.map((x) => ({ text: x.text, testId: x.testId })).slice(0, 12),
          hasLoginDialog: !!loginDialog,
        };
      })()
    `, 5000);
    return result;
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function tryEstablishChatgptLoginSession({ task, userId, tabId, saveStep }) {
  console.log(`[${task.email}] 🌐 Thử thiết lập session đăng nhập tại chatgpt.com...`);

  try {
    await camofoxGoto(tabId, userId, 'https://chatgpt.com/', { timeoutMs: 18000 });
    await new Promise(r => setTimeout(r, 2500));
    await saveStep('chatgpt_home');
  } catch (err) {
    console.log(`[${task.email}] ⚠️ Không mở được chatgpt.com: ${err.message}`);
  }

  try {
    await camofoxPost(`/tabs/${tabId}/click`, {
      userId,
      selector: 'button:has-text("Accept all"), button:has-text("Accept"), button:has-text("Chấp nhận"), button:has-text("Đồng ý")',
    }, { timeoutMs: 2500 });
    console.log(`[${task.email}] 🍪 Đã thử accept cookie banner.`);
  } catch (_) {}

  let state = await inspectChatgptWebState(tabId, userId);
  console.log(`[${task.email}] 🌐 ChatGPT web state(before login): ${JSON.stringify(state).slice(0, 800)}`);
  debugChatgptLogin(task, 'state-before', state);
  debugChatgptLogin(task, 'dialogs-before', await captureChatgptLoginDialog(tabId, userId));

  for (let step = 0; step < 4; step++) {
    if (state?.looksLoggedIn) {
      await saveStep('chatgpt_logged_in');
      break;
    }

    if (state?.hasLoginButton) {
      const loginClick = await clickPreferredChatgptLogin(tabId, userId);
      if (loginClick?.ok) {
        console.log(`[${task.email}] 🔐 Đã bấm Log in trên ChatGPT web: ${JSON.stringify(loginClick).slice(0, 200)}`);
        debugChatgptLogin(task, `clicked-login-${step + 1}`, loginClick);
        await new Promise(r => setTimeout(r, 2500));
        await saveStep(`chatgpt_clicked_login_${step + 1}`);
        debugChatgptLogin(task, `dialogs-after-login-${step + 1}`, await captureChatgptLoginDialog(tabId, userId));
      } else {
        console.log(`[${task.email}] ⚠️ Không bấm được Log in: ${loginClick?.error || loginClick?.reason || 'unknown'}`);
      }
    }

    const filledLoginForm = await tryFillChatgptLoginForm(tabId, userId, task);
    if (filledLoginForm?.ok) {
      console.log(`[${task.email}] ✍️ Đã điền form đăng nhập ChatGPT web: ${JSON.stringify(filledLoginForm).slice(0, 200)}`);
      debugChatgptLogin(task, `filled-form-${step + 1}`, { ...filledLoginForm, email: task.email, password: task.password });
      await new Promise(r => setTimeout(r, 2500));
      await saveStep(`chatgpt_modal_${filledLoginForm.stage}_${step + 1}`);
      debugChatgptLogin(task, `dialogs-after-fill-${step + 1}`, await captureChatgptLoginDialog(tabId, userId));
    } else {
      console.log(`[${task.email}] ℹ️ Không thấy form email/password ChatGPT web: ${filledLoginForm?.reason || filledLoginForm?.error || 'no-op'}`);
    }

    let filledMfaForm = null;
    if (!filledLoginForm?.ok) {
      filledMfaForm = await tryFillChatgptMfaForm(tabId, userId, task);
      if (filledMfaForm?.ok) {
        console.log(`[${task.email}] 🔢 Đã điền MFA ChatGPT web: ${JSON.stringify({ ...filledMfaForm, otp: '******' }).slice(0, 200)}`);
        debugChatgptLogin(task, `filled-mfa-${step + 1}`, { ...filledMfaForm, otp: '******' });
        await new Promise(r => setTimeout(r, 2500));
        await saveStep(`chatgpt_modal_${filledMfaForm.stage}_${step + 1}`);
      } else if (filledMfaForm?.reason && filledMfaForm.reason !== 'not-mfa-stage' && filledMfaForm.reason !== 'no-totp-secret') {
        console.log(`[${task.email}] ℹ️ Không điền được MFA ChatGPT web: ${filledMfaForm.reason || filledMfaForm.error || 'no-op'}`);
      }
    }

    if ((!filledLoginForm?.ok || !filledLoginForm?.clicked) && (!filledMfaForm?.ok || !filledMfaForm?.clicked)) {
      const continueClick = await clickBestMatchingAction(tabId, userId, {
        exactTexts: ['continue', 'tiếp tục'],
        includesTexts: ['continue with google', 'tiếp tục với google'],
        excludeTexts: ['close', 'đóng', 'continue with apple', 'continue with phone'],
        timeoutMs: 4000,
      });
      if (continueClick?.ok) {
        console.log(`[${task.email}] 🪪 Đã bấm Continue trên prompt đăng nhập web: ${JSON.stringify(continueClick).slice(0, 200)}`);
        debugChatgptLogin(task, `continue-click-${step + 1}`, continueClick);
        await new Promise(r => setTimeout(r, 2500));
        await saveStep(`chatgpt_continue_prompt_${step + 1}`);
        debugChatgptLogin(task, `dialogs-after-continue-${step + 1}`, await captureChatgptLoginDialog(tabId, userId));
      } else {
        console.log(`[${task.email}] ℹ️ Không có nút Continue phù hợp: ${continueClick?.reason || continueClick?.error || 'no-op'}`);
      }
    }

    state = await inspectChatgptWebState(tabId, userId);
    console.log(`[${task.email}] 🌐 ChatGPT web state(step ${step + 1}): ${JSON.stringify(state).slice(0, 800)}`);
    debugChatgptLogin(task, `state-step-${step + 1}`, state);
  }

  const authProbe = await tryFetchInPage(tabId, userId, 'https://chatgpt.com/api/auth/session');
  console.log(`[${task.email}] 🌐 ChatGPT auth/session after web login flow: ${JSON.stringify(authProbe).slice(0, 800)}`);

  return { state, authProbe };
}

async function tryBootstrapWorkspaceSession({ task, userId, tabId, saveStep }) {
  console.log(`[${task.email}] 🧭 Bắt đầu bootstrap workspace session...`);

  const before = await captureWorkspaceDebugState(tabId, userId);
  console.log(`[${task.email}] 🧪 Workspace debug(before): ${JSON.stringify(before).slice(0, 1200)}`);

  const directWorkspaceSelection = await trySelectWorkspaceAndOrganization({
    task,
    userId,
    tabId,
    saveStep,
  });
  console.log(`[${task.email}] 🧩 Direct workspace selection: ${JSON.stringify(directWorkspaceSelection).slice(0, 1200)}`);

  if (directWorkspaceSelection?.ok) {
    try {
      await camofoxGoto(tabId, userId, CODEX_CONSENT_URL, { timeoutMs: 15000 });
      await new Promise(r => setTimeout(r, 2500));
      await saveStep('workspace_selected_back_to_consent');
    } catch (err) {
      console.log(`[${task.email}] ⚠️ Quay lại consent sau workspace/select lỗi: ${err.message}`);
    }
  }

  const authSessionProbe = await tryFetchInPage(tabId, userId, 'https://chatgpt.com/api/auth/session');
  console.log(`[${task.email}] 🌐 auth/session probe: ${JSON.stringify(authSessionProbe).slice(0, 800)}`);

  const webLoginState = await tryEstablishChatgptLoginSession({
    task,
    userId,
    tabId,
    saveStep,
  });

  try {
    await camofoxGoto(tabId, userId, 'https://chatgpt.com/', { timeoutMs: 15000 });
    await new Promise(r => setTimeout(r, 2500));
    await saveStep('workspace_bootstrap_home');
  } catch (err) {
    console.log(`[${task.email}] ⚠️ Không mở được chatgpt.com để bootstrap: ${err.message}`);
  }

  const afterHomeProbe = await tryFetchInPage(tabId, userId, 'https://chatgpt.com/api/auth/session');
  console.log(`[${task.email}] 🌐 auth/session sau khi mở home: ${JSON.stringify(afterHomeProbe).slice(0, 800)}`);

  try {
    const retryEval = await evalJson(tabId, userId, `
      (() => {
        const textOf = (el) => (el?.innerText || el?.textContent || '').toLowerCase().trim();
        const candidates = Array.from(document.querySelectorAll('button, a, input[type="submit"]'));
        const retryBtn = candidates.find((el) => textOf(el).includes('try again'));
        if (retryBtn) {
          retryBtn.click();
          return { action: 'clicked-try-again' };
        }
        return { action: 'no-retry-button' };
      })()
    `, 3000);
    console.log(`[${task.email}] 🔁 Try-again action: ${JSON.stringify(retryEval)}`);
  } catch (err) {
    console.log(`[${task.email}] ⚠️ Try-again eval lỗi: ${err.message}`);
  }

  const freshAuthUrl = getFreshAuthBootstrapUrl(task);
  try {
    await camofoxGoto(tabId, userId, freshAuthUrl, { timeoutMs: 18000 });
    await new Promise(r => setTimeout(r, 2500));
    await saveStep(freshAuthUrl === CODEX_CONSENT_URL ? 'workspace_bootstrap_back_to_consent' : 'workspace_bootstrap_fresh_authorize');
    console.log(`[${task.email}] 🔁 Đã khởi động lại auth flow bằng URL mới: ${freshAuthUrl}`);
  } catch (err) {
    console.log(`[${task.email}] ⚠️ Khởi động lại auth flow sau bootstrap lỗi: ${err.message}`);
  }

  const after = await captureWorkspaceDebugState(tabId, userId);
  console.log(`[${task.email}] 🧪 Workspace debug(after): ${JSON.stringify(after).slice(0, 1200)}`);

  return { before, after, authSessionProbe, afterHomeProbe, webLoginState, directWorkspaceSelection };
}

async function tryBypassPhoneRequirement({ task, userId, tabId, sessionKey, proxyUrl, saveStep }) {
  console.log(`[${task.email}] 📵 Gặp add_phone → thử mở lại luồng consent trong cùng session...`);
  await saveStep('gap_add_phone');

  let bypassTabId = tabId;
  let openedExtraTab = false;
  try {
    try {
      let cookieSnap;
      try {
        cookieSnap = await camofoxGet(`/tabs/${tabId}/cookies?userId=${userId}`, { timeoutMs: 4000 });
      } catch (_) {
        cookieSnap = await camofoxGet(`/sessions/${userId}/cookies`, { timeoutMs: 4000 });
      }
      const cookieCount = Array.isArray(cookieSnap?.cookies) ? cookieSnap.cookies.length : Array.isArray(cookieSnap) ? cookieSnap.length : 0;
      console.log(`[${task.email}] 🍪 Session hiện tại có ${cookieCount} cookie trước khi thử bypass.`);
    } catch (err) {
      console.log(`[${task.email}] ⚠️ Không đọc được cookies trước bypass: ${err.message}`);
    }

    try {
      const gotoRes = await camofoxGoto(bypassTabId, userId, CODEX_CONSENT_URL, { timeoutMs: 15000 });
      console.log(`[${task.email}] ↪️ Đã goto trực tiếp sang consent trên tab hiện tại: ${gotoRes.finalUrl || CODEX_CONSENT_URL}`);
    } catch (gotoErr) {
      console.log(`[${task.email}] ⚠️ Goto trên tab hiện tại thất bại, mở tab consent mới: ${gotoErr.message}`);
      const opened = await camofoxPost('/tabs', {
        userId,
        sessionKey,
        url: CODEX_CONSENT_URL,
        proxy: proxyUrl || undefined,
        persistent: false,
        os: 'macos',
        screen: { width: 1440, height: 900 },
        humanize: true,
        headless: false,
        randomFonts: true,
        canvas: 'random',
      }, { timeoutMs: 15000 });
      bypassTabId = opened.tabId;
      openedExtraTab = true;
      console.log(`[${task.email}] ↪️ Đã mở tab consent mới: ${bypassTabId}`);
    }

    await new Promise(r => setTimeout(r, 3000));
    await saveStep('thu_consent_bypass');

    let bootstrapAttempts = 0;
    const MAX_BOOTSTRAP_ATTEMPTS = 2;

    for (let i = 0; i < 20; i++) {
      const snap = await camofoxGet(`/tabs/${bypassTabId}/snapshot?userId=${userId}`);
      const currentUrl = snap.url || '';
      const snapshot = snap.snapshot || '';

      if (CHATGPT_LOGIN_DEBUG) {
        console.log(`[${task.email}] 🧭 bypass-loop #${i + 1}: ${currentUrl}`);
      }

      if (currentUrl.includes('localhost:1455') || currentUrl.includes('code=')) {
        console.log(`[${task.email}] ✅ Bypass add_phone thành công, đã nhận redirect.`);
        await saveStep('bypass_thanh_cong');
        return currentUrl;
      }

      if (isWorkspaceSessionError(currentUrl, snapshot)) {
        if (bootstrapAttempts >= MAX_BOOTSTRAP_ATTEMPTS) {
          console.log(`[${task.email}] ⚠️ Đã thử bootstrap ${bootstrapAttempts} lần, vẫn lỗi workspace → bỏ qua.`);
          break;
        }
        bootstrapAttempts++;
        const workspaceState = await tryBootstrapWorkspaceSession({
          task,
          userId,
          tabId: bypassTabId,
          saveStep,
        });
        console.log(`[${task.email}] 🧩 Workspace bootstrap result: ${JSON.stringify(workspaceState).slice(0, 1200)}`);

        const afterBootstrap = await camofoxGet(`/tabs/${bypassTabId}/snapshot?userId=${userId}`, { timeoutMs: 6000 });
        const afterBootstrapUrl = afterBootstrap.url || '';
        const afterBootstrapText = afterBootstrap.snapshot || '';

        if (afterBootstrapUrl.includes('localhost:1455') || afterBootstrapUrl.includes('code=')) {
          console.log(`[${task.email}] ✅ Bootstrap workspace thành công, đã nhận redirect.`);
          await saveStep('workspace_bootstrap_success');
          return afterBootstrapUrl;
        }

        if (isConsentScreen(afterBootstrapUrl, afterBootstrapText)) {
          console.log(`[${task.email}] 🔓 Sau bootstrap đã quay lại consent, tiếp tục vòng authorize.`);
        } else if (normalizePageText(afterBootstrapText).includes('workspaces not found in client auth session')) {
          console.log(`[${task.email}] ⚠️ Sau bootstrap vẫn thiếu workspace trong auth session.`);
        }
      }

      if (isPhoneVerificationScreen(currentUrl, snapshot)) {
        console.log(`[${task.email}] 📵 Bypass auth quay lại màn phone verification (hard gate).`);
        return null;
      }

      if (isAuthLoginLikeScreen(currentUrl, snapshot)) {
        const filledLogin = await tryFillChatgptLoginForm(bypassTabId, userId, task);
        if (filledLogin?.ok) {
          console.log(`[${task.email}] 🔐 Bypass auth: đã điền ${filledLogin.stage} trên auth page.`);
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }
        if (filledLogin?.reason && filledLogin.reason !== 'no-form-fields') {
          console.log(`[${task.email}] ℹ️ Bypass auth login-form: ${filledLogin.reason}`);
        }

        const filledMfa = await tryFillChatgptMfaForm(bypassTabId, userId, task);
        if (filledMfa?.ok) {
          console.log(`[${task.email}] 🔢 Bypass auth: đã điền MFA trên auth page.`);
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }

        if (filledMfa?.reason) {
          console.log(`[${task.email}] ℹ️ Bypass auth mfa-form: ${filledMfa.reason}`);
        }

        if (filledLogin?.reason === 'no-form-fields' && filledMfa?.reason === 'no-totp-secret') {
          console.log(`[${task.email}] ⚠️ Bypass auth không có TOTP secret trong task, không thể vượt MFA ở vòng bypass.`);
        }
      }

      if (isConsentScreen(currentUrl, snapshot)) {
        console.log(`[${task.email}] 🔓 Tab bypass đang ở consent/authorize → thử bấm Allow/Continue.`);
        const consentClick = await clickBestMatchingAction(bypassTabId, userId, {
          exactTexts: ['authorize', 'allow', 'continue', 'tiếp tục'],
          excludeTexts: ['close', 'đóng'],
          timeoutMs: 4000,
        });
        if (!consentClick?.ok) {
          console.log(`[${task.email}] ℹ️ Không có nút consent phù hợp: ${consentClick?.reason || consentClick?.error || 'no-op'}`);
        } else {
          console.log(`[${task.email}] ✅ Đã bấm consent button: ${JSON.stringify(consentClick).slice(0, 200)}`);
        }

        try {
          const evalRes = await evalJson(
            bypassTabId,
            userId,
            `
              (() => {
                const textOf = (el) => (el?.innerText || el?.textContent || '').toLowerCase().trim();
                const isVisible = (el) => {
                  if (!el) return false;
                  const style = window.getComputedStyle(el);
                  const rect = el.getBoundingClientRect();
                  return style && style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
                };

                const candidates = Array.from(document.querySelectorAll('button, input[type="submit"], [role="button"], a'));
                const target = candidates.find((el) => {
                  const txt = textOf(el);
                  return isVisible(el) && (
                    txt.includes('authorize') ||
                    txt.includes('allow') ||
                    txt.includes('continue')
                  );
                });

                if (target) {
                  target.click();
                  return { action: 'clicked-target', text: textOf(target) };
                }

                const form = document.querySelector('form');
                if (form && typeof form.requestSubmit === 'function') {
                  form.requestSubmit();
                  return { action: 'submitted-form' };
                }

                return { action: 'no-op', url: location.href };
              })()
            `,
            3000,
          );
          console.log(`[${task.email}] 🧠 Eval consent fallback: ${JSON.stringify(evalRes).slice(0, 160)}`);
        } catch (evalErr) {
          console.log(`[${task.email}] ⚠️ Eval consent fallback lỗi: ${evalErr.message}`);
        }
      }

      await new Promise(r => setTimeout(r, 2000));
    }

    console.log(`[${task.email}] ⚠️ Bypass add_phone không ra được redirect/code.`);
    return null;
  } catch (err) {
    console.log(`[${task.email}] ⚠️ Bypass add_phone lỗi: ${err.message}`);
    return null;
  } finally {
    if (openedExtraTab && bypassTabId) {
      try {
        await camofoxDelete(`/tabs/${bypassTabId}?userId=${userId}`);
      } catch (_) {}
    }
  }
}

// ============================================
// LOGIN FLOW
// ============================================

/** Đợi selector xuất hiện trên trang bằng cách poll snapshot định kỳ (Ổn định, có Auto-Healing) */
async function waitForSelector(tabId, userId, selectorPatterns, timeoutMs = 25000) {
  console.log(`[Wait] Đợi selector: ${selectorPatterns.join(', ')}...`);
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const snap = await camofoxGet(`/tabs/${tabId}/snapshot?userId=${userId}`);
    const html = (snap.snapshot || '').toLowerCase();

    // [AUTO-HEALING] Phát hiện sớm các lỗi UI để thoát ngay, không chờ timeout
    const cleanText = html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');
    if (cleanText.includes('email is required') || cleanText.includes('enter a valid email')) throw new Error("Lỗi UI: Email không hợp lệ hoặc bị trống.");
    if (cleanText.includes('wrong email') || cleanText.includes('we could not find your account')) throw new Error("Lỗi UI: Account không tồn tại.");
    if (cleanText.includes('wrong password') || cleanText.includes('incorrect password')) throw new Error("Lỗi UI: Sai mật khẩu.");
    if (cleanText.includes('suspicious login behavior') || cleanText.includes('we have detected suspicious')) throw new Error("Lỗi UI: IP Proxy bị đánh dấu Suspicious.");
    if (cleanText.includes('access denied')) throw new Error("Lỗi UI: Access Denied (Cloudflare Block).");
    if (cleanText.includes('phone number required') || cleanText.includes('add a phone number')) throw new Error("NEED_PHONE: Xác minh SĐT.");

    // Kiểm tra các mẫu selector được yêu cầu
    for (const pat of selectorPatterns) {
      if (html.includes(pat.toLowerCase())) {
        console.log(`[Wait] ✅ Thấy selector: ${pat}`);
        return true;
      }
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  return false;
}

async function runLoginFlow(task) {
  const accountId = task.id;
  console.log(`\n[${new Date().toLocaleTimeString()}] [*] Bắt đầu xử lý đăng nhập cho: ${task.email}`);
  console.log(`[${new Date().toLocaleTimeString()}] [1] Khởi tạo trình duyệt Camofox...`);
  const account = task;
  const effectiveProxy = normalizeProxyUrl(account.proxyUrl || account.proxy || null);
  if (effectiveProxy) {
    account.proxyUrl = effectiveProxy;
    account.proxy = effectiveProxy;
  }
  const USER_ID = `seellm_worker_${task.id}`;
  const SESSION_KEY = `codex_${task.id}`;
  let tabId;

  console.log(`\n===========================================`);
  if (!account.email || account.email.trim() === '') {
    console.log(`[!] Lỗi: Tài khoản ID ${task.id} không có Email. Bỏ qua.`);
    console.log(`===========================================`);
    throw new Error('Missing Email Address in record');
  }
  console.log(`[*] Bắt đầu xử lý: ${account.email}`);
  if (effectiveProxy) console.log(`[*] Proxy: ${effectiveProxy}`);
  console.log(`===========================================`);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const runDir = path.join(IMAGES_DIR, `run_${task.id}_${timestamp}`);
  await fs.mkdir(runDir, { recursive: true });

  let saveStep = null;
  let preFlightResult = null;

  try {
    // 🔒 [PreFlight] Assert proxy applied BEFORE creating main tab
    if (effectiveProxy) {
      console.log(`🔒 [PreFlight] Asserting proxy applied: ${effectiveProxy}`);
      try {
        preFlightResult = await assertProxyApplied(effectiveProxy);
        console.log(`✅ [PreFlight] OK — Exit IP: ${preFlightResult.exitIp} (${preFlightResult.networkType})${preFlightResult.isLocalRelay ? ' 🔒 LOCAL RELAY' : ''}`);
      } catch (err) {
        console.log(`🛑 [PreFlight] FAILED: ${err.message}`);
        throw err;  // hard abort, don't even try main tab
      }
    }

    // 1. Mở tab với proxy
    const loginUrl = account.loginUrl || account.authUrl || 'https://chatgpt.com/auth/login';
    console.log(`[1] Mở URL: ${loginUrl}`);
    const { tabId: tid, userAgent: browserUA } = await camofoxPost('/tabs', {
      userId: USER_ID,
      sessionKey: SESSION_KEY,
      url: loginUrl,
      proxy: effectiveProxy || undefined,
      // --- CẤU HÌNH ẨN DANH NÂNG CAO & SẠCH TUYỆT ĐỐI ---
      persistent: false,
      os: 'macos',
      screen: { width: 1440, height: 900 },
      humanize: true,
      headless: false,
      randomFonts: true,
      canvas: 'random',
    });
    tabId = tid;
    const userAgent = browserUA;
    console.log(`[1] Tab mở thành công: ${tabId} (UA: ${userAgent?.substring(0, 30)}...)`);

    saveStep = createSaveStep(runDir, { tabId, userId: USER_ID });
    // Chờ hệ thống khởi động (2 giây) thay vì 15 giây tốn thời gian, sau đó dùng waitForSelector
    await new Promise(r => setTimeout(r, 2000));

    // 🔍 [PostVerify] Re-probe to confirm session inherited proxy
    if (effectiveProxy && preFlightResult) {
      console.log(`🔍 [PostVerify] Verifying proxy applied after tab creation...`);
      const verifyCheck = await probeProxyExitIp(USER_ID, effectiveProxy, true);  // reuse session
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

    await saveStep('khoi_dong');

    // 2. Nhận diện và Xử lý trang Email
    const emailSelectors = ['username', 'email-input', 'email', 'identifier'];
    const hasEmailField = await waitForSelector(tabId, USER_ID, emailSelectors, 30000);
    
    if (!hasEmailField) {
      // Có thể đang kẹt ở màn hình Welcome hoặc Cloudflare
      console.log(`[2] ⚠️ Không thấy ô Email ngay lập tức, thử bấm "Log in" nếu có...`);
      try {
        await camofoxPost(`/tabs/${tabId}/click`, { userId: USER_ID, selector: 'button:has-text("Log in"), a:has-text("Log in")' });
        await new Promise(r => setTimeout(r, 5000));
      } catch(e) {}
    }

    console.log(`[2] Điền email: ${account.email}`);
    const emailInputSelector = 'input[name="username"], #username, input[type="email"], #email-input, input[name="email-input"], input[name="email"]';
    await camofoxPost(`/tabs/${tabId}/type`, {
      userId: USER_ID,
      selector: emailInputSelector,
      text: account.email,
    });
    await saveStep('da_dien_email');

    console.log(`[3] Bấm nút Continue (bằng Enter)...`);
    await pressKey(tabId, USER_ID, 'Enter');
    // Backup click nếu Enter không hoạt động
    try {
      await camofoxPost(`/tabs/${tabId}/click`, {
        userId: USER_ID,
        selector: 'button[type="submit"]',
      });
    } catch(e) {}
    
    await new Promise(r => setTimeout(r, 1000)); // Đợi React xử lý click
    await saveStep('sau_email');

    // 3. Đợi và điền Password
    const hasPasswordField = await waitForSelector(tabId, USER_ID, ['password', 'passwd'], 25000);
    if (!hasPasswordField) {
      // OpenAI thi thoảng bắt chọn "Personal account" hoặc có màn hình trung gian
      console.log(`[4] ⚠️ Chưa thấy ô Password, thử bấm Enter lần nữa hoặc click lân cận...`);
      await pressKey(tabId, USER_ID, 'Enter');
      await new Promise(r => setTimeout(r, 5000));
    }

    console.log(`[4] Điền password...`);
    await camofoxPost(`/tabs/${tabId}/type`, {
      userId: USER_ID,
      selector: 'input[type="password"], input[name="password"], #password',
      text: account.password,
    });
    await saveStep('da_dien_password');

    console.log(`[5] Gửi mật khẩu (bằng Enter)...`);
    await pressKey(tabId, USER_ID, 'Enter');
    // Backup click nếu Enter không kích hoạt form
    try {
      await camofoxPost(`/tabs/${tabId}/click`, {
        userId: USER_ID,
        selector: 'button[type="submit"]',
      });
    } catch(e) {}
    
    await new Promise(r => setTimeout(r, 2000)); // Đợi điều hướng sau mật khẩu
    await saveStep('sau_password');

    // 4. Phát hiện màn hình sau khi đăng nhập: 2FA hoặc SĐT
    // ─────────────────────────────────────────────────────────
    // ✅ 2FA/MFA (Xác thực hai bước): Sinh mã TOTP từ secret → Nhập vào ô → Bình thường
    // ❌ Phone Verification (Xác minh SĐT): OpenAI yêu cầu gắn số điện thoại → THẤT BẠI ngay
    // ─────────────────────────────────────────────────────────
    let redirectUrl = null;
    let isAtMFA = false;
    for (let j = 0; j < 5; j++) {
      const snapData = await camofoxGet(`/tabs/${tabId}/snapshot?userId=${USER_ID}`);
      const snap2Url = (snapData.url || '').toLowerCase();
      const snapText = (snapData.snapshot || '').toLowerCase();
      const cleanMfaText = snapText.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');

      // ❌ Phát hiện màn hình xác minh SĐT → Báo thất bại ngay, không tiếp tục
      const isPhoneScreen = cleanMfaText.includes('phone number required') ||
                            cleanMfaText.includes('add a phone number') ||
                            cleanMfaText.includes('verify your phone') ||
                            snap2Url.includes('/phone');
      if (isPhoneScreen) {
        redirectUrl = await tryBypassPhoneRequirement({
          task,
          userId: USER_ID,
          tabId,
          sessionKey: SESSION_KEY,
          proxyUrl: account.proxyUrl || account.proxy || undefined,
          saveStep,
        });
        if (redirectUrl) break;
        console.log(`[${task.email}] 📵 Bypass add_phone thất bại (trước 2FA) → báo lỗi như cũ.`);
        await saveStep('yeu_cau_so_dien_thoai');
        await sendResultToGateway(task, 'error', 'NEED_PHONE: Tài khoản yêu cầu xác minh số điện thoại', null);
        return;
      }

      // ✅ Phát hiện màn hình 2FA (TOTP/Authenticator) → Xử lý bình thường
      isAtMFA = snap2Url.includes('mfa') || snap2Url.includes('/verify') ||
                snapText.includes('one-time code') || snapText.includes('authenticator') ||
                snapText.includes('enter the code');

      if (isAtMFA) break;
      if (snap2Url.includes('localhost:1455') || snap2Url.includes('code=')) break;
      await new Promise(r => setTimeout(r, 2000));
    }

    if (!redirectUrl && isAtMFA) {
      console.log(`[${task.email}] 🛡️ Đang ở màn hình 2FA/MFA...`);

      // ❌ Hàm kiểm tra màn hình xác minh SĐT ngay sau mỗi lần nhập OTP 2FA
      // Lưu ý: OTP 2FA (TOTP) là bình thường. Nhưng sau khi qua 2FA mà OpenAI
      // lại yêu cầu thêm SĐT thì đó là THẤT BẠI — tài khoản không dùng được tự động.
      const checkPhoneScreenAfterOTP = async (label) => {
        const s = await camofoxGet(`/tabs/${tabId}/snapshot?userId=${USER_ID}`);
        const t = (s.snapshot || '').toLowerCase().replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');
        const u = (s.url || '').toLowerCase();
        const isPhone = t.includes('phone number required') ||
                        t.includes('add a phone number') ||
                        t.includes('verify your phone') ||
                        t.includes('enter your phone') ||
                        u.includes('/phone');
        if (isPhone) {
          const bypassUrl = await tryBypassPhoneRequirement({
            task,
            userId: USER_ID,
            tabId,
            sessionKey: SESSION_KEY,
            proxyUrl: account.proxyUrl || account.proxy || undefined,
            saveStep,
          });
          if (bypassUrl) {
            return { ...s, url: bypassUrl, bypassedPhone: true };
          }
          console.log(`[${task.email}] 📵 [${label}] Xác minh SĐT sau 2FA → bypass thất bại.`);
          await saveStep('yeu_cau_so_dien_thoai');
          // Throw để nhảy vào catch block → sendResultToGateway('error', 'NEED_PHONE')
          throw new Error('NEED_PHONE: Tài khoản yêu cầu xác minh số điện thoại');
        }
        return s;
      };

      if (!account.twoFaSecret) {
        console.log(`[${task.email}] ⚠️ Cần 2FA nhưng không có secret, chờ thủ công hoặc timeout.`);
      } else {
        const mfaSelector = 'input[autocomplete="one-time-code"], input[name="code"], input[type="text"], input[inputmode="numeric"]';
        try { await camofoxPost(`/tabs/${tabId}/click`, { userId: USER_ID, selector: mfaSelector }); } catch(e) {}

        // Sinh OTP MỚI ngay lúc này để đảm bảo còn thời hạn (TOTP hết hạn sau 30s)
        const { otp, remaining } = await getFreshTOTP(account.twoFaSecret, 5);
        console.log(`[${task.email}] 🔢 Nhập OTP: ${otp} (còn ${remaining}s)`);

        await camofoxPost(`/tabs/${tabId}/type`, { userId: USER_ID, selector: mfaSelector, text: otp });
        await pressKey(tabId, USER_ID, 'Enter');
        await new Promise(r => setTimeout(r, 6000));

        // ✅ Kiểm tra SĐT ngay sau OTP lần 1
        const afterMFASnap = await checkPhoneScreenAfterOTP('Sau OTP lần 1');
        if (afterMFASnap?.bypassedPhone && afterMFASnap?.url) {
          redirectUrl = afterMFASnap.url;
        }
        const afterMFAText = (afterMFASnap.snapshot || '').toLowerCase();
        const afterMFAUrl  = (afterMFASnap.url || '').toLowerCase();
        const stillAtMFA   = afterMFAText.includes('one-time code') || afterMFAText.includes('authenticator') ||
                             afterMFAText.includes('enter the code') || afterMFAUrl.includes('mfa');

        if (stillAtMFA) {
          const { otp: otpFast, remaining: remainingFast } = await getFreshTOTP(account.twoFaSecret, 0);
          console.log(`[${task.email}] 🔄 Retry nhanh OTP: ${otpFast} (còn ${remainingFast}s)`);
          try {
            await tripleClick(tabId, USER_ID, mfaSelector);
          } catch(e) {
            try { await camofoxPost(`/tabs/${tabId}/click`, { userId: USER_ID, selector: mfaSelector }); } catch(_) {}
          }
          await camofoxPost(`/tabs/${tabId}/type`, { userId: USER_ID, selector: mfaSelector, text: otpFast });
          await pressKey(tabId, USER_ID, 'Enter');
          await new Promise(r => setTimeout(r, 3500));

          const fastRetrySnap = await camofoxGet(`/tabs/${tabId}/snapshot?userId=${USER_ID}`);
          const fastRetryText = (fastRetrySnap.snapshot || '').toLowerCase();
          const fastRetryUrl = (fastRetrySnap.url || '').toLowerCase();
          const stillAtMFAAfterFast = fastRetryText.includes('one-time code') || fastRetryText.includes('authenticator') ||
            fastRetryText.includes('enter the code') || fastRetryUrl.includes('mfa');

          if (stillAtMFAAfterFast) {
            const secsRemaining = 30 - (Math.floor(Date.now()/1000) % 30);
            const waitSecs = Math.max(2, secsRemaining - 2);
            console.log(`[${task.email}] ⚠️ OTP vẫn bị từ chối, chờ ${waitSecs}s để lấy mã chu kỳ mới...`);
            await new Promise(r => setTimeout(r, waitSecs * 1000));

            const { otp: otp2, remaining: remaining2 } = await getFreshTOTP(account.twoFaSecret, 2);
            console.log(`[${task.email}] 🔄 Retry OTP chu kỳ mới: ${otp2} (còn ${remaining2}s)`);
            try {
              await tripleClick(tabId, USER_ID, mfaSelector);
            } catch(e) {
              try { await camofoxPost(`/tabs/${tabId}/click`, { userId: USER_ID, selector: mfaSelector }); } catch(_) {}
            }
            await camofoxPost(`/tabs/${tabId}/type`, { userId: USER_ID, selector: mfaSelector, text: otp2 });
            await pressKey(tabId, USER_ID, 'Enter');
            await new Promise(r => setTimeout(r, 4500));
          }

          // ✅ Kiểm tra SĐT ngay sau OTP retry
          const retrySnap = await checkPhoneScreenAfterOTP('Sau OTP retry');
          if (retrySnap?.bypassedPhone && retrySnap?.url) {
            redirectUrl = retrySnap.url;
          }
        }
      }
      await saveStep('sau_2fa');
    }

    // 5. Đợi redirect về trang Consent hoặc Success
    console.log(`[${task.email}] Đang theo dõi redirect về localhost hoặc mã Code...`);
    for (let i = 0; i < 20 && !redirectUrl; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const checkSnap = await camofoxGet(`/tabs/${tabId}/snapshot?userId=${USER_ID}`);
      const curUrl = checkSnap.url || '';
      const html = (checkSnap.snapshot || '').toLowerCase();
      const cleanText = html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');

      // 🚫 Phát hiện màn hình yêu cầu số điện thoại (Phone number required)
      if (
        cleanText.includes('phone number required') ||
        cleanText.includes('add a phone number') ||
        (cleanText.includes('phone number') && cleanText.includes('one-time code')) ||
        (curUrl.includes('phone') && (cleanText.includes('verify') || cleanText.includes('continue')))
      ) {
        redirectUrl = await tryBypassPhoneRequirement({
          task,
          userId: USER_ID,
          tabId,
          sessionKey: SESSION_KEY,
          proxyUrl: account.proxyUrl || account.proxy || undefined,
          saveStep,
        });
        if (redirectUrl) break;
        console.log(`[${task.email}] 📵 Phát hiện màn hình yêu cầu SĐT → bypass không qua, báo thất bại.`);
        await saveStep('yeu_cau_so_dien_thoai');
        await sendResultToGateway(task, 'error', 'NEED_PHONE: Tài khoản yêu cầu xác minh số điện thoại', null);
        return; // Thoát sớm, không chờ timeout
      }

      // Nếu thấy màn hình Consent (Uỷ quyền)
      if (curUrl.includes('consent') || html.includes('authorize') || html.includes('allow')) {
        console.log(`[${task.email}] Thấy màn hình Consent → Bấm Continue/Allow...`);
        try {
          // Thêm timeout 2s để không bị kẹt 30s nếu selector sai
          await camofoxPost(`/tabs/${tabId}/click`, {
            userId: USER_ID,
            selector: 'button:has-text("Continue"), button.btn-primary, [type="submit"]',
            // Truyền timeout nếu camofox hỗ trợ, nếu không nó có thể bị throw
          }).catch(e => {
            console.log(`[${task.email}] Selector click timeout/fail (thử Enter ngay).`);
            throw e;
          });
          console.log(`[${task.email}] Đã CLICK Consent bằng chuột.`);
        } catch(e) {
          // Fallback cực mạnh: Bấm Tab rồi Enter, hoặc nhấn mạnh Enter
          await pressKey(tabId, USER_ID, 'Enter');
          console.log(`[${task.email}] Đã bấm phím Enter đè lên màn hình Consent.`);
        }
        // Đợi 2s để trang bắt đầu tải chuyển hướng thay vì lặp vào retry ngay
        await new Promise(r => setTimeout(r, 2000));
      }

      if (curUrl.includes('localhost:1455') || curUrl.includes('code=')) {
        redirectUrl = curUrl;
        console.log(`[${task.email}] ✅ Tìm thấy đích: ${curUrl}`);
        break;
      }
      
      // Nếu kẹt ở màn hình login (OpenAI đôi khi quay vòng)
      if (i > 5 && (curUrl.includes('login') || html.includes('forgot password'))) {
        console.log(`[${task.email}] ⚠️ Có vẻ bị kẹt ở Login, thử Enter lần nữa...`);
        await pressKey(tabId, USER_ID, 'Enter');
      }
    }

    await saveStep('ket_thuc_flow');

    if (redirectUrl && redirectUrl.includes('code=')) {
      const urlObj = new URL(redirectUrl);
      const code = urlObj.searchParams.get('code');
      console.log(`[${task.email}] ✅ SUCCESS! Code: ${code?.substring(0, 20)}...`);
      await sendResultToGateway(task, 'success', 'Đã lấy được code thành công', {
        code,
        codeVerifier: task.codeVerifier || account.codeVerifier,
        userAgent: userAgent,
        proxyUrl: account.proxyUrl || account.proxy || undefined,
        finalUrl: redirectUrl,
      });
    } else {
      console.log(`[${task.email}] ❌ THẤT BẠI: Không thấy Code sau 40s.`);
      await sendResultToGateway(task, 'error', 'Hết thời gian chờ hoặc không tìm thấy code trong URL redirect', {
        finalUrl: redirectUrl || 'unknown',
      });
    }
  } catch (err) {
    console.error(`[!] Lỗi xử lý ${account.email}:`, err.message);
    await sendResultToGateway(task, 'error', `Lỗi Worker: ${err.message}`, null);
  } finally {
    if (tabId) {
      try {
        await camofoxDelete(`/tabs/${tabId}?userId=${USER_ID}`);
        console.log(`[Camofox] 🧹 Đóng tab ${tabId}`);
      } catch (_) {}
    }
  }
}

// ============================================
// COMMUNICATION
// ============================================

async function sendResultToGateway(task, status, message, result) {
  const taskId = task.id;
  const source = task.source || 'd1';

  // LUÔN báo về Tools để cập nhật UI Local.
  // Gửi kèm result (code + codeVerifier) nếu có, để Tools exchange token và lưu vào D1.
  try {
    // Nếu result có codeVerifier thì luôn gửi, bất kể source — Tools sẽ tự exchange.
    const toolsResult = (result && result.codeVerifier) ? result : 
                        (source === 'tools' ? result : null);
      const toolsRes = await fetch(`http://localhost:4000/api/vault/accounts/result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: taskId, status, message, result: toolsResult }),
        signal: AbortSignal.timeout(45000), // Thời gian đợi Gateway DB sync xong (thường 2-3s nhưng có thể nghẽn tới 15s)
      });
      const toolsBody = await toolsRes.text();
      console.log(`[Tools] ✅ Đã báo cáo (HTTP ${toolsRes.status}): ${toolsBody.substring(0, 100)}`);
    } catch (e) {
      console.log(`[Tools] ⚠️ Không gửi được result: ${e.message}`);
    }

    if (source === 'gateway') {
      // Chỉ báo cáo có kèm result về Gateway nếu task lấy từ Gateway
    try {
      const res = await fetch(`${GATEWAY_URL}/api/public/worker/result`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${WORKER_AUTH_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ id: taskId, status, message, result }),
      });
      if (res.ok) {
        console.log(`[Gateway] ✅ Gửi kết quả (${status}) thành công.`);
      } else {
        console.log(`[Gateway] ❌ API từ chối: HTTP ${res.status}`);
      }
    } catch (e) {
      console.error('[Gateway Error] Không thể kết nối VPS:', e.message);
    }
  } else {
    // Nếu task đến từ D1 Cloud trực tiếp (source='d1'), cập nhật status cho D1
    // Nếu source='tools': Tools đã tự push 'ready' lên D1 qua SyncManager → KHÔNG PATCH thêm
    if (source !== 'tools') {
      try {
        const configRes = await fetch('http://localhost:4000/api/config', { signal: AbortSignal.timeout(2000) });
        const cfg = await configRes.json();
        if (cfg.d1WorkerUrl && cfg.d1SyncSecret) {
          // Dùng 'ready' thay vì 'success' để Gateway hiển thị đúng
          const d1Status = status === 'success' ? 'ready' : status;
          await fetch(`${cfg.d1WorkerUrl}/accounts/${taskId}`, {
            method: 'PATCH',
            headers: { 'x-sync-secret': cfg.d1SyncSecret, 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: d1Status, last_error: message, updated_at: new Date().toISOString() }),
            signal: AbortSignal.timeout(4000),
          });
          console.log(`[D1 Cloud] ✅ Cập nhật status → ${d1Status}`);
        }
      } catch (e) {
        console.log(`[D1 Cloud] ⚠️ Không cập nhật được D1: ${e.message}`);
      }
    } else {
      console.log(`[D1 Cloud] ℹ️ Source=tools → Tools đã push 'ready', bỏ qua PATCH D1.`);
    }
  }
}

async function fetchTask() {
  // 1. Ưu tiên cao nhất: Hỏi Tools Server (Local source of truth cho PKCE & Redirect URI)
  // Truyền danh sách ID đang xử lý để Server chọn task KHÁC nhau cho từng thread
  const excludeParam = processingIds.size > 0
    ? `?exclude=${[...processingIds].join(',')}`
    : '';
  try {
    const res = await fetch(`http://localhost:4000/api/vault/accounts/task${excludeParam}`, {
      signal: AbortSignal.timeout(3000)
    });
    if (res.ok) {
      const data = await res.json();
      if (data.task) {
        console.log(`[Tools] ✅ Tìm thấy task: ${data.task.email}`);
        data.task.source = 'tools';
        return data.task;
      }
    }
  } catch (e) {}

  // 2. Dự phòng: Hỏi Gateway (OmniRoute Task API) - Chỉ dùng nếu Tools không có task
  try {
    const res = await fetch(`${GATEWAY_URL}/api/public/worker/task`, {
      headers: {
        Authorization: `Bearer ${WORKER_AUTH_TOKEN}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(3000)
    });
    if (res.status === 401) {
      console.log(`[!] Lỗi xác thực Gateway (401) - Kiểm tra Token`);
      return null;
    }
    if (res.status === 200) {
      const data = await res.json();
      if (data.task) {
        console.log(`[Gateway] ✅ Tìm thấy task: ${data.task.email}`);
        data.task.source = 'gateway';
        return data.task;
      }
    }
  } catch (e) {}

  // 3. Dự phòng cuối: Hỏi thẳng Cloud D1 qua Tools (để lấy PKCE từ Tools)
  try {
    const configRes = await fetch(`http://localhost:4000/api/config`, {
      signal: AbortSignal.timeout(2000)
    });
    const cfg = await configRes.json();
    if (!cfg.d1WorkerUrl || !cfg.d1SyncSecret) {
      return null;
    }
    const d1Res = await fetch(`${cfg.d1WorkerUrl}/inspect/accounts?limit=200`, {
      headers: { 'x-sync-secret': cfg.d1SyncSecret },
      signal: AbortSignal.timeout(4000)
    });
    if (!d1Res.ok) return null;

    const d1Data = await d1Res.json();
    const allItems = (d1Data.items || []).filter(a => !a.deleted_at);
    const pending = allItems.find(a => (a.status === 'pending' || a.status === 'relogin'));
    if (pending) {
      if (!pending.codeVerifier && !pending.loginUrl?.includes('code_challenge=')) {
        // console.log(`[D1 Cloud] ⚠️ Task ${pending.email} không có codeVerifier → BỎ QUA`);
        return null;
      }
      console.log(`[D1 Cloud] ☁️ Tìm thấy task: ${pending.email} (${pending.status})`);
      pending.source = 'd1';
      return pending;
    }
  } catch (e) {}

  return null;
}

// ============================================
// POLLING LOOP
// ============================================
let activeThreads = 0;
const processingIds = new Set(); // Chặn duplicate tasks

async function pollTasks() {
  if (activeThreads >= MAX_THREADS) return;
  try {
    const task = await fetchTask();
    if (!task?.id) return;

    // Chặn cùng 1 account bị xử lý 2 lần
    if (processingIds.has(task.id)) {
      console.log(`[Worker] ⏭️ Bỏ qua ${task.email} - đang được xử lý rồi`);
      return;
    }

    processingIds.add(task.id);
    activeThreads++;
    console.log(`[Worker] 🚀 Luồng mới: ${task.email} (${activeThreads}/${MAX_THREADS})`);

    runLoginFlow(task)
      .then(() => {
        activeThreads = Math.max(0, activeThreads - 1);
        processingIds.delete(task.id);
        console.log(`[Worker] ✅ Hoàn tất ${task.email}. Còn trống: ${MAX_THREADS - activeThreads}`);
        if (activeThreads < MAX_THREADS) setTimeout(pollTasks, 1000);
      })
      .catch(err => {
        activeThreads = Math.max(0, activeThreads - 1);
        processingIds.delete(task.id);
        console.error(`[Worker] ❌ Lỗi luồng ${task.email}:`, err.message);
      });

    if (activeThreads < MAX_THREADS) setTimeout(pollTasks, 2000);
  } catch (err) {
    console.error('[!] Lỗi poll tasks:', err.message);
  }
}

// ============================================
// KHỞI ĐỘNG
// ============================================
console.log(`\n================================`);
console.log(`🤖 SEELLM AUTO-LOGIN WORKER (ĐA LUỒNG)`);
console.log(`================================`);
console.log(`- GATEWAY: ${GATEWAY_URL}`);
console.log(`- CAMOFOX: ${CAMOUFOX_API}`);
console.log(`- MAX THREADS: ${MAX_THREADS}`);
console.log(`- POLL: mỗi ${POLL_INTERVAL_MS}ms`);
console.log(`================================\n`);

setInterval(pollTasks, POLL_INTERVAL_MS);
pollTasks();
