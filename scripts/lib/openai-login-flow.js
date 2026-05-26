/**
 * scripts/lib/openai-login-flow.js
 * 
 * Shared OpenAI login flow helpers (eval-based DOM manipulation).
 * Consolidated from auto-connect-worker for reuse in auto-login-worker.
 *
 * MULTI-LANGUAGE: tất cả phát hiện text-based đều dùng `MULTILANG` keywords
 * (en, de, fr, es, it, pt, vi, ru, ja, zh) để hoạt động khi proxy ở quốc gia khác
 * khiến UI render ngôn ngữ khác (ví dụ: Phần Lan → tiếng Đức).
 */

import { evalJson } from './camofox.js';

/**
 * Multi-language keyword sets used by login-flow detectors.
 * Always include English first (chatgpt.com mostly serves English even via foreign IPs;
 * Google FedCM popup is the most common case rendered in local language).
 */
export const MULTILANG = {
  // Cookie consent: "Accept all" buttons across languages
  acceptCookie: [
    'accept all', 'accept cookies', 'accept', 'agree', 'i agree', 'allow all',
    'alle akzeptieren', 'alle annehmen', 'einverstanden', 'zustimmen', 'akzeptieren',
    'tout accepter', 'accepter tout', 'accepter', "j'accepte",
    'aceptar todo', 'aceptar todas', 'aceptar', 'acepto',
    'accetta tutto', 'accetta tutti', 'accetto', 'accetta',
    'aceitar tudo', 'aceitar todos', 'aceitar', 'aceito',
    'chấp nhận tất cả', 'đồng ý', 'chấp nhận',
    'принять все', 'согласен', 'принять',
    'すべて受け入れる', '同意する', '同意',
    '全部接受', '同意', '接受所有',
  ],
  // Phone verification screen
  phoneVerify: [
    'phone number required', 'add a phone number', 'add phone number', 'verify your phone',
    'enter your phone', 'add your phone', 'phone verification',
    'telefonnummer erforderlich', 'telefonnummer hinzufügen', 'telefon bestätigen', 'telefonnummer bestätigen',
    'numéro de téléphone', 'ajouter un numéro de téléphone', 'vérifier votre téléphone',
    'número de teléfono', 'añadir un número', 'agregar número de teléfono', 'verificar tu teléfono',
    'numero di telefono', 'aggiungi un numero di telefono', 'verifica il tuo telefono',
    'número de telefone', 'adicione um número', 'verificar seu telefone',
    'số điện thoại', 'thêm số điện thoại', 'xác minh số điện thoại',
    'номер телефона', 'добавьте номер телефона', 'подтвердите номер',
    '電話番号', '電話番号を追加', '電話を確認',
    '电话号码', '手机号码', '添加电话号码', '验证您的手机',
  ],
  // Login error: wrong password
  wrongPassword: [
    'wrong password', 'incorrect password', 'invalid password',
    'falsches passwort', 'passwort ist falsch', 'ungültiges passwort',
    'mot de passe incorrect', 'mot de passe invalide',
    'contraseña incorrecta', 'contraseña inválida',
    'password errata', 'password non valida',
    'senha incorreta', 'senha inválida',
    'sai mật khẩu', 'mật khẩu không đúng', 'mật khẩu sai',
    'неправильный пароль', 'неверный пароль',
    'パスワードが間違って', 'パスワードが正しくありません',
    '密码错误', '密码不正确',
  ],
  // Login error: suspicious / blocked
  suspiciousLogin: [
    'suspicious login behavior', 'we have detected suspicious', 'suspicious activity',
    'verdächtige anmeldeaktivität', 'verdächtige aktivität',
    'comportement de connexion suspect', 'activité suspecte',
    'comportamiento sospechoso', 'actividad sospechosa',
    'comportamento sospetto', 'attività sospetta',
    'comportamento suspeito', 'atividade suspeita',
    'hành vi đáng ngờ',
    'подозрительная активность',
  ],
  // Access denied (Cloudflare/IP block)
  accessDenied: [
    'access denied', 'forbidden', 'cloudflare',
    'zugriff verweigert', 'verboten',
    'accès refusé', 'interdit',
    'acceso denegado', 'prohibido',
    'accesso negato', 'vietato',
    'acesso negado', 'proibido',
    'truy cập bị từ chối',
    'доступ запрещен',
  ],
  // Consent / authorize / allow
  consent: [
    'authorize', 'allow', 'continue', 'consent',
    'autorisieren', 'zulassen', 'erlauben', 'fortfahren',
    'autoriser', 'autoriser', 'continuer', 'permettre',
    'autorizar', 'permitir', 'continuar',
    'autorizza', 'consenti', 'continua', 'permetti',
    'autorizar', 'permitir', 'continuar',
    'cho phép', 'tiếp tục', 'ủy quyền',
    'разрешить', 'продолжить',
  ],
  // Workspace / organization screens
  workspace: [
    'select workspace', 'choose workspace',
    'arbeitsbereich auswählen', 'arbeitsbereich wählen',
    'sélectionner un espace de travail',
    'seleccionar espacio de trabajo',
    'chọn không gian làm việc',
  ],
  organization: [
    'select organization', 'choose organization',
    'organisation auswählen',
    'sélectionner une organisation',
    'seleccionar organización',
    'chọn tổ chức',
  ],
  personal: [
    'personal account', 'personal',
    'persönliches konto', 'persönlich',
    'compte personnel', 'personnel',
    'cuenta personal',
    'account personale', 'personale',
    'conta pessoal', 'pessoal',
    'tài khoản cá nhân', 'cá nhân',
    'lichnyy akkaunt', 'личný аккаунт', 'личный',
    '個人用アカウント', '個人用', '個人',
    '个人帐户', '个人'
  ],
  // Generic error UI
  somethingWrong: [
    'something went wrong', 'try again',
    'etwas ist schief gegangen', 'erneut versuchen',
    'une erreur est survenue', 'réessayer',
    'algo salió mal', 'inténtalo de nuevo',
    'qualcosa è andato storto', 'riprova',
    'algo deu errado', 'tentar novamente',
    'đã xảy ra lỗi', 'thử lại',
    'что-то пошло не так', 'повторить',
    // OpenAI auth error pages
    'authentication error', 'an error occurred during authentication',
    'workspaces not found', 'invalid authorize request',
    'session ended', 'invalid_state',
    'oops!', 'we ran into an issue', 'signing you in',
    'please take a break', 'try again soon',
  ],
};

