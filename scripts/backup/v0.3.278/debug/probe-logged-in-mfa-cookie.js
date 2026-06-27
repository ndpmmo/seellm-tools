/**
 * Login với tài khoản đã cung cấp và kiểm tra:
 * 1. MFA setup screen
 * 2. Cookie/session token
 */
import { WORKER_AUTH_TOKEN } from '../config.js';
import { getTOTP } from '../lib/totp.js';

const CAMOUFOX_API = 'http://localhost:9377';

async function camofoxPost(endpoint, body, { timeoutMs = 30000 } = {}) {
  const payload = { ...body, sessionKey: WORKER_AUTH_TOKEN };
  const res = await fetch(`${CAMOUFOX_API}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Camofox ${endpoint} → ${res.status}: ${await res.text()}`);
  return res.json();
}

async function evalJson(tabId, userId, js, timeoutMs = 5000) {
  const res = await fetch(`${CAMOUFOX_API}/tabs/${tabId}/evaluate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, sessionKey: WORKER_AUTH_TOKEN, expression: js }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Camofox evaluate → ${res.status}: ${await res.text()}`);
  return res.json();
}

const EMAIL = 'kelseybellamymaris8671@hotmail.com';
const PASSWORD = '3om%5v*sTmzav70N';
const SECRET = '4EP4GNVY7ARQSJY7H6LP6DIGFTV7XFMI';

const USER_ID = `probe_logged_${Date.now()}`;

