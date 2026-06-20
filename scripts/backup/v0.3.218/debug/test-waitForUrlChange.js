#!/usr/bin/env node
/**
 * scripts/debug/test-waitForUrlChange.js
 * 
 * Test if waitForUrlChange correctly detects URL changes
 * and what happens when it times out.
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

// Copy of waitForUrlChange from auto-register-worker.js
async function waitForUrlChange(tabId, userId, initialUrl, { timeoutMs = 8000, intervalMs = 500 } = {}) {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    await new Promise(r => setTimeout(r, intervalMs));
    try {
      const currentUrl = await camofoxPost(`/tabs/${tabId}/evaluate`, {
        userId,
        expression: 'location.href'
      });
      const url = currentUrl.result || currentUrl;
      if (url && url !== initialUrl) {
        return url;
      }
    } catch (e) {
      // Continue on error
    }
  }
  return null;
}

async function testWaitForUrlChange() {
  console.log('🧪 Testing waitForUrlChange detection...\n');

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
    const urlBeforeSignup = initialUrl.result || initialUrl;
    console.log(`📄 Initial URL: ${urlBeforeSignup}`);

    // Click signup button
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

    // Test waitForUrlChange with 8s timeout
    console.log('\n⏱️  Waiting for URL change (8s timeout)...');
    const urlChanged = await waitForUrlChange(tabId, USER_ID, urlBeforeSignup, { timeoutMs: 8000, intervalMs: 500 });
    
    if (urlChanged) {
      console.log(`✅ waitForUrlChange SUCCESS: ${urlChanged.slice(0, 80)}`);
    } else {
      console.log(`❌ waitForUrlChange TIMEOUT (8s)`);
      
      // Check actual URL after timeout
      const actualUrl = await camofoxPost(`/tabs/${tabId}/evaluate`, {
        userId: USER_ID,
        expression: 'location.href'
      });
      console.log(`📄 Actual URL after timeout: ${(actualUrl.result || actualUrl).slice(0, 80)}`);
      console.log(`📄 URL changed? ${(actualUrl.result || actualUrl) !== urlBeforeSignup ? 'YES' : 'NO'}`);
    }

    // Check email input
    const hasEmailInput = await camofoxPost(`/tabs/${tabId}/evaluate`, {
      userId: USER_ID,
      expression: `!!document.querySelector('input[type="email"], input[name="email"], input[name="identifier"], input[autocomplete="email"]')`
    });
    console.log(`📄 Email input: ${hasEmailInput.result || hasEmailInput ? 'YES' : 'NO'}`);

    console.log('\n==========================================');
    console.log('✅ Test complete');
    console.log('==========================================');

  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await cleanup();
  }
}

testWaitForUrlChange();
