/**
 * SeeLLM Tools - ChatGPT Account Warmup Module
 * Automates conversational Q&A interactions using Camofox to maintain account health.
 */

import { CAMOUFOX_API, TOOLS_API_URL, WARMUP_SCREENSHOTS } from './config.js';
import { camofoxPost, camofoxGet, camofoxDelete, navigate, pressKey, evalJson, getSnapshot, clickRef } from './lib/camofox.js';
import { normalizeProxyUrl, assertProxyApplied, probeProxyExitIp, getLocalPublicIp, isLocalRelayProxy } from './lib/proxy-diag.js';
import { getFreshTOTP } from './lib/totp.js';
import { generateWarmupPrompts } from './lib/warmup-prompts.js';
import { createStepRecorder } from './lib/screenshot.js';
import { waitForOTPCode } from './lib/ms-graph-email.js';
import {
  getState,
  fillEmail,
  fillPassword,
  fillMfa,
  tryAcceptCookies,
  dismissGooglePopupAndClickLogin,
  clickWelcomeBackContinue,
  selectPersonalWorkspaceOnWorkspacePage,
  clickContinueWithPassword,
  tryDismissPasskeyEnrollment,
} from './lib/openai-login-flow.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';



// Helper to get random number between min and max inclusive
function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Wait helper
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Wait up to maxMs, polling state every intervalMs. If state changes, return early.
async function waitStateTransition(tabId, userId, initialState, maxMs = 5000, intervalMs = 1000) {
  if (!initialState) {
    await delay(maxMs);
    return null;
  }
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    await delay(intervalMs);
    const newState = await getState(tabId, userId).catch(() => null);
    if (!newState) continue;
    if (newState.href !== initialState.href ||
        newState.hasEmailInput !== initialState.hasEmailInput ||
        newState.hasPasswordInput !== initialState.hasPasswordInput ||
        newState.hasMfaInput !== initialState.hasMfaInput ||
        newState.looksLoggedIn !== initialState.looksLoggedIn ||
        newState.hasError !== initialState.hasError) {
      return newState;
    }
  }
  return null;
}

function summarizeLoginState(state) {
  if (!state) return 'state=null';
  return [
    `url=${state.href || 'unknown'}`,
    `onAuthDomain=${state.onAuthDomain}`,
    `looksLoggedIn=${state.looksLoggedIn}`,
    `hasEmailInput=${state.hasEmailInput}`,
    `hasPasswordInput=${state.hasPasswordInput}`,
    `hasMfaInput=${state.hasMfaInput}`,
    `hasContinueWithPassword=${state.hasContinueWithPassword}`,
    `hasLoggedOutChatShell=${state.hasLoggedOutChatShell}`,
    `hasVisibleLoginAction=${state.hasVisibleLoginAction}`,
    `hasSessionExpiredText=${state.hasSessionExpiredText}`,
  ].join(', ');
}

function classifyLoginTimeout(state, meta = {}) {
  const href = String(state?.href || '').toLowerCase();
  const flags = summarizeLoginState(state);
  const action = meta.lastLoginAction || 'unknown';

  if (!state) {
    return `LOGIN_TIMEOUT_STATE_UNAVAILABLE: Không lấy được trạng thái trang trong login loop (lastAction=${action})`;
  }
  if (state.hasDeactivated) return 'ACCOUNT_DEACTIVATED: Tài khoản đã bị khóa';
  if (state.hasResetPasswordScreen) return 'PASSWORD_RESET_REQUIRED: Tài khoản yêu cầu đặt lại mật khẩu';
  if (state.hasWrongPassword) return 'WRONG_PASSWORD: Mật khẩu không đúng';
  if (state.hasEmailOtpInput) return `EMAIL_OTP_REQUIRED: Màn hình OTP email vẫn còn sau khi hết thời gian login (${flags})`;
  if (state.hasMfaInput) return `NEED_2FA: Màn hình 2FA vẫn còn sau khi hết thời gian login nhưng không hoàn tất được (${flags})`;
  if (state.hasPasswordInput) return `LOGIN_TIMEOUT_PASSWORD_SCREEN: Kẹt ở màn hình mật khẩu sau ${meta.passwordWaitCount || 0} lần chờ (lastAction=${action}; ${flags})`;
  if (state.hasEmailInput) return `LOGIN_TIMEOUT_EMAIL_SCREEN: Kẹt ở màn hình email sau ${meta.emailWaitCount || 0} lần chờ (lastAction=${action}; ${flags})`;
  if (state.hasContinueWithPassword || state.hasEmailInboxScreen) return `LOGIN_TIMEOUT_EMAIL_VERIFICATION_SCREEN: Kẹt ở màn hình xác minh email/Continue with password (lastAction=${action}; ${flags})`;
  if (href.includes('/auth/login_with')) return `LOGIN_TIMEOUT_LOGIN_WITH_STUCK: Kẹt tại auth/login_with không render form đăng nhập (lastAction=${action}; ${flags})`;
  if (state.onAuthDomain && state.hasVisibleLoginAction) return `LOGIN_TIMEOUT_AUTH_LANDING: Kẹt ở auth landing có nút login nhưng không mở form (lastAction=${action}; ${flags})`;
  if (state.onAuthDomain) return `LOGIN_TIMEOUT_AUTH_BLANK: Kẹt ở auth domain nhưng không có form/action rõ ràng (lastAction=${action}; ${flags})`;
  if (state.hasLoggedOutChatShell || state.hasVisibleLoginAction || state.hasVisibleSignUpAction) return `LOGIN_TIMEOUT_LOGGED_OUT_SHELL: Kẹt ở ChatGPT logged-out shell, redirect login không hoàn tất (lastAction=${action}; ${flags})`;
  if (state.hasSessionExpiredText) return `SESSION_EXPIRED: Trang báo session expired trong login recovery (${flags})`;
  return `LOGIN_TIMEOUT_UNKNOWN_STATE: Login loop hết thời gian ở trạng thái chưa phân loại (lastAction=${action}; ${flags})`;
}

function classifyWarmupTransportFailure(message) {
  const msg = String(message || '').toLowerCase();
  if (
    msg.includes('net_timeout_navigate') ||
    msg.includes('page.goto') ||
    (msg.includes('timeout') && msg.includes('navigate')) ||
    msg.includes('proxy') && msg.includes('timeout')
  ) {
    return {
      category: 'proxy_or_network',
      note: 'Warmup thất bại do proxy/mạng chậm hoặc không tải được ChatGPT kịp thời.',
    };
  }
  if (
    msg.includes('blocked_by_openai_turnstile') ||
    msg.includes('turnstile') ||
    msg.includes('ip reputation') ||
    msg.includes('access denied') ||
    msg.includes('cloudflare')
  ) {
    return {
      category: 'proxy_reputation',
      note: 'Warmup thất bại do Turnstile/IP reputation block; proxy hiện tại nhiều khả năng không đạt độ tin cậy.',
    };
  }
  if (msg.includes('browser_restarted') || msg.includes('tab no longer exists') || msg.includes('context closed')) {
    return {
      category: 'browser_restarted',
      note: 'Warmup thất bại do browser/tab bị khởi động lại trong quá trình chạy.',
    };
  }
  return null;
}

function getLoginScreenFingerprint(state) {
  if (!state) return 'state:null';
  const href = String(state.href || '').toLowerCase();
  const bucket = [
    state.onAuthDomain ? 'auth' : 'home',
    state.hasEmailInput ? 'email' : 'no-email',
    state.hasPasswordInput ? 'password' : 'no-password',
    state.hasMfaInput ? 'mfa' : 'no-mfa',
    state.hasContinueWithPassword ? 'cwp' : 'no-cwp',
    state.hasLoggedOutChatShell ? 'loggedout' : 'shell-ok',
    state.hasVisibleLoginAction ? 'login-action' : 'no-login-action',
    state.hasSessionExpiredText ? 'session-expired' : 'no-session-expired',
    href.includes('/auth/login_with') ? 'login-with' : href.includes('/auth/login?') ? 'auth-login' : href.includes('/auth/log-in') ? 'auth-log-in' : 'other'
  ];
  return bucket.join('|');
}

async function clearAuthClientState(tabId, userId) {
  return evalJson(tabId, userId, `(() => {
    const result = { localStorage: 0, sessionStorage: 0, cookies: 0 };
    const shouldRemoveKey = key => {
      const lower = String(key || '').toLowerCase();
      return lower.includes('auth') ||
        lower.includes('login') ||
        lower.includes('account') ||
        lower.includes('remember') ||
        lower.includes('user');
    };
    for (const storage of [window.localStorage, window.sessionStorage]) {
      try {
        const keys = [];
        for (let i = 0; i < storage.length; i++) keys.push(storage.key(i));
        for (const key of keys) {
          if (shouldRemoveKey(key)) {
            storage.removeItem(key);
            if (storage === window.localStorage) result.localStorage++;
            else result.sessionStorage++;
          }
        }
      } catch (_) {}
    }
    try {
      const expires = 'Thu, 01 Jan 1970 00:00:00 GMT';
      for (const rawCookie of document.cookie.split(';')) {
        const name = rawCookie.split('=')[0]?.trim();
        if (!name) continue;
        const lower = name.toLowerCase();
        if (!shouldRemoveKey(lower) && !lower.startsWith('__host-') && !lower.startsWith('__secure-')) continue;
        document.cookie = name + '=; expires=' + expires + '; path=/';
        document.cookie = name + '=; expires=' + expires + '; path=/; domain=.openai.com';
        document.cookie = name + '=; expires=' + expires + '; path=/; domain=.chatgpt.com';
        result.cookies++;
      }
    } catch (_) {}
    return result;
  })()`, 5000).catch(err => ({ error: err?.message || String(err) }));
}

async function recoverWelcomeBackStuck(tabId, userId, reason = 'stuck') {
  const resetResult = await clearAuthClientState(tabId, userId);
  console.warn(`[Warmup] ⚠️ Welcome Back ${reason} -> clear auth client state: ${JSON.stringify(resetResult)}`);
  await navigate(tabId, userId, 'https://auth.openai.com/log-in?prompt=login', { timeoutMs: 20000, waitUntil: 'commit' }).catch(async () => {
    await navigate(tabId, userId, 'https://chatgpt.com/?login', { timeoutMs: 15000, waitUntil: 'commit' }).catch(() => {});
  });
}

// Parse command line arguments
function parseArgs() {
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const val = process.argv[i + 1];
      if (val && !val.startsWith('--')) {
        args[key] = val;
        i++;
      } else {
        args[key] = true;
      }
    }
  }
  return args;
}

async function assertChatgptAuthenticated(tabId, userId, context = 'before_qna') {
  const state = await getState(tabId, userId);
  if (!state?.looksLoggedIn) {
    const flags = [
      `looksLoggedIn=${state?.looksLoggedIn ?? 'null'}`,
      `hasProfileBtn=${state?.hasProfileBtn ?? 'null'}`,
      `hasLogInBtn=${state?.hasLogInBtn ?? 'null'}`,
      `hasSignUpInPage=${state?.hasSignUpInPage ?? 'null'}`,
      `hasLoggedOutChatShell=${state?.hasLoggedOutChatShell ?? 'null'}`,
      `hasVisibleLoginAction=${state?.hasVisibleLoginAction ?? 'null'}`,
      `hasVisibleSignUpAction=${state?.hasVisibleSignUpAction ?? 'null'}`,
      `hasLoggedOutSidebarPrompt=${state?.hasLoggedOutSidebarPrompt ?? 'null'}`,
      `href=${state?.href || 'unknown'}`
    ].join(', ');
    throw new Error(`session_expired: ChatGPT chưa đăng nhập ở ${context} (${flags})`);
  }

  try {
    const sessionRes = await evalJson(tabId, userId, `
      (async () => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 12000);
        try {
          const r = await fetch('/api/auth/session', { signal: controller.signal });
          clearTimeout(timeoutId);
          return r.ok ? await r.json() : null;
        } catch (e) {
          clearTimeout(timeoutId);
          return null;
        }
      })()
    `);
    if (!sessionRes || !sessionRes.accessToken) {
      const url = String(state?.href || '');
      const onAuthDomain = !!state?.onAuthDomain;
      const hasLoginLikeScreen = !!(state?.hasLoggedOutChatShell || state?.hasVisibleLoginAction || state?.hasVisibleSignUpAction || state?.hasEmailInput || state?.hasPasswordInput || state?.hasMfaInput);
      if (onAuthDomain || hasLoginLikeScreen || url.includes('/auth/') || url.includes('/login')) {
        console.warn(`[Warmup] ⚠️ DOM looksLoggedIn=true nhưng API /api/auth/session báo chưa đăng nhập!`);
        throw new Error(`session_expired: API session invalid hoặc expired ở ${context}`);
      }
      console.warn(`[Warmup] ⚠️ API session check chưa xác nhận nhưng page không ở auth/login screen. Giữ cảnh báo nhẹ để tránh false positive.`);
    }
  } catch (err) {
    if (err.message.includes('session_expired')) throw err;
    console.warn(`[Warmup] ⚠️ Lỗi kiểm tra API session (có thể do mạng/lag): ${err.message}`);
  }

  return state;
}