async function run() {
  console.log('Creating tab...');
  const tabRes = await camofoxPost('/tabs', {
    userId: USER_ID,
    url: 'https://chatgpt.com/auth/login',
    headless: false,
    humanize: true,
  });
  const tabId = tabRes.tabId;
  console.log(`Tab ID: ${tabId}`);

  await new Promise(r => setTimeout(r, 5000));

  // 1. Login
  console.log('\n========== 1. LOGIN ==========');
  const loginResult = await evalJson(tabId, USER_ID, `
    (() => {
      const typeReact = (el, text) => {
        if (!el) return false;
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        nativeSetter.call(el, text);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      };
      const isVisible = el => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };

      // Click Sign up để chuyển sang form signup/login
      const signupBtn = document.querySelector('button[data-testid="signup-button"]');
      if (signupBtn) {
        signupBtn.click();
      }

      return { clickedSignup: !!signupBtn };
    })()
  `, 5000);

  console.log(`Clicked signup:`, loginResult);
  await new Promise(r => setTimeout(r, 3000));

  // Điền email
  const emailFill = await evalJson(tabId, USER_ID, `
    (() => {
      const typeReact = (el, text) => {
        if (!el) return false;
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        nativeSetter.call(el, text);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      };
      const emailInput = document.querySelector('input[type="email"], input[name="email"]');
      if (!emailInput) return { error: 'no-email-input' };
      typeReact(emailInput, "${EMAIL}");
      return { ok: true };
    })()
  `, 5000);

  console.log(`Email fill:`, emailFill);
  await new Promise(r => setTimeout(r, 1000));

  // Click Continue
  await evalJson(tabId, USER_ID, `
    (() => {
      const isVisible = el => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const btn = Array.from(document.querySelectorAll('button')).find(b => {
        const t = (b.innerText || b.textContent || '').toLowerCase();
        return !t.includes('with') && t === 'continue';
      });
      if (btn) btn.click();
      return { clicked: !!btn };
    })()
  `, 5000);

  await new Promise(r => setTimeout(r, 5000));

  // Điền password
  const pwdFill = await evalJson(tabId, USER_ID, `
    (() => {
      const typeReact = (el, text) => {
        if (!el) return false;
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        nativeSetter.call(el, text);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      };
      const pwdInput = document.querySelector('input[type="password"], input[name="password"]');
      if (!pwdInput) return { error: 'no-password-input' };
      typeReact(pwdInput, "${PASSWORD}");
      return { ok: true };
    })()
  `, 5000);

  console.log(`Password fill:`, pwdFill);
  await new Promise(r => setTimeout(r, 1000));

  // Click Continue
  await evalJson(tabId, USER_ID, `
    (() => {
      const isVisible = el => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const btn = Array.from(document.querySelectorAll('button')).find(b => {
        const t = (b.innerText || b.textContent || '').toLowerCase();
        return !t.includes('with') && t === 'continue';
      });
      if (btn) btn.click();
      return { clicked: !!btn };
    })()
  `, 5000);

  await new Promise(r => setTimeout(r, 5000));

  // Check if MFA needed
  const mfaCheck = await evalJson(tabId, USER_ID, `
    (() => {
      const hasMfaInput = !!document.querySelector('input[name="code"], input[autocomplete="one-time-code"]');
      const url = location.href;
      return { hasMfaInput, url };
    })()
  `, 5000);

  console.log(`MFA check:`, mfaCheck);
  const mfaData = mfaCheck.ok ? mfaCheck.result : mfaCheck;

  if (mfaData.hasMfaInput) {
    // Generate TOTP
    const totpCode = getTOTP(SECRET);
    console.log(`Generated TOTP: ${totpCode}`);

    const mfaFill = await evalJson(tabId, USER_ID, `
      (() => {
        const typeReact = (el, text) => {
          if (!el) return false;
          const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          nativeSetter.call(el, text);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        };
        const mfaInput = document.querySelector('input[name="code"], input[autocomplete="one-time-code"]');
        if (!mfaInput) return { error: 'no-mfa-input' };
        typeReact(mfaInput, "${totpCode}");
        return { ok: true };
      })()
    `, 5000);

    console.log(`MFA fill:`, mfaFill);
    await new Promise(r => setTimeout(r, 1000));

    // Click Continue
    await evalJson(tabId, USER_ID, `
      (() => {
        const btn = Array.from(document.querySelectorAll('button')).find(b => {
          const t = (b.innerText || b.textContent || '').toLowerCase();
          return !t.includes('with') && t === 'continue';
        });
        if (btn) btn.click();
        return { clicked: !!btn };
      })()
    `, 5000);

    await new Promise(r => setTimeout(r, 5000));
  }

  // 2. Check login status
  console.log('\n========== 2. CHECK LOGIN STATUS ==========');
  await new Promise(r => setTimeout(r, 3000));
  const loginStatus = await evalJson(tabId, USER_ID, `
    (() => {
      const url = location.href;
      const body = (document.body?.innerText || '').toLowerCase();
      const hasProfileBtn = !!document.querySelector('[data-testid="profile-button"], [data-testid="user-menu-button"], [aria-label="Open user menu"]');
      const hasLogInBtn = body.includes('log in');
      const hasNewChat = body.includes('new chat');

      return {
        url,
        hasProfileBtn,
        hasLogInBtn,
        hasNewChat,
        isLoggedIn: hasProfileBtn || (hasNewChat && !hasLogInBtn)
      };
    })()
  `, 5000);

  const loginData = loginStatus.ok ? loginStatus.result : loginStatus;
  console.log(`Login status:`, JSON.stringify(loginData, null, 2));

  if (!loginData.isLoggedIn) {
    console.log('Login failed. Please check manually...');
    await new Promise(resolve => setTimeout(resolve, 10000));
  }

  // 3. Check cookies
  console.log('\n========== 3. CHECK COOKIES ==========');
  try {
    const cookieRes = await fetch(`${CAMOUFOX_API}/tabs/${tabId}/cookies?userId=${USER_ID}`);
    const cookieData = await cookieRes.json();
    const cookies = Array.isArray(cookieData.cookies) ? cookieData.cookies : (Array.isArray(cookieData) ? cookieData : []);

    console.log(`Total cookies: ${cookies.length}`);
    const sessionToken = cookies.find(c => c.name === '__Secure-next-auth.session-token');
    console.log(`Session token found: ${!!sessionToken}`);
    if (sessionToken) {
      console.log(`Session token value length: ${sessionToken.value?.length || 0}`);
    }

    const allCookies = cookies.map(c => ({
      name: c.name,
      value: c.value ? c.value.slice(0, 30) + '...' : 'EMPTY',
      domain: c.domain,
    }));
    console.log(`\n--- All Cookies ---`);
    allCookies.forEach(c => {
      console.log(`${c.name}: ${c.value} (domain: ${c.domain})`);
    });
  } catch (err) {
    console.log(`Cookie check failed: ${err.message}`);
  }

  // 4. Navigate to Security settings
  console.log('\n========== 4. NAVIGATE TO SECURITY SETTINGS ==========');
  await evalJson(tabId, USER_ID, `window.location.href = 'https://chatgpt.com/#settings/Security'`);
  await new Promise(r => setTimeout(r, 5000));

  // Click security-tab (theo cách cũ)
  const secTabClick = await evalJson(tabId, USER_ID, `
    (() => {
      const sec = document.querySelector('[data-testid="security-tab"]');
      if (sec) {
        sec.click();
        return { clicked: true };
      }
      return { clicked: false, error: 'security-tab-not-found' };
    })()
  `, 5000);

  console.log(`Security tab click:`, JSON.stringify(secTabClick));
  await new Promise(r => setTimeout(r, 3000));

  const securityPage = await evalJson(tabId, USER_ID, `
    (() => {
      const url = location.href;
      const body = (document.body?.innerText || '').slice(0, 1000);

      // Find all elements with security-related text
      const securityKeywords = ['authenticator', '2fa', 'two-factor', 'mfa', 'security', 'verification'];
      const relevantElements = Array.from(document.querySelectorAll('*')).filter(el => {
        const text = (el.innerText || el.textContent || '').toLowerCase();
        return securityKeywords.some(kw => text.includes(kw)) && el.getBoundingClientRect().width > 0;
      }).slice(0, 30).map(el => ({
        tagName: el.tagName,
        text: (el.innerText || el.textContent || '').trim().slice(0, 80),
        id: el.id,
        className: el.className,
        role: el.getAttribute('role'),
        type: el.getAttribute('type'),
      }));

      // Find all switches/toggles
      const toggles = Array.from(document.querySelectorAll('button[role="switch"], [role="switch"], input[type="checkbox"]')).map(el => ({
        text: (el.parentElement?.innerText || el.innerText || '').trim().slice(0, 100),
        checked: el.getAttribute('aria-checked') === 'true' || el.checked,
        id: el.id,
        className: el.className,
        tagName: el.tagName,
      }));

      return { url, body: body.slice(0, 300), relevantElements, toggles };
    })()
  `, 5000);

  const securityData = securityPage.ok ? securityPage.result : securityPage;
  console.log(`URL: ${securityData.url}`);
  console.log(`Body preview: ${securityData.body}`);
  console.log(`\n--- Security-related Elements ---`);
  securityData.relevantElements.forEach((el, i) => {
    console.log(`[${i}] ${el.tagName}: "${el.text}" id="${el.id}" class="${el.className}" role="${el.role}"`);
  });
  console.log(`\n--- Toggles ---`);
  securityData.toggles.forEach((t, i) => {
    console.log(`[${i}] ${t.tagName}: "${t.text}" checked=${t.checked}`);
  });

  // 5. Try to find MFA toggle more aggressively
  console.log('\n========== 5. AGGRESSIVE MFA TOGGLE SEARCH ==========');
  const mfaSearch = await evalJson(tabId, USER_ID, `
    (() => {
      // Find text "Authenticator app" anywhere
      const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT,
        null,
        false
      );

      let authAppNode = null;
      let node;
      while (node = walker.nextNode()) {
        const text = node.textContent.trim().toLowerCase();
        if (text === 'authenticator app' || text === 'authenticator') {
          authAppNode = node;
          break;
        }
      }

      if (!authAppNode) {
        return { found: false, error: 'no-authenticator-text' };
      }

      // Get parent element and search for switch
      let parent = authAppNode.parentElement;
      for (let i = 0; i < 15 && parent; i++) {
        const switchEl = parent.querySelector('button[role="switch"], [role="switch"], input[type="checkbox"]');
        if (switchEl) {
          return {
            found: true,
            method: 'tree-walker',
            levels: i,
            switchInfo: {
              tagName: switchEl.tagName,
              type: switchEl.type,
              ariaChecked: switchEl.getAttribute('aria-checked'),
              checked: switchEl.checked,
              className: switchEl.className,
              id: switchEl.id,
              parentText: parent.innerText.trim().slice(0, 150),
              parentHTML: parent.outerHTML.slice(0, 500),
            }
          };
        }
        parent = parent.parentElement;
      }

      return { found: false, error: 'no-switch-near-authenticator-text', textFound: true };
    })()
  `, 5000);

  const mfaSearchData = mfaSearch.ok ? mfaSearch.result : mfaSearch;
  console.log(`MFA search result:`, JSON.stringify(mfaSearchData, null, 2));

  await camofoxPost(`/tabs/${tabId}?userId=${USER_ID}`, {}, 3000).catch(() => {});
}

run().then(() => console.log('\nDone')).catch(err => console.error('Error:', err));
