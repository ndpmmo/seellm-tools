#!/usr/bin/env node
/**
 * scripts/debug/test-timing.js
 * 
 * Test timing of redirect after clicking "Sign up for free"
 * to determine optimal wait time.
 */

import { camofoxPost, camofoxGet, camofoxDelete } from '../lib/camofox.js';

const USER_ID = `debug_${Date.now()}`;
let tabId = null;

async function cleanup() {
  if (tabId) {
    try {
      await camofoxDelete(`/tabs/${tabId}?userId=${USER_ID}`);
    } catch (e) {}
  }
}

async function testRedirectTiming() {
  console.log('🧪 Testing redirect timing after clicking "Sign up for free"...\n');

  try {
    // Create tab
    const tabRes = await camofoxPost('/tabs', {
      userId: USER_ID,
      url: 'https://chatgpt.com/auth/login',
      headless: false,
      humanize: true,
    });
    tabId = tabRes.tabId;
    console.log(`✅ Tab ID: ${tabId}`);

    // Wait for page load
    await new Promise(r => setTimeout(r, 5000));

    // Get initial URL
    const initialUrl = await camofoxPost(`/tabs/${tabId}/evaluate`, {
      userId: USER_ID,
      expression: 'location.href'
    });
    console.log(`📄 Initial URL: ${initialUrl.result || initialUrl}`);

    // Click signup button by data-testid
    console.log('\n🎬 Clicking "Sign up for free"...');
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

    // Poll URL changes with timestamps
    console.log('\n⏱️  Polling URL changes...\n');
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 500));
      
      const currentUrl = await camofoxPost(`/tabs/${tabId}/evaluate`, {
        userId: USER_ID,
        expression: 'location.href'
      });
      
      const hasEmailInput = await camofoxPost(`/tabs/${tabId}/evaluate`, {
        userId: USER_ID,
        expression: `!!document.querySelector('input[type="email"], input[name="email"], input[name="identifier"], input[autocomplete="email"]')`
      });

      const elapsed = (i + 1) * 500;
      console.log(`[${elapsed}ms] URL: ${(currentUrl.result || currentUrl).slice(0, 80)}`);
      console.log(`[${elapsed}ms] Email input: ${hasEmailInput.result || hasEmailInput ? '✅ YES' : '❌ NO'}`);
      
      if (currentUrl.result !== initialUrl.result && (currentUrl.result || currentUrl).includes('auth.openai.com')) {
        console.log(`\n✅ Redirect detected at ${elapsed}ms`);
        break;
      }
      
      if (hasEmailInput.result || hasEmailInput) {
        console.log(`\n✅ Email input detected at ${elapsed}ms`);
        break;
      }
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

testRedirectTiming();
