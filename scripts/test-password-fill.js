import { CAMOUFOX_API } from './config.js';
import { camofoxPost, camofoxDelete, evalJson, pressKey } from './lib/camofox.js';
import { fillEmail } from './lib/openai-login-flow.js';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const USER_ID = `test_bypass_${Date.now()}`;
const TEST_EMAIL = `test_bypass_${Date.now()}@outlook.com`;
const TEST_PASSWORD = 'TestPassword123!';

async function saveScreenshot(tabId, name) {
  try {
    const res = await fetch(`${CAMOUFOX_API}/tabs/${tabId}/screenshot?userId=${USER_ID}`);
    if (res.ok) {
      const buffer = await res.arrayBuffer();
      const dir = './data/screenshots/test_fill';
      mkdirSync(dir, { recursive: true });
      const filePath = join(dir, name);
      writeFileSync(filePath, Buffer.from(buffer));
      console.log(`📸 Saved screenshot to: ${filePath}`);
    }
  } catch (e) {
    console.log(`❌ Error saving screenshot: ${e.message}`);
  }
}

async function run() {
  console.log(`🚀 Starting form submission interceptor bypass test...`);
  let tabId = null;
  try {
    const opened = await camofoxPost('/tabs', {
      userId: USER_ID,
      sessionKey: `test_bypass_${Date.now()}`,
      url: 'https://chatgpt.com/auth/login',
      persistent: false,
      humanize: true,
      headless: false,
    }, { timeoutMs: 25000 });
    tabId = opened.tabId;

    await new Promise(r => setTimeout(r, 6000));
    await fillEmail(tabId, USER_ID, TEST_EMAIL);
    await pressKey(tabId, USER_ID, 'Enter');
    await new Promise(r => setTimeout(r, 6000));

    const currentUrl = await evalJson(tabId, USER_ID, 'location.href');
    if (currentUrl.includes('email-verification')) {
      await evalJson(tabId, USER_ID, `
        const link = document.querySelector('a[href*="create-account/password"]');
        if (link) link.click();
      `);
      await new Promise(r => setTimeout(r, 6000));
    }

    const isOnPasswordPage = await evalJson(tabId, USER_ID, `
      !!document.querySelector('input[type="password"], input[name="password"], input[name="new-password"], input[autocomplete="new-password"]')
    `);
    if (!isOnPasswordPage) {
      console.log('❌ Error: Did not land on password page!');
      return;
    }

    // Set non-reload flag
    await evalJson(tabId, USER_ID, 'window.__hasNotReloaded = true;');

    // Fill password using typeReact DOM method
    console.log('Filling password...');
    await evalJson(tabId, USER_ID, `
      (() => {
        const typeReact = (input, text) => {
          if (!input) return false;
          const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          nativeSetter.call(input, text);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        };
        const pwdInput = document.querySelector('input[name="new-password"], input[name="password"], input[type="password"], input[autocomplete="new-password"]');
        if (!pwdInput) return;
        typeReact(pwdInput, "${TEST_PASSWORD}");
      })()
    `);

    // Click Continue to fire the submit event
    console.log('Clicking Continue button to trigger submit listener...');
    const clickRes = await evalJson(tabId, USER_ID, `
      (() => {
        const btn = document.querySelector('button[type="submit"]');
        if (btn) {
          btn.click();
          return { ok: true, clicked: true };
        }
        return { ok: false, reason: 'no-submit-btn' };
      })()
    `);
    console.log('Click Response:', JSON.stringify(clickRes));

    await new Promise(r => setTimeout(r, 1000));

    // Check if window.__submitPendingForm is defined, and trigger it
    console.log('Checking for window.__submitPendingForm...');
    const checkBypass = await evalJson(tabId, USER_ID, `
      (() => {
        const hasBypass = typeof window.__submitPendingForm === 'function';
        if (hasBypass) {
          window.__submitPendingForm();
          return { ok: true, called: true, msg: '__submitPendingForm triggered successfully' };
        }
        return { ok: false, called: false, msg: '__submitPendingForm was not defined on window' };
      })()
    `);
    console.log('Bypass Response:', JSON.stringify(checkBypass));

    await new Promise(r => setTimeout(r, 6000));
    await saveScreenshot(tabId, 'after_successful_bypass_wait.png');

    const finalUrl = await evalJson(tabId, USER_ID, 'location.href');
    const isStillOnPage = await evalJson(tabId, USER_ID, `
      !!document.querySelector('input[type="password"], input[name="password"], input[name="new-password"], input[autocomplete="new-password"]')
    `);
    console.log(`Final URL: ${finalUrl}`);
    console.log(`Is still on password page: ${isStillOnPage}`);

  } catch (err) {
    console.error('❌ Test failed:', err);
  } finally {
    if (tabId) await camofoxDelete(`/tabs/${tabId}?userId=${USER_ID}`).catch(() => {});
  }
}

run();