/**
 * Build a JS expression string that checks if any keyword matches in a body string variable.
 * Used inside eval() so the multi-language list is embedded into the page-side code.
 * @param {string[]} keywords
 * @param {string} bodyVar - JS variable name in eval scope
 */
function jsAnyMatch(keywords, bodyVar = 'body') {
  return JSON.stringify(keywords) + `.some(k => ${bodyVar}.includes(k))`;
}

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

      const isVisible = el => {
        if (!el) return false;
        const s = window.getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0' && r.width > 0 && r.height > 0;
      };

      // ── Auth pages (auth.openai.com hoặc /auth/*) ──
      const onAuthDomain    = host.includes('auth.openai.com') || href.includes('/auth/');
      
      const hasEmailInput = (() => {
        const selectors = [
          'input[type="email"]', 'input[name="username"]', 'input[id="username"]', 'input[name="email"]', 'input[autocomplete="email"]'
        ];
        return selectors.some(s => isVisible(document.querySelector(s)));
      })();

      const hasPasswordInput = (() => {
        const selectors = [
          'input[type="password"]', 'input[name="password"]', 'input[id="password"]', 'input[autocomplete="current-password"]'
        ];
        return selectors.some(s => isVisible(document.querySelector(s)));
      })();

      // ── MFA: URL chứa /mfa hoặc có input one-time-code ──
      const isAddPhonePage = href.includes('/add-phone');
      const hasMfaInput = !isAddPhonePage && !!(
        href.includes('/mfa') || href.includes('/totp') || href.includes('two-factor') || href.includes('/otp') || href.includes('email-verification') ||
        body.includes('one-time code') || body.includes('authenticator app') || body.includes('6-digit') ||
        body.includes('mã xác minh') || body.includes('mã xác thực') || body.includes('mã otp') || body.includes('verification code') ||
        body.includes('sent a code') || body.includes('temporary verification code') || body.includes('check your inbox') ||
        Array.from(document.querySelectorAll('input[autocomplete="one-time-code"], input[name="code"], input[name="otp"], input[placeholder*="code"], input[placeholder*="Code"], input[placeholder*="mã"], input[id*="code"], input[id*="otp"], input[class*="code"]')).some(isVisible)
      );

      const COOKIE_KW = ${JSON.stringify(MULTILANG.acceptCookie)};
      const PHONE_KW = ${JSON.stringify(MULTILANG.phoneVerify)};
      const ERROR_KW = ${JSON.stringify(MULTILANG.somethingWrong)};
      const CONSENT_KW = ${JSON.stringify(MULTILANG.consent)};
      const WORKSPACE_KW = ${JSON.stringify(MULTILANG.workspace)};
      const ORG_KW = ${JSON.stringify(MULTILANG.organization)};

      // ── Cookie banner ──
      const hasCookieBanner = (() => {
        return !!Array.from(document.querySelectorAll('button, [role="button"], a'))
          .filter(isVisible)
          .find(el => {
            const t = (el.innerText || el.textContent || '').toLowerCase().trim();
            return COOKIE_KW.some(k => t === k || t.includes(k));
          });
      })();

      // ── Phone verify ──
      const hasPhoneScreen = isAddPhonePage || PHONE_KW.some(k => body.includes(k));

      // ── Onboarding screen ──
      const isOnboarding = lowerUrl.includes('/onboarding') || body.includes('how old are you') || body.includes('finish creating account') || body.includes('finish creating');

      // ── Workspace Screen ──
      const isWorkspaceScr = (
        lowerUrl.includes('/workspace') ||
        (lowerUrl.includes('sign-in-with-chatgpt') && !lowerUrl.includes('consent')) ||
        WORKSPACE_KW.some(k => body.includes(k)) ||
        body.includes('launch a workspace') ||
        body.includes('choose a workspace') ||
        body.includes('has access to')
      );

      // Inline consent screen logic
      const isConsentScr = (
        (lowerUrl.includes('consent') && !lowerUrl.includes('/log-in')) ||
        (CONSENT_KW.some(k => body.includes(k)) && body.includes('continue'))
      );

      // ── Error screen ──
      const rawHasError = ERROR_KW.some(k => body.includes(k));
      const hasProfileBtn = !!(
        document.querySelector('[data-testid="profile-button"]') ||
        document.querySelector('[data-testid="user-menu-button"]') ||
        document.querySelector('[aria-label="Open user menu"]') ||
        document.querySelector('[aria-label="User menu"]')
      );
      const hasSignUpInPage = body.includes('sign up for free') || body.includes('sign up') || body.includes('đăng ký');
      const hasLogInBtn     = body.includes('log in') && !hasProfileBtn;
      const hasNewChat      = body.includes('new chat') || body.includes('search chats') || body.includes('chatgpt plus');
      const isConversation  = href.includes('/c/') || href.includes('/g/');
      const isChatgptHome   = (host === 'chatgpt.com' || host.endsWith('.chatgpt.com')) && (href.endsWith('chatgpt.com/') || href.endsWith('chatgpt.com'));

      const tempLooksLoggedIn = ((hasProfileBtn || hasNewChat) && !hasSignUpInPage && !hasLogInBtn) || isConversation || (isChatgptHome && !hasSignUpInPage && !hasLogInBtn);
      const hasError = rawHasError && (onAuthDomain || !tempLooksLoggedIn);

      const hasDeactivated = body.includes('account_deactivated') || body.includes('deactivated') || (body.includes('vô hiệu hóa') && body.includes('tài khoản'));

      // ── Logged-in indicators (loại trừ chặt chẽ toàn bộ các màn hình trung gian để tránh nhận diện nhầm) ──
      const looksLoggedIn = (
        !hasEmailInput &&
        !hasPasswordInput &&
        !hasMfaInput &&
        !hasPhoneScreen &&
        !hasError &&
        !hasDeactivated &&
        !isOnboarding &&
        !isWorkspaceScr &&
        !isConsentScr &&
        (((hasProfileBtn || hasNewChat) && !hasSignUpInPage && !hasLogInBtn) || isConversation || (isChatgptHome && !hasSignUpInPage && !hasLogInBtn))
      );

      return {
        href, host,
        looksLoggedIn, hasProfileBtn, hasSignUpInPage, hasLogInBtn, isConversation,
        onAuthDomain, hasEmailInput, hasPasswordInput, hasMfaInput,
        hasCookieBanner, hasPhoneScreen, hasError, hasDeactivated,
        isConsentScreen: isConsentScr,
        isWorkspaceScreen: !hasError && isWorkspaceScr,
        isOrganizationScreen: lowerUrl.includes('/organization') || ORG_KW.some(k => body.includes(k)),
        isOnboardingScreen: isOnboarding,
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

      // Check if there are multiple inputs for single-digit code entry (e.g. 6 separate boxes)
      const inputs = Array.from(document.querySelectorAll('input')).filter(isVisible);
      const isSixDigitBoxes = inputs.length >= 6 && inputs.slice(0, 6).every(el => 
        el.maxLength === 1 || el.size === 1 || (el.className || '').includes('code') || (el.className || '').includes('otp')
      );

      if (isSixDigitBoxes) {
        for (let i = 0; i < 6; i++) {
          const char = val[i] || '';
          if (char) {
            setValue(inputs[i], char);
            inputs[i].dispatchEvent(new KeyboardEvent('keydown', { key: char, code: 'Digit' + char, bubbles: true }));
            inputs[i].dispatchEvent(new KeyboardEvent('keypress', { key: char, code: 'Digit' + char, bubbles: true }));
            inputs[i].dispatchEvent(new KeyboardEvent('keyup', { key: char, code: 'Digit' + char, bubbles: true }));
          }
        }
        const btn = Array.from(document.querySelectorAll('button, [role="button"]'))
          .filter(isVisible)
          .find(el => {
            const t = (el.innerText || el.textContent || '').trim().toLowerCase();
            return t.includes('continue') || t.includes('verify') || t.includes('confirm') || t.includes('xác nhận');
          });
        if (btn) btn.click();
        return { ok: true, isSixDigitBoxes: true, clicked: !!btn };
      }

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
      // Clear old value before setting new code (important when retrying after ?error=totp)
      const nativeInput = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
      if (nativeInput) nativeInput.set.call(input, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
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
      const isVisible = el => {
        if (!el) return false;
        const s = window.getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0' && r.width > 0 && r.height > 0;
      };
      const KW = ${JSON.stringify(MULTILANG.acceptCookie)};
      const btn = Array.from(document.querySelectorAll('button, [role="button"], a'))
        .filter(isVisible)
        .find(el => {
          const t = (el.innerText || el.textContent || '').toLowerCase().trim();
          return KW.some(k => t === k || t.includes(k));
        });
      if (btn) {
        btn.click();
        try {
          btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
          btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        } catch (_) {}
      }
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
    (async () => {
      const isVisible = el => {
        if (!el) return false;
        const s = window.getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0' && r.width > 0 && r.height > 0;
      };
      const safeClick = el => {
        if (!el) return false;
        try { el.focus?.(); } catch (_) {}
        try { el.click(); return true; } catch (_) {}
        try {
          el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
          return true;
        } catch (_) {}
        return false;
      };
      const results = [];

      // 1. Đóng popup "Sign in with Google" — multi-language aria-label + iframe removal
      const closeAriaLabels = ['close','schließen','fermer','cerrar','chiudi','fechar','đóng','закрыть','閉じる','关闭'];
      const closeButtons = Array.from(document.querySelectorAll(
        '[aria-label], button[id*="close" i], [data-dismiss], .close-button, [class*="close" i][role="button"]'
      )).filter(el => {
        if (!isVisible(el)) return false;
        const al = (el.getAttribute('aria-label') || '').toLowerCase();
        return closeAriaLabels.some(k => al.includes(k)) || /close|dismiss/i.test(el.id || '');
      });
      const xButtons = Array.from(document.querySelectorAll('button, div[role="button"]'))
        .filter(el => {
          if (!isVisible(el)) return false;
          const t = (el.innerText || el.textContent || '').trim();
          return t === '✕' || t === '×' || t === 'X' || t === '✖';
        });
      const googleClose = closeButtons[0] || xButtons[0];
      if (googleClose) {
        safeClick(googleClose);
        results.push('dismissed-google-popup');
      }

      // Cũng tìm Google iframe overlay và xóa nó (FedCM popup là iframe accounts.google.com)
      const googleIframes = document.querySelectorAll('iframe[src*="accounts.google.com"], iframe[src*="gsi/iframe"], iframe[src*="oauth/iframe"]');
      googleIframes.forEach(iframe => {
        try { iframe.remove(); } catch (_) {}
      });
      if (googleIframes.length > 0) results.push('removed-google-iframes');

      // 2. Tìm và click nút "Log in" - UI hiện tại có nút trực tiếp với data-testid
      let loginBtn = null;
      
      // Ưu tiên 1: data-testid chính xác (UI hiện tại)
      loginBtn = document.querySelector('button[data-testid="login-button"], a[data-testid="login-button"]');
      if (loginBtn && isVisible(loginBtn)) results.push('found-by-data-testid');
      
      // Ưu tiên 2: Các vùng landing page (UI cũ/backup)
      if (!loginBtn) {
        const landingSelectors = ['[class*="login" i] button', '[class*="auth" i] button', 'header button', 'nav button', '[role="banner"] button'];
        for (const sel of landingSelectors) {
          const candidates = Array.from(document.querySelectorAll(sel)).filter(isVisible);
          loginBtn = candidates.find(el => {
            const t = (el.innerText || el.textContent || '').trim().toLowerCase();
            return t === 'log in' || t === 'login' || t === 'sign in' || t.includes('email') || t.includes('password');
          });
          if (loginBtn) { results.push('found-in-landing-area'); break; }
        }
      }
      
      // Ưu tiên 3: href chứa /auth/login
      if (!loginBtn) {
        const allClickable = Array.from(document.querySelectorAll('button, a, [role="button"]')).filter(isVisible);
        loginBtn = allClickable.find(el => {
          const href = (el.getAttribute('href') || '').toLowerCase();
          return href.includes('/auth/login') || href.includes('/login');
        });
        if (loginBtn) results.push('found-by-href');
      }
      
      // Ưu tiên 4: text match
      if (!loginBtn) {
        const allClickable = Array.from(document.querySelectorAll('button, a, [role="button"]')).filter(isVisible);
        loginBtn = allClickable.find(el => {
          const t = (el.innerText || el.textContent || '').trim().toLowerCase();
          return t === 'log in' || t === 'login' || t === 'sign in' || t.includes('email') || t.includes('password');
        });
        if (loginBtn) results.push('found-by-text');
      }
      
      if (loginBtn && isVisible(loginBtn)) {
        const href = loginBtn.getAttribute('href') || loginBtn.dataset?.href || '';
        const clicked = safeClick(loginBtn);
        results.push(clicked ? 'clicked-login-button' : 'failed-click-login-button');
        if (!clicked && href) {
          try {
            location.assign(href.startsWith('http') ? href : new URL(href, location.origin).toString());
            results.push('navigated-via-href');
          } catch (_) {}
        }
      } else {
        results.push('no-login-button-found');
        // Log chi tiết debug
        const allClickable = Array.from(document.querySelectorAll('button, a, [role="button"]')).filter(isVisible);
        const visibleTexts = allClickable.map(e => {
          const text = (e.innerText || e.textContent || '').trim();
          const tag = (e.tagName || '').toLowerCase();
          const testId = e.getAttribute('data-testid') || '';
          const href = e.getAttribute('href') || '';
          return tag + (testId ? '[' + testId + ']' : '') + ':' + text.slice(0, 30) + (href ? '->' + href.slice(0, 20) : '');
        }).filter(Boolean).slice(0, 15);
        results.push('visible: ' + visibleTexts.join(' | '));
        // Fallback cuối
        try {
          location.assign('/auth/login');
          results.push('forced-location-auth-login');
        } catch (_) {}
      }

      return { ok: results.some(r => r.startsWith('clicked') || r === 'navigated-via-href' || r === 'forced-location-auth-login'), actions: results };
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
    // Handle intermediate states: if MFA, phone, workspace, onboarding or deactivated screen appears, return state early
    // This prevents timeout when page redirects to MFA/phone/workspace after password fill
    if (state?.hasMfaInput || state?.hasPhoneScreen || state?.isWorkspaceScreen || state?.isOnboardingScreen || state?.hasDeactivated) return state;
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
  // URL signals — strongest, language-agnostic
  if (lowerUrl.includes('/add-phone') || lowerUrl.includes('/add_phone') ||
      lowerUrl.includes('/phone-verification') || lowerUrl.includes('/phone-verify') ||
      lowerUrl.includes('/verify-phone')) {
    return true;
  }
  // Multi-language text signals (en, de, fr, es, it, pt, vi, ru, ja, zh)
  if (MULTILANG.phoneVerify.some(k => cleanText.includes(k))) return true;
  // Generic combined signals (any language with 'phone' in URL + verify/continue text)
  return (lowerUrl.includes('phone') && (
    cleanText.includes('verify') || cleanText.includes('continue') ||
    cleanText.includes('verifizieren') || cleanText.includes('vérifier') ||
    cleanText.includes('verificar') || cleanText.includes('xác minh') ||
    cleanText.includes('подтвер')
  ));
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

/**
 * Select personal workspace on the "Choose a workspace" page (auth.openai.com/workspace).
 * This page appears after MFA for accounts belonging to workspaces.
 * Clicks the "Personal account" button and optionally waits for redirect.
 * @param {string} tabId - Tab ID
 * @param {string} userId - User ID
 * @param {object} options - { timeoutMs = 10000, waitRedirect = true }
 * @returns {Promise<object>} - { ok, clicked, reason, redirectUrl }
 */
export async function selectPersonalWorkspaceOnWorkspacePage(tabId, userId, { timeoutMs = 15000, waitRedirect = true } = {}) {
  try {
    const result = await evalJson(tabId, userId, `
      (() => {
        const personalKeywords = ${JSON.stringify(MULTILANG.personal)};
        const isVisible = el => {
          if (!el) return false;
          const r = el.getBoundingClientRect();
          const s = window.getComputedStyle(el);
          return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
        };

        // ── Strategy A: Direct listitem query with data-testid="existing-workspace-row"
        const rows = Array.from(document.querySelectorAll('[data-testid="existing-workspace-row"]')).filter(isVisible);
        for (const row of rows) {
          const rowText = (row.textContent || '').toLowerCase();
          const hasPersonal = personalKeywords.some(k => rowText.includes(k));
          if (hasPersonal) {
            const openBtn = row.querySelector('button');
            if (openBtn && isVisible(openBtn)) {
              openBtn.focus();
              openBtn.click();
              openBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
              openBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
              openBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
              return { ok: true, clicked: true, strategy: 'testid_row_personal_btn', text: rowText.trim().slice(0, 80) };
            }
          }
        }

        // ── Strategy B: Walk UP the DOM from each "Open" button looking for the SMALLEST container
        // that contains "personal workspace" text. We stop at the first ancestor where
        // the PARENT no longer has "personal workspace" (meaning we found the actual row).
        const openKeywords = ['open', 'mở', 'select', 'chọn', 'launch', 'enter', 'go'];
        const allBtns = Array.from(document.querySelectorAll('button, [role="button"], a')).filter(isVisible);

        const openBtns = allBtns.filter(btn => {
          const t = (btn.textContent || btn.innerText || btn.value || '').toLowerCase().trim();
          return openKeywords.some(k => t === k || t === k + ' ');
        });

        for (const btn of openBtns) {
          let container = btn.parentElement;
          let bestMatch = null;
          for (let depth = 0; depth < 8 && container; depth++) {
            const cText = (container.textContent || '').toLowerCase();
            const hasPersonal = personalKeywords.some(k => cText.includes(k));
            if (hasPersonal) {
              // Check if parent ALSO has "personal" text — if so, we haven't found the row yet
              const parentText = (container.parentElement?.textContent || '').toLowerCase();
              const parentHasPersonal = personalKeywords.some(k => parentText.includes(k));
              if (!parentHasPersonal) {
                // This is the SMALLEST container with "personal" — the actual row
                bestMatch = { btn, container };
                break;
              }
            }
            container = container.parentElement;
          }
          if (bestMatch) {
            bestMatch.btn.focus();
            bestMatch.btn.click();
            bestMatch.btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            bestMatch.btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
            bestMatch.btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
            return { ok: true, clicked: true, strategy: 'open_btn_in_personal_row', text: (bestMatch.container.textContent || '').trim().slice(0, 80) };
          }
        }

        // ── Strategy C: Find the element whose OWN text (text nodes only) contains
        // "personal workspace", then walk UP to find the row and click its Open button.
        const allEls = Array.from(document.querySelectorAll('*')).filter(el => {
          if (!isVisible(el)) return false;
          const ownText = Array.from(el.childNodes)
            .filter(n => n.nodeType === Node.TEXT_NODE)
            .map(n => n.textContent.toLowerCase().trim())
            .join(' ');
          return personalKeywords.some(k => ownText.includes(k));
        });

        for (const labelEl of allEls) {
          let container = labelEl.parentElement;
          for (let depth = 0; depth < 8 && container; depth++) {
            const cText = (container.textContent || '').toLowerCase();
            const openBtn = Array.from(container.querySelectorAll('button, [role="button"], a'))
              .find(b => isVisible(b) && openKeywords.some(k => (b.textContent || b.innerText || '').toLowerCase().trim() === k));
            if (openBtn) {
              const parentText = (container.parentElement?.textContent || '').toLowerCase();
              const parentHasPersonal = personalKeywords.some(k => parentText.includes(k));
              if (!parentHasPersonal) {
                openBtn.focus();
                openBtn.click();
                openBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                openBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
                openBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                return { ok: true, clicked: true, strategy: 'label_then_open_btn', text: cText.trim().slice(0, 80) };
              }
            }
            container = container.parentElement;
          }
        }

        // ── Strategy D: Find button containing "personal" keywords in its own text
        const personalBtn = allBtns.find(el => {
          const text = (el.textContent || '').toLowerCase();
          return personalKeywords.some(k => text.includes(k));
        });
        if (personalBtn) {
          personalBtn.focus();
          personalBtn.click();
          personalBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          personalBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
          personalBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
          return { ok: true, clicked: true, strategy: 'text_match', text: (personalBtn.textContent || '').trim().slice(0, 60) };
        }

        // ── Strategy D: Fallback — click the LAST visible button on workspace forms
        const formBtns = allBtns.filter(el => el.closest('form'));
        if (formBtns.length >= 2) {
          const lastBtn = formBtns[formBtns.length - 1];
          lastBtn.click();
          return { ok: true, clicked: true, strategy: 'last_form_btn', text: (lastBtn.textContent || '').trim().slice(0, 60) };
        }

        // No button found — dump debug
        const btnTexts = allBtns.map(el => (el.textContent || '').trim().slice(0, 60));
        return { ok: false, clicked: false, reason: 'no_personal_button', btnTexts: btnTexts.slice(0, 15) };
      })()
    `, 6000);

    if (!result?.clicked) {
      console.warn('[selectPersonalWorkspace] No button found. Debug:', JSON.stringify(result?.btnTexts || []));
      return { ok: false, clicked: false, reason: result?.reason || 'unknown', btnTexts: result?.btnTexts || [] };
    }

    console.log('[selectPersonalWorkspace] Clicked via strategy:', result.strategy, '| text:', result.text);

    // Wait for the workspace selection page to go away
    if (waitRedirect) {
      const deadline = Date.now() + timeoutMs;
      const workspaceIndicators = ['launch a workspace', 'choose a workspace', '/workspace', 'has access to'];
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 1500));
        const check = await evalJson(tabId, userId, `(() => ({
          url: location.href,
          body: (document.body?.innerText || '').toLowerCase().slice(0, 300)
        }))()`, 3000) || {};
        const url = check.url || '';
        const body = check.body || '';
        // Successfully left workspace page: either on chatgpt.com chat/home, consent, or NOT workspace screen
        const stillOnWorkspace = workspaceIndicators.some(k => url.toLowerCase().includes(k) || body.includes(k));
        if (!stillOnWorkspace) {
          return { ok: true, clicked: true, reason: 'left_workspace_screen', redirectUrl: url };
        }
        if (url.includes('consent') || url.includes('sign-in-with-chatgpt')) {
          return { ok: true, clicked: true, reason: 'consent_page', redirectUrl: url };
        }
        if (url.includes('chatgpt.com') && !url.includes('/auth/')) {
          return { ok: true, clicked: true, reason: 'chatgpt_home', redirectUrl: url };
        }
      }
      const finalUrl = await evalJson(tabId, userId, 'location.href', 3000) || '';
      console.warn('[selectPersonalWorkspace] Timeout waiting for redirect. finalUrl:', finalUrl);
      return { ok: true, clicked: true, reason: 'click_done_no_redirect', redirectUrl: finalUrl };
    }

    return { ok: true, clicked: true, reason: 'clicked' };
  } catch (e) {
    return { ok: false, clicked: false, reason: `exception: ${e.message}` };
  }
}
