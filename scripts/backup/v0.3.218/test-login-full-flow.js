#!/usr/bin/env node
/**
 * scripts/test-login-full-flow.js
 * 
 * Target account: rafaelfreemaniorz@hotmail.com
 * Format: email:pass:2fa
 * Purpose: Open a clean Camofox tab (without DB cookies), navigate to chatgpt.com/auth/login,
 * perform interactive step-by-step login (Email -> Password -> TOTP 2FA), 
 * take screenshots at EVERY stage/phase, dump exact inner DOM state at key steps,
 * and wait/report exactly where each UI screen appears.
 */

import { CAMOUFOX_API } from './config.js';
import { camofoxPost, camofoxDelete, evalJson, navigate, getSnapshot } from './lib/camofox.js';
import { getFreshTOTP } from './lib/totp.js';
import { getState } from './lib/openai-login-flow.js';
import fs from 'node:fs/promises';
import path from 'node:path';

// Target Account Credentials
const EMAIL = 'rafaelfreemaniorz@hotmail.com';
const PASSWORD = '$Xjb!XAjMk4r#jKu';
const TOTP_SECRET = 'KVXLPC3MVNTEYRYG3VDLDLZOKS4JUWT3'; // Extra clean base32 portion if needed, let's verify length

const USER_ID = `test_login_flow_${Date.now()}`;
const DATA_DIR = path.resolve('data', 'screenshots', `login_flow_acc_b7468014`);

// Log helper
function log(step, msg) {
  console.log(`[${step}] ${msg}`);
}

async function takeScreenshotAndSave(tabId, filename) {
  try {
    const res = await fetch(`${CAMOUFOX_API}/tabs/${tabId}/screenshot?userId=${USER_ID}&fullPage=true`);
    if (res.ok) {
      const buffer = Buffer.from(await res.arrayBuffer());
      const filepath = path.join(DATA_DIR, filename);
      await fs.writeFile(filepath, buffer);
      log('SCREENSHOT', `Saved screenshot to: ${filepath}`);
    } else {
      log('SCREENSHOT', `WARNING: Failed to fetch screenshot for ${filename} - ${res.status}`);
    }
  } catch (err) {
    log('SCREENSHOT', `Error taking screenshot: ${err.message}`);
  }
}