/**
 * Polls the DOM to detect when ChatGPT has finished generating the AI response.
 * Uses multiple strategies for bulletproof detection.
 */
async function waitForGenerationComplete(tabId, userId, timeoutMs = 150000) {
  const startTime = Date.now();
  console.log(`[Warmup] ⏳ Chờ ChatGPT phản hồi xong...`);
  
  let hasStarted = false;
  const startTimeout = 20000; // 20 seconds to start generating (increased from 8s for slow proxies)
  let lastTextLength = 0;
  let textLengthStableSec = 0;
  
  while (Date.now() - startTime < timeoutMs) {
    const state = await evalJson(tabId, userId, `(() => {
      const isVisible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        return !!(rect.width || rect.height || el.getClientRects().length);
      };

      // 1. Check for visible "Stop generating" button
      const stopBtn = document.querySelector('button[aria-label="Stop generating"], button[data-testid="stop-generating-button"], button[class*="composer-submit"] svg[use*="stop"]');
      const isStopVisible = isVisible(stopBtn);
      
      // 2. Check for active streaming classes or selectors
      const streamingEl = document.querySelector('.result-streaming, .streaming, [class*="streaming"]');
      const isStreaming = !!streamingEl;
      
      // 3. Check submit/voice button state. Keep this narrow: ChatGPT now reuses
      // composer-submit classes for idle controls, which previously caused hangs.
      const submitBtn = document.querySelector('button[data-testid="stop-button"], button[data-testid="stop-generating-button"], button[aria-label="Stop generating"]');
      const isSubmitStop = isVisible(submitBtn);
      
      // Get text length of main conversation container to monitor typing progress
      const mainEl = document.querySelector('main');
      const textLength = mainEl ? mainEl.innerText.length : 0;
      
      // Check for error elements or warning text
      let errorText = '';
      const errorSelectors = [
        '[data-testid="error-message"]',
        '.text-token-text-error',
        '.border-red-500',
        '.text-red-500',
        '.bg-red-500'
      ];
      for (const sel of errorSelectors) {
        const el = document.querySelector(sel);
        if (isVisible(el)) {
          errorText = el.innerText || el.textContent || '';
          break;
        }
      }
      if (!errorText) {
        const errorKeywords = [
          'something went wrong',
          'something seems to have gone wrong',
          'retry',
          'error generating a response',
          'try signing in again',
          'token has been invalidated',
          'unusual activity',
          'session has expired',
          'session expired',
          'please log in again',
          'please sign in again',
        ];
        const contextualErrors = Array.from(document.querySelectorAll('[role="alert"], [data-testid*="error"], [class*="error"], button'))
          .filter(isVisible)
          .map(el => (el.innerText || el.textContent || '').trim())
          .filter(Boolean);
        const matchedError = contextualErrors.find(text => {
          const lower = text.toLowerCase();
          return errorKeywords.some(k => lower.includes(k));
        });
        if (matchedError) {
          errorText = matchedError.slice(0, 150).replace(/\\n/g, ' ');
        }
      }
      if (!errorText) {
        const bodyText = (document.body?.innerText || '').toLowerCase();
        const exactSessionErrors = [
          'your session has expired',
          'please log in again to continue using the app',
          'try signing in again',
          'please sign in again',
        ];
        if (exactSessionErrors.some(k => bodyText.includes(k))) {
          errorText = 'Your session has expired. Please log in again to continue using the app.';
        }
      }
      
      return {
        isGenerating: isStopVisible || isStreaming || isSubmitStop,
        generatingReason: isStopVisible ? 'stop-button' : (isStreaming ? 'streaming-element' : (isSubmitStop ? 'submit-stop' : 'none')),
        textLength,
        errorText
      };
    })()`);
    
    const elapsed = Date.now() - startTime;
    
    if (!state) {
      console.log(`[Warmup] ⚠️ Không thể truy xuất trạng thái trang (state is null). Đang thử lại...`);
      await delay(2000);
      continue;
    }
    
    if (state.errorText) {
      console.log(`[Warmup] ❌ Phát hiện lỗi trên trang ChatGPT: "${state.errorText}"`);
      throw new Error(`session_expired: Lỗi trên trang ChatGPT: ${state.errorText}`);
    }
    
    if (state.isGenerating) {
      hasStarted = true;
    }
    
    if (hasStarted) {
      if (!state.isGenerating) {
        console.log(`[Warmup] ✅ ChatGPT đã trả lời xong!`);
        return true;
      }
      
      // Monitor if the text length is changing
      if (state.textLength === lastTextLength) {
        textLengthStableSec += 2;
      } else {
        textLengthStableSec = 0;
        lastTextLength = state.textLength;
      }
      
      console.log(`[Warmup] ⏱️ Generation status: generating (${state.generatingReason}) (${Math.round(elapsed / 1000)}s, stable: ${textLengthStableSec}s)`);
      
      // If the response text has not changed for 14 seconds
      if (textLengthStableSec >= 14) {
        if (state.generatingReason === 'streaming-element') {
          console.log(`[Warmup] ⚠️ Độ dài văn bản không đổi trong 14s ở trạng thái streaming-element. Coi như hoàn tất.`);
          return true;
        } else if (state.generatingReason === 'submit-stop' && elapsed > 120000) {
          // 120s absolute max — likely a real stall but don't restart tab (avoid RC-1 cascade)
          // Returning false (not throwing) so caller can handle gracefully
          console.warn(`[Warmup] ⚠️ submit-stop kẹt > 120s không thay đổi. Bỏ qua câu hỏi này, tiếp tục.`);
          return false;
        }
      }
    } else {
      // If we haven't seen it start generating yet
      if (elapsed > startTimeout) {
        // Check if text content actually grew since we sent the question
        // (fast response may appear before generating indicator updates)
        if (state.textLength > lastTextLength + 100) {
          console.log(`[Warmup] ✅ Text tăng ${state.textLength - lastTextLength} ký tự — phản hồi đã xuất hiện mà không có chỉ báo generating.`);
          return true;
        }
        console.log(`[Warmup] ⚠️ Không phát hiện trạng thái generating sau ${startTimeout / 1000}s. Coi như phản hồi hoàn tất hoặc lỗi.`);
        return false;
      }
      console.log(`[Warmup] ⏱️ Generation status: waiting for start (${Math.round(elapsed / 1000)}s)`);
    }
    
    await delay(2000);
  }
  
  console.log(`[Warmup] ⚠️ Hết thời gian chờ phản hồi (${timeoutMs}ms). Tiến hành tiếp tục.`);
  return false;
}

async function getAssistantMessageCount(tabId, userId) {
  return await evalJson(tabId, userId, `
  (function() {
    var selectors = [
      '.markdown',
      '.prose',
      'article:not([data-message-author-role="user"])',
      '[data-message-author-role="assistant"]',
      '[data-testid*="conversation-turn"] [data-message-author-role="assistant"]'
    ];
    var els = Array.from(document.querySelectorAll(selectors.join(',')))
      .filter(Boolean);
    var validEls = els.filter(function(el) {
      if (el.closest('form') || el.closest('#prompt-textarea') || el.closest('[contenteditable="true"]')) {
        return false;
      }
      var text = (el.innerText || el.textContent || '').trim();
      return text.length > 0;
    });
    return validEls.length;
  })()`).catch(() => 0);
}

async function getLatestAssistantMessage(tabId, userId, prevCount = 0) {
  return await evalJson(tabId, userId, `
  (function() {
    var prevCount = ${prevCount};
    var selectors = [
      '.markdown',
      '.prose',
      'article:not([data-message-author-role="user"])',
      '[data-message-author-role="assistant"]',
      '[data-testid*="conversation-turn"] [data-message-author-role="assistant"]'
    ];
    var els = Array.from(document.querySelectorAll(selectors.join(',')))
      .filter(Boolean);
    if (els.length === 0) return null;
    
    var validEls = els.filter(function(el) {
      if (el.closest('form') || el.closest('#prompt-textarea') || el.closest('[contenteditable="true"]')) {
        return false;
      }
      var text = (el.innerText || el.textContent || '').trim();
      return text.length > 0;
    });
    
    if (validEls.length === 0 || validEls.length <= prevCount) return null;
    var lastEl = validEls[validEls.length - 1];
    return (lastEl.innerText || lastEl.textContent || '').trim();
  })()`).catch(() => null);
}

async function getLatestAssistantMessageWithRetry(tabId, userId, prevCount = 0, retries = 3) {
  for (var i = 0; i < retries; i++) {
    var msg = await getLatestAssistantMessage(tabId, userId, prevCount);
    if (msg && msg.length > 0) {
      return msg;
    }
    if (i < retries - 1) {
      console.log(`[Warmup] ⏳ Chưa đọc được câu trả lời từ DOM, đang thử lại sau 2 giây (lần ${i + 1}/${retries})...`);
      await delay(2000);
    }
  }
  return null;
}

async function checkPageErrors(tabId, userId) {
  return await evalJson(tabId, userId, `(() => {
    const text = document.body?.innerText || '';
    const errWords = [
      'something went wrong',
      'network error',
      'too many requests',
      'unusual activity',
      'our systems have detected',
      'please try again later',
      'failed to get service status',
      'error generating response'
    ];
    for (const word of errWords) {
      if (text.toLowerCase().includes(word)) {
        return { hasError: true, word, snippet: text.slice(0, 500) };
      }
    }
    const redEl = document.querySelector('[class*="error"], [class*="red-500"], .text-red-500');
    if (redEl && redEl.offsetParent !== null) {
      const textVal = (redEl.innerText || '').toLowerCase();
      if (!textVal.includes('can make mistakes') && !textVal.includes('check important info')) {
        return { hasError: true, snippet: redEl.innerText.slice(0, 200) };
      }
    }
    return { hasError: false };
  })()`).catch(() => ({ hasError: false }));
}


async function getComposerState(tabId, userId) {
  return await evalJson(tabId, userId, `(() => {
    const isVisible = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      return !!(rect.width || rect.height || el.getClientRects().length);
    };
    const editor = document.querySelector('#prompt-textarea');
    const visible = isVisible(editor);
    const text = editor ? ((editor.value || editor.innerText || editor.textContent || '').trim()) : '';
    const sendBtn = document.querySelector('button[data-testid="send-button"], button[aria-label="Send prompt"], button[class*="composer-submit"]');
    const sendVisible = isVisible(sendBtn);
    const sendDisabled = !!(sendBtn && (sendBtn.disabled || sendBtn.hasAttribute('disabled') || sendBtn.getAttribute('aria-disabled') === 'true'));
    return {
      visible,
      text,
      textLength: text.length,
      sendVisible,
      sendDisabled,
      sendAria: sendBtn ? (sendBtn.getAttribute('aria-label') || '') : '',
    };
  })()`);
}

