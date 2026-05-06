#!/usr/bin/env node
/**
 * scripts/debug/test-email-exists.js
 * 
 * Test what happens when trying to register with an already-registered email.
 * This might explain the different behavior.
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

async function testEmailExists() {
  console.log('==========================================');
  console.log('🧪 Testing signup with existing email (if any)');
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
          hasError: bodyText.includes('error') || bodyText.includes('already') || bodyText.includes('exists') || bodyText.includes('taken'),
          bodyText: bodyText
        };
      })()`
    });

    console.log(`📄 URL: ${(state.result || state).url}`);
    console.log(`📄 hasEmailInput: ${(state.result || state).hasEmailInput}`);
    console.log(`📄 hasError: ${(state.result || state).hasError}`);
    console.log(`📄 bodyText: ${(state.result || state).bodyText.slice(0, 400)}...`);

    // If no email input, try to fill email to see what happens
    if (!(state.result || state).hasEmailInput) {
      console.log('\n📝 No email input found. Checking if we need to navigate to signup page directly...');
      
      // Try navigate to auth.openai.com/signup directly
      await new Promise(r => setTimeout(r, 2000));
      await camofoxPost(`/tabs/${tabId}/navigate`, {
        userId: USER_ID,
        url: 'https://auth.openai.com/signup'
      });
      
      await new Promise(r => setTimeout(r, 5000));
      
      const state2 = await camofoxPost(`/tabs/${tabId}/evaluate`, {
        userId: USER_ID,
        expression: `(() => {
          const bodyText = (document.body.innerText || document.body.textContent || '').toLowerCase().slice(0, 800);
          return {
            url: location.href,
            hasEmailInput: !!document.querySelector('input[type="email"], input[name="email"], input[name="identifier"], input[autocomplete="email"]'),
            bodyText: bodyText
          };
        })()`
      });
      
      console.log(`\n📄 After navigate to /signup:`);
      console.log(`📄 URL: ${(state2.result || state2).url}`);
      console.log(`📄 hasEmailInput: ${(state2.result || state2).hasEmailInput}`);
      console.log(`📄 bodyText: ${(state2.result || state2).bodyText.slice(0, 400)}...`);
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

testEmailExists();
