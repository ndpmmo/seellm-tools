/**
 * Probe sau khi login để kiểm tra:
 * 1. MFA setup screen
 * 2. Session token
 * 
 * Sử dụng account từ test trước (đã đăng ký thành công đến bước home)
 */
import { CAMOUFOX_API, WORKER_AUTH_TOKEN } from '../config.js';
import { camofoxPost, evalJson } from '../lib/camofox.js';

async function camofoxPostWithSessionKey(endpoint, body, timeoutMs = 30000) {
  const payload = { ...body, sessionKey: WORKER_AUTH_TOKEN };
  return camofoxPost(endpoint, payload, { timeoutMs });
}

const USER_ID = `probe_after_login_${Date.now()}`;

async function run() {
  console.log('Creating tab...');
  const tabRes = await camofoxPostWithSessionKey('/tabs', {
    userId: USER_ID,
    url: 'https://chatgpt.com',
    headless: false,
    humanize: true,
  });
  const tabId = tabRes.tabId;
  console.log(`Tab ID: ${tabId}`);

  await new Promise(r => setTimeout(r, 5000));

  // Check if already logged in
  console.log('\n========== CHECK LOGIN STATUS ==========');
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

  console.log(`Login status:`, JSON.stringify(loginStatus, null, 2));

  if (!loginStatus.isLoggedIn) {
    console.log('\nNot logged in. Please login manually and press Enter to continue...');
    await new Promise(resolve => {
      process.stdin.once('data', resolve);
    });
    await new Promise(r => setTimeout(r, 3000));
  }

  // 1. Check cookies after login
  console.log('\n========== 1. CHECK COOKIES AFTER LOGIN ==========');
  try {
    const cookieRes = await fetch(`${CAMOUFOX_API}/tabs/${tabId}/cookies?userId=${USER_ID}`);
    const cookieData = await cookieRes.json();
    const cookies = Array.isArray(cookieData.cookies) ? cookieData.cookies : (Array.isArray(cookieData) ? cookieData : []);

    console.log(`Total cookies: ${cookies.length}`);
    const sessionToken = cookies.find(c => c.name === '__Secure-next-auth.session-token');
    console.log(`Session token found: ${!!sessionToken}`);
    if (sessionToken) {
      console.log(`Session token value length: ${sessionToken.value?.length || 0}`);
      console.log(`Session token preview: ${sessionToken.value ? sessionToken.value.slice(0, 50) + '...' : 'EMPTY'}`);
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

  // 2. Navigate to Security settings
  console.log('\n========== 2. NAVIGATE TO SECURITY SETTINGS ==========');
  await evalJson(tabId, USER_ID, `window.location.href = 'https://chatgpt.com/#settings/Security'`);
  await new Promise(r => setTimeout(r, 5000));

  const securityPage = await evalJson(tabId, USER_ID, `
    (() => {
      const url = location.href;
      const body = (document.body?.innerText || '').slice(0, 1000);

      // Find all elements with security-related text
      const securityKeywords = ['authenticator', '2fa', 'two-factor', 'mfa', 'security', 'verification'];
      const relevantElements = Array.from(document.querySelectorAll('*')).filter(el => {
        const text = (el.innerText || el.textContent || '').toLowerCase();
        return securityKeywords.some(kw => text.includes(kw)) && el.getBoundingClientRect().width > 0;
      }).slice(0, 20).map(el => ({
        tagName: el.tagName,
        text: (el.innerText || el.textContent || '').trim().slice(0, 80),
        id: el.id,
        className: el.className,
        role: el.getAttribute('role'),
        type: el.getAttribute('type'),
        dataTestId: el.getAttribute('data-testid'),
      }));

      // Find all switches/toggles
      const toggles = Array.from(document.querySelectorAll('button[role="switch"], [role="switch"]')).map(el => ({
        text: (el.parentElement?.innerText || el.innerText || '').trim().slice(0, 80),
        checked: el.getAttribute('aria-checked') === 'true',
        id: el.id,
        className: el.className,
      }));

      return { url, body: body.slice(0, 300), relevantElements, toggles };
    })()
  `, 5000);

  console.log(`URL: ${securityPage.url}`);
  console.log(`Body preview: ${securityPage.body}`);
  console.log(`\n--- Security-related Elements ---`);
  securityPage.relevantElements.forEach((el, i) => {
    console.log(`[${i}] ${el.tagName}: "${el.text}" id="${el.id}" class="${el.className}" role="${el.role}"`);
  });
  console.log(`\n--- Toggles ---`);
  securityPage.toggles.forEach((t, i) => {
    console.log(`[${i}] "${t.text}" checked=${t.checked}`);
  });

  // 3. Try to find MFA toggle more aggressively
  console.log('\n========== 3. AGGRESSIVE MFA TOGGLE SEARCH ==========');
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
        if (node.textContent.trim().toLowerCase() === 'authenticator app') {
          authAppNode = node;
          break;
        }
      }

      if (!authAppNode) {
        // Try case-insensitive partial match
        walker.currentNode = document.body;
        while (node = walker.nextNode()) {
          if (node.textContent.toLowerCase().includes('authenticator')) {
            authAppNode = node;
            break;
          }
        }
      }

      if (!authAppNode) {
        return { found: false, error: 'no-authenticator-text' };
      }

      // Get parent element
      let parent = authAppNode.parentElement;
      for (let i = 0; i < 10 && parent; i++) {
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
              className: switchEl.className,
              id: switchEl.id,
              parentText: parent.innerText.trim().slice(0, 100),
            }
          };
        }
        parent = parent.parentElement;
      }

      return { found: false, error: 'no-switch-near-authenticator-text', textFound: true };
    })()
  `, 5000);

  console.log(`MFA search result:`, JSON.stringify(mfaSearch, null, 2));

  await camofoxPostWithSessionKey(`/tabs/${tabId}?userId=${USER_ID}`, {}, 3000).catch(() => {});
}

run().then(() => console.log('\nDone')).catch(err => console.error('Error:', err));