async function clearComposerPrompt(tabId, userId) {
  return await evalJson(tabId, userId, `(() => {
    const isVisible = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      return !!(rect.width || rect.height || el.getClientRects().length);
    };
    const editor = document.querySelector('#prompt-textarea');
    if (!isVisible(editor)) {
      return { ok: true, reason: 'composer-not-visible' };
    }

    editor.focus();
    if ('value' in editor) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
        || Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      if (setter) setter.call(editor, '');
      else editor.value = '';
    } else {
      editor.replaceChildren();
    }

    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', data: null }));
    editor.dispatchEvent(new Event('change', { bubbles: true }));
    const text = (editor.value || editor.innerText || editor.textContent || '').trim();
    return { ok: text.length === 0, textLength: text.length };
  })()`).catch(err => ({ ok: false, reason: err.message }));
}

async function injectComposerPrompt(tabId, userId, promptText) {
  const promptJson = JSON.stringify(promptText);
  return await evalJson(tabId, userId, `(() => {
    const promptText = ${promptJson};
    const editor = document.querySelector('#prompt-textarea');
    if (!editor || editor.offsetParent === null) {
      return { ok: false, reason: 'composer-not-visible' };
    }

    editor.focus();
    if ('value' in editor) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
        || Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      if (setter) setter.call(editor, promptText);
      else editor.value = promptText;
    } else {
      editor.replaceChildren();
      const block = document.createElement('p');
      block.textContent = promptText;
      editor.appendChild(block);
    }

    editor.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: promptText }));
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: promptText }));
    editor.dispatchEvent(new Event('change', { bubbles: true }));
    editor.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: ' ', code: 'Space' }));

    const text = (editor.value || editor.innerText || editor.textContent || '').trim();
    return { ok: text.includes(promptText.slice(0, 40)), textLength: text.length, textSample: text.slice(0, 120) };
  })()`);
}

async function ensureComposerPrompt(tabId, userId, promptText) {
  let state = await getComposerState(tabId, userId).catch(() => null);
  if (state?.text?.includes(promptText.slice(0, 40))) {
    return { ok: true, method: 'keyboard', state };
  }

  console.log(`[Warmup] ⚠️ Composer chưa nhận đủ prompt sau /type (len=${state?.textLength ?? 0}). Thử inject DOM fallback...`);
  const injected = await injectComposerPrompt(tabId, userId, promptText).catch(err => ({ ok: false, reason: err.message }));
  await delay(800);
  state = await getComposerState(tabId, userId).catch(() => null);
  const ok = !!(state?.text?.includes(promptText.slice(0, 40)));
  return { ok, method: injected?.ok ? 'dom-inject' : 'failed', state, injected };
}

async function sendComposerPrompt(tabId, userId) {
  return await evalJson(tabId, userId, `(() => {
    const sendButtons = Array.from(document.querySelectorAll('button[data-testid="send-button"], button[aria-label="Send prompt"], button[class*="composer-submit"]'))
      .filter(btn => btn && btn.offsetParent !== null && !btn.disabled && !btn.hasAttribute('disabled') && btn.getAttribute('aria-disabled') !== 'true');
    const sendBtn = sendButtons.find(btn => {
      const label = (btn.getAttribute('aria-label') || '').toLowerCase();
      const testId = (btn.getAttribute('data-testid') || '').toLowerCase();
      return testId.includes('send') || label.includes('send') || !label.includes('voice');
    });
    if (!sendBtn) {
      return { ok: false, reason: 'send-button-disabled-or-missing', count: sendButtons.length };
    }
    sendBtn.click();
    sendBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return { ok: true, aria: sendBtn.getAttribute('aria-label') || '', testId: sendBtn.getAttribute('data-testid') || '' };
  })()`).catch(err => ({ ok: false, reason: err.message }));
}

async function submitComposerWithRetry(tabId, userId, promptText) {
  const attempts = [
    async () => {
      await pressKey(tabId, userId, 'Enter');
      return { method: 'enter' };
    },
    async () => {
      const sent = await sendComposerPrompt(tabId, userId);
      return { method: 'dom-click', sent };
    },
    async () => {
      await pressKey(tabId, userId, 'Meta+Enter');
      return { method: 'meta-enter' };
    },
    async () => {
      await pressKey(tabId, userId, 'Control+Enter');
      return { method: 'ctrl-enter' };
    },
  ];

  for (const attempt of attempts) {
    const result = await attempt().catch(err => ({ method: 'unknown', error: err.message }));
    await delay(2000);
    const submitted = await waitForPromptSubmitted(tabId, userId, promptText, 15000);
    if (submitted.ok) {
      return { ok: true, method: result.method, submitted, result };
    }
    if (submitted.reason === 'session_expired') {
      return { ok: false, method: result.method, reason: 'session_expired', submitted, result };
    }
    console.log(`[Warmup] ⚠️ Submit bằng ${result.method} chưa tạo user message (composerLen=${submitted.state?.composerTextLength ?? 0}, stopVisible=${submitted.state?.stopVisible}, onChatUrl=${submitted.state?.onChatUrl}). Thử cách khác...`);
  }

  return { ok: false, reason: 'no-user-message', state: await getComposerState(tabId, userId).catch(() => null) };
}

async function waitForPromptSubmitted(tabId, userId, promptText, timeoutMs = 15000) {
  const promptHead = promptText.slice(0, 40);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = await evalJson(tabId, userId, `
    (function() {
      var promptHead = ${JSON.stringify(promptHead)};
      var editor = document.querySelector('#prompt-textarea');
      var composerText = editor ? ((editor.value || editor.innerText || editor.textContent || '').trim()) : '';
      var bodyText = (document.body ? document.body.innerText || '' : '').toLowerCase();
      var sessionExpired = bodyText.indexOf('your session has expired') !== -1 || bodyText.indexOf('please log in again to continue using the app') !== -1;
      var userMessageSelectors = [
        '[data-message-author-role="user"]',
        '[data-testid*="conversation-turn"] [data-message-author-role="user"]',
        'article [data-message-author-role="user"]',
        'main article',
      ];
      var userMessageTexts = Array.from(document.querySelectorAll(userMessageSelectors.join(',')))
        .filter(function(el) { return el && el.offsetParent !== null && !el.closest('form') && !el.closest('[contenteditable="true"]') && !el.closest('#prompt-textarea'); })
        .map(function(el) { return (el.innerText || el.textContent || '').trim(); })
        .filter(Boolean);
      var stopBtn = document.querySelector('button[aria-label="Stop generating"], button[data-testid="stop-generating-button"], button[data-testid="stop-button"], button[data-testid="composer-stop-button"]');
      var hasUserMessage = userMessageTexts.some(function(text) { return text.indexOf(promptHead) !== -1; });
      var onChatUrl = /\\/c\\/[a-z0-9-]+/.test(window.location.pathname);
      var stopVisible = !!(stopBtn && stopBtn.offsetParent !== null);
      return {
        sessionExpired: sessionExpired,
        composerTextLength: composerText.length,
        composerStillHasPrompt: composerText.indexOf(promptHead) !== -1,
        hasUserMessage: hasUserMessage,
        userMessageCount: userMessageTexts.length,
        stopVisible: stopVisible,
        onChatUrl: onChatUrl,
      };
    })()`).catch(() => null);

    if (state?.sessionExpired) {
      return { ok: false, reason: 'session_expired', state };
    }
    if (state?.hasUserMessage) {
      return { ok: true, state };
    }
    // If stop button visible OR on a chat URL with empty composer = AI is generating = submit succeeded
    if (state?.stopVisible || (state?.onChatUrl && state?.composerTextLength === 0)) {
      return { ok: true, state };
    }
    await delay(1000);
  }
  return { ok: false, state: await getComposerState(tabId, userId).catch(() => null) };
}

/**
 * Automatically detects and clicks "Okay, let's go", "Next", "Skip", "Continue", "Done", etc.
 * onboarding buttons to clear ChatGPT's multi-step onboarding modals.
 */
async function dismissOnboardingModals(tabId, userId) {
  return await evalJson(tabId, userId, `(() => {
    const isVisible = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      return !!(rect.width || rect.height || el.getClientRects().length);
    };
    let clickedAny = false;
    const buttons = Array.from(document.querySelectorAll('button, [role="button"], a, [class*="button"], [class*="btn"]'));
    for (const btn of buttons) {
      if (!isVisible(btn)) continue;
      const text = (btn.innerText || btn.textContent || '').trim().toLowerCase();
      if (
        text.includes("let's go") ||
        text.includes("let’s go") ||
        text === "okay, let's go" ||
        text === "okay, let’s go" ||
        text === "okay" ||
        text === "ok" ||
        text === "got it" ||
        text === "done" ||
        text === "next" ||
        text === "skip" ||
        text === "continue" ||
        text === "get started" ||
        text === "tiếp tục" ||
        text === "bắt đầu" ||
        text === "đóng" ||
        text.includes("let's get started") ||
        text.includes("okay, let's get started") ||
        text.includes("you're all set")
      ) {
        btn.click();
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        clickedAny = true;
      }
    }
    return clickedAny;
  })()`).catch(() => false);
}

