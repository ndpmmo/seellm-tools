/**
 * Probe script để kiểm tra:
 * 1. MFA setup screen UI hiện tại
 * 2. Cookie/session token extraction
 */
import { CAMOUFOX_API, WORKER_AUTH_TOKEN } from '../config.js';
import { camofoxPost, evalJson } from '../lib/camofox.js';

async function camofoxPostWithSessionKey(endpoint, body, timeoutMs = 30000) {
  const payload = { ...body, sessionKey: WORKER_AUTH_TOKEN };
  return camofoxPost(endpoint, payload, { timeoutMs });
}

const USER_ID = `probe_mfa_${Date.now()}`;

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

  // 1. Check Security settings page
  console.log('\n========== 1. NAVIGATE TO SECURITY SETTINGS ==========');
  await evalJson(tabId, USER_ID, `window.location.href = 'https://chatgpt.com/#settings/Security'`);
  await new Promise(r => setTimeout(r, 5000));

  const securityPage = await evalJson(tabId, USER_ID, `
    (() => {
      const url = location.href;
      const body = (document.body?.innerText || '').slice(0, 800);

      // Find all elements with "Authenticator" or "2FA" or "MFA" text
      const allElements = Array.from(document.querySelectorAll('*')).filter(el => {
        const text = (el.innerText || el.textContent || '').toLowerCase();
        return (text.includes('authenticator') || text.includes('2fa') || text.includes('two-factor') || text.includes('mfa')) &&
               el.getBoundingClientRect().width > 0;
      });

      const authenticatorElements = allElements.slice(0, 15).map(el => ({
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
        text: (el.innerText || el.textContent || '').trim().slice(0, 50),
        checked: el.getAttribute('aria-checked') === 'true',
        id: el.id,
        className: el.className,
      }));

      // Find all buttons
      const buttons = Array.from(document.querySelectorAll('button')).slice(0, 20).map(btn => ({
        text: (btn.innerText || btn.textContent || '').trim().slice(0, 50),
        id: btn.id,
        className: btn.className,
        dataTestId: btn.getAttribute('data-testid'),
        type: btn.type,
      }));

      return { url, body, authenticatorElements, toggles, buttons };
    })()
  `, 5000);

  console.log(`URL: ${securityPage.url}`);
  console.log(`\n--- Authenticator Elements ---`);
  securityPage.authenticatorElements.forEach((el, i) => {
    console.log(`[${i}] ${el.tagName}: "${el.text}" id="${el.id}" class="${el.className}" data-testid="${el.dataTestId}"`);
  });
  console.log(`\n--- Toggles ---`);
  securityPage.toggles.forEach((t, i) => {
    console.log(`[${i}] "${t.text}" checked=${t.checked} id="${t.id}"`);
  });
  console.log(`\n--- Buttons (first 20) ---`);
  securityPage.buttons.forEach((b, i) => {
    console.log(`[${i}] "${b.text}" type="${b.type}" data-testid="${b.dataTestId}"`);
  });

  // 2. Check cookies
  console.log('\n========== 2. CHECK COOKIES ==========');
  try {
    const cookieRes = await fetch(`${CAMOUFOX_API}/tabs/${tabId}/cookies?userId=${USER_ID}`);
    const cookieData = await cookieRes.json();
    const cookies = Array.isArray(cookieData.cookies) ? cookieData.cookies : (Array.isArray(cookieData) ? cookieData : []);

    console.log(`Total cookies: ${cookies.length}`);
    const sessionToken = cookies.find(c => c.name === '__Secure-next-auth.session-token');
    console.log(`Session token found: ${!!sessionToken}`);
    if (sessionToken) {
      console.log(`Session token value: ${sessionToken.value ? sessionToken.value.slice(0, 50) + '...' : 'EMPTY'}`);
    }

    const relevantCookies = cookies.filter(c =>
      c.name.includes('session') ||
      c.name.includes('auth') ||
      c.name.includes('token') ||
      c.name.includes('oai-')
    );
    console.log(`\n--- Relevant Cookies ---`);
    relevantCookies.forEach(c => {
      console.log(`${c.name}: ${c.value ? c.value.slice(0, 30) + '...' : 'EMPTY'}`);
    });
  } catch (err) {
    console.log(`Cookie check failed: ${err.message}`);
  }

  // 3. Try to find MFA toggle by searching for "Authenticator app" text and finding nearest switch
  console.log('\n========== 3. TRY TO FIND MFA TOGGLE ==========');
  const toggleSearch = await evalJson(tabId, USER_ID, `
    (() => {
      // Find element with "Authenticator app" text
      const allTextNodes = Array.from(document.querySelectorAll('*'));
      let targetElement = null;
      for (const el of allTextNodes) {
        const text = (el.innerText || el.textContent || '').trim();
        if (text === 'Authenticator app' || text.toLowerCase() === 'authenticator app') {
          targetElement = el;
          break;
        }
      }

      if (!targetElement) {
        return { found: false, error: 'no-authenticator-app-text' };
      }

      // Search for switch nearby (within 8 parent levels)
      let current = targetElement;
      for (let i = 0; i < 8; i++) {
        if (!current.parentElement) break;
        current = current.parentElement;
        const switchEl = current.querySelector('button[role="switch"], [role="switch"]');
        if (switchEl) {
          return {
            found: true,
            method: 'parent-search',
            levels: i + 1,
            switchInfo: {
              tagName: switchEl.tagName,
              ariaChecked: switchEl.getAttribute('aria-checked'),
              className: switchEl.className,
              id: switchEl.id,
            }
          };
        }
      }

      // Fallback: search entire document for switches
      const allSwitches = Array.from(document.querySelectorAll('button[role="switch"], [role="switch"]'));
      return {
        found: false,
        error: 'no-switch-nearby',
        authenticatorTextFound: true,
        totalSwitches: allSwitches.length,
        switchesInfo: allSwitches.map(s => ({
          text: (s.parentElement?.innerText || '').trim().slice(0, 50),
          ariaChecked: s.getAttribute('aria-checked'),
        }))
      };
    })()
  `, 5000);

  console.log(`Toggle search result:`, JSON.stringify(toggleSearch, null, 2));

  await camofoxPostWithSessionKey(`/tabs/${tabId}?userId=${USER_ID}`, {}, 3000).catch(() => {});
}

run().then(() => console.log('\nDone')).catch(err => console.error('Error:', err));
