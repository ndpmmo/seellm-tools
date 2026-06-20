#!/usr/bin/env node
/**
 * scripts/debug/test-signup-flows.js
 * 
 * Test different signup flow paths to understand the new ChatGPT UI.
 * Tests:
 * 1. Click "Sign up for free" button
 * 2. Click "Try it first" button
 * 3. Navigate directly to signup URL
 * 4. Check what happens after each action
 */

import { camofoxPost, camofoxGet, camofoxDelete, navigate } from '../lib/camofox.js';
import { CAMOUFOX_API } from '../config.js';

const USER_ID = `debug_${Date.now()}`;
let tabId = null;

async function cleanup() {
  if (tabId) {
    try {
      await camofoxDelete(`/tabs/${tabId}?userId=${USER_ID}`);
      console.log(`🧹 Đã đóng tab ${tabId}`);
    } catch (e) {
      console.log(`⚠️ Lỗi khi đóng tab: ${e.message}`);
    }
  }
}

process.on('SIGINT', async () => {
  console.log('\n🛑 Đang cleanup...');
  await cleanup();
  process.exit(0);
});

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

async function testFlow(flowName, actionFn) {
  console.log('\n==========================================');
  console.log(`🧪 Testing: ${flowName}`);
  console.log('==========================================\n');

  try {
    // Create fresh tab
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

    // Get initial state
    const initialState = await getState(tabId, USER_ID);
    console.log(`📄 Initial URL: ${initialState?.url}`);
    console.log(`📄 Initial hasEmailInput: ${initialState?.hasEmailInput}`);
    console.log(`📄 Initial bodyText: ${initialState?.bodyText?.slice(0, 200)}...`);

    // Execute action
    console.log(`\n🎬 Executing action...`);
    await actionFn(tabId, USER_ID);

    // Wait for navigation/changes
    await new Promise(r => setTimeout(r, 5000));

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
    }

    // Close tab
    await camofoxDelete(`/tabs/${tabId}?userId=${USER_ID}`);
    tabId = null;

  } catch (error) {
    console.error(`❌ Error in ${flowName}:`, error.message);
  }
}

async function runAllTests() {
  console.log('==========================================');
  console.log('🔍 ChatGPT Signup Flow Tests');
  console.log('==========================================\n');

  try {
    // Test 1: Click "Sign up for free" by data-testid
    await testFlow('Click "Sign up for free" (data-testid)', async (tabId, userId) => {
      await camofoxPost(`/tabs/${tabId}/evaluate`, {
        userId,
        expression: `(() => {
          const btn = document.querySelector('button[data-testid="signup-button"]');
          if (btn) {
            btn.click();
            return { clicked: true };
          }
          return { clicked: false };
        })()`
      });
    });

    // Test 2: Click "Try it first"
    await testFlow('Click "Try it first"', async (tabId, userId) => {
      await camofoxPost(`/tabs/${tabId}/evaluate`, {
        userId,
        expression: `(() => {
          const btns = Array.from(document.querySelectorAll('button'));
          const tryBtn = btns.find(b => (b.innerText || b.textContent || '').includes('Try it first'));
          if (tryBtn) {
            tryBtn.click();
            return { clicked: true, text: tryBtn.innerText.trim() };
          }
          return { clicked: false };
        })()`
      });
    });

    // Test 3: Navigate directly to signup URL
    await testFlow('Navigate to ?action=signup', async (tabId, userId) => {
      await navigate(tabId, userId, 'https://chatgpt.com/auth/login?action=signup', { timeoutMs: 15000 });
    });

    // Test 4: Navigate to auth.openai.com directly
    await testFlow('Navigate to auth.openai.com/signup', async (tabId, userId) => {
      await navigate(tabId, userId, 'https://auth.openai.com/signup', { timeoutMs: 15000 });
    });

    // Test 5: Navigate to chatgpt.com/signup (if exists)
    await testFlow('Navigate to chatgpt.com/signup', async (tabId, userId) => {
      try {
        await navigate(tabId, userId, 'https://chatgpt.com/signup', { timeoutMs: 15000 });
      } catch (e) {
        console.log('⚠️ /signup endpoint might not exist');
      }
    });

    console.log('\n==========================================');
    console.log('✅ All tests complete');
    console.log('==========================================\n');

  } catch (error) {
    console.error('❌ Fatal error:', error.message);
  } finally {
    await cleanup();
  }
}

runAllTests();