async function runWarmup() {
  const args = parseArgs();
  const accountId = args.accountId;
  
  if (!accountId) {
    console.error('❌ Thiếu đối số --accountId');
    process.exit(1);
  }
  
  let qCountArg = parseInt(args.questions || '0', 10);
  if (isNaN(qCountArg) || qCountArg <= 0) {
    qCountArg = randomInt(1, 3); // 1 to 3 questions randomly
  }
  
  console.log(`\n🔥 [Warmup] BẮT ĐẦU WARMUP TÀI KHOẢN: ${accountId}`);
  console.log(`[Warmup] 📝 Số câu hỏi tương tác dự kiến: ${qCountArg}\n`);
  
  // 1. Fetch account info from SeeLLM Tools local API
  let account;
  try {
    const res = await fetch(`${TOOLS_API_URL}/api/vault/accounts/${encodeURIComponent(accountId)}`);
    if (!res.ok) {
      throw new Error(`GET account returned status ${res.status}: ${await res.text()}`);
    }
    const data = await res.json();
    account = data.account;
  } catch (err) {
    console.error(`❌ Không tìm thấy thông tin tài khoản: ${err.message}`);
    process.exit(1);
  }
  
  const USER_ID = `seellm_warmup_${account.id}`;
  console.log(`SESSION_ID: ${USER_ID}`); // Quan trọng để frontend link ảnh chụp
  const SESSION_KEY = `warmup_${account.id}`;
  const effectiveProxy = normalizeProxyUrl(account.proxy_url || account.proxyUrl || account.proxy || null);
  
  let tabId = null;
  let preFlightResult = null;
  let questionsAsked = 0;
  let stepRecorder = null;
  let lastLoginAction = 'not-started';
  
  try {
    // Clean up root screenshot folder once before attempts run
    if (WARMUP_SCREENSHOTS) {
    const baseDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'screenshots', USER_ID);
    await fs.rm(baseDir, { recursive: true, force: true }).catch(() => {});
    }

    const maxAttempts = 3;
    let runSuccess = false;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        questionsAsked = 0; // Reset question count on retry attempt
        
        // 2. Pre-flight Proxy Assert (traffic isolation security)
        if (effectiveProxy) {
          console.log(`[Warmup] 🔒 [PreFlight] Kiểm tra proxy (lượt ${attempt}/${maxAttempts}): ${effectiveProxy}`);
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
            console.log(`[Warmup] ⚠️ [PreFlight] Thử lại ${preflightAttempt + 1}/2 sau lỗi: ${msg}`);
            await delay(2000 + preflightAttempt * 1500);
          }
        }
        if (!preFlightResult && lastErr) throw lastErr;
        console.log(`[Warmup] ✅ [PreFlight] Exit IP: ${preFlightResult.exitIp}`);
      } catch (err) {
        console.error(`[Warmup] 🛑 [PreFlight] Proxy verification FAILED: ${err.message}`);
        throw err;
      }
    }
    
    // 3. Open Camofox Tab
    console.log(`[Warmup] 🦊 Khởi động Camofox tab...`);
    const opened = await camofoxPost('/tabs', {
      userId: USER_ID,
      sessionKey: SESSION_KEY,
      url: 'about:blank',
      proxy: effectiveProxy || undefined,
      persistent: true, // Reuse profiles/cookies inside Camofox
      os: 'macos',
      screen: { width: 1440, height: 900 },
      humanize: true,
      headless: false,
      blockResources: true,
    }, { timeoutMs: 35000 });
    
    tabId = opened.tabId;
    await delay(1000);

    // Set up recorder as soon as a tab exists so early viewport/cookie/nav errors still leave evidence.
    if (WARMUP_SCREENSHOTS) {
    const runDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'screenshots', USER_ID, `attempt_${attempt}`);
    await fs.mkdir(runDir, { recursive: true });
    stepRecorder = createStepRecorder(runDir, { tabId, userId: USER_ID, ignoreGlobalDisable: true });
    console.log(`[Warmup] 📸 Chụp ảnh logs cho lượt thử ${attempt} đã bật! Thư mục ảnh: ${runDir}`);
    }

    // Set fixed viewport to avoid narrow/mobile layout on headful macOS
    console.log(`[Warmup] 🌐 Thiết lập viewport size 1440x900...`);
    await camofoxPost(`/tabs/${tabId}/viewport`, {
      userId: USER_ID,
      width: 1440,
      height: 900
    }).catch(err => {
      console.warn(`⚠️ [Warmup] Không thể thiết lập viewport: ${err.message}`);
    });

    await delay(2000);
    // 4. Import cookies from database if present
    if (account.cookies && Array.isArray(account.cookies) && account.cookies.length > 0) {
      console.log(`[Warmup] 🍪 Nạp ${account.cookies.length} cookies từ database vào browser context...`);
      try {
        await fetch(`${CAMOUFOX_API}/sessions/${USER_ID}/cookies`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cookies: account.cookies })
        });
        // Small delay to ensure browser context picks up the imported cookies
        // before navigation fires (import is async on camofox side)
        await delay(1500);
      } catch (err) {
        console.warn(`⚠️ [Warmup] Lỗi khi import cookies: ${err.message}`);
      }
    }
    
    // 5. Navigate to ChatGPT Chat interface
    console.log(`[Warmup] 🌐 Mở trang ChatGPT...`);
    await navigate(tabId, USER_ID, 'https://chatgpt.com/', { timeoutMs: 30000, waitUntil: 'commit' });
    await delay(5000);
    
    if (WARMUP_SCREENSHOTS && stepRecorder) {
      await stepRecorder.checkpoint(1, 1, 'chatgpt_initial_page');
    }
    
    // 6. Check login state
    const checkLoginState = async () => {
      const state = await getState(tabId, USER_ID);
      return state?.looksLoggedIn ?? false;
    };

    let isLoggedIn = await checkLoginState();
    
    if (!isLoggedIn) {
      console.log(`[Warmup] 👤 Chưa đăng nhập hoặc cookie hết hạn! Tiến hành đăng nhập...`);
      
      const maxLoginAttempts = 40;
      let emailFilled = false;
      let emailWaitCount = 0;
      let passwordFilled = false;
      let passwordWaitCount = 0;
      let passwordBlockCount = 0;
      let mfaFilled = false;
      let consecutiveRedirectClicks = 0; // Đếm số lần click redirect mà URL không thay đổi
      let lastLoginState = null;
      lastLoginAction = 'start';
      let loginWithStuckCount = 0;
      let lastLoginFingerprint = null;
      let repeatedLoginFingerprintCount = 0;
      let welcomeBackNoTransitionCount = 0;
      
      for (let attempt = 1; attempt <= maxLoginAttempts; attempt++) {
        console.log(`[Warmup] 🔑 Loop đăng nhập - Lượt ${attempt}/${maxLoginAttempts}...`);
        
        
        // 1. Get current state
        const state = await getState(tabId, USER_ID);
        if (!state) {
          console.warn(`[Warmup] ⚠️ Không thể lấy trạng thái trang (state is null) ở loop đăng nhập. Đang thử lại...`);
          lastLoginState = null;
          lastLoginAction = 'state-unavailable';
          await delay(2000);
          continue;
        }
        lastLoginState = state;
        const currentLoginFingerprint = getLoginScreenFingerprint(state);
        if (currentLoginFingerprint === lastLoginFingerprint) {
          repeatedLoginFingerprintCount++;
        } else {
          lastLoginFingerprint = currentLoginFingerprint;
          repeatedLoginFingerprintCount = 1;
        }

        const hrefLower = String(state.href || '').toLowerCase();
        const hostLower = String(state.host || '').toLowerCase();
        const isProviderDriftHost = hostLower.endsWith('accounts.google.com') ||
          hostLower.endsWith('appleid.apple.com') ||
          hostLower.endsWith('login.live.com') ||
          hostLower.endsWith('login.microsoftonline.com');

        if (isProviderDriftHost && !state.looksLoggedIn) {
          console.warn(`[Warmup] ⚠️ Provider drift sang ${hostLower} -> quay lại OpenAI password login ngay.`);
          lastLoginAction = `recover-provider-drift:${hostLower}`;
          emailFilled = false;
          emailWaitCount = 0;
          passwordFilled = false;
          passwordWaitCount = 0;
          repeatedLoginFingerprintCount = 0;
          welcomeBackNoTransitionCount = 0;
          await navigate(tabId, USER_ID, 'https://auth.openai.com/log-in', { timeoutMs: 20000, waitUntil: 'commit' }).catch(async () => {
            await navigate(tabId, USER_ID, 'https://chatgpt.com/?login', { timeoutMs: 15000, waitUntil: 'commit' }).catch(() => {});
          });
          await delay(4000);
          continue;
        }

        if (repeatedLoginFingerprintCount >= 6 && !state.looksLoggedIn) {
          console.warn(`[Warmup] ⚠️ Login screen fingerprint lặp ${repeatedLoginFingerprintCount} vòng: ${currentLoginFingerprint}`);
          if (state.hasEmailInput && !state.hasPasswordInput && !state.hasMfaInput && state.onAuthDomain) {
            lastLoginAction = 'fingerprint-email-refill';
            emailFilled = false;
            emailWaitCount = 0;
            repeatedLoginFingerprintCount = 0;
            console.warn(`[Warmup] ⚠️ Email screen đứng yên -> reset cờ để điền lại email ở handler chính.`);
          }
          if (state.hasLoggedOutChatShell && !state.onAuthDomain) {
            lastLoginAction = 'fingerprint-stuck-loggedout-shell';
            await dismissGooglePopupAndClickLogin(tabId, USER_ID).catch(() => {});
            await delay(3500);
            continue;
          }
        }
        console.log(`[Warmup] ℹ️ Lượt ${attempt} trạng thái trang:`);
        console.log(`   - URL: ${state.href}`);
        console.log(`   - onAuthDomain: ${state.onAuthDomain}`);
        console.log(`   - looksLoggedIn: ${state.looksLoggedIn}`);
        console.log(`   - hasEmailInput: ${state.hasEmailInput}`);
        console.log(`   - hasPasswordInput: ${state.hasPasswordInput}`);
        console.log(`   - hasMfaInput: ${state.hasMfaInput}`);
        console.log(`   - hasContinueWithPassword: ${state.hasContinueWithPassword}`);
        console.log(`   - hasLoggedOutChatShell: ${state.hasLoggedOutChatShell}`);
        console.log(`   - hasVisibleLoginAction: ${state.hasVisibleLoginAction}`);
        console.log(`   - hasVisibleSignUpAction: ${state.hasVisibleSignUpAction}`);
        console.log(`   - hasLoggedOutSidebarPrompt: ${state.hasLoggedOutSidebarPrompt}`);
        
        if (state.looksLoggedIn) {
          console.log(`[Warmup] 👤 Đăng nhập thành công (trạng thái looksLoggedIn = true)!`);
          isLoggedIn = true;
          break;
        }

        // Reset bộ đếm khi URL đã chuyển sang auth domain thành công
        if (state.onAuthDomain) {
          consecutiveRedirectClicks = 0;
        }

        if (hrefLower.includes('/auth/login_with') && !state.hasEmailInput && !state.hasPasswordInput && !state.hasMfaInput) {
          loginWithStuckCount++;
          if (loginWithStuckCount >= 4) {
            console.warn(`[Warmup] ⚠️ auth/login_with kẹt ${loginWithStuckCount} vòng không render form -> force reload auth.openai.com/log-in sạch...`);
            lastLoginAction = 'recover-login-with-stuck';
            loginWithStuckCount = 0;
            emailFilled = false;
            emailWaitCount = 0;
            passwordFilled = false;
            passwordWaitCount = 0;
            welcomeBackNoTransitionCount = 0;
            await navigate(tabId, USER_ID, 'https://auth.openai.com/log-in', { timeoutMs: 20000, waitUntil: 'commit' }).catch(async () => {
              await navigate(tabId, USER_ID, 'https://chatgpt.com/auth/login', { timeoutMs: 15000, waitUntil: 'commit' }).catch(() => {});
            });
            await delay(4000);
            continue;
          }
        } else {
          loginWithStuckCount = 0;
        }
        
        if (state.hasDeactivated) {
          throw new Error('ACCOUNT_DEACTIVATED: Tài khoản đã bị khóa');
        }

        if (state.hasResetPasswordScreen) {
          throw new Error('PASSWORD_RESET_REQUIRED: Tài khoản yêu cầu đặt lại mật khẩu');
        }

        if (state.hasWrongPassword) {
          throw new Error('WRONG_PASSWORD: Mật khẩu không đúng');
        }
        
        // 1.5. Handle OpenAI/ChatGPT Error screen with self-healing click
        if (state.hasError && !state.isOnboardingScreen) {
          console.log(`[Warmup] ⚠️ Phát hiện lỗi trên trang OpenAI/ChatGPT! URL: ${state.href}`);
          // Reset tất cả flags để login loop bắt đầu lại sạch
          emailFilled = false;
          emailWaitCount = 0;
          passwordFilled = false;
          passwordWaitCount = 0;
          mfaFilled = false;
          welcomeBackNoTransitionCount = 0;

          // Navigate thẳng về chatgpt.com thay vì click "Go back" (tránh vòng lặp redirect)
          // "Go back" sau workspace selection thường đưa về login page gây loop
          console.log(`[Warmup] 🔄 Điều hướng lại về chatgpt.com để khắc phục lỗi...`);
          lastLoginAction = 'recover-error-screen';
          try {
            await navigate(tabId, USER_ID, 'https://chatgpt.com/');
          } catch (_) {
            // Fallback: click "Go back" nếu navigate thất bại
            await evalJson(tabId, USER_ID, `(() => {
              const btn = Array.from(document.querySelectorAll('button, a, [role="button"]'))
                .find(el => {
                  const t = (el.innerText || el.textContent || '').trim().toLowerCase();
                  return t.includes('go back') || t.includes('try again') || t.includes('thử lại') || t.includes('quay lại');
                });
              if (btn) { btn.click(); return true; }
              return false;
            })()`).catch(() => false);
          }
          await delay(6000);
          continue;
        }

        if (!state.onAuthDomain) {
          if (emailFilled && emailWaitCount < 3) {
            console.log(`[Warmup] ⏳ Đang chờ chuyển trang sau khi điền email...`);
            await delay(3000);
            continue;
          }
          if (passwordFilled && passwordWaitCount < 3) {
            console.log(`[Warmup] ⏳ Đang chờ chuyển trang sau khi điền password...`);
            await delay(3000);
            continue;
          }

          if (emailFilled || passwordFilled) {
            console.log(`[Warmup] 🔄 Trang đã rời khỏi input nhưng chưa login xong -> reset trạng thái và quay lại login flow...`);
            emailFilled = false;
            emailWaitCount = 0;
            passwordFilled = false;
            passwordWaitCount = 0;
            consecutiveRedirectClicks = 0; // reset vì ta đã vào được auth domain trước đó
            welcomeBackNoTransitionCount = 0;
            lastLoginAction = 'reset-after-left-input';
            await dismissGooglePopupAndClickLogin(tabId, USER_ID);
            await delay(4000);
            continue;
          }

          consecutiveRedirectClicks++;
          if (consecutiveRedirectClicks >= 3) {
            // Click DOM không hiệu quả → force navigate thẳng đến trang đăng nhập
            console.log(`[Warmup] 🚨 Click redirect thất bại ${consecutiveRedirectClicks} lần liên tiếp -> Force navigate thẳng đến auth.openai.com/log-in...`);
            consecutiveRedirectClicks = 0;
            lastLoginAction = 'force-auth-log-in';
            try {
              await navigate(tabId, USER_ID, 'https://auth.openai.com/log-in', { timeoutMs: 20000, waitUntil: 'commit' });
            } catch (navErr) {
              console.warn(`[Warmup] ⚠️ Force navigate thất bại: ${navErr.message}. Thử lại bằng chatgpt.com login page...`);
              await navigate(tabId, USER_ID, 'https://chatgpt.com/?login', { timeoutMs: 15000, waitUntil: 'commit' }).catch(() => {});
            }
            await delay(3000);
          } else {
            console.log(`[Warmup] 🌐 Đang ở trang chủ nhưng chưa đăng nhập -> Chuyển hướng tới trang login (lần ${consecutiveRedirectClicks}/3)...`);
            lastLoginAction = 'click-chatgpt-login';
            await dismissGooglePopupAndClickLogin(tabId, USER_ID);
            await delay(4000);
          }
          continue;
        }
        
        // 2. Handle Welcome Back dialog (Diane Mitchell dialog in Image 1)
        const chooseResult = await clickWelcomeBackContinue(tabId, USER_ID, account.email);
        if (chooseResult?.ok) {
          console.log(`[Warmup] 👤 Phát hiện bảng Welcome Back -> Đã xử lý: ${chooseResult.method || chooseResult.reason} (transitioned=${chooseResult.transitioned})`);
          lastLoginAction = `welcome-back:${chooseResult.method || 'ok'}`;
          if (chooseResult.transitioned === false) {
            const transitionedState = await waitStateTransition(tabId, USER_ID, state, 5000, 1000);
            if (transitionedState) {
              console.log(`[Warmup] ✅ Welcome Back đã chuyển trạng thái sau khi chờ: ${summarizeLoginState(transitionedState)}`);
              welcomeBackNoTransitionCount = 0;
              repeatedLoginFingerprintCount = 0;
              await delay(1000);
              continue;
            }

            welcomeBackNoTransitionCount++;
            repeatedLoginFingerprintCount = Math.max(repeatedLoginFingerprintCount, 6);
            console.warn(`[Warmup] ⚠️ Welcome Back click không đổi trang/form (${welcomeBackNoTransitionCount}/2), method=${chooseResult.method || 'unknown'}, text="${chooseResult.text || ''}"`);
            if (welcomeBackNoTransitionCount >= 2) {
              console.warn(`[Warmup] ⚠️ Welcome Back đứng yên sau ${welcomeBackNoTransitionCount} lần -> bỏ remembered account và ép login password sạch.`);
              lastLoginAction = `welcome-back-stuck:${chooseResult.method || 'unknown'}`;
              emailFilled = false;
              emailWaitCount = 0;
              passwordFilled = false;
              passwordWaitCount = 0;
              repeatedLoginFingerprintCount = 0;
              welcomeBackNoTransitionCount = 0;
              throw new Error(`Welcome Back bị kẹt/loop (no-transition): ${chooseResult.method || 'unknown'}`);
            }
          } else {
            welcomeBackNoTransitionCount = 0;
            repeatedLoginFingerprintCount = 0;
          }
          await delay(4000);
          continue;
        }

        if (chooseResult?.reason === 'welcome-back-stuck' || chooseResult?.reason === 'welcome-back-loop') {
          console.warn(`[Warmup] ⚠️ Welcome Back bị kẹt/loop -> reset state và quay lại auth login sạch.`);
          lastLoginAction = `welcome-back-recover:${chooseResult.reason}`;
          emailFilled = false;
          emailWaitCount = 0;
          passwordFilled = false;
          passwordWaitCount = 0;
          repeatedLoginFingerprintCount = 0;
          welcomeBackNoTransitionCount = 0;
          throw new Error(`Welcome Back bị kẹt/loop: ${chooseResult.reason}`);
        }

        // 2.5. Handle auth.openai.com landing page: "Log in" button visible but no form yet
        // Xảy ra khi navigate thẳng đến auth.openai.com/log-in nhưng trang hiển thị
        // nút "Log in" + "Sign up" mà chưa render form email (React chưa hydrate xong).
        if (state.onAuthDomain && state.hasVisibleLoginAction && !state.hasEmailInput && !state.hasPasswordInput && !state.hasMfaInput) {
          console.log(`[Warmup] 🖱️ Ở auth domain nhưng chưa có form email -> Click nút "Log in" để mở form đăng nhập...`);
          const clickedLoginBtn = await evalJson(tabId, USER_ID, `(() => {
            const isVisible = el => {
              if (!el) return false;
              const s = window.getComputedStyle(el);
              const r = el.getBoundingClientRect();
              return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0' && r.width > 0 && r.height > 0;
            };
            const isSocialAuthButton = el => {
              const text = (el.innerText || el.textContent || el.value || '').trim().toLowerCase();
              const aria = (el.getAttribute('aria-label') || '').trim().toLowerCase();
              const testId = (el.getAttribute('data-testid') || '').trim().toLowerCase();
              const href = (el.getAttribute('href') || '').trim().toLowerCase();
              const combined = [text, aria, testId, href].join(' ');
              return combined.includes('google') ||
                combined.includes('apple') ||
                combined.includes('microsoft') ||
                combined.includes('continue with') ||
                combined.includes('sign in with') ||
                combined.includes('log in with') ||
                combined.includes('oauth');
            };
            const loginKeywords = ['log in', 'login', 'sign in', 'đăng nhập', 'anmelden', 'se connecter', 'iniciar sesión', 'accedi', 'entrar', 'войти'];
            const els = Array.from(document.querySelectorAll('button, a, [role="button"]')).filter(isVisible).filter(el => !isSocialAuthButton(el));
            for (const el of els) {
              const text = (el.innerText || el.textContent || '').trim().toLowerCase();
              const href = (el.getAttribute('href') || '').toLowerCase();
              const testId = (el.getAttribute('data-testid') || '').toLowerCase();
              if (loginKeywords.some(k => text === k) || testId.includes('login') || href.includes('/log-in') || href.includes('/login')) {
                el.click();
                el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                return { clicked: true, text: text.slice(0, 60), href, testId };
              }
            }
            // Fallback: nếu không tìm thấy nút exact match, thử bất kỳ nút nào có text ngắn gồm "log"
            for (const el of els) {
              const text = (el.innerText || el.textContent || '').trim().toLowerCase();
              if (text.includes('log') && text.length < 20) {
                el.click();
                el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                return { clicked: true, fallback: true, text: text.slice(0, 60) };
              }
            }
            return { clicked: false, totalEls: els.length };
          })()`).catch(() => null);
          console.log(`[Warmup] 🖱️ Click "Log in" result:`, JSON.stringify(clickedLoginBtn));
          lastLoginAction = clickedLoginBtn?.clicked ? 'click-auth-login-button' : 'auth-login-button-not-found';
          await delay(3000);
          continue;
        }
        
        // 3. Handle Cookie Banner
        if (state.hasCookieBanner) {
          console.log(`[Warmup] 🍪 Phát hiện cookie banner -> Chấp nhận cookies...`);
          const clicked = await tryAcceptCookies(tabId, USER_ID);
          await delay(2000);
          if (clicked) {
            lastLoginAction = 'accept-cookies';
            continue;
          }
        }
        
        // 4. Handle Workspace Selection (Image 2)
        if (state.isWorkspaceScreen) {
          console.log(`[Warmup] 🗂️ Phát hiện màn hình chọn Workspace -> Chọn Personal account...`);
          const wsResult = await selectPersonalWorkspaceOnWorkspacePage(tabId, USER_ID, { timeoutMs: 15000 });
          if (wsResult?.ok) {
            console.log(`[Warmup] ✅ Đã chọn Personal workspace: ${wsResult.text || ''}`);
            lastLoginAction = 'select-personal-workspace';
            await delay(4000);
          } else {
            console.warn(`[Warmup] ⚠️ Chọn Workspace thất bại: ${wsResult?.reason}`);
            lastLoginAction = `workspace-select-failed:${wsResult?.reason || 'unknown'}`;
            await delay(2000);
          }
          continue;
        }
        
         // 4.5. Handle Email Inbox verification screen ("Check your inbox")
        // Xảy ra khi OpenAI yêu cầu xác minh email trước khi vào màn hình mật khẩu.
        // Phân biệt với TOTP: trang này có nút "Continue with password" → click để đi thẳng vào password screen.
        if (state.hasEmailInboxScreen || state.hasContinueWithPassword) {
          console.log(`[Warmup] 📬 Phát hiện màn hình xác minh qua Email ("Check your inbox"). Chuyển sang nhập mật khẩu...`);
          const cwpResult = await clickContinueWithPassword(tabId, USER_ID);
          if (cwpResult?.ok) {
            console.log(`[Warmup] ✅ Đã click "Continue with password" (method: ${cwpResult.method}). Chờ màn hình mật khẩu...`);
            passwordFilled = false;
            passwordWaitCount = 0;
            lastLoginAction = `continue-with-password:${cwpResult.method || 'ok'}`;
            await delay(4000);
          } else {
            console.warn(`[Warmup] ⚠️ Không tìm thấy nút "Continue with password" trên màn hình email. Thử lại...`);
            lastLoginAction = 'continue-with-password-not-found';
            await delay(3000);
          }
          continue;
        }

        // 5. Handle Password Input
        if (state.hasPasswordInput) {
          if (passwordFilled) {
            passwordWaitCount++;
            if (passwordWaitCount < 3) {
              console.log(`[Warmup] 🔑 Password đã được điền ở lượt trước, đang chờ đăng nhập (lần đợi ${passwordWaitCount})...`);
              // Retrigger password submit click just in case the password is still in the input box
              const clicked = await evalJson(tabId, USER_ID, `(() => {
                const input = document.querySelector('input[type="password"], input[name="password"], input[id="password"]');
                if (input && !input.value.trim()) {
                  return false;
                }
                const btn = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]'))
                  .find(el => {
                    const t = (el.innerText || el.textContent || el.value || '').trim().toLowerCase();
                    const aria = (el.getAttribute('aria-label') || '').trim().toLowerCase();
                    const href = (el.getAttribute('href') || '').trim().toLowerCase();
                    const combined = [t, aria, href].join(' ');
                    const isSocial = combined.includes('google') || combined.includes('apple') || combined.includes('microsoft') || combined.includes('continue with') || combined.includes('sign in with') || combined.includes('log in with') || combined.includes('oauth');
                    return !isSocial && (t === 'continue' || t === 'sign in' || t === 'log in' || t === 'next' || t === 'tiếp tục');
                  });
                if (btn) {
                  btn.click();
                  btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                  return true;
                }
                return false;
              })()`).catch(() => null);
              
              if (clicked === false) {
                if (passwordWaitCount >= 2) {
                  console.log(`[Warmup] 🔑 Ô nhập password bị trống sau ${passwordWaitCount} lần chờ -> Tiến hành điền lại password...`);
                  passwordFilled = false;
                  passwordWaitCount = 0;
                } else {
                  console.log(`[Warmup] 🔑 Ô nhập password tạm thời trống (trang đang chuyển), tiếp tục chờ (lần ${passwordWaitCount}/2)...`);
                }
              }
              lastLoginAction = clicked ? 'retrigger-password-submit' : 'password-submit-not-ready';
              await delay(3000);
              continue;
            } else {
              console.log(`[Warmup] ⚠️ Đã đợi lâu nhưng vẫn ở màn hình password -> Tiến hành điền lại password...`);
              passwordFilled = false;
              passwordWaitCount = 0;
            }
          }
          if (!passwordFilled) {
            console.log(`[Warmup] 🔑 Điền password...`);
            const pwdResult = await fillPassword(tabId, USER_ID, account.password);
            if (pwdResult && pwdResult.ok === false && pwdResult.isBlock) {
              if (pwdResult.reason === 'PASSWORD_TOO_SHORT') {
                throw new Error(`PASSWORD_TOO_SHORT: Mật khẩu hiện tại (${account.password ? account.password.length : 0} ký tự) ngắn hơn yêu cầu 12 ký tự của OpenAI`);
              }
              passwordBlockCount++;
              console.warn(`[Warmup] ⚠️ Gặp màn hình Cloudflare Turnstile hoặc IP bị chặn (lần ${passwordBlockCount}/3)...`);
              if (passwordBlockCount >= 3) {
                throw new Error(`BLOCKED_BY_OPENAI_TURNSTILE: ${pwdResult.reason || 'Bị chặn bởi Cloudflare Turnstile'}`);
              }
              // Reset passwordFilled and delay to try again in next round
              passwordFilled = false;
              passwordWaitCount = 0;
              await delay(3000);
              continue;
            }
            passwordFilled = true;
            passwordWaitCount = 0;
            lastLoginAction = `fill-password:${pwdResult?.strategy || 'unknown'}`;
            if (WARMUP_SCREENSHOTS && stepRecorder) {
              await stepRecorder.checkpoint(1, 3, 'login_password_filled');
            }
            await waitStateTransition(tabId, USER_ID, state, 6000);
            continue;
          }
        }
        
        // 6. Handle Email Input
        if (state.hasEmailInput) {
          if (emailFilled) {
            emailWaitCount++;
            if (emailWaitCount < 3) {
              console.log(`[Warmup] 📧 Email đã được điền ở lượt trước, đang chờ chuyển trang (lần đợi ${emailWaitCount})...`);
              // Retrigger the continue click just in case the email is actually in the input box
              const clicked = await evalJson(tabId, USER_ID, `(() => {
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
                  if (el && el.offsetParent !== null) { input = el; break; }
                }
                
                // If there's an input box but it has no value (cleared), don't click Continue
                if (input && !input.value.trim()) {
                  return false;
                }
                
                const btn = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]'))
                  .find(el => {
                    const t = (el.innerText || el.textContent || el.value || '').trim().toLowerCase();
                    const aria = (el.getAttribute('aria-label') || '').trim().toLowerCase();
                    const href = (el.getAttribute('href') || '').trim().toLowerCase();
                    const combined = [t, aria, href].join(' ');
                    const isSocial = combined.includes('google') || combined.includes('apple') || combined.includes('microsoft') || combined.includes('continue with') || combined.includes('sign in with') || combined.includes('log in with') || combined.includes('oauth');
                    return !isSocial && (t === 'continue' || t === 'next' || t === 'tiếp tục');
                  });
                if (btn) {
                  btn.click();
                  btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                  return true;
                }
                return false;
              })()`).catch(() => null);
              
              if (clicked === false) {
                if (emailWaitCount >= 2) {
                  console.log(`[Warmup] 📧 Ô nhập email bị trống sau ${emailWaitCount} lần chờ -> Tiến hành điền lại email...`);
                  emailFilled = false;
                  emailWaitCount = 0;
                } else {
                  console.log(`[Warmup] 📧 Ô nhập email tạm thời trống (trang đang chuyển), tiếp tục chờ (lần ${emailWaitCount}/2)...`);
                }
              }
              lastLoginAction = clicked ? 'retrigger-email-submit' : 'email-submit-not-ready';
              await delay(3000);
              continue;
            } else {
              console.log(`[Warmup] ⚠️ Đã đợi lâu nhưng vẫn ở màn hình email -> Tiến hành điền lại email...`);
              emailFilled = false;
              emailWaitCount = 0;
            }
          }
          if (!emailFilled) {
            // 6a. Check if this is "Welcome back" screen with email pre-filled — use native click instead of fillEmail
            const wbPrefilledCheck = await clickWelcomeBackContinue(tabId, USER_ID, account.email);
            const isWelcomeBackNative = wbPrefilledCheck?.ok && (
              wbPrefilledCheck?.method === 'native-actclick-continue' ||
              wbPrefilledCheck?.method === 'native-press-enter' ||
              wbPrefilledCheck?.method === 'welcome-back-prefilled-email-no-click'
            );
            if (isWelcomeBackNative) {
              // clickWelcomeBackContinue already handled via native actClick/actPress
              console.log(`[Warmup] 👤 Welcome Back (pre-filled email) - native click result: method=${wbPrefilledCheck.method}, transitioned=${wbPrefilledCheck.transitioned}`);
              lastLoginAction = `welcome-back-native-click:${wbPrefilledCheck.method}`;
              emailFilled = true;
              emailWaitCount = 0;
              welcomeBackNoTransitionCount = wbPrefilledCheck.transitioned ? 0 : (welcomeBackNoTransitionCount + 1);
              if (!wbPrefilledCheck.transitioned && welcomeBackNoTransitionCount >= 3) {
                console.warn(`[Warmup] ⚠️ Welcome Back native click kẹt ${welcomeBackNoTransitionCount} lần -> reset email để thử lại.`);
                emailFilled = false;
                emailWaitCount = 0;
                welcomeBackNoTransitionCount = 0;
              }
              await delay(3000);
              continue;
            }
            // 6b. Normal fillEmail flow
            console.log(`[Warmup] 📧 Điền email: ${account.email}`);
            const fillResult = await fillEmail(tabId, USER_ID, account.email);
            if (!fillResult?.ok) {
              console.warn(`[Warmup] ⚠️ fillEmail failed: ${fillResult?.reason || 'unknown'} — sẽ thử lại ở vòng sau`);
              emailFilled = false;
              emailWaitCount = 0;
              lastLoginAction = `fill-email-failed:${fillResult?.reason || 'unknown'}`;
              await delay(3000);
              continue;
            }
            emailFilled = true;
            emailWaitCount = 0;
            lastLoginAction = `fill-email:${fillResult?.strategy || 'unknown'}`;
            if (WARMUP_SCREENSHOTS && stepRecorder) {
              await stepRecorder.checkpoint(1, 2, 'login_email_filled');
            }
            await waitStateTransition(tabId, USER_ID, state, 5000);
            continue;
          }
        }
        
        // 7. Handle MFA Input
        if (state.hasMfaInput) {
          console.log(`[Warmup] 🛡️ Phát hiện màn hình 2FA!`);
          const totpSecret = account.two_fa_secret || account.twoFaSecret;
          if (!totpSecret) {
            throw new Error('Tài khoản yêu cầu 2FA nhưng không có Secret Key!');
          }
          const { otp } = await getFreshTOTP(totpSecret);
          console.log(`[Warmup] 🔢 Điền mã OTP: ${otp}`);
          await fillMfa(tabId, USER_ID, otp);
          mfaFilled = true;
          lastLoginAction = 'fill-totp';
          if (WARMUP_SCREENSHOTS && stepRecorder) {
            await stepRecorder.checkpoint(1, 4, 'login_mfa_filled');
          }
          await delay(5000);
          continue;
        }

        // 7.5. Handle Email OTP Screen (Device Verification)
        if (state.hasEmailOtpInput) {
          console.log(`[Warmup] 📧 Phát hiện thử thách OTP gửi qua Email!`);
          let emailCreds = null;
          try {
            const res = await fetch(`${TOOLS_API_URL}/api/vault/email-pool/${encodeURIComponent(account.email)}`);
            if (res.ok) {
              const data = await res.json();
              emailCreds = data.item;
            }
          } catch (_) {}

          const refreshToken = emailCreds?.refreshToken || emailCreds?.refresh_token;
          const clientId = emailCreds?.clientId || emailCreds?.client_id;
          if (refreshToken && clientId) {
            console.log(`[Warmup] 🔄 Đang tự động lấy mã OTP từ Email...`);
            if (stepRecorder) await stepRecorder.before(4, 1, 'before_email_otp');
            const otpCode = await waitForOTPCode({
              email: account.email,
              refreshToken: refreshToken,
              clientId: clientId,
              senderDomain: 'openai.com',
              maxWaitSecs: 120
            });
            if (otpCode) {
              console.log(`[Warmup] 🔢 Nhập mã OTP từ email: ${otpCode}`);
              await fillMfa(tabId, USER_ID, otpCode);
              lastLoginAction = 'fill-email-otp';
              await delay(6000);
              if (stepRecorder) await stepRecorder.after(4, 1, 'email_otp_filled');
              continue;
            } else {
              throw new Error('EMAIL_OTP_REQUIRED: Không lấy được mã OTP từ email hoặc hết thời gian chờ!');
            }
          } else {
            throw new Error('EMAIL_OTP_REQUIRED: Yêu cầu mã OTP email nhưng thông tin email pool không đủ để lấy OTP (thiếu refresh_token/client_id)!');
          }
        }

        // 7.6. Handle Passkey Enrollment (faster login) screen
        if (state.hasPasskeyEnrollScreen) {
          console.log(`[Warmup] 🔑 Phát hiện màn hình đăng ký Passkey ("Log in faster next time"). Tiến hành bỏ qua...`);
          const dismissed = await tryDismissPasskeyEnrollment(tabId, USER_ID);
          if (dismissed) {
            console.log(`[Warmup] ✅ Đã bỏ qua màn hình Passkey thành công!`);
            lastLoginAction = 'dismiss-passkey';
            await delay(3000);
            continue;
          }
        }
        
        // Fallback sleep
        await delay(3000);
      }
      
      if (!isLoggedIn) {
        throw new Error(classifyLoginTimeout(lastLoginState, {
          lastLoginAction,
          emailWaitCount,
          passwordWaitCount,
        }));
      }
    } else {
      console.log(`[Warmup] ✅ Session hợp lệ!`);
    }

    // 6b. Self-healing wrong/restricted workspace (e.g. Codex/SeeLLM plan instead of Personal account)
    if (isLoggedIn) {
      const isRestricted = await evalJson(tabId, USER_ID, `(() => {
        const body = (document.body?.innerText || '').toLowerCase();
        return body.includes("you don't have chatgpt access on this plan") || 
               body.includes("assigned codex access only") ||
               body.includes("back to codex");
      })()`);

      if (isRestricted) {
        console.log(`[Warmup] ⚠️ Phát hiện tài khoản đang ở Workspace bị giới hạn! Đang tự động chuyển sang Personal Workspace...`);
        
        if (WARMUP_SCREENSHOTS && stepRecorder) {
          await stepRecorder.checkpoint(2, 2, 'wrong_workspace_detected');
        }

        // STEP 1: Dismiss the blocking restricted modal dialog and its backdrop first!
        await evalJson(tabId, USER_ID, `(() => {
          // Press Escape key
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true }));
          
          // Click close "X" button if found
          const buttons = Array.from(document.querySelectorAll('button'));
          const closeBtn = buttons.find(el => {
            const label = (el.getAttribute('aria-label') || '').toLowerCase();
            const text = (el.textContent || '').trim().toLowerCase();
            return label.includes('close') || label.includes('đóng') || text === '✕' || text === '×';
          });
          if (closeBtn) {
            closeBtn.click();
            closeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          }
        })()`);
        console.log(`[Warmup] 🛡️ Đã bấm đóng/Escape để tắt hộp thoại chặn và giải phóng backdrop...`);
        await delay(2000);

        // STEP 2: Click profile button using Camofox browser-level click API (not JS dispatchEvent)
        // Radix UI menus don't respond to synthetic JS events; Camofox click simulates real user clicks.
        // There are 2 elements with data-testid="accounts-profile-button" (collapsed + expanded sidebar),
        // so we use snapshot to find the correct ref and click it to avoid strict mode violations.
        let switchResult = 'not_attempted';
        try {
          // Take snapshot to find profile button ref
          console.log(`[Warmup] 🖱️ Finding profile button via Camofox snapshot...`);
          const preSnapshot = await getSnapshot(tabId, USER_ID, { timeoutMs: 5000 });
          let profileClicked = false;
          
          if (preSnapshot?.snapshot) {
            const preLines = preSnapshot.snapshot.split('\n');
            for (const line of preLines) {
              const lower = line.toLowerCase();
              if (lower.includes('open profile menu') || lower.includes('profile menu')) {
                const refMatch = line.match(/\b(e\d+)\b/);
                if (refMatch) {
                  await clickRef(tabId, USER_ID, refMatch[1], { timeoutMs: 5000 });
                  console.log(`[Warmup] 🖱️ Clicked profile button ref=${refMatch[1]}`);
                  profileClicked = true;
                  break;
                }
              }
            }
          }
          
          if (!profileClicked) {
            // Fallback: try with specific aria-label selector 
            await camofoxPost(`/tabs/${tabId}/click`, { userId: USER_ID, selector: '[data-testid="accounts-profile-button"][aria-label*="open profile menu" i]' }, { timeoutMs: 5000 });
            console.log(`[Warmup] 🖱️ Clicked profile button via fallback selector`);
          }
          await delay(2500);
          
          // Take accessibility snapshot to find Personal workspace menu item
          const snapshot = await getSnapshot(tabId, USER_ID, { timeoutMs: 5000 });
          if (snapshot?.snapshot) {
            const snapshotText = snapshot.snapshot;
            const lines = snapshotText.split('\n');
            const personalKeywords = ['personal account', 'personal workspace', 'cá nhân', 'gabriel webb', 'personal'];
            
            // Step 2a: Look for personal workspace directly in first dropdown
            let personalRef = null;
            for (const line of lines) {
              const lower = line.toLowerCase();
              const refMatch = line.match(/\b(e\d+)\b/);
              if (!refMatch) continue;
              
              const hasPersonalKw = personalKeywords.some(k => {
                if (k === 'personal') {
                  return lower.includes('personal') && !lower.includes('personalization') && !lower.includes('personalize');
                }
                return lower.includes(k);
              });
              if (hasPersonalKw) {
                const isProfileBtn = lower.includes('open profile menu') || lower.includes('accounts-profile');
                if (!isProfileBtn) {
                  personalRef = refMatch[1];
                  console.log(`[Warmup] 🎯 Found personal workspace item ref=${personalRef} directly in first dropdown: ${line.trim().slice(0, 80)}`);
                  break;
                }
              }
            }

            // Step 2b: Expand active workspace submenu if not found in first level
            if (!personalRef) {
              console.log('[Warmup] 🖱️ "Personal" not directly in dropdown. Searching for active workspace submenu trigger...');
              let workspaceSwitcherRef = null;
              for (const line of lines) {
                const lower = line.toLowerCase();
                if (lower.includes('menuitem') && 
                    (lower.includes('seellm') || lower.includes('business') || (lower.includes('workspace') && !lower.includes('settings')))) {
                  const refMatch = line.match(/\b(e\d+)\b/);
                  if (refMatch) {
                    workspaceSwitcherRef = refMatch[1];
                    console.log(`[Warmup] 🖱️ Found active workspace trigger ref=${workspaceSwitcherRef} in line: ${line.trim().slice(0, 80)}`);
                    break;
                  }
                }
              }

              if (workspaceSwitcherRef) {
                try {
                  console.log(`[Warmup] 🖱️ Expanding workspace submenu by clicking ref=${workspaceSwitcherRef}...`);
                  await clickRef(tabId, USER_ID, workspaceSwitcherRef, { timeoutMs: 5000 });
                  await delay(2000);

                  // Take a new snapshot of the sub-menu
                  const subSnapshot = await getSnapshot(tabId, USER_ID, { timeoutMs: 5000 });
                  if (subSnapshot?.snapshot) {
                    const subLines = subSnapshot.snapshot.split('\n');
                    
                    // Pass 1: Match explicit personal keywords in the sub-menu
                    for (const line of subLines) {
                      const lower = line.toLowerCase();
                      if (lower.includes('menuitemradio')) {
                        const hasPersonalKw = personalKeywords.some(k => {
                          if (k === 'personal') {
                            return lower.includes('personal') && !lower.includes('personalization') && !lower.includes('personalize');
                          }
                          return lower.includes(k);
                        });
                        if (hasPersonalKw) {
                          const refMatch = line.match(/\b(e\d+)\b/);
                          if (refMatch) {
                            personalRef = refMatch[1];
                            console.log(`[Warmup] 🎯 Found personal workspace item ref=${personalRef} in submenu by keyword: ${line.trim().slice(0, 80)}`);
                            break;
                          }
                        }
                      }
                    }

                    // Pass 2: Fallback to the other non-checked, non-business workspace item
                    if (!personalRef) {
                      for (const line of subLines) {
                        const lower = line.toLowerCase();
                        if (lower.includes('menuitemradio') && !lower.includes('[checked]') && !lower.includes('seellm') && !lower.includes('business')) {
                          const refMatch = line.match(/\b(e\d+)\b/);
                          if (refMatch) {
                            personalRef = refMatch[1];
                            console.log(`[Warmup] 🎯 Found personal workspace item ref=${personalRef} in submenu by non-checked fallback: ${line.trim().slice(0, 80)}`);
                            break;
                          }
                        }
                      }
                    }

                    // Pass 3: DOM evaluation fallback click (since menuitemradio options lack refs in snapshot)
                    if (!personalRef) {
                      console.log('[Warmup] 🖱️ Submenu refs not found in snapshot. Attempting DOM evaluation click...');
                      const domClickResult = await evalJson(tabId, USER_ID, `(() => {
                        const radios = Array.from(document.querySelectorAll('[role="menuitemradio"]'));
                        const target = radios.find(el => {
                          const checked = el.getAttribute('aria-checked') === 'true';
                          const txt = (el.textContent || '').toLowerCase();
                          return !checked && !txt.includes('seellm') && !txt.includes('business') && !txt.includes('workspace');
                        });
                        if (target) {
                          target.click();
                          return { ok: true, text: target.textContent };
                        }
                        return { ok: false };
                      })()`, 3000);

                      if (domClickResult?.ok) {
                        console.log(`[Warmup] 🎯 Clicked personal workspace in DOM: ${domClickResult.text}`);
                        personalRef = 'dom_evaluated_click';
                      } else {
                        console.warn('[Warmup] ⚠️ DOM evaluation click did not find target.');
                      }
                    }
                  }
                } catch (e) {
                  console.warn('[Warmup] ⚠️ Submenu traversal failed:', e.message);
                }
              }
            }
            
            if (personalRef) {
              if (personalRef !== 'dom_evaluated_click') {
                await clickRef(tabId, USER_ID, personalRef, { timeoutMs: 5000 });
                console.log(`[Warmup] ✅ Clicked personal workspace via Camofox ref=${personalRef}`);
              } else {
                console.log('[Warmup] ✅ Workspace already clicked via DOM evaluation.');
              }
              switchResult = `clicked_personal_item_ref_${personalRef}`;
            } else {
              switchResult = 'personal_item_not_found_in_snapshot';
              // Close dropdown before fallback
              try {
                await camofoxPost(`/tabs/${tabId}/click`, { userId: USER_ID, selector: 'body' }, { timeoutMs: 3000 });
              } catch (_) {}
            }
          } else {
            switchResult = 'snapshot_empty';
          }
        } catch (e) {
          switchResult = `camofox_click_error: ${e.message}`;
        }

        console.log(`[Warmup] 🗂️ Kết quả chuyển Workspace: ${switchResult}`);
        await delay(5000);

        // Fallback Strategy B: If profile dropdown failed, navigate to /workspace directly and use the standard selection helper!
        if (!switchResult.startsWith('clicked_personal_item')) {
          console.log(`[Warmup] ⚠️ Chuyển bằng Dropdown thất bại. Sử dụng Fallback: Điều hướng trực tiếp sang /workspace...`);
          await navigate(tabId, USER_ID, 'https://chatgpt.com/workspace');
          await delay(6000);
          
          if (WARMUP_SCREENSHOTS && stepRecorder) {
            await stepRecorder.checkpoint(2, 3, 'forced_workspace_navigation');
          }

          const wsResult = await selectPersonalWorkspaceOnWorkspacePage(tabId, USER_ID, { timeoutMs: 20000 });
          console.log(`[Warmup] ✅ Kết quả chọn Workspace tại trang /workspace: ${JSON.stringify(wsResult)}`);
          await delay(5000);
        }

        if (WARMUP_SCREENSHOTS && stepRecorder) {
          await stepRecorder.checkpoint(2, 4, 'after_workspace_healed');
        }
      }
    }
    
    if (WARMUP_SCREENSHOTS && stepRecorder) {
      await stepRecorder.checkpoint(2, 1, 'chatgpt_logged_in_dashboard');
    }

    await assertChatgptAuthenticated(tabId, USER_ID, 'trước_QA');
    
    // 7. Perform conversational Q&A warmup
    console.log(`\n💬 [Warmup] Bắt đầu tương tác Q&A (${qCountArg} câu hỏi)...`);
    
    // Generate deterministic prompts per account run to avoid collisions
    const existingProviderData = account.provider_specific_data || {};
    const warmupCount = existingProviderData.warmupCount || 0;
    const seed = `seellm_warmup_${account.id}_${warmupCount}`;
    const selectedPrompts = generateWarmupPrompts(qCountArg, seed);
    
    for (let idx = 0; idx < selectedPrompts.length; idx++) {
      const promptText = selectedPrompts[idx];
      console.log(`\n[Warmup] ❓ Câu hỏi ${idx + 1}/${selectedPrompts.length}: "${promptText}"`);
      await assertChatgptAuthenticated(tabId, USER_ID, `trước_câu_${idx + 1}`);
      
      // Clear onboarding modals (up to 5 screens) if any overlays exist.
      // ChatGPT shows multi-step onboarding: "What brings you to ChatGPT?" → "You're all set" → etc.
      // Each step needs a delay after clicking for the next screen to render.
      for (let i = 0; i < 5; i++) {
        const dismissed = await dismissOnboardingModals(tabId, USER_ID);
        if (dismissed) {
          console.log(`[Warmup] 🛡️ Phát hiện và đóng hộp thoại giới thiệu / Onboarding Modal (Lượt ${i + 1})...`);
          await delay(1500); // reduced from 3000ms to speed up the process
        } else {
          break;
        }
      }
      
      // Wait for prompt-textarea to be visible with retry/polling loop
      let isInputVisible = false;
      let spinnerDetectedSec = 0;
      let hasReloaded = false;
      const waitStart = Date.now();
      const waitTimeout = 45000; // 45 seconds max wait
      while (Date.now() - waitStart < waitTimeout) {
        isInputVisible = await evalJson(tabId, USER_ID, `(() => {
          const ta = document.querySelector('#prompt-textarea');
          if (!ta) return false;
          const rect = ta.getBoundingClientRect();
          return !!(rect.width || rect.height || ta.getClientRects().length);
        })()`).catch(() => false);
        
        if (isInputVisible) {
          break;
        }
        
        // Check if there is a loading spinner on the page
        const isSpinnerVisible = await evalJson(tabId, USER_ID, `(() => {
          const spinner = document.querySelector('svg.animate-spin, .loading, [class*="loading"], [class*="spinner"], .status-loading');
          if (spinner && spinner.offsetParent !== null) return true;
          const bodyText = (document.body?.innerText || '').trim().toLowerCase();
          return bodyText === 'loading...' || bodyText === 'loading';
        })()`).catch(() => false);
        
        if (isSpinnerVisible) {
          spinnerDetectedSec += 1.5;
          if (spinnerDetectedSec >= 15 && !hasReloaded) {
            console.log(`[Warmup] ⚠️ Phát hiện trang bị kẹt ở trạng thái loading spinner quá 15 giây. Tiến hành tự động reload trang...`);
            hasReloaded = true;
            spinnerDetectedSec = 0;
            try {
              await navigate(tabId, USER_ID, 'https://chatgpt.com/');
            } catch (navErr) {
              console.log(`[Warmup] ⚠️ Reload trang thất bại: ${navErr.message}`);
            }
          }
        } else {
          spinnerDetectedSec = 0;
        }
        
        // Also check/dismiss onboarding modals while waiting
        const dismissed = await dismissOnboardingModals(tabId, USER_ID);
        if (dismissed) {
          console.log(`[Warmup] 🛡️ Phát hiện và đóng hộp thoại giới thiệu trong lúc chờ hộp thoại chat...`);
        }
        
        await delay(1500);
      }
      
      if (!isInputVisible) {
        throw new Error('Không tìm thấy hộp thoại chat của ChatGPT! (Chờ 45 giây không xuất hiện)');
      }
      
      // Lấy số lượng câu trả lời hiện tại trước khi gửi prompt mới
      const prevAssistantCount = await getAssistantMessageCount(tabId, USER_ID);

      // Type message using keyboard mode first, then verify because ChatGPT's
      // composer can accept focus while silently dropping keyboard input.
      const cleared = await clearComposerPrompt(tabId, USER_ID);
      if (!cleared.ok) {
        console.log(`[Warmup] ⚠️ Không clear được composer trước khi nhập prompt mới (reason=${cleared.reason || 'unknown'}, len=${cleared.textLength ?? 'n/a'}).`);
      }
      await camofoxPost(`/tabs/${tabId}/type`, { userId: USER_ID, selector: '#prompt-textarea', text: promptText, mode: 'keyboard', delay: 10 });
      await delay(1000);
      const composerResult = await ensureComposerPrompt(tabId, USER_ID, promptText);
      if (!composerResult.ok) {
        throw new Error(`warmup_prompt_input_failed: Composer không nhận prompt (method=${composerResult.method}, len=${composerResult.state?.textLength ?? 0}, reason=${composerResult.injected?.reason || 'unknown'})`);
      }
      console.log(`[Warmup] ✅ Prompt đã vào composer (${composerResult.method}, len=${composerResult.state?.textLength ?? 0}).`);
      
      // Submit message and only continue when a real user message appears.
      const submitted = await submitComposerWithRetry(tabId, USER_ID, promptText);
      if (!submitted.ok) {
        if (submitted.reason === 'session_expired') {
          throw new Error('session_expired: ChatGPT báo session expired ngay sau khi gửi prompt');
        }
        throw new Error(`warmup_prompt_submit_failed: Không thấy user message sau khi gửi prompt (reason=${submitted.reason || 'unknown'}, len=${submitted.state?.textLength ?? 0}, sendVisible=${submitted.state?.sendVisible ?? false}, sendDisabled=${submitted.state?.sendDisabled ?? false})`);
      }
      console.log(`[Warmup] ✅ Prompt đã được gửi vào conversation (${submitted.method}).`);
      
      // Wait for complete response
      const genCompleted = await waitForGenerationComplete(tabId, USER_ID);
      if (!genCompleted) {
        console.log(`[Warmup] ⚠️ Không xác nhận được phản hồi ChatGPT cho câu hỏi ${idx + 1}. Tiếp tục...`);
      }
      
      // In Câu trả lời của ChatGPT
      const aiResponse = await getLatestAssistantMessageWithRetry(tabId, USER_ID, prevAssistantCount);
      if (aiResponse && aiResponse.length > 0) {
        console.log(`[Warmup] 💬 ChatGPT trả lời:\n--------------------------------------------------\n${aiResponse}\n--------------------------------------------------`);
       } else {
        const pageErr = await checkPageErrors(tabId, USER_ID);
        if (pageErr && pageErr.hasError) {
          throw new Error(`CHATGPT_ERROR: ChatGPT báo lỗi trên trang: "${pageErr.snippet || pageErr.word}". Có thể do proxy chậm hoặc nghẽn mạng.`);
        }
        throw new Error(`session_expired: Không nhận được câu trả lời từ AI cho câu hỏi ${idx + 1} (phản hồi trống hoặc bị kẹt)`);
      }
      
      if (WARMUP_SCREENSHOTS && stepRecorder) {
        await stepRecorder.after(3 + idx, 4, `q${idx + 1}_response_complete`);
      }
      
      questionsAsked++;
      // Sleep between questions to simulate human reading/thinking
      if (idx < selectedPrompts.length - 1) {
        const sleepMs = randomInt(4000, 8000);
        console.log(`[Warmup] 💤 Nghỉ ${Math.round(sleepMs / 1000)} giây trước câu hỏi tiếp theo...`);
        await delay(sleepMs);
      }
    }
    
    console.log(`\n🎉 [Warmup] Tương tác thành công tất cả ${questionsAsked} câu hỏi!`);
    
    // Get fresh cookies after success to keep them updated
    console.log(`[Warmup] 🍪 Thu thập cookies mới từ session...`);
    const newCookiesRes = await camofoxGet(`/tabs/${tabId}/cookies?userId=${USER_ID}`).catch(() => null);
    const newCookies = Array.isArray(newCookiesRes?.cookies) ? newCookiesRes.cookies : (Array.isArray(newCookiesRes) ? newCookiesRes : null);
    
    // Fetch session data to get accessToken, plan, etc.
    let accessToken = undefined;
    let plan = undefined;
    let workspaceId = undefined;
    let deviceId = undefined;
    let sessionData = undefined;
    try {
      console.log(`[Warmup] 🔄 Lấy thông tin session từ /api/auth/session...`);
      const sessionRes = await evalJson(tabId, USER_ID, `
        (async () => {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 12000);
          try {
            const r = await fetch('/api/auth/session', { signal: controller.signal });
            clearTimeout(timeoutId);
            return r.ok ? await r.json() : null;
          } catch (e) {
            clearTimeout(timeoutId);
            return null;
          }
        })()
      `, { timeoutMs: 35000 }); // Increased from 8s — fetch goes through proxy, needs more time
      if (sessionRes && typeof sessionRes === 'object') {
        sessionData = sessionRes;
        accessToken = sessionRes.accessToken;
        plan = sessionRes.account?.planType;
        workspaceId = sessionRes.account?.id;
        deviceId = newCookies ? (newCookies.find(c => c.name === 'oai-did')?.value || '') : '';
        console.log(`[Warmup] 👤 Lấy session thành công (UserId: ${sessionData?.user?.id || 'n/a'}, Plan: ${plan || 'n/a'})`);
      } else {
        console.log(`[Warmup] ⚠️ Không lấy được session data (định dạng rỗng hoặc null)`);
      }
    } catch (sessionErr) {
      console.warn(`[Warmup] ⚠️ Lỗi khi gọi /api/auth/session: ${sessionErr.message}`);
    }

    // Save success result back to server
    await fetch(`${TOOLS_API_URL}/api/vault/accounts/${accountId}/warmup-result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'success',
        questionsAsked,
        cookies: newCookies || undefined,
        accessToken,
        plan,
        workspaceId,
        deviceId,
        sessionData
      })
    });
    
    console.log(`[Warmup] ✅ Hoàn tất cập nhật trạng thái Warmup thành công!`);
    
    runSuccess = true;
    break; // Exit retry loop on success
    } catch (err) {
      const msg = String(err.message || err || '').toLowerCase();
      
      // Classify error type for logging and wait-time decision
      const isNavigateTimeout = (
        msg.includes('page.goto') ||
        msg.includes('navigate timed out') ||
        (msg.includes('timeout') && msg.includes('navigate'))
      );
      const isRetriable = (
        isNavigateTimeout ||
        msg.includes('browser_restarted') ||
        msg.includes('session_expired') ||
        msg.includes('tab no longer exists') ||
        msg.includes('browser was restarted') ||
        msg.includes('browser session expired') ||
        msg.includes('target page, context or browser has been closed') ||
        msg.includes('context closed') ||
        msg.includes('browser closed') ||
        msg.includes('net_timeout') ||
        msg.includes('aborted due to timeout') ||
        msg.includes('blocked_by_openai_turnstile') ||
        msg.includes('không tìm thấy hộp thoại chat') ||
        msg.includes('không nhận được câu trả lời từ ai') ||
        msg.includes('không nhận được phản hồi') ||
        msg.includes('welcome back bị kẹt') ||
        msg.includes('welcome-back-stuck') ||
        msg.includes('welcome-back-loop')
      );
      
      if (isRetriable && attempt < maxAttempts) {
        // Navigate timeouts need longer recovery: camofox destroys the session and
        // needs time to reinitialise a fresh BrowserContext with a clean proxy slot.
        const retryWaitMs = isNavigateTimeout ? 12000 : 5000;
        console.warn(`\n⚠️ [Warmup] Phát hiện lỗi ${ isNavigateTimeout ? 'navigate timeout (proxy chậm)' : 'trình duyệt/session' } ở lượt ${attempt}/${maxAttempts}: ${err.message}.`);
        console.warn(`⏳ [Warmup] Chờ ${retryWaitMs / 1000}s rồi khởi động lại tab mới...`);
        if (tabId) {
          console.log(`[Warmup] 🧹 Đóng tab cũ: ${tabId}`);
          await camofoxDelete(`/tabs/${tabId}?userId=${USER_ID}`).catch(() => {});
          tabId = null;
        }
        console.log(`[Warmup] 🧹 Xoá session cũ để làm sạch cookies và bắt đầu lượt thử mới: ${USER_ID}`);
        await camofoxDelete(`/sessions/${USER_ID}`).catch(() => {});
        await delay(retryWaitMs);
        continue;
      }
      if (isNavigateTimeout) {
        throw new Error(`NET_TIMEOUT_NAVIGATE: Proxy/browser không tải được ChatGPT sau ${maxAttempts} lượt thử (${err.message})`);
      }
      throw err;
    } finally {
      if (tabId && !runSuccess && attempt < maxAttempts) {
        console.log(`[Warmup] 🧹 Đóng tab của lượt thử thất bại...`);
        await camofoxDelete(`/tabs/${tabId}?userId=${USER_ID}`).catch(() => {});
        tabId = null;
      }
    }
  }
  } catch (err) {
    console.error(`\n❌ [Warmup] Lỗi trong quá trình chạy: ${err.message}`);
    
    if (WARMUP_SCREENSHOTS && stepRecorder) {
      await stepRecorder.error(99, 1, 'warmup_error').catch(() => {});
    }
    
    // Save failure status back to server
    try {
      const failureMeta = classifyWarmupTransportFailure(err.message || err) || {};
      const failureNotes = [
        failureMeta.note || null,
        `lastAction=${typeof lastLoginAction === 'string' ? lastLoginAction : 'unknown'}`,
        failureMeta.category ? `category=${failureMeta.category}` : null,
      ].filter(Boolean).join(' | ');
      await fetch(`${TOOLS_API_URL}/api/vault/accounts/${accountId}/warmup-result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'failed',
          error: err.message,
          questionsAsked,
          notes: failureNotes
        })
      });
      console.log(`[Warmup] 🛑 Cập nhật trạng thái Warmup THẤT BẠI về database.`);
    } catch (saveErr) {
      console.error(`[Warmup] Lỗi khi cố gắng lưu trạng thái thất bại: ${saveErr.message}`);
    }
    
  } finally {
    // 8. Clean up Tab to prevent resource leak
    if (tabId) {
      console.log(`[Warmup] 🧹 Đóng tab Camofox để giải phóng tài nguyên...`);
      await camofoxDelete(`/tabs/${tabId}?userId=${USER_ID}`).catch(() => {});
    }
    console.log(`[Warmup] 🧹 Xoá session Camofox để giải phóng bộ nhớ...`);
    await camofoxDelete(`/sessions/${USER_ID}`).catch(() => {});
    console.log(`🔥 [Warmup] KẾT THÚC CHƯƠNG TRÌNH WARMUP.\n`);
  }
}

runWarmup().then(() => {
  process.exit(0);
}).catch(err => {
  console.error(err);
  process.exit(1);
});