async function main() {
  let tabId = null;
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    log('START', `Starting step-by-step full login flow test for ${EMAIL}`);
    
    // Launch Camoufox Tab with NO cookies (clean state test)
    const launchOptions = {
      userId: USER_ID,
      sessionKey: `login_flow_test_${Date.now()}`,
      url: 'https://chatgpt.com/auth/login?prompt=login',
      persistent: false,
      os: 'macos',
      screen: { width: 1440, height: 900 },
      headless: false,
    };

    log('CAMOFOX', 'Opening fresh tab...');
    const opened = await camofoxPost('/tabs', launchOptions, { timeoutMs: 35000 });
    tabId = opened.tabId;
    log('CAMOFOX', `Tab opened successfully: ${tabId}`);
    
    // Wait for login landing page
    await new Promise(r => setTimeout(r, 6000));
    await takeScreenshotAndSave(tabId, '01_login_page_loaded.png');

    // Click log in button to trigger Auth0 navigation
    log('LOGIN', 'Clicking ChatGPT Log In button...');
    await evalJson(tabId, USER_ID, `(() => {
      const buttons = Array.from(document.querySelectorAll('button, a'));
      const loginBtn = buttons.find(b => {
        const text = (b.textContent || '').trim().toLowerCase();
        return text === 'log in' || text === 'đăng nhập';
      });
      if (loginBtn) {
        loginBtn.click();
        loginBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return 'clicked_login_button';
      }
      return 'login_button_not_found';
    })()`);

    await new Promise(r => setTimeout(r, 6000));
    await takeScreenshotAndSave(tabId, '02_auth0_landing_page.png');

    // Wait and evaluate state
    let state = await getState(tabId, USER_ID);
    log('STATE', `Page State: ${JSON.stringify(state)}`);

    // 1. Fill email
    if (state.hasEmailInput) {
      log('EMAIL', `Filling email: ${EMAIL}`);
      await evalJson(tabId, USER_ID, `(() => {
        const input = document.querySelector('input[name="username"], input[name="email"], input[type="email"]');
        if (input) {
          const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          nativeSetter.call(input, "${EMAIL}");
          input.dispatchEvent(new Event('input', { bubbles: true }));
          
          const btn = Array.from(document.querySelectorAll('button, input[type="submit"]')).find(b => {
            const txt = (b.textContent || b.innerText || b.value || '').trim().toLowerCase();
            return txt === 'continue' || txt === 'tiếp tục' || txt === 'next';
          });
          if (btn) {
            btn.click();
            btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          }
        }
      })()`);
      
      await new Promise(r => setTimeout(r, 6000));
      await takeScreenshotAndSave(tabId, '03_after_email_submit.png');
    }

    // 2. Fill password
    state = await getState(tabId, USER_ID);
    if (state.hasPasswordInput) {
      log('PASSWORD', `Filling password...`);
      await evalJson(tabId, USER_ID, `(() => {
        const input = document.querySelector('input[name="password"], input[type="password"]');
        if (input) {
          const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          nativeSetter.call(input, "${PASSWORD}");
          input.dispatchEvent(new Event('input', { bubbles: true }));
          
          const btn = Array.from(document.querySelectorAll('button, input[type="submit"]')).find(b => {
            const txt = (b.textContent || b.innerText || b.value || '').trim().toLowerCase();
            return txt === 'continue' || txt === 'tiếp tục' || txt === 'log in' || txt === 'sign in';
          });
          if (btn) {
            btn.click();
            btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          }
        }
      })()`);

      await new Promise(r => setTimeout(r, 6000));
      await takeScreenshotAndSave(tabId, '04_after_password_submit.png');
    }

    // 3. Fill MFA (2FA)
    state = await getState(tabId, USER_ID);
    if (state.hasMfaInput) {
      log('MFA', `MFA screen detected! Extracting OTP from TOTP Secret...`);
      const { otp } = await getFreshTOTP(TOTP_SECRET, 8);
      log('MFA', `Generated OTP code: ${otp}`);
      
      await evalJson(tabId, USER_ID, `(() => {
        const input = document.querySelector('input[autocomplete="one-time-code"], input[name="code"], input[name="otp"], input[placeholder*="code"]');
        if (input) {
          const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          nativeSetter.call(input, "${otp}");
          input.dispatchEvent(new Event('input', { bubbles: true }));
          
          const btn = Array.from(document.querySelectorAll('button, input[type="submit"]')).find(b => {
            const txt = (b.textContent || b.innerText || b.value || '').trim().toLowerCase();
            return txt === 'continue' || txt === 'tiếp tục' || txt === 'verify' || txt === 'xác minh';
          });
          if (btn) {
            btn.click();
            btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          }
        }
      })()`);

      await new Promise(r => setTimeout(r, 8000));
      await takeScreenshotAndSave(tabId, '05_after_mfa_submit.png');
    }

    // 4. Standalone Workspace Selection screen or onboarding checks
    state = await getState(tabId, USER_ID);
    log('STATE', `Page State after login/MFA stage: ${JSON.stringify(state)}`);

    if (state.isWorkspaceScreen || finalUrl.includes('/workspace') || finalUrl.includes('auth.openai.com')) {
      log('WORKSPACE', `Workspace selection page detected! Dumping DOM list element structures...`);
      
      // Let's dump all clickable/button-like rows on this Choose a Workspace auth page
      const workspaceDump = await evalJson(tabId, USER_ID, `(() => {
        const results = [];
        const clickables = document.querySelectorAll('button, [role="button"], [role="option"], a, div');
        for (const el of clickables) {
          if (el.offsetParent === null) continue;
          const text = (el.textContent || '').trim();
          if (!text || text.length > 150) continue;
          const tagName = el.tagName.toLowerCase();
          results.push({
            tag: el.tagName,
            text,
            classes: el.className,
            attributes: Array.from(el.attributes).map(a => a.name + '=' + a.value)
          });
        }
        return results;
      })()`);
      
      log('WORKSPACE', `Choose a Workspace DOM clickables: ${JSON.stringify(workspaceDump, null, 2)}`);
      
      const clickResult = await evalJson(tabId, USER_ID, `(() => {
        // Pioritize specific leaf-like elements (buttons or spans/divs with no child divs)
        const buttons = Array.from(document.querySelectorAll('button, [role="button"], [role="option"], a'));
        for (const el of buttons) {
          if (el.offsetParent === null) continue;
          const text = (el.textContent || '').trim().toLowerCase();
          if (text.includes('personal') && text.length < 100) {
            el.focus();
            el.click();
            el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
            el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
            el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
            return 'clicked_personal_button: ' + text;
          }
        }
        
        // Fallback to divs
        const divs = Array.from(document.querySelectorAll('div'));
        for (const el of divs) {
          if (el.offsetParent === null) continue;
          if (el.querySelector('div')) continue; // Skip non-leaf divs
          const text = (el.textContent || '').trim().toLowerCase();
          if (text.includes('personal') && text.length < 100) {
            el.focus();
            el.click();
            el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
            el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
            el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
            return 'clicked_personal_div: ' + text;
          }
        }
        return 'personal_element_not_found';
      })()`);
      
      log('WORKSPACE', `Click Result: ${clickResult}`);

      await new Promise(r => setTimeout(r, 12000));
      await takeScreenshotAndSave(tabId, '06_after_workspace_selection.png');
    }

    // Save final screen DOM structure for review
    const finalUrl = await evalJson(tabId, USER_ID, 'location.href');
    log('FINAL', `Final Page URL: ${finalUrl}`);
    await takeScreenshotAndSave(tabId, '07_final_page_state.png');

  } catch (err) {
    log('ERROR', `Error during clean login flow execution: ${err.message}`);
    console.error(err);
  } finally {
    if (tabId) {
      log('CLEANUP', 'Closing Camofox testing tab...');
      await camofoxDelete(`/tabs/${tabId}?userId=${USER_ID}`);
      log('CLEANUP', 'Completed.');
    }
  }
}

main();
