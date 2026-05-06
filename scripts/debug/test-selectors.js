#!/usr/bin/env node
/**
 * scripts/debug/test-selectors.js
 * 
 * Test if the current selectors in auto-register-worker.js work correctly
 * on the new UI.
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

async function testSelectors() {
  console.log('🧪 Testing current selectors from auto-register-worker.js...\n');

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

    // Test 1: Find signup button by text (same logic as script)
    console.log('\n📝 Test 1: Find "Sign up" button by text...');
    const textSearchResult = await camofoxPost(`/tabs/${tabId}/evaluate`, {
      userId: USER_ID,
      expression: `(() => {
        const hasEmailInput = !!document.querySelector('input[type="email"], input[name="email"], input[name="identifier"], input[autocomplete="email"]');
        if (hasEmailInput) return { skipped: true, reason: 'unified-ui-email-input-present' };
        
        const isVisible = el => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const elements = Array.from(document.querySelectorAll('a, button, div[role="button"]')).filter(isVisible);
        const signup = elements.find(l => {
          const t = (l.innerText || l.textContent || '').toLowerCase().trim();
          return t === 'sign up' || t === 'sign up for free' || (t.startsWith('sign up') && !t.includes(' or '));
        });
        if (signup) {
          return { 
            found: true, 
            text: signup.innerText.trim(), 
            tag: signup.tagName,
            hasDataTestId: !!signup.getAttribute('data-testid'),
            dataTestIdValue: signup.getAttribute('data-testid')
          };
        }
        return { found: false, reason: 'no-signup-button-found' };
      })()`
    });
    console.log(`   Result:`, JSON.stringify(textSearchResult.result || textSearchResult));

    // Test 2: Find signup button by data-testid
    console.log('\n📝 Test 2: Find button with data-testid="signup-button"...');
    const dataTestidResult = await camofoxPost(`/tabs/${tabId}/evaluate`, {
      userId: USER_ID,
      expression: `(() => {
        const btn = document.querySelector('button[data-testid="signup-button"]');
        if (btn) {
          return { 
            found: true, 
            text: btn.innerText.trim(),
            visible: btn.offsetWidth > 0 && btn.offsetHeight > 0
          };
        }
        return { found: false };
      })()`
    });
    console.log(`   Result:`, JSON.stringify(dataTestidResult.result || dataTestidResult));

    // Test 3: Check email input selector
    console.log('\n📝 Test 3: Check email input selector...');
    const emailInputResult = await camofoxPost(`/tabs/${tabId}/evaluate`, {
      userId: USER_ID,
      expression: `(() => {
        const selector = 'input[type="email"], input[name="email"], input[name="identifier"], input[autocomplete="email"]';
        const input = document.querySelector(selector);
        if (input) {
          return { 
            found: true, 
            type: input.type,
            name: input.name,
            autocomplete: input.getAttribute('autocomplete')
          };
        }
        return { found: false };
      })()`
    });
    console.log(`   Result:`, JSON.stringify(emailInputResult.result || emailInputResult));

    // Test 4: Simulate the exact flow from script
    console.log('\n📝 Test 4: Simulate exact script flow...');
    
    // Step 1: Try text-based click
    console.log('   Step 1: Click by text...');
    const click1 = await camofoxPost(`/tabs/${tabId}/evaluate`, {
      userId: USER_ID,
      expression: `(() => {
        const hasEmailInput = !!document.querySelector('input[type="email"], input[name="email"], input[name="identifier"], input[autocomplete="email"]');
        if (hasEmailInput) return { skipped: true, reason: 'unified-ui-email-input-present' };
        
        const isVisible = el => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const elements = Array.from(document.querySelectorAll('a, button, div[role="button"]')).filter(isVisible);
        const signup = elements.find(l => {
          const t = (l.innerText || l.textContent || '').toLowerCase().trim();
          return t === 'sign up' || t === 'sign up for free' || (t.startsWith('sign up') && !t.includes(' or '));
        });
        if (signup) {
          signup.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
          signup.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
          signup.click();
          return { clicked: true, text: signup.innerText.trim(), tag: signup.tagName };
        }
        return { skipped: true, reason: 'no-signup-button-found' };
      })()`
    });
    console.log(`   Click 1 result:`, JSON.stringify(click1.result || click1));

    // Wait
    await new Promise(r => setTimeout(r, 3000));

    // Check URL and email input
    const state1 = await camofoxPost(`/tabs/${tabId}/evaluate`, {
      userId: USER_ID,
      expression: `(() => {
        return {
          url: location.href,
          hasEmailInput: !!document.querySelector('input[type="email"], input[name="email"], input[name="identifier"], input[autocomplete="email"]')
        };
      })()`
    });
    console.log(`   After 3s: URL = ${(state1.result || state1).url.slice(0, 80)}`);
    console.log(`   After 3s: Email input = ${(state1.result || state1).hasEmailInput}`);

    // Step 2: If no email input, try data-testid click
    if (!(state1.result || state1).hasEmailInput) {
      console.log('   Step 2: Click by data-testid...');
      const click2 = await camofoxPost(`/tabs/${tabId}/evaluate`, {
        userId: USER_ID,
        expression: `(() => {
          const btn = document.querySelector('button[data-testid="signup-button"]');
          if (btn) {
            btn.click();
            return { clicked: true, method: 'data-testid' };
          }
          return { clicked: false, error: 'no-signup-button-by-testid' };
        })()`
      });
      console.log(`   Click 2 result:`, JSON.stringify(click2.result || click2));

      // Wait
      await new Promise(r => setTimeout(r, 4000));

      // Check again
      const state2 = await camofoxPost(`/tabs/${tabId}/evaluate`, {
        userId: USER_ID,
        expression: `(() => {
          return {
            url: location.href,
            hasEmailInput: !!document.querySelector('input[type="email"], input[name="email"], input[name="identifier"], input[autocomplete="email"]')
          };
        })()`
      });
      console.log(`   After 4s: URL = ${(state2.result || state2).url.slice(0, 80)}`);
      console.log(`   After 4s: Email input = ${(state2.result || state2).hasEmailInput}`);
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

testSelectors();
