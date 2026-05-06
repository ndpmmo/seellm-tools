#!/usr/bin/env node
/**
 * scripts/debug/test-specific-email.js
 * 
 * Test signup flow with the specific email from the error log.
 */

import { camofoxPost, camofoxGet, camofoxDelete } from '../lib/camofox.js';

const USER_ID = `debug_${Date.now()}`;
const TEST_EMAIL = 'rafaelfreemaniorz@hotmail.com';
let tabId = null;

async function cleanup() {
  if (tabId) {
    try {
      await camofoxDelete(`/tabs/${tabId}?userId=${USER_ID}`);
    } catch (e) {}
  }
}

async function testSpecificEmail() {
  console.log('==========================================');
  console.log(`🧪 Testing signup with email: ${TEST_EMAIL}`);
  console.log('==========================================\n');

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

    // Wait for redirect
    await new Promise(r => setTimeout(r, 5000));

    // Check state
    const state = await camofoxPost(`/tabs/${tabId}/evaluate`, {
      userId: USER_ID,
      expression: `(() => {
        const bodyText = (document.body.innerText || document.body.textContent || '').toLowerCase().slice(0, 800);
        return {
          url: location.href,
          hasEmailInput: !!document.querySelector('input[type="email"], input[name="email"], input[name="identifier"], input[autocomplete="email"]'),
          hasPasswordInput: !!document.querySelector('input[type="password"], input[name="password"]'),
          bodyText: bodyText
        };
      })()`
    });

    console.log(`📄 URL: ${(state.result || state).url}`);
    console.log(`📄 hasEmailInput: ${(state.result || state).hasEmailInput}`);
    console.log(`📄 bodyText: ${(state.result || state).bodyText.slice(0, 400)}...`);

    // If email input exists, try to fill it
    if ((state.result || state).hasEmailInput) {
      console.log('\n📝 Email input found. Filling with test email...');
      
      await camofoxPost(`/tabs/${tabId}/evaluate`, {
        userId: USER_ID,
        expression: `(() => {
          const input = document.querySelector('input[type="email"], input[name="email"], input[name="identifier"], input[autocomplete="email"]');
          if (input) {
            input.value = '${TEST_EMAIL}';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            return { filled: true };
          }
          return { filled: false };
        })()`
      });

      await new Promise(r => setTimeout(r, 2000));

      // Check if any error appears
      const state2 = await camofoxPost(`/tabs/${tabId}/evaluate`, {
        userId: USER_ID,
        expression: `(() => {
          const bodyText = (document.body.innerText || document.body.textContent || '').toLowerCase().slice(0, 800);
          return {
            url: location.href,
            hasError: bodyText.includes('error') || bodyText.includes('already') || bodyText.includes('exists') || bodyText.includes('taken') || bodyText.includes('in use'),
            bodyText: bodyText
          };
        })()`
      });

      console.log(`\n📄 After filling email:`);
      console.log(`📄 URL: ${(state2.result || state2).url}`);
      console.log(`📄 hasError: ${(state2.result || state2).hasError}`);
      console.log(`📄 bodyText: ${(state2.result || state2).bodyText.slice(0, 400)}...`);

      if ((state2.result || state2).hasError) {
        console.log('\n⚠️ Email might already be registered or flagged!');
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

testSpecificEmail();
