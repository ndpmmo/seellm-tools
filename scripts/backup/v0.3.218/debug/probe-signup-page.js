/**
 * Probe signup page state after navigate with action=signup
 */
import { CAMOUFOX_API, WORKER_AUTH_TOKEN } from '../config.js';
import { camofoxPost, evalJson } from '../lib/camofox.js';

async function camofoxPostWithSessionKey(endpoint, body, timeoutMs = 30000) {
  const payload = { ...body, sessionKey: WORKER_AUTH_TOKEN };
  return camofoxPost(endpoint, payload, { timeoutMs });
}

const USER_ID = `probe_signup_${Date.now()}`;

async function run() {
  console.log('Creating tab...');
  const tabRes = await camofoxPostWithSessionKey('/tabs', {
    userId: USER_ID,
    url: 'https://chatgpt.com/auth/login?action=signup',
    headless: false,
    humanize: true,
  });
  const tabId = tabRes.tabId;
  console.log(`Tab ID: ${tabId}`);

  // Wait and check multiple times
  for (let i = 1; i <= 6; i++) {
    console.log(`\n========== Check ${i} (waited ${i * 3}s) ==========`);
    await new Promise(r => setTimeout(r, 3000));

    const state = await evalJson(tabId, USER_ID, `
      (() => {
        const url = location.href;
        const title = document.title;
        const body = (document.body?.innerText || '').slice(0, 500);

        const emailInput = document.querySelector('input[type="email"], input[name="email"], input[name="identifier"], input[autocomplete="email"]');
        const passwordInput = document.querySelector('input[type="password"], input[name="password"]');
        const codeInput = document.querySelector('input[name="code"], input[autocomplete="one-time-code"]');

        const allInputs = Array.from(document.querySelectorAll('input')).map(inp => ({
          type: inp.type,
          name: inp.name,
          id: inp.id,
          placeholder: inp.placeholder,
          autocomplete: inp.autocomplete,
          visible: inp.getBoundingClientRect().width > 0,
        }));

        const allButtons = Array.from(document.querySelectorAll('button')).slice(0, 10).map(btn => ({
          text: (btn.innerText || btn.textContent || '').trim().slice(0, 50),
          id: btn.id,
          dataTestId: btn.getAttribute('data-testid'),
        }));

        return {
          url,
          title,
          body,
          hasEmailInput: !!emailInput,
          hasPasswordInput: !!passwordInput,
          hasCodeInput: !!codeInput,
          allInputs,
          allButtons,
        };
      })()
    `, 5000);

    console.log(`URL: ${state.url}`);
    console.log(`Title: ${state.title}`);
    console.log(`Has email input: ${state.hasEmailInput}`);
    console.log(`Has password input: ${state.hasPasswordInput}`);
    console.log(`Has code input: ${state.hasCodeInput}`);
    console.log(`\nInputs:`, JSON.stringify(state.allInputs, null, 2));
    console.log(`\nButtons:`, JSON.stringify(state.allButtons, null, 2));
  }

  await camofoxPostWithSessionKey(`/tabs/${tabId}?userId=${USER_ID}`, {}, 3000).catch(() => {});
}

run().then(() => console.log('\nDone')).catch(err => console.error('Error:', err));
