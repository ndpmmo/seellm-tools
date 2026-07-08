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

import fs from 'node:fs/promises';
import { CAMOUFOX_API } from '../config.js';
import { evalJson, getSnapshot, clickRef, camofoxPost, actType, actClick, actPress } from './camofox.js';

const EMAIL_INPUT_SELECTORS = [
  'input[type="email"]',
  'input[name="username"]',
  'input[id="username"]',
  'input[name="email"]',
  'input[autocomplete="email"]',
  'input[name="identifier"]',
];

function getEmailInputSelector() {
  return EMAIL_INPUT_SELECTORS.join(', ');
}

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
    'incorrect email address or password', 'incorrect email or password',
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
    'something seems to have gone wrong', 'retry',
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
    'oops!', 'we ran into an issue',
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
      const isChatgptHost = host === 'chatgpt.com' || host.endsWith('.chatgpt.com');

      const isVisible = el => {
        if (!el) return false;
        const s = window.getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0' && r.width > 0 && r.height > 0;
      };

      // ── Auth pages (auth.openai.com hoặc /auth/*) ──
      const isOpenAIAuthHost = host.includes('auth.openai.com');
      const isChatgptAuthPath = isChatgptHost && lowerUrl.includes('/auth/');
      const onAuthDomain    = isOpenAIAuthHost || isChatgptAuthPath;
      
      const hasEmailInput = (() => {
        const selectors = ${JSON.stringify(EMAIL_INPUT_SELECTORS)};
        return selectors.some(s => isVisible(document.querySelector(s)));
      })();

      const emailValue = (() => {
        const selectors = ${JSON.stringify(EMAIL_INPUT_SELECTORS)};
        for (const s of selectors) {
          const el = document.querySelector(s);
          if (isVisible(el)) return el.value || '';
        }
        return '';
      })();

      const hasPasswordInput = (() => {
        const selectors = [
          'input[type="password"]', 'input[name="password"]', 'input[id="password"]', 'input[autocomplete="current-password"]'
        ];
        return selectors.some(s => isVisible(document.querySelector(s)));
      })();

      // ── MFA: URL chứa /mfa hoặc có input one-time-code ──
      const isAddPhonePage = href.includes('/add-phone');

      // ── Email Inbox Screen (OpenAI sends code to email; user can bypass via "Continue with password") ──
      // Phân biệt rõ ràng với TOTP/Authenticator screen:
      // - Email inbox: URL /email-verification, body "check your inbox" + nút "Continue with password" visible
      // - TOTP screen: URL /mfa /totp, body "authenticator app" "6-digit"
       const hasContinueWithPassword = !hasPasswordInput && !!Array.from(document.querySelectorAll('button, [role="button"], a')).find(el =>
        isVisible(el) && (
          (el.innerText || el.textContent || '').trim().toLowerCase().includes('continue with password') ||
          (el.innerText || el.textContent || '').trim().toLowerCase().includes('enter your password') ||
          (el.innerText || el.textContent || '').trim().toLowerCase().includes('use password') ||
          ((el.getAttribute('href') || '').toLowerCase().includes('password') && !(el.getAttribute('href') || '').toLowerCase().includes('forgot') && !(el.getAttribute('href') || '').toLowerCase().includes('reset') && !(el.getAttribute('href') || '').toLowerCase().includes('change'))
        )
      );

      const hasEmailInboxScreen = (
        (href.includes('email-verification') || body.includes('check your inbox') || body.includes('resend email')) &&
        !Array.from(document.querySelectorAll('input')).some(el => isVisible(el) && (el.type === 'text' || el.type === 'number' || el.autocomplete === 'one-time-code' || (el.placeholder || '').toLowerCase().includes('code') || (el.name || '').toLowerCase().includes('code'))) &&
        hasContinueWithPassword
      );

      // ── Email OTP Input Screen: "Check your inbox" + có ô nhập code + có nút "Continue with password" ──
      // Khác với hasEmailInboxScreen (chỉ có nút bypass, không có ô code):
      // Màn hình này có cả ô nhập mã code VÀ nút "Continue with password".
      // Dùng để các flow cần lấy email OTP thực sự (2FA regen, register) không bị bypass nhầm.
      const hasEmailOtpInput = !!(
        (href.includes('email-verification') || body.includes('check your inbox') || body.includes('resend email') || body.includes('xác minh email')) &&
        Array.from(document.querySelectorAll('input')).some(el => isVisible(el) && (
          el.autocomplete === 'one-time-code' || 
          (el.placeholder || '').toLowerCase().includes('code') || 
          (el.name || '').toLowerCase().includes('code') || 
          (el.id || '').toLowerCase().includes('code') ||
          (el.className || '').toLowerCase().includes('code') ||
          el.type === 'number'
        ))
      );

      // ── MFA / TOTP Authenticator Screen (gated: phải KHÔNG phải email inbox screen, KHÔNG phải email OTP, và KHÔNG có nút Continue với Password) ──
      const hasMfaInput = !isAddPhonePage && !hasEmailInboxScreen && !hasContinueWithPassword && !hasEmailOtpInput && !!(
        href.includes('/mfa') || href.includes('/totp') || href.includes('two-factor') || href.includes('/otp') ||
        body.includes('one-time code') || body.includes('authenticator app') || body.includes('6-digit') ||
        body.includes('mã xác minh') || body.includes('mã xác thực') || body.includes('mã otp') || body.includes('verification code') ||
        body.includes('sent a code') || body.includes('temporary verification code') ||
        Array.from(document.querySelectorAll('input[autocomplete="one-time-code"], input[name="code"], input[name="otp"], input[placeholder*="code"], input[placeholder*="Code"], input[placeholder*="mã"], input[id*="code"], input[id*="otp"], input[class*="code"]')).some(isVisible)
      );

      const COOKIE_KW = ${JSON.stringify(MULTILANG.acceptCookie)};
      const PHONE_KW = ${JSON.stringify(MULTILANG.phoneVerify)};
      const ERROR_KW = ${JSON.stringify(MULTILANG.somethingWrong)};
      const CONSENT_KW = ${JSON.stringify(MULTILANG.consent)};
      const WORKSPACE_KW = ${JSON.stringify(MULTILANG.workspace)};
      const ORG_KW = ${JSON.stringify(MULTILANG.organization)};
      const WRONG_PASSWORD_KW = ${JSON.stringify(MULTILANG.wrongPassword)};

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
      const isWorkspaceScr = !hasEmailInput && !hasPasswordInput && (
        lowerUrl.includes('/workspace') ||
        (lowerUrl.includes('sign-in-with-chatgpt') && !lowerUrl.includes('consent')) ||
        WORKSPACE_KW.some(k => body.includes(k)) ||
        body.includes('launch a workspace') ||
        body.includes('choose a workspace') ||
        body.includes('has access to')
      );

      // Inline consent screen logic
      const specificConsentKws = [
        'authorize', 'allow', 'consent',
        'autorisieren', 'zulassen', 'erlauben',
        'autoriser', 'permettre',
        'autorizar', 'permitir',
        'autorizza', 'consenti',
        'cho phép', 'ủy quyền',
        'разрешить'
      ];
      const isConsentScr = (
        (lowerUrl.includes('consent') && !lowerUrl.includes('/log-in')) ||
        (onAuthDomain && specificConsentKws.some(k => body.includes(k)) && (body.includes('continue') || body.includes('allow') || body.includes('authorize')))
      );


      // ── Error screen ──
      const rawHasError = ERROR_KW.some(k => body.includes(k));
      const hasProfileBtn = !!Array.from(document.querySelectorAll([
        '[data-testid="profile-button"]',
        '[data-testid="accounts-profile-button"]',
        '[data-testid="user-menu-button"]',
        '[aria-label="Open user menu"]',
        '[aria-label="User menu"]',
        'button[aria-haspopup="menu"]'
      ].join(','))).find(el => {
        const isClosedSidebar = !!document.querySelector('[data-testid="show-sidebar-button"], [aria-label="Show sidebar"], [aria-label="Open sidebar"]');
        if (!isVisible(el) && !isClosedSidebar) return false;
        const aria = (el.getAttribute('aria-label') || '').toLowerCase();
        const testId = (el.getAttribute('data-testid') || '').toLowerCase();
        const text = (el.innerText || el.textContent || '').toLowerCase();
        return testId.includes('profile') || testId.includes('user-menu') || aria.includes('user menu') || aria.includes('profile') || aria.includes('account') || text.includes('my plan');
      });
      const visibleAuthActions = Array.from(document.querySelectorAll('button, a, [role="button"]'))
        .filter(isVisible)
        .map(el => ({
          text: (el.innerText || el.textContent || '').trim().toLowerCase(),
          aria: (el.getAttribute('aria-label') || '').trim().toLowerCase(),
          testId: (el.getAttribute('data-testid') || '').trim().toLowerCase(),
          href: (el.getAttribute('href') || '').trim().toLowerCase(),
        }));
      const hasVisibleLoginAction = visibleAuthActions.some(item =>
        item.testId === 'login-button' ||
        item.testId.includes('login') ||
        item.href.includes('/login') ||
        item.href.includes('/log-in') ||
        item.aria === 'log in' ||
        item.aria === 'login' ||
        item.text === 'log in' ||
        item.text === 'login' ||
        item.text === 'đăng nhập'
      );
      const hasVisibleSignUpAction = visibleAuthActions.some(item =>
        item.testId === 'signup-button' ||
        item.testId.includes('signup') ||
        item.testId.includes('sign-up') ||
        item.href.includes('/signup') ||
        item.href.includes('/sign-up') ||
        item.aria === 'sign up' ||
        item.aria === 'sign up for free' ||
        item.text === 'sign up' ||
        item.text === 'sign up for free' ||
        item.text === 'đăng ký'
      );
      const hasLoggedOutSidebarPrompt =
        body.includes('get responses tailored to you') ||
        body.includes('log in to get answers tailored to you') ||
        body.includes('log in or sign up') ||
        body.includes('try it first');
      const hasSignUpInPage = hasVisibleSignUpAction || body.includes('sign up for free') || body.includes('sign up') || body.includes('đăng ký');
      const hasLogInBtn = !hasProfileBtn && (hasVisibleLoginAction || body.includes('log in'));
      const hasLoggedOutChatShell = isChatgptHost && (
        hasVisibleLoginAction || 
        hasVisibleSignUpAction || 
        hasLoggedOutSidebarPrompt ||
        !!document.querySelector('[data-testid="login-button"], [data-testid="signup-button"]')
      );
      const hasNewChat      = body.includes('new chat') || body.includes('search chats') || body.includes('chatgpt plus');
      const isConversation  = href.includes('/c/') || href.includes('/g/');
      const isChatgptHome   = isChatgptHost && (href.endsWith('chatgpt.com/') || href.endsWith('chatgpt.com'));

      const tempLooksLoggedIn = !hasLoggedOutChatShell && (hasProfileBtn || (
        isConversation || 
        (isChatgptHome 
          ? (hasProfileBtn && !hasSignUpInPage && !hasLogInBtn) 
          : ((hasProfileBtn || hasNewChat) && !hasSignUpInPage && !hasLogInBtn)
        )
      ));
      const hasError = rawHasError && (onAuthDomain || !tempLooksLoggedIn);

      const hasDeactivated = body.includes('account_deactivated') || 
        body.includes('deactivated') || 
        body.includes('deactive') || 
        body.includes('vô hiệu hóa') || 
        body.includes('vô hiệu hoá') || 
        body.includes('đã bị xóa') || 
        body.includes('đã bị xoá') || 
        body.includes('bị khóa') || 
        body.includes('bị khoá') || 
        body.includes('bị block') ||
        body.includes('account suspended') ||
        body.includes('suspended account') ||
        (body.includes('tài khoản') && body.includes('vô hiệu'));
      const hasResetPasswordScreen = onAuthDomain && (body.includes('reset password') || body.includes('khôi phục mật khẩu') || body.includes('đặt lại mật khẩu') || lowerUrl.includes('reset-password') || lowerUrl.includes('reset_password'));
      const hasWrongPassword = onAuthDomain && WRONG_PASSWORD_KW.some(k => body.includes(k));
      const hasPasskeyEnrollScreen = lowerUrl.includes('login-enroll-passkey') || lowerUrl.includes('enroll-passkey') || 
        body.includes('log in faster next time') || body.includes('setup faster login') || body.includes('set up faster login') ||
        body.includes('faster login') || body.includes('passkey') || body.includes('đăng nhập nhanh hơn') || body.includes('khóa truy cập') ||
        body.includes('iniciar sesión más rápido') || body.includes('connexion plus rapide') || body.includes('schneller anmelden') ||
        body.includes('быстрее войти');

       // ── Logged-in indicators ──
      const hasSessionExpiredText = body.includes('session has expired') || 
        body.includes('session expired') || 
        body.includes('please log in again') || 
        body.includes('please sign in again') ||
        body.includes('token has been invalidated');

      const looksLoggedIn = !hasSessionExpiredText && tempLooksLoggedIn && (
        onAuthDomain ? (
          !hasEmailInput &&
          !hasPasswordInput &&
          !hasMfaInput &&
          !hasContinueWithPassword &&
          !hasResetPasswordScreen &&
          !hasWrongPassword &&
          !hasPasskeyEnrollScreen &&
          !hasPhoneScreen &&
          !hasError &&
          !hasDeactivated &&
          !isOnboarding &&
          !isWorkspaceScr &&
          !isConsentScr
        ) : (
          !hasLoggedOutChatShell &&
          !hasResetPasswordScreen &&
          !hasWrongPassword &&
          !hasPasskeyEnrollScreen &&
          !hasPhoneScreen &&
          !hasError &&
          !hasDeactivated &&
          !isOnboarding &&
          !isWorkspaceScr &&
          !isConsentScr
        )
      );

      return {
        href, host,
        looksLoggedIn, hasProfileBtn, hasSignUpInPage, hasLogInBtn, hasLoggedOutChatShell, hasVisibleLoginAction, hasVisibleSignUpAction, hasLoggedOutSidebarPrompt, isConversation,
        onAuthDomain, hasEmailInput, hasPasswordInput, hasMfaInput,
        hasCookieBanner, hasPhoneScreen, hasError, hasDeactivated,
        hasEmailInboxScreen,
        hasEmailOtpInput,
        hasContinueWithPassword,
        hasResetPasswordScreen,
        hasWrongPassword,
        hasPasskeyEnrollScreen,
        isConsentScreen: isConsentScr,
        isWorkspaceScreen: !hasError && isWorkspaceScr,
        isOrganizationScreen: lowerUrl.includes('/organization') || ORG_KW.some(k => body.includes(k)),
        isOnboardingScreen: isOnboarding,
        hasSessionExpiredText,
        tempLooksLoggedIn,
        isWorkspaceScr,
        isConsentScr,
        isOnboarding,
        emailValue
      };
    })()
  `, 5000);
  console.log(`[getState debug] looksLoggedIn=${state?.looksLoggedIn}, hasProfileBtn=${state?.hasProfileBtn}, hasLoggedOutChatShell=${state?.hasLoggedOutChatShell}, hasSessionExpiredText=${state?.hasSessionExpiredText}, tempLooksLoggedIn=${state?.tempLooksLoggedIn}, isWorkspaceScr=${state?.isWorkspaceScreen}, isConsentScr=${state?.isConsentScreen}, hasError=${state?.hasError}`);
  console.log(`[getState debug detail] hasResetPasswordScreen=${state?.hasResetPasswordScreen}, hasWrongPassword=${state?.hasWrongPassword}, hasPasskeyEnrollScreen=${state?.hasPasskeyEnrollScreen}, hasPhoneScreen=${state?.hasPhoneScreen}, hasDeactivated=${state?.hasDeactivated}, isOnboarding=${state?.isOnboardingScreen}`);
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
  // --- PRIMARY: Camoufox native keyboard type ---
  console.log(`[fillEmail] Trying Camoufox keyboard type (primary)...`);
  const selector = getEmailInputSelector();

  // Step 0: Clear the email field first (important on retries)
  try {
    await evalJson(tabId, userId, `
      (() => {
        const inp = document.querySelector(${JSON.stringify(selector)});
        if (!inp) return false;
        inp.focus();
        const nativeInput = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
        if (nativeInput) nativeInput.set.call(inp, '');
        else inp.value = '';
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        
        // Only close the actual Google One Tap container. A global Escape closes
        // ChatGPT's login modal, making the email input disappear before typing.
        try {
          const oneTapContainer = document.querySelector('#credential_picker_container, #credential_picker_iframe, [data-credential_picker_id]');
          if (oneTapContainer) {
            const closeBtn = oneTapContainer.querySelector('[aria-label="Close"], button[jsname="VCKitc"], button[jsname="tJiF1b"]');
            if (closeBtn) closeBtn.click();
            else oneTapContainer.remove();
          }
        } catch (_) {}
        return !!inp;
      })()
    `, 3000).catch(() => {});
    await new Promise(r => setTimeout(r, 200));
  } catch (_) {}

  try {
    const typeRes = await actType(tabId, userId, {
      selector,
      text: email,
      mode: 'keyboard',
      submit: true
    }, { timeoutMs: 10000 });
    
    if (typeRes && typeRes.ok) {
      await new Promise(r => setTimeout(r, 200));
      const typedValue = await evalJson(tabId, userId, `
        (() => {
          const inp = document.querySelector(${JSON.stringify(selector)});
          if (!inp) return '';
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          inp.dispatchEvent(new Event('change', { bubbles: true }));
          return inp.value || '';
        })()
      `).catch(() => '');
      
      if (typedValue.trim().toLowerCase() === email.toLowerCase()) {
        console.log(`[fillEmail] Keyboard type email matched. Attempting native click on Continue button...`);
        
        // Wait for Cloudflare Turnstile token to be injected (or 8s timeout)
        // Turnstile injects a hidden input[name="cf-turnstile-response"] when solved.
        // Clicking Continue before this = server-side silent reject (no navigation).
        let turnstileStatus = 'unknown';
        for (let waitTick = 0; waitTick < 16; waitTick++) {
          turnstileStatus = await evalJson(tabId, userId, `
            (() => {
              const btn = document.querySelector('button[value="email"][name="intent"], button[type="submit"][value="email"]');
              const ariaDisabled = btn ? btn.getAttribute('aria-disabled') : 'no-btn';
              // Turnstile injects this hidden input when solved
              const tokenInput = document.querySelector('input[name="cf-turnstile-response"]');
              const hasTurnstile = !!tokenInput;
              const tokenValue = tokenInput ? tokenInput.value : '';
              // If no Turnstile present: ready immediately
              if (!hasTurnstile) return JSON.stringify({ ready: true, reason: 'no-turnstile', ariaDisabled });
              // If Turnstile present but token filled: ready
              if (tokenValue && tokenValue.length > 10) return JSON.stringify({ ready: true, reason: 'token-ready', tokenLen: tokenValue.length, ariaDisabled });
              return JSON.stringify({ ready: false, reason: 'waiting-token', tokenLen: tokenValue.length, ariaDisabled });
            })()
          `).catch(() => JSON.stringify({ ready: true, reason: 'eval-error' }));
          let parsed = {};
          try { parsed = JSON.parse(turnstileStatus); } catch (_) { parsed = { ready: true }; }
          if (parsed.ready) { turnstileStatus = parsed.reason || 'ready'; break; }
          console.log(`[fillEmail] Waiting for Turnstile token... tick=${waitTick + 1} ariaDisabled=${parsed.ariaDisabled}`);
          await new Promise(r => setTimeout(r, 500));
        }
        console.log(`[fillEmail] Turnstile status=${turnstileStatus}. Clicking Continue now...`);
        
        try {
          // Add human-like delay before clicking — OpenAI bot detection resets form if click is too fast
          const humanDelay = 1500 + Math.floor(Math.random() * 1500); // 1.5s - 3s random
          console.log(`[fillEmail] Human-like pause ${humanDelay}ms before click...`);
          await new Promise(r => setTimeout(r, humanDelay));
          
          // Use precise selector to avoid strict mode violation (5+ elements with :has-text)
          const nativeClickRes = await actClick(tabId, userId, {
            selector: 'button[value="email"][name="intent"], button[type="submit"][value="email"], button[data-dd-action-name="Continue"]',
            timeoutMs: 6000
          }, { timeoutMs: 9000 });
          if (nativeClickRes && nativeClickRes.ok) {
            console.log(`[fillEmail] Native click succeeded:`, JSON.stringify(nativeClickRes));
            
            // Wait up to 8s for page to transition (password screen appears)
            // SPA transition can take 2-4s; need enough time before falling back
            let stillOnEmailPage = true;
            for (let check = 0; check < 16; check++) {
              stillOnEmailPage = await evalJson(tabId, userId, `
                (() => {
                  const inp = document.querySelector(${JSON.stringify(selector)});
                  return !!(inp && inp.getBoundingClientRect().width > 0);
                })()
              `).catch(() => false);
              if (!stillOnEmailPage) break;
              await new Promise(r => setTimeout(r, 500));
            }

            if (stillOnEmailPage) {
              console.log('[fillEmail] Native click did not transition page. Trying form.requestSubmit()...');
              const submitResult = await evalJson(tabId, userId, `
                (() => {
                  const submitBtn = document.querySelector('button[type="submit"]');
                  const form = submitBtn?.closest('form') || document.querySelector('form');
                  if (form) {
                    try {
                      if (typeof form.requestSubmit === 'function') {
                        form.requestSubmit(submitBtn || undefined);
                        return { method: 'requestSubmit', ok: true };
                      } else {
                        form.submit();
                        return { method: 'submit', ok: true };
                      }
                    } catch (e) {
                      return { method: 'error', ok: false, err: e.message };
                    }
                  }
                  return { method: 'no-form', ok: false };
                })()
              `).catch(() => null);
              console.log('[fillEmail] requestSubmit result:', JSON.stringify(submitResult));
            }
          }
        } catch (clickErr) {
          console.log(`⚠️ [fillEmail] Native click Continue button error: ${clickErr.message}`);
        }
        return { ok: true, strategy: 'camofox-type', value: email };
      } else {
        console.log(`⚠️ [fillEmail] Camoufox Type gõ xong nhưng giá trị thực tế không khớp (mong muốn: "${email}", thực tế: "${typedValue}"). Chuyển sang DOM fallback...`);
      }
    }
  } catch (typeErr) {
    console.log(`⚠️ [fillEmail] Camoufox Type thất bại: ${typeErr.message}. Fallback to DOM...`);
  }

  // --- FALLBACK: DOM JS ---
  const escaped = JSON.stringify(email);
  let res = await evalJson(tabId, userId, `
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
      const selectors = ${JSON.stringify(EMAIL_INPUT_SELECTORS)};
      let input = null;
      for (const s of selectors) {
        const el = document.querySelector(s);
        if (isVisible(el)) { input = el; break; }
      }
      if (!input) return { ok: false, reason: 'no-email-input', tried: selectors };
      input.focus();
      setValue(input, val);

      if (input.value !== val) {
        return { ok: false, reason: 'value-mismatch-after-set', currentVal: input.value };
      }

      const form = input.closest('form');
      const searchRoot = form || document;
      const btn = Array.from(searchRoot.querySelectorAll('button, [role="button"], input[type="submit"]'))
        .filter(isVisible)
        .filter(el => {
          const inPopup = el.closest('[id*="credential_picker"], [id*="g_id_"], [class*="nsm7Bb"], [data-credential_picker_id]');
          return !inPopup && !isSocialAuthButton(el);
        })
        .find(el => {
          const t = (el.innerText || el.textContent || el.value || '').trim().toLowerCase();
          return t === 'continue' || t === 'next' || t === 'tiếp tục';
        });
      if (btn) btn.click();
      else {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      }
      return { ok: true, clicked: !!btn, value: input.value, strategy: 'dom' };
    })()
  `, 6000);

  return res;
}

/**
 * Fill password input and submit
 *
 * Strategy order:
 * 1. PRIMARY — Camoufox native keyboard typing (actType mode:"keyboard").
 *    This sends real hardware-level keystrokes that React's synthetic event
 *    system recognises properly. DOM btn.click() bypasses React handlers on the
 *    OpenAI "Create a password" page, causing the field to be silently reset.
 * 2. FALLBACK — DOM setValue + btn.click() (kept for non-React pages).
 *
 * @param {string} tabId - Tab ID
 * @param {string} userId - User ID
 * @param {string} password - Password
 * @returns {Promise<object>} Result object
 */
export async function fillPassword(tabId, userId, password) {
  // --- PRIMARY: Camoufox native keyboard type ---
  console.log(`[fillPassword] Trying Camoufox keyboard type (primary)...`);

  // Step 0: Clear the password field first (important on retries — avoid appending to old value)
  try {
    await evalJson(tabId, userId, `
      (() => {
        const inp = document.querySelector('input[autocomplete="new-password"], input[autocomplete="current-password"], input[type="password"]');
        if (!inp) return false;
        inp.focus();
        // Select-all + delete to clear via React-compatible way
        const nativeInput = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
        if (nativeInput) nativeInput.set.call(inp, '');
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()
    `, 3000).catch(() => {});
    await new Promise(r => setTimeout(r, 200));
  } catch (_) {}

  try {
    const typeRes = await actType(tabId, userId, {
      selector: 'input[autocomplete="new-password"], input[autocomplete="current-password"], input[type="password"], input[name="password"], input[id="password"]',
      text: password,
      mode: 'keyboard',
      submit: false
    }, { timeoutMs: 10000 });
    
    if (typeRes && typeRes.ok) {
      console.log(`[fillPassword] Keyboard type succeeded. Waiting 2500ms for validation/Turnstile...`);
      await new Promise(r => setTimeout(r, 2500));

      // Debug: Take a screenshot to verify password value is typed
      try {
        const cleanUser = userId.replace('register_', '');
        await fetch(`${CAMOUFOX_API}/tabs/${tabId}/screenshot?userId=${userId}&fullPage=false`, {
          signal: AbortSignal.timeout(6000),
        }).then(res => res.arrayBuffer()).then(buf => {
          fs.writeFile(`/Users/ndpmmo/Documents/Github/seellm-tools/data/screenshots/register_${cleanUser}/pwd_typed_attempt_${Date.now()}.png`, Buffer.from(buf)).catch(() => {});
        }).catch(() => {});
      } catch (_) {}

      // Log any validation error text visible on page (helpful for debugging)
      const pageErrorText = await evalJson(tabId, userId, `
        (() => {
          const body = document.body?.innerText || '';
          const errEl = document.querySelector('[class*="error"], [class*="alert"], [role="alert"], [aria-live], .error-message');
          return { bodySnippet: body.slice(0, 300), errEl: errEl?.innerText?.slice(0, 100) };
        })()
      `).catch(() => null);
      if (pageErrorText) {
        console.log(`[fillPassword] Page state after type:`, JSON.stringify(pageErrorText));
      }
      
      // Try native click on Continue button first (trusted click for React 19 compatibility)
      console.log(`[fillPassword] Attempting native click on Continue button...`);
      try {
        const nativeClickRes = await actClick(tabId, userId, {
          selector: 'button[type="submit"]:has-text("Continue"), button[type="submit"]:has-text("Tiếp tục"), button[type="submit"]:has-text("Next")',
          timeoutMs: 6000
        }, { timeoutMs: 9000 });
        if (nativeClickRes && nativeClickRes.ok) {
          console.log(`[fillPassword] Native click succeeded:`, JSON.stringify(nativeClickRes));
          
          // Poll checking if still on password page (max 3500ms)
          let stillOnPwdPage = true;
          for (let check = 0; check < 7; check++) {
            stillOnPwdPage = await evalJson(tabId, userId, `
              !!document.querySelector('input[type="password"]')
            `).catch(() => false);
            if (!stillOnPwdPage) break;
            await new Promise(r => setTimeout(r, 500));
          }

          if (stillOnPwdPage) {
            // Log visible error text to understand why submit failed
            const errInfo = await evalJson(tabId, userId, `
              (() => {
                const body = (document.body?.innerText || '').slice(0, 400);
                const url = location.href;
                const errEl = document.querySelector('[class*="error"], [role="alert"], [aria-live="polite"], [aria-live="assertive"]');
                return { url, body, errEl: errEl?.innerText?.slice(0, 150) };
              })()
            `).catch(() => null);
            console.log('[fillPassword] Native click did not transition page. Page info:', JSON.stringify(errInfo));

            // Try form.requestSubmit() — triggers React onSubmit handler (unlike native submit())
            const submitResult = await evalJson(tabId, userId, `
              (() => {
                const submitBtn = document.querySelector('button[type="submit"]');
                const form = submitBtn?.closest('form') || document.querySelector('form');
                if (form) {
                  try {
                    if (typeof form.requestSubmit === 'function') {
                      form.requestSubmit(submitBtn || undefined);
                      return { method: 'requestSubmit', ok: true };
                    } else {
                      form.submit();
                      return { method: 'submit', ok: true };
                    }
                  } catch (e) {
                    return { method: 'error', ok: false, err: e.message };
                  }
                }
                return { method: 'no-form', ok: false };
              })()
            `).catch(() => null);
            console.log('[fillPassword] requestSubmit result:', JSON.stringify(submitResult));

            // Poll check after requestSubmit (max 3500ms)
            let stillOnPwdPage2 = true;
            for (let check = 0; check < 7; check++) {
              stillOnPwdPage2 = await evalJson(tabId, userId, `
                !!document.querySelector('input[type="password"]')
              `).catch(() => false);
              if (!stillOnPwdPage2) break;
              await new Promise(r => setTimeout(r, 500));
            }

            if (stillOnPwdPage2) {
              if (submitResult && submitResult.ok) {
                const isShortPwd = password && password.length < 12;
                const bodyLower = (errInfo?.body || '').toLowerCase();
                const isCriteriaError = bodyLower.includes('12 characters') || bodyLower.includes('at least 12');
                if (isShortPwd || isCriteriaError) {
                  console.log('[fillPassword] Password validation failed because the password is less than 12 characters or does not meet criteria.');
                  return { ok: false, reason: 'PASSWORD_TOO_SHORT', isBlock: true };
                }
                const isIncorrectPwd = bodyLower.includes('incorrect email') || 
                                       bodyLower.includes('wrong email') || 
                                       bodyLower.includes('incorrect password') || 
                                       bodyLower.includes('không chính xác') || 
                                       bodyLower.includes('sai mật khẩu') ||
                                       bodyLower.includes('mật khẩu không đúng') ||
                                       bodyLower.includes('password is incorrect') ||
                                       bodyLower.includes('wrong password');
                if (isIncorrectPwd) {
                  console.log('[fillPassword] Password validation failed: Incorrect email address or password.');
                  return { ok: false, reason: 'INCORRECT_PASSWORD', isBlock: false };
                }
                console.log('[fillPassword] form.requestSubmit() completed but page did not transition. This strongly indicates a Turnstile / IP Reputation block.');
                return { ok: false, reason: 'BLOCKED_BY_OPENAI_TURNSTILE', isBlock: true };
              }
              console.log('[fillPassword] Still on password page after requestSubmit — throwing to trigger DOM fallback');
              throw new Error('primary-strategy-failed-to-transition');
            }
          }
          
          return { ok: true, strategy: 'keyboard-native-click', value: '***' };
        }
      } catch (clickErr) {
        console.log(`[fillPassword] Native click failed: ${clickErr.message}`);
      }
      
      // Fallback to DOM click (untrusted but works on some forms)
      console.log(`[fillPassword] Falling back to DOM click on submit button...`);
      const domClickRes = await evalJson(tabId, userId, `
        (() => {
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
          const btn = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]'))
            .filter(isVisible)
            .filter(el => !isSocialAuthButton(el))
            .find(el => {
              const t = (el.innerText || el.textContent || el.value || '').trim().toLowerCase();
              return t === 'continue' || t === 'sign in' || t === 'log in' || t === 'next' || t === 'tiếp tục';
            });
          if (btn) {
            btn.click();
            // Try requestSubmit (React-compatible) then fallback to native submit
            const form = btn.closest('form') || document.querySelector('form');
            if (form) {
              try {
                if (typeof form.requestSubmit === 'function') form.requestSubmit(btn);
                else form.submit();
              } catch (_) {}
            }
            return { ok: true, clicked: true, text: btn.innerText || btn.textContent };
          }
          return { ok: false, reason: 'no-submit-button-found' };
        })()
      `, 3000);
      console.log(`[fillPassword] DOM click result:`, JSON.stringify(domClickRes));
      
      if (domClickRes && domClickRes.ok) {
        return { ok: true, strategy: 'keyboard-dom-click', value: '***' };
      }
      
      // Last resort: Press Enter
      console.log(`[fillPassword] Last resort: Pressing Enter key...`);
      await actPress(tabId, userId, { key: 'Enter' }, { timeoutMs: 3000 }).catch(() => {});
      return { ok: true, strategy: 'keyboard-enter-fallback', value: '***' };
    }
    console.log(`[fillPassword] Keyboard type not-ok:`, JSON.stringify(typeRes));
  } catch (typeErr) {
    console.log(`[fillPassword] Keyboard type threw: ${typeErr.message}`);
  }

  // --- FALLBACK: DOM setValue + btn.click() ---
  console.log(`[fillPassword] Falling back to DOM setValue...`);
  const escaped = JSON.stringify(password);
  let res = await evalJson(tabId, userId, `
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
      const selectors = [
        'input[autocomplete="current-password"]',
        'input[autocomplete="new-password"]',
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

      if (input.value !== val) {
        return { ok: false, reason: 'value-mismatch-after-set', currentVal: input.value };
      }

      const btn = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]'))
        .filter(isVisible)
        .filter(el => !isSocialAuthButton(el))
        .find(el => {
          const t = (el.innerText || el.textContent || el.value || '').trim().toLowerCase();
          return t === 'continue' || t === 'sign in' || t === 'log in' || t === 'next' || t === 'tiếp tục';
        });
      if (btn) btn.click();
      else {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      }
      return { ok: true, clicked: !!btn, strategy: 'dom', value: '***' };
    })()
  `, 6000);

  return res;
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
 * Dismiss Passkey/faster login enrollment screen by clicking "Skip" or "Bỏ qua"
 * @param {string} tabId - Tab ID
 * @param {string} userId - User ID
 * @returns {Promise<boolean>} true if dismissed
 */
export async function tryDismissPasskeyEnrollment(tabId, userId) {
  return evalJson(tabId, userId, `
    (() => {
      const isVisible = el => {
        if (!el) return false;
        const s = window.getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0' && r.width > 0 && r.height > 0;
      };
      const skipKeywords = [
        'skip', 'bỏ qua', 'dismiss', 'later', 'not now', 'để sau',
        'omitir', 'ignorer', 'пропустить', 'cancel', 'hủy', 'abbrechen', 'annuler'
      ];
      const btn = Array.from(document.querySelectorAll('button, [role="button"], a'))
        .filter(isVisible)
        .find(el => {
          const t = (el.innerText || el.textContent || '').toLowerCase().trim();
          return skipKeywords.some(k => t === k || t.includes(k));
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
 * Click "Continue with password" on the Email Inbox verification screen.
 * Appears after email submit when OpenAI requires email verification.
 * Clicking this button bypasses email OTP and routes to the password screen.
 * @param {string} tabId - Tab ID
 * @param {string} userId - User ID
 * @returns {Promise<object>} { ok, method, text }
 */
export async function clickContinueWithPassword(tabId, userId) {
  return evalJson(tabId, userId, `
    (() => {
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
          combined.includes('continue with google') ||
          combined.includes('sign in with') ||
          combined.includes('log in with') ||
          combined.includes('oauth');
      };

      // Strategy 1: Exact text match on button/[role="button"]
      const kwds = ['continue with password', 'enter your password', 'use password', 'use your password', 'with password'];
      let btn = Array.from(document.querySelectorAll('button, [role="button"]'))
        .filter(isVisible)
        .filter(el => !isSocialAuthButton(el))
        .find(el => {
          const t = (el.innerText || el.textContent || '').trim().toLowerCase();
          return kwds.some(k => t === k || t.includes(k));
        });
      if (btn) {
        btn.click();
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return { ok: true, method: 'button-text', text: (btn.innerText || btn.textContent || '').trim() };
      }

      // Strategy 2: <a> tag with href containing "password" (not "forgot", "reset", "change")
      const link = Array.from(document.querySelectorAll('a')).filter(isVisible).find(a => {
        const href = (a.getAttribute('href') || '').toLowerCase();
        return href.includes('password') && !href.includes('forgot') && !href.includes('reset') && !href.includes('change');
      });
      if (link) {
        link.click();
        return { ok: true, method: 'link-href', href: link.getAttribute('href') };
      }

      // Strategy 3: Outline/ghost button appearing after an "OR" divider
      const allBtns = Array.from(document.querySelectorAll('button')).filter(isVisible);
      const orDivider = Array.from(document.querySelectorAll('*')).find(el =>
        isVisible(el) && (el.innerText || el.textContent || '').trim().toUpperCase() === 'OR'
      );
      if (orDivider) {
        const afterOr = allBtns.find(b => {
          if (isSocialAuthButton(b)) return false;
          try {
            return orDivider.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING;
          } catch (_) { return false; }
        });
        if (afterOr) {
          afterOr.click();
          afterOr.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          return { ok: true, method: 'after-or-divider', text: (afterOr.innerText || afterOr.textContent || '').trim() };
        }
      }

      return { ok: false };
    })()
  `, 5000);
}

/**
 * Handle the "Welcome back" / remembered account screen.
 * This screen often shows a prefilled email plus a "Continue" button.
 * @param {string} tabId - Tab ID
 * @param {string} userId - User ID
 * @param {string} accountEmail - Email used to prefer the correct remembered account
 * @returns {Promise<object>} Result object
 */
export async function clickWelcomeBackContinue(tabId, userId, accountEmail = '') {
  const escapedEmail = JSON.stringify(String(accountEmail || '').toLowerCase());
  const domResult = await evalJson(tabId, userId, `
    (() => {
      const isVisible = el => {
        if (!el) return false;
        const s = window.getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0' && r.width > 0 && r.height > 0;
      };
      const lowerEmail = ${escapedEmail};
      const lowerLocalPart = lowerEmail.includes('@') ? lowerEmail.split('@')[0] : '';
      const bodyText = (document.body?.innerText || '').toLowerCase();
      const hasWelcomeBack = bodyText.includes('welcome back') ||
        bodyText.includes('chào mừng quay trở lại') ||
        bodyText.includes('choose an account') ||
        bodyText.includes('chọn một tài khoản');
      if (!hasWelcomeBack) return { ok: false, reason: 'no-welcome-back' };

      // Check if there is an email input. If there is, we only click Continue if it is prefilled with our email!
      const emailInputs = Array.from(document.querySelectorAll('input')).filter(el => isVisible(el) && (
        el.type === 'email' ||
        (el.name || '').toLowerCase().includes('email') ||
        (el.name || '').toLowerCase().includes('username') ||
        (el.id || '').toLowerCase().includes('email') ||
        (el.id || '').toLowerCase().includes('username')
      ));
      
      if (emailInputs.length > 0) {
        const hasCorrectEmail = emailInputs.some(input => input.value.trim().toLowerCase() === lowerEmail);
        if (!hasCorrectEmail) {
          return { ok: false, reason: 'email-input-not-matching-or-empty' };
        }
        // Email pre-filled correctly — signal caller to use native actClick/actPress
        return { ok: true, method: 'welcome-back-prefilled-email', transitioned: false, needsNativeClick: true };
      }

      const clickables = Array.from(document.querySelectorAll('button, [role="button"], [role="option"], a, input[type="submit"]')).filter(isVisible);
      const beforeHref = location.href;
      const beforeEmailInputs = Array.from(document.querySelectorAll('input')).filter(el => isVisible(el) && (
        el.type === 'email' ||
        (el.name || '').toLowerCase().includes('email') ||
        (el.name || '').toLowerCase().includes('username') ||
        (el.id || '').toLowerCase().includes('email') ||
        (el.id || '').toLowerCase().includes('username')
      )).length;
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
      const matchesAccount = el => {
        const text = ((el.innerText || el.textContent || el.value || '') + ' ' + (el.getAttribute('aria-label') || '')).trim().toLowerCase();
        return !!text && (
          (lowerEmail && text.includes(lowerEmail)) ||
          (lowerLocalPart && text.includes(lowerLocalPart)) ||
          text.includes('remembered') ||
          text.includes('saved account')
        );
      };
      const safeClick = el => {
        if (!el) return false;
        try { el.focus?.(); } catch (_) {}
        try { el.click(); } catch (_) {}
        try { el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); } catch (_) {}
        try { el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); } catch (_) {}
        try { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window })); } catch (_) {}
        return true;
      };

      const accountCandidates = clickables.filter(el => !isSocialAuthButton(el)).filter(matchesAccount);
      for (const el of accountCandidates) {
        if (safeClick(el)) {
          const afterHref = location.href;
          const afterEmailInputs = Array.from(document.querySelectorAll('input')).filter(el => isVisible(el) && (
            el.type === 'email' ||
            (el.name || '').toLowerCase().includes('email') ||
            (el.name || '').toLowerCase().includes('username') ||
            (el.id || '').toLowerCase().includes('email') ||
            (el.id || '').toLowerCase().includes('username')
          )).length;
          return { ok: true, method: 'matched-account', transitioned: afterHref !== beforeHref || afterEmailInputs > beforeEmailInputs, text: (el.innerText || el.textContent || el.value || '').trim().slice(0, 80) };
        }
      }

      const continueCandidates = clickables.filter(el => !isSocialAuthButton(el)).filter(el => {
        const text = (el.innerText || el.textContent || el.value || '').trim().toLowerCase();
        const aria = (el.getAttribute('aria-label') || '').trim().toLowerCase();
        return text === 'continue' ||
               text.includes('continue') ||
               text.includes('next') ||
               text.includes('tiếp tục') ||
               aria === 'continue' ||
               aria.includes('continue') ||
               aria.includes('next');
      });
      for (const el of continueCandidates) {
        const text = ((el.innerText || el.textContent || el.value || '') + ' ' + (el.getAttribute('aria-label') || '')).trim().toLowerCase();
        const parentText = (el.closest('div, section, main, dialog')?.innerText || '').toLowerCase();
        if (text.includes('continue') || parentText.includes('welcome back') || parentText.includes('choose an account')) {
          if (safeClick(el)) {
            const afterHref = location.href;
            const afterEmailInputs = Array.from(document.querySelectorAll('input')).filter(el => isVisible(el) && (
              el.type === 'email' ||
              (el.name || '').toLowerCase().includes('email') ||
              (el.name || '').toLowerCase().includes('username') ||
              (el.id || '').toLowerCase().includes('email') ||
              (el.id || '').toLowerCase().includes('username')
            )).length;
            return { ok: true, method: 'continue-button', transitioned: afterHref !== beforeHref || afterEmailInputs > beforeEmailInputs, text: (el.innerText || el.textContent || el.value || '').trim().slice(0, 80) };
          }
        }
      }

      const forms = Array.from(document.querySelectorAll('form')).filter(isVisible);
      for (const form of forms) {
        const submit = Array.from(form.querySelectorAll('button, [role="button"], input[type="submit"]')).filter(isVisible).find(el => !isSocialAuthButton(el));
        if (submit && safeClick(submit)) {
          const afterHref = location.href;
          const afterEmailInputs = Array.from(document.querySelectorAll('input')).filter(el => isVisible(el) && (
            el.type === 'email' ||
            (el.name || '').toLowerCase().includes('email') ||
            (el.name || '').toLowerCase().includes('username') ||
            (el.id || '').toLowerCase().includes('email') ||
            (el.id || '').toLowerCase().includes('username')
          )).length;
          return { ok: true, method: 'form-submit', transitioned: afterHref !== beforeHref || afterEmailInputs > beforeEmailInputs, text: (submit.innerText || submit.textContent || submit.value || '').trim().slice(0, 80) };
        }
        try {
          if (typeof form.requestSubmit === 'function') {
            form.requestSubmit(submit || undefined);
            const afterHref = location.href;
            const afterEmailInputs = Array.from(document.querySelectorAll('input')).filter(el => isVisible(el) && (
              el.type === 'email' ||
              (el.name || '').toLowerCase().includes('email') ||
              (el.name || '').toLowerCase().includes('username') ||
              (el.id || '').toLowerCase().includes('email') ||
              (el.id || '').toLowerCase().includes('username')
            )).length;
            return { ok: true, method: 'request-submit', transitioned: afterHref !== beforeHref || afterEmailInputs > beforeEmailInputs };
          }
        } catch (_) {}
      }

      const rememberedAccount = clickables.find(el => {
        if (isSocialAuthButton(el)) return false;
        const text = ((el.innerText || el.textContent || el.value || '') + ' ' + (el.getAttribute('aria-label') || '')).trim().toLowerCase();
        return text.includes(lowerEmail) || text.includes(lowerLocalPart);
      });
      if (rememberedAccount && safeClick(rememberedAccount)) {
        const afterHref = location.href;
        const afterEmailInputs = Array.from(document.querySelectorAll('input')).filter(el => isVisible(el) && (
          el.type === 'email' ||
          (el.name || '').toLowerCase().includes('email') ||
          (el.name || '').toLowerCase().includes('username') ||
          (el.id || '').toLowerCase().includes('email') ||
          (el.id || '').toLowerCase().includes('username')
        )).length;
        return { ok: true, method: 'remembered-account-fallback', transitioned: afterHref !== beforeHref || afterEmailInputs > beforeEmailInputs, text: (rememberedAccount.innerText || rememberedAccount.textContent || rememberedAccount.value || '').trim().slice(0, 80) };
      }

      return { ok: false, reason: hasWelcomeBack ? 'welcome-back-loop' : 'welcome-back-unhandled', visible: clickables.slice(0, 10).map(el => (el.innerText || el.textContent || el.value || '').trim().slice(0, 80)) };
    })()
  `, 5000);

  // If DOM result says this is the "Welcome back" screen with correct pre-filled email,
  // use Camoufox native actClick (then actPress Enter as fallback) instead of DOM events.
  // This is the ONLY reliable way to click the Continue button on this screen.
  if (domResult?.ok && domResult?.needsNativeClick) {
    console.log(`[clickWelcomeBackContinue] 🖱️ Welcome back + prefilled email detected → trying native Camoufox actClick on Continue button...`);
    
    // Wait for Cloudflare Turnstile token to be injected (or 8s timeout)
    // Turnstile injects a hidden input[name="cf-turnstile-response"] when solved.
    // Clicking Continue before this = server-side silent reject (no navigation).
    let turnstileStatus = 'unknown';
    for (let waitTick = 0; waitTick < 16; waitTick++) {
      turnstileStatus = await evalJson(tabId, userId, `
        (() => {
          const btn = document.querySelector('button[value="email"][name="intent"], button[type="submit"][value="email"]');
          const ariaDisabled = btn ? btn.getAttribute('aria-disabled') : 'no-btn';
          const tokenInput = document.querySelector('input[name="cf-turnstile-response"]');
          const hasTurnstile = !!tokenInput;
          const tokenValue = tokenInput ? tokenInput.value : '';
          if (!hasTurnstile) return JSON.stringify({ ready: true, reason: 'no-turnstile', ariaDisabled });
          if (tokenValue && tokenValue.length > 10) return JSON.stringify({ ready: true, reason: 'token-ready', tokenLen: tokenValue.length, ariaDisabled });
          return JSON.stringify({ ready: false, reason: 'waiting-token', tokenLen: tokenValue.length, ariaDisabled });
        })()
      `).catch(() => JSON.stringify({ ready: true, reason: 'eval-error' }));
      let parsed = {};
      try { parsed = JSON.parse(turnstileStatus); } catch (_) { parsed = { ready: true }; }
      if (parsed.ready) { turnstileStatus = parsed.reason || 'ready'; break; }
      console.log(`[clickWelcomeBackContinue] Waiting for Turnstile token... tick=${waitTick + 1} ariaDisabled=${parsed.ariaDisabled}`);
      await new Promise(r => setTimeout(r, 500));
    }
    console.log(`[clickWelcomeBackContinue] Turnstile status=${turnstileStatus}. Proceeding with click strategies...`);

    // Human-like delay before clicking — OpenAI bot detection resets form if click is too fast
    const humanDelay = 1500 + Math.floor(Math.random() * 1500); // 1.5s - 3s random
    console.log(`[clickWelcomeBackContinue] Human-like pause ${humanDelay}ms before click...`);
    await new Promise(r => setTimeout(r, humanDelay));

    // Strategy 1: actClick with PRECISE selector (value="email" = the email-submit Continue button, not Google/Apple)
    // From actual HTML: <button type="submit" value="email" name="intent" data-dd-action-name="Continue">Continue</button>
    const preciseSelectors = [
      'button[value="email"][name="intent"]',
      'button[type="submit"][value="email"]',
      'button[data-dd-action-name="Continue"]',
      'button[type="submit"][aria-disabled="false"]:not([form])',
    ];

    
    for (const sel of preciseSelectors) {
      try {
        const nativeRes = await actClick(tabId, userId, {
          selector: sel,
          timeoutMs: 4000
        }, { timeoutMs: 6000 });
        if (nativeRes?.ok) {
          console.log(`[clickWelcomeBackContinue] ✅ Native actClick succeeded with selector "${sel}": ${JSON.stringify(nativeRes)}`);
          await new Promise(r => setTimeout(r, 1500));
          const transitioned = await evalJson(tabId, userId, `
            (() => {
              const hasPassword = !!document.querySelector('input[type="password"]');
              const bodyText = (document.body?.innerText || '').toLowerCase();
              const hasWelcomeBack = bodyText.includes('welcome back') || bodyText.includes('choose an account');
              return hasPassword || !hasWelcomeBack;
            })()
          `, 3000).catch(() => false);
          return { ok: true, method: `native-actclick-continue:${sel}`, transitioned, needsNativeClick: false };
        }
      } catch (nativeErr) {
        console.log(`[clickWelcomeBackContinue] ⚠️ actClick selector "${sel}" failed: ${nativeErr.message}`);
      }
    }

    // Strategy 2: Snapshot-based clickRef — get accessibility tree, find the "Continue" button ref (exact text match)
    try {
      console.log(`[clickWelcomeBackContinue] 📸 Trying snapshot-based clickRef...`);
      const snapshot = await getSnapshot(tabId, userId, { timeoutMs: 8000 });
      const snapshotText = typeof snapshot === 'string' ? snapshot : JSON.stringify(snapshot);
      // Parse snapshot lines to find [button eN] Continue (exact, not "Continue with Google")
      const lines = snapshotText.split('\n');
      let continueRef = null;
      for (const line of lines) {
        // Match: [button e5] Continue  (exact, no "with" after it)
        const m = line.match(/\[button\s+(e\d+)\]\s+Continue\s*$/i);
        if (m) { continueRef = m[1]; break; }
        // Also match: [button e5] Continue\r or end of line
        const m2 = line.match(/\[button\s+(e\d+)\]\s+Continue[\s\r]*$/i);
        if (m2) { continueRef = m2[1]; break; }
      }
      if (continueRef) {
        console.log(`[clickWelcomeBackContinue] 📌 Found Continue button ref: ${continueRef}`);
        const refRes = await clickRef(tabId, userId, continueRef, { timeoutMs: 6000 });
        console.log(`[clickWelcomeBackContinue] ✅ clickRef result: ${JSON.stringify(refRes)}`);
        await new Promise(r => setTimeout(r, 1500));
        const transitioned = await evalJson(tabId, userId, `
          (() => {
            const hasPassword = !!document.querySelector('input[type="password"]');
            const bodyText = (document.body?.innerText || '').toLowerCase();
            const hasWelcomeBack = bodyText.includes('welcome back') || bodyText.includes('choose an account');
            return hasPassword || !hasWelcomeBack;
          })()
        `, 3000).catch(() => false);
        return { ok: true, method: `snapshot-clickref:${continueRef}`, transitioned, needsNativeClick: false };
      } else {
        console.log(`[clickWelcomeBackContinue] ⚠️ No exact "Continue" button ref found in snapshot`);
      }
    } catch (snapErr) {
      console.log(`[clickWelcomeBackContinue] ⚠️ Snapshot clickRef failed: ${snapErr.message}`);
    }

    // Strategy 3: Focus email input first, THEN press Enter (so focus is in the right place)
    try {
      console.log(`[clickWelcomeBackContinue] ⌨️ Focusing email input then pressing Enter...`);
      // Focus the email input first
      await actClick(tabId, userId, {
        selector: 'input[type="email"], input[autocomplete="email"], input[name="username"]',
        timeoutMs: 3000
      }, { timeoutMs: 5000 }).catch(() => {});
      await new Promise(r => setTimeout(r, 300));
      // Now press Enter
      await actPress(tabId, userId, { key: 'Enter' }, { timeoutMs: 5000 });
      await new Promise(r => setTimeout(r, 1500));
      const transitioned = await evalJson(tabId, userId, `
        (() => {
          const hasPassword = !!document.querySelector('input[type="password"]');
          const bodyText = (document.body?.innerText || '').toLowerCase();
          const hasWelcomeBack = bodyText.includes('welcome back') || bodyText.includes('choose an account');
          return hasPassword || !hasWelcomeBack;
        })()
      `, 3000).catch(() => false);
      return { ok: true, method: 'focus-input-press-enter', transitioned, needsNativeClick: false };
    } catch (pressErr) {
      console.log(`[clickWelcomeBackContinue] ⚠️ Focus+Enter failed: ${pressErr.message}`);
    }

    // If all native methods failed, still return ok=true with transitioned=false so caller handles retry
    return { ok: true, method: 'welcome-back-prefilled-email-no-click', transitioned: false, needsNativeClick: false };
  }

  return domResult;
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
      if (loginBtn && isVisible(loginBtn) && !isSocialAuthButton(loginBtn)) results.push('found-by-data-testid');
      else loginBtn = null;
      
      // Ưu tiên 2: Các vùng landing page (UI cũ/backup)
      if (!loginBtn) {
        const landingSelectors = ['[class*="login" i] button', '[class*="auth" i] button', 'header button', 'nav button', '[role="banner"] button'];
        for (const sel of landingSelectors) {
          const candidates = Array.from(document.querySelectorAll(sel)).filter(isVisible).filter(el => !isSocialAuthButton(el));
          loginBtn = candidates.find(el => {
            const t = (el.innerText || el.textContent || '').trim().toLowerCase();
            return t === 'log in' || t === 'login' || t === 'sign in' || t.includes('email') || t.includes('password');
          });
          if (loginBtn) { results.push('found-in-landing-area'); break; }
        }
      }
      
      // Ưu tiên 3: href chứa /auth/login
      if (!loginBtn) {
        const allClickable = Array.from(document.querySelectorAll('button, a, [role="button"]')).filter(isVisible).filter(el => !isSocialAuthButton(el));
        loginBtn = allClickable.find(el => {
          const href = (el.getAttribute('href') || '').toLowerCase();
          return href.includes('/auth/login') || href.includes('/login');
        });
        if (loginBtn) results.push('found-by-href');
      }
      
      // Ưu tiên 4: text match
      if (!loginBtn) {
        const allClickable = Array.from(document.querySelectorAll('button, a, [role="button"]')).filter(isVisible).filter(el => !isSocialAuthButton(el));
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
 * Dismiss Google "Sign in with Google" popup overlay
 * @param {string} tabId - Tab ID
 * @param {string} userId - User ID
 * @returns {Promise<object>} Result object
 */
export async function dismissGooglePopup(tabId, userId) {
  return evalJson(tabId, userId, `
    (() => {
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

      return { ok: results.length > 0, actions: results };
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
    // Dismiss any blocking restricted popup/overlay using Camofox browser-level actions.
    // IMPORTANT: Do NOT remove DOM elements with .remove() — it crashes the React SPA.
    const isRestricted = await evalJson(tabId, userId, `(() => {
      const body = (document.body?.innerText || '').toLowerCase();
      return body.includes("don't have chatgpt") || 
             body.includes("don\u2019t have chatgpt") || 
             body.includes("codex access") ||
             body.includes("back to codex");
    })()`, 3000);

    if (isRestricted) {
      console.log('[selectPersonalWorkspace] Restricted popup detected. Dismissing via Camofox...');
      // Try clicking the X close button via Camofox browser-level click
      try {
        await camofoxPost(`/tabs/${tabId}/click`, { userId, selector: 'button[aria-label*="close" i], button[aria-label*="Close"]' }, { timeoutMs: 3000 });
        console.log('[selectPersonalWorkspace] Clicked close button via Camofox.');
      } catch (_) {
        // If no close button found, try pressing Escape via Camofox
        try {
          await camofoxPost(`/tabs/${tabId}/press`, { userId, key: 'Escape' }, { timeoutMs: 3000 });
          console.log('[selectPersonalWorkspace] Pressed Escape via Camofox.');
        } catch (_2) {
          console.warn('[selectPersonalWorkspace] Could not dismiss popup via close button or Escape.');
        }
      }
      await new Promise(r => setTimeout(r, 2000));
      
      // Check if popup is still visible; if so, unlock pointer-events only (no DOM removal)
      const stillRestricted = await evalJson(tabId, userId, `(() => {
        const body = (document.body?.innerText || '').toLowerCase();
        return body.includes("don't have chatgpt") || body.includes("back to codex");
      })()`, 3000);
      
      if (stillRestricted) {
        console.log('[selectPersonalWorkspace] Popup still visible. Unlocking pointer-events...');
        await evalJson(tabId, userId, `(() => {
          document.body.style.pointerEvents = 'auto';
          document.body.style.overflow = 'auto';
          document.body.removeAttribute('data-scroll-locked');
          document.documentElement.style.pointerEvents = 'auto';
          document.documentElement.style.overflow = 'auto';
        })()`, 3000);
      }
    }
    await new Promise(r => setTimeout(r, 1000));

    // ── Strategy Zero: Camofox Snapshot click on chatgpt.com "Choose a workspace" page ──
    // This page appears after MFA on chatgpt.com (NOT auth.openai.com) and shows rows:
    //   [icon] SeeLLM  >
    //   [icon] Personal account  >
    // The rows are <a> links — JavaScript dispatchEvent doesn't navigate properly.
    // We MUST use Camofox's real browser click (via snapshot ref) to follow the href.
    try {
      const isChooseWorkspacePage = await evalJson(tabId, userId, `(() => {
        const body = (document.body?.innerText || '').toLowerCase();
        const url = location.href.toLowerCase();
        return (body.includes('choose a workspace') || url.includes('/workspaces') || url.includes('workspace/select')) && !document.querySelector('[data-testid="accounts-profile-button"]');
      })()`, 3000).catch(() => false);

      if (isChooseWorkspacePage) {
        console.log('[selectPersonalWorkspace] Strategy Zero: chatgpt.com workspace picker detected, using Camofox snapshot click...');
        const personalKw = MULTILANG.personal;
        let strategyZeroClicked = false;

        let snapshot;
        try {
          snapshot = await getSnapshot(tabId, userId, { timeoutMs: 5000 });
        } catch (e) {
          console.warn('[selectPersonalWorkspace] Strategy Zero: snapshot failed:', e.message);
        }

        if (snapshot?.snapshot) {
          const lines = snapshot.snapshot.split('\n');
          // Find line with "personal" keyword that has a ref (eN) — skip lines with "seellm"/"business"
          let personalRef = null;
          for (const line of lines) {
            const lower = line.toLowerCase();
            if (lower.includes('seellm') || lower.includes('business')) continue;
            const hasPersonal = personalKw.some(k => {
              if (k === 'personal') return lower.includes('personal') && !lower.includes('personalization') && !lower.includes('personalize');
              return lower.includes(k);
            });
            if (hasPersonal) {
              const refMatch = line.match(/\b(e\d+)\b/);
              if (refMatch) {
                personalRef = refMatch[1];
                console.log(`[selectPersonalWorkspace] Strategy Zero: Found personal row ref=${personalRef}: ${line.trim().slice(0, 80)}`);
                break;
              }
            }
          }

          if (personalRef) {
            try {
              await clickRef(tabId, userId, personalRef, { timeoutMs: 8000 });
              console.log(`[selectPersonalWorkspace] Strategy Zero: Clicked ref=${personalRef} via Camofox`);
              strategyZeroClicked = true;
            } catch (e) {
              console.warn('[selectPersonalWorkspace] Strategy Zero: clickRef failed:', e.message);
            }
          } else {
            // Try Camofox selector click on last <a> in main content (Personal account is always last row)
            console.log('[selectPersonalWorkspace] Strategy Zero: No personal ref found in snapshot. Trying Camofox selector...');
            try {
              await camofoxPost(`/tabs/${tabId}/click`, { userId, selector: 'main a:last-of-type, [class*="workspace"] a:last-child, li:last-child a' }, { timeoutMs: 5000 });
              console.log('[selectPersonalWorkspace] Strategy Zero: Clicked via Camofox selector fallback');
              strategyZeroClicked = true;
            } catch (e) {
              console.warn('[selectPersonalWorkspace] Strategy Zero: Camofox selector fallback failed:', e.message);
            }
          }
        }

        if (strategyZeroClicked) {
          await new Promise(r => setTimeout(r, 3000));
          const postUrl = await evalJson(tabId, userId, 'location.href', 3000).catch(() => '');
          const postLower = postUrl.toLowerCase();
          const leftWorkspace = !postLower.includes('/workspace') && !postLower.includes('choose') && !postLower.includes('auth/error');
          if (leftWorkspace) {
            console.log(`[selectPersonalWorkspace] Strategy Zero: Success! URL: ${postUrl}`);
            // Successfully navigated — wait for final redirect and return
            if (waitRedirect) {
              const deadline = Date.now() + timeoutMs;
              const wsIndicators = ['launch a workspace', 'choose a workspace', '/workspace', 'has access to'];
              while (Date.now() < deadline) {
                await new Promise(r => setTimeout(r, 1500));
                const check = await evalJson(tabId, userId, `(() => ({ url: location.href, body: (document.body?.innerText || '').toLowerCase().slice(0, 300) }))()`, 3000).catch(() => ({}));
                const url = check?.url || '';
                const body = check?.body || '';
                const stillOnWs = wsIndicators.some(k => url.toLowerCase().includes(k) || body.includes(k));
                if (!stillOnWs) return { ok: true, clicked: true, strategy: 'camofox_snapshot_row', reason: 'left_workspace_screen', redirectUrl: url };
                if (url.includes('consent') || url.includes('sign-in-with-chatgpt')) return { ok: true, clicked: true, strategy: 'camofox_snapshot_row', reason: 'consent_page', redirectUrl: url };
                if (url.includes('chatgpt.com') && !url.includes('/auth/')) return { ok: true, clicked: true, strategy: 'camofox_snapshot_row', reason: 'chatgpt_home', redirectUrl: url };
              }
            }
            return { ok: true, clicked: true, strategy: 'camofox_snapshot_row', reason: 'click_done', redirectUrl: postUrl };
          } else if (postLower.includes('auth/error')) {
            console.warn(`[selectPersonalWorkspace] Strategy Zero: auth/error after click — falling through to other strategies`);
            // Navigate back to attempt recovery before other strategies run
            try { await navigate(tabId, userId, 'https://chatgpt.com/'); await new Promise(r => setTimeout(r, 3000)); } catch (_) {}
          } else {
            console.warn(`[selectPersonalWorkspace] Strategy Zero: Still on workspace page after click (${postUrl}) — falling through`);
          }
        }
      }
    } catch (e) {
      console.warn('[selectPersonalWorkspace] Strategy Zero exception:', e.message);
    }


    // ── Strategy Pre: Profile Dropdown Switch via Camofox browser-level clicks ──
    // Radix UI menus don't respond to JavaScript dispatchEvent; we must use Camofox's
    // click API which simulates real user clicks through the browser automation layer.
    try {
      // Tự động mở sidebar nếu bị đóng để profile button hiển thị
      await evalJson(tabId, userId, `(() => {
        const showSidebarBtn = document.querySelector('[data-testid="show-sidebar-button"], [aria-label="Show sidebar"], [aria-label="Open sidebar"]');
        if (showSidebarBtn && window.getComputedStyle(showSidebarBtn).display !== 'none') {
          showSidebarBtn.click();
          return true;
        }
        return false;
      })()`, 3000).catch(() => {});
      await new Promise(r => setTimeout(r, 1000));

      // Check if profile button is visible on the current page (dashboard sidebar)
      const hasProfileBtn = await evalJson(tabId, userId, `(() => {
        const btn = document.querySelector('[data-testid="accounts-profile-button"]');
        if (!btn) return false;
        const r = btn.getBoundingClientRect();
        const s = window.getComputedStyle(btn);
        return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
      })()`, 3000);

      if (hasProfileBtn) {
        // Step 1: Click the profile button using Camofox snapshot + ref click
        // There are 2 elements with data-testid="accounts-profile-button" (collapsed + expanded sidebar),
        // so we use snapshot to find the correct ref and click it to avoid strict mode violations.
        console.log('[selectPersonalWorkspace] Strategy Pre: Profile button found, clicking via Camofox snapshot...');
        
        // Take snapshot first to find the profile button ref
        let preSnapshot;
        try {
          preSnapshot = await getSnapshot(tabId, userId, { timeoutMs: 5000 });
        } catch (e) {
          console.warn('[selectPersonalWorkspace] Strategy Pre: Pre-snapshot failed:', e.message);
        }
        
        let profileClicked = false;
        if (preSnapshot?.snapshot) {
          const preLines = preSnapshot.snapshot.split('\n');
          // Look for lines like "[button e15] Open profile menu" or "[button e20] SeeLLM Workspace Business, open profile menu"
          for (const line of preLines) {
            const lower = line.toLowerCase();
            if (lower.includes('open profile menu') || lower.includes('profile menu')) {
              const refMatch = line.match(/\b(e\d+)\b/);
              if (refMatch) {
                try {
                  await clickRef(tabId, userId, refMatch[1], { timeoutMs: 5000 });
                  console.log(`[selectPersonalWorkspace] Strategy Pre: Clicked profile button ref=${refMatch[1]}`);
                  profileClicked = true;
                  break;
                } catch (e) {
                  console.warn(`[selectPersonalWorkspace] Strategy Pre: clickRef(${refMatch[1]}) failed:`, e.message);
                }
              }
            }
          }
        }
        
        if (!profileClicked) {
          // Fallback: try clicking with more specific selector
          try {
            await camofoxPost(`/tabs/${tabId}/click`, { userId, selector: '[data-testid="accounts-profile-button"][aria-label*="open profile menu" i]' }, { timeoutMs: 5000 });
            profileClicked = true;
            console.log('[selectPersonalWorkspace] Strategy Pre: Clicked profile via fallback selector');
          } catch (e) {
            console.warn('[selectPersonalWorkspace] Strategy Pre: Fallback profile click also failed:', e.message);
          }
        }
        await new Promise(r => setTimeout(r, 2500));

        // Step 2: Take a snapshot to find menu items
        let snapshot;
        try {
          snapshot = await getSnapshot(tabId, userId, { timeoutMs: 5000 });
        } catch (e) {
          console.warn('[selectPersonalWorkspace] Strategy Pre: Snapshot failed:', e.message);
        }

        if (snapshot?.snapshot) {
          const snapshotText = snapshot.snapshot;
          const lines = snapshotText.split('\n');
          const personalKw = MULTILANG.personal;
          
          // Step 2a: Look for a menu item with "personal" keyword directly in the first dropdown
          let personalRef = null;
          for (const line of lines) {
            const lower = line.toLowerCase();
            const refMatch = line.match(/\b(e\d+)\b/);
            if (!refMatch) continue;
            
            const hasPersonalKw = personalKw.some(k => {
              if (k === 'personal') {
                return lower.includes('personal') && !lower.includes('personalization') && !lower.includes('personalize');
              }
              if (k === 'personnel') {
                return lower.includes('personnel') && !lower.includes('personnalisation') && !lower.includes('personnaliser');
              }
              return lower.includes(k);
            });
            if (hasPersonalKw) {
              const isProfileBtn = lower.includes('open profile menu') || lower.includes('accounts-profile');
              if (!isProfileBtn) {
                personalRef = refMatch[1];
                console.log(`[selectPersonalWorkspace] Strategy Pre: Found personal item ref=${personalRef} directly in first dropdown: ${line.trim().slice(0, 80)}`);
                break;
              }
            }
          }

          // Step 2b: If NOT found directly, we need to click the active workspace item to open the workspace submenu
          if (!personalRef) {
            console.log('[selectPersonalWorkspace] Strategy Pre: "Personal" not directly in dropdown. Searching for active workspace submenu trigger...');
            let workspaceSwitcherRef = null;
            for (const line of lines) {
              const lower = line.toLowerCase();
              if (lower.includes('menuitem') && 
                  (lower.includes('seellm') || lower.includes('business') || (lower.includes('workspace') && !lower.includes('settings')))) {
                const refMatch = line.match(/\b(e\d+)\b/);
                if (refMatch) {
                  workspaceSwitcherRef = refMatch[1];
                  console.log(`[selectPersonalWorkspace] Strategy Pre: Found active workspace trigger ref=${workspaceSwitcherRef} in line: ${line.trim().slice(0, 80)}`);
                  break;
                }
              }
            }

            if (workspaceSwitcherRef) {
              try {
                console.log(`[selectPersonalWorkspace] Strategy Pre: Expanding workspace submenu by clicking ref=${workspaceSwitcherRef}...`);
                await clickRef(tabId, userId, workspaceSwitcherRef, { timeoutMs: 5000 });
                await new Promise(r => setTimeout(r, 2000));

                // Take a new snapshot of the sub-menu
                const subSnapshot = await getSnapshot(tabId, userId, { timeoutMs: 5000 });
                if (subSnapshot?.snapshot) {
                  const subLines = subSnapshot.snapshot.split('\n');
                  
                  // Pass 1: Match explicit personal keywords in the sub-menu
                  for (const line of subLines) {
                    const lower = line.toLowerCase();
                    if (lower.includes('menuitemradio')) {
                      const hasPersonalKw = personalKw.some(k => {
                        if (k === 'personal') {
                          return lower.includes('personal') && !lower.includes('personalization') && !lower.includes('personalize');
                        }
                        return lower.includes(k);
                      });
                      if (hasPersonalKw) {
                        const refMatch = line.match(/\b(e\d+)\b/);
                        if (refMatch) {
                          personalRef = refMatch[1];
                          console.log(`[selectPersonalWorkspace] Strategy Pre: Found personal item ref=${personalRef} in submenu by keyword: ${line.trim().slice(0, 80)}`);
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
                          console.log(`[selectPersonalWorkspace] Strategy Pre: Found personal item ref=${personalRef} in submenu by non-checked fallback: ${line.trim().slice(0, 80)}`);
                          break;
                        }
                      }
                    }
                  }

                  // Pass 3: DOM evaluation fallback click (since menuitemradio options lack refs in snapshot)
                  if (!personalRef) {
                    console.log('[selectPersonalWorkspace] Strategy Pre: Submenu refs not found in snapshot. Attempting DOM evaluation click...');
                    const domClickResult = await evalJson(tabId, userId, `(() => {
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
                      console.log(`[selectPersonalWorkspace] Strategy Pre: Clicked personal workspace in DOM: ${domClickResult.text}`);
                      personalRef = 'dom_evaluated_click';
                    } else {
                      console.warn('[selectPersonalWorkspace] Strategy Pre: DOM evaluation click did not find target.');
                    }
                  }
                }
              } catch (e) {
                console.warn('[selectPersonalWorkspace] Strategy Pre: Submenu traversal failed:', e.message);
              }
            }
          }

          if (personalRef) {
            // Click the personal workspace item via Camofox ref click
            try {
              if (personalRef !== 'dom_evaluated_click') {
                await clickRef(tabId, userId, personalRef, { timeoutMs: 5000 });
                console.log(`[selectPersonalWorkspace] Strategy Pre: Clicked personal ref=${personalRef} via Camofox API`);
              } else {
                console.log('[selectPersonalWorkspace] Strategy Pre: Workspace already clicked via DOM evaluation.');
              }
              // Don't return yet — fall through to the waitRedirect logic at the bottom
              // We'll skip the evalJson strategies since we already clicked
              await new Promise(r => setTimeout(r, 3000));
              
              // Check if we successfully left the restricted workspace
              const postClickUrl = await evalJson(tabId, userId, 'location.href', 3000) || '';
              if (postClickUrl.includes('chatgpt.com') && !postClickUrl.includes('/workspace')) {
                // Verify sidebar now shows Personal instead of Business
                const sidebarCheck = await evalJson(tabId, userId, `(() => {
                  const profileBtn = document.querySelector('[data-testid="accounts-profile-button"]');
                  return profileBtn ? (profileBtn.textContent || '').trim().slice(0, 80) : '';
                })()`, 3000) || '';
                
                const lowerSidebar = sidebarCheck.toLowerCase();
                const isStillBusiness = lowerSidebar.includes('business') || lowerSidebar.includes('seellm');
                
                if (!isStillBusiness) {
                  return { ok: true, clicked: true, strategy: 'camofox_profile_dropdown', text: sidebarCheck };
                }
                console.log(`[selectPersonalWorkspace] Strategy Pre: Still on business workspace after click. Sidebar: ${sidebarCheck}`);
              }
            } catch (e) {
              console.warn('[selectPersonalWorkspace] Strategy Pre: clickRef failed:', e.message);
            }
          } else {
            console.log('[selectPersonalWorkspace] Strategy Pre: No personal item found in snapshot. Dismissing menu...');
            // Press Escape to close the dropdown before falling through to workspace page strategies
            try {
              await camofoxPost(`/tabs/${tabId}/click`, { userId, selector: 'body' }, { timeoutMs: 3000 });
            } catch (_) {}
            await new Promise(r => setTimeout(r, 500));
          }
        }
      }
    } catch (e) {
      console.warn('[selectPersonalWorkspace] Strategy Pre exception:', e.message);
    }


    const result = await evalJson(tabId, userId, `
      (async () => {
        const personalKeywords = ${JSON.stringify(MULTILANG.personal)};
        const isVisible = el => {
          if (!el) return false;
          const r = el.getBoundingClientRect();
          const s = window.getComputedStyle(el);
          return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
        };

        // ── Strategy Pre is handled OUTSIDE evalJson (uses Camofox click API) ──
        // See the camofox-based profile dropdown code block above this evalJson call.


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
              // Stop at the first ancestor containing the keyword (which is the smallest matching row)
              bestMatch = { btn, container };
              break;
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
              openBtn.focus();
              openBtn.click();
              openBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
              openBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
              openBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
              return { ok: true, clicked: true, strategy: 'label_then_open_btn', text: cText.trim().slice(0, 80) };
            }
            container = container.parentElement;
          }
        }

        // ── Strategy D: Find button containing "personal" keywords in its own text (must not be a container wrapping other buttons)
        const personalBtn = allBtns.find(el => {
          const text = (el.textContent || '').toLowerCase();
          const isContainer = el.querySelector('button, [role="button"], a');
          return !isContainer && personalKeywords.some(k => text.includes(k)) && !text.includes('business') && !text.includes('seellm');
        });
        if (personalBtn) {
          const targetClick = personalBtn.tagName === 'BUTTON' ? personalBtn : (personalBtn.querySelector('button') || personalBtn);
          targetClick.focus();
          targetClick.click();
          targetClick.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          targetClick.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
          targetClick.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
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
