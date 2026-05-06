#!/usr/bin/env node
/**
 * scripts/debug/test-with-proxy.js
 * 
 * Test signup flow with proxy to see if proxy affects behavior.
 * Set PROXY_URL environment variable to test.
 */

import { camofoxPost, camofoxGet, camofoxDelete, navigate } from '../lib/camofox.js';
import { CAMOUFOX_API } from '../config.js';

const USER_ID = `debug_${Date.now()}`;
const PROXY_URL = process.env.PROXY_URL || null;
let tabId = null;

async function cleanup() {
  if (tabId) {
    try {
      await camofoxDelete(`/tabs/${tabId}?userId=${USER_ID}`);
    } catch (e) {}
  }
}

async function getState(tabId, userId) {
  try {
    const res = await camofoxPost(`/tabs/${tabId}/evaluate`, {
      userId,
      expression: `(() => {
        const bodyText = (document.body.innerText || document.body.textContent || '').toLowerCase().slice(0, 500);
        return {
          url: location.href,
          hasEmailInput: !!document.querySelector('input[type="email"], input[name="email"], input[name="identifier"], input[autocomplete="email"]'),
          hasPasswordInput: !!document.querySelector('input[type="password"], input[name="password"]'),
          bodyText: bodyText
        };
      })()`
    });
    return res.result || res;
  } catch (e) {
    return null;
  }
}

async function testWithProxy() {
  console.log('==========================================');
  console.log('🧪 Testing signup flow' + (PROXY_URL ? ` with proxy: ${PROXY_URL}` : ' WITHOUT proxy'));
  console.log('==========================================\n');

  try {
    // Create tab
    const tabRes = await camofoxPost('/tabs', {
      userId: USER_ID,
      url: 'https://chatgpt.com/auth/login',
      headless: false,
      humanize: true,
      proxy: PROXY_URL || undefined,
    });
    tabId = tabRes.tabId;
    console.log(`✅ Tab ID: ${tabId}`);

    // Wait for page load (longer with proxy)
    await new Promise(r => setTimeout(r, 8000));

    // Get initial state
    const initialState = await getState(tabId, USER_ID);
    console.log(`📄 Initial URL: ${initialState?.url}`);
    console.log(`📄 Initial hasEmailInput: ${initialState?.hasEmailInput}`);
    console.log(`📄 Initial bodyText: ${initialState?.bodyText?.slice(0, 200)}...`);

    // Click signup button by data-testid
    console.log('\n🎬 Clicking "Sign up for free" by data-testid...');
    await camofoxPost(`/tabs/${tabId}/evaluate`, {
      userId: USER_ID,
      expression: `(() => {
        const btn = document.querySelector('button[data-testid="signup-button"]');
        if (btn) {
          btn.click();
          return { clicked: true };
        }
        return { clicked: false };
      })()`
    });

    // Wait longer with proxy
    console.log('\n⏱️  Waiting for redirect (10s)...');
    await new Promise(r => setTimeout(r, 10000));

    // Get final state
    const finalState = await getState(tabId, USER_ID);
    console.log(`\n📄 Final URL: ${finalState?.url}`);
    console.log(`📄 Final hasEmailInput: ${finalState?.hasEmailInput}`);
    console.log(`📄 Final hasPasswordInput: ${finalState?.hasPasswordInput}`);
    console.log(`📄 Final bodyText: ${finalState?.bodyText?.slice(0, 300)}...`);

    // Check if email input appeared
    if (finalState?.hasEmailInput) {
      console.log('\n✅ SUCCESS: Email input appeared!');
    } else {
      console.log('\n❌ FAILED: No email input after action');
      console.log('\n💡 This might indicate:');
      console.log('   - Proxy blocking redirect');
      console.log('   - IP rate-limited by OpenAI');
      console.log('   - Different UI for this region/IP');
    }

    console.log('\n==========================================');
    console.log('✅ Test complete');
    console.log('==========================================');

  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await cleanup();
  }
}

testWithProxy();
