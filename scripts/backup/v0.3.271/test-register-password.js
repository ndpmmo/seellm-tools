import sqlite3 from 'better-sqlite3';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { CAMOUFOX_API, WORKER_AUTH_TOKEN } from './config.js';
import { camofoxPost, camofoxDelete, evalJson, navigate, waitForSelector, actType, actClick, actPress, getSnapshot } from './lib/camofox.js';
import { waitForOTPCode } from './lib/ms-graph-email.js';
import { fillEmail, fillPassword } from './lib/openai-login-flow.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function saveScreenshot(tabId, userId, name) {
  try {
    const res = await fetch(`${CAMOUFOX_API}/tabs/${tabId}/screenshot?userId=${userId}`);
    if (res.ok) {
      const buffer = await res.arrayBuffer();
      const dir = path.join(__dirname, '../data/screenshots/test_otp_debug');
      await fs.mkdir(dir, { recursive: true });
      const filePath = path.join(dir, name);
      await fs.writeFile(filePath, Buffer.from(buffer));
      console.log(`📸 Saved debug screenshot: ${filePath}`);
    } else {
      console.log(`❌ Failed to capture screenshot: ${res.statusText}`);
    }
  } catch (e) {
    console.log(`❌ Error saving debug screenshot: ${e.message}`);
  }
}

async function runTest() {
  const dbPath = path.join(__dirname, '../data/vault.db');
  const db = new sqlite3(dbPath);

  const account = db.prepare(`
    SELECT email, password, refresh_token, client_id 
    FROM vault_email_pool 
    WHERE email = 'jenniferwalkerwcnhcm4o@hotmail.com'
  `).get();

  if (!account) {
    console.error('❌ Could not find target account in database!');
    db.close();
    return;
  }
  db.close();

  const testPassword = account.password;
  console.log(`Using account: ${account.email}`);

  const USER_ID = `test_otp_${Date.now()}`;
  let tabId = null;

  try {
    console.log('1. Launching Camoufox tab with proxy...');
    const opened = await camofoxPost('/tabs', {
      userId: USER_ID,
      sessionKey: WORKER_AUTH_TOKEN || `test_${Date.now()}`,
      url: 'https://chatgpt.com/auth/login',
      persistent: false,
      humanize: true,
      headless: false
    }, { timeoutMs: 35000 });
    
    tabId = opened.tabId;
    console.log(`Tab created: ${tabId}`);

    console.log('Waiting 8s for login page to load...');
    await new Promise(r => setTimeout(r, 8000));
    await saveScreenshot(tabId, USER_ID, '01_login_page_loaded.png');

    const emailSubmitTime = Date.now();
    console.log('2. Submitting email...');
    const emailRes = await fillEmail(tabId, USER_ID, account.email);
    console.log('Email fill response:', JSON.stringify(emailRes));

    console.log('Pressing Enter to submit email...');
    await actPress(tabId, USER_ID, { key: 'Enter' });

    console.log('Waiting 8s for transitions...');
    await new Promise(r => setTimeout(r, 8000));
    await saveScreenshot(tabId, USER_ID, '02_after_email_submit.png');

    let currentUrl = await evalJson(tabId, USER_ID, 'location.href');
    console.log('Current URL after email submit:', currentUrl);

    // Xử lý OTP pre-password bằng cách click 'Continue with password' trực tiếp
    if (currentUrl.includes('email-verification')) {
      console.log('OTP screen detected. Attempting to click "Continue with password" link directly...');
      const pwdLinkResult = await evalJson(tabId, USER_ID, `
        (() => {
          let link = document.querySelector('a[href*="create-account/password"]');
          if (link) {
            link.click();
            return { clicked: true, method: 'href', text: link.textContent.trim() };
          }
          link = Array.from(document.querySelectorAll('a')).find(a => {
            const t = (a.textContent || '').trim().toLowerCase();
            return t === 'continue with password' || t.includes('password');
          });
          if (link) {
            link.click();
            return { clicked: true, method: 'text', text: link.textContent.trim() };
          }
          return { clicked: false, error: 'no-continue-with-password-link' };
        })()
      `, 5000);
      console.log('Click "Continue with password" link response:', JSON.stringify(pwdLinkResult));

      console.log('Waiting 10s for transition to password page...');
      await new Promise(r => setTimeout(r, 10000));
      await saveScreenshot(tabId, USER_ID, '03_after_clicking_continue_with_password.png');

      currentUrl = await evalJson(tabId, USER_ID, 'location.href');
      console.log('Current URL after link click:', currentUrl);

      const hasPwdInput = await evalJson(tabId, USER_ID, `!!document.querySelector('input[type="password"], input[name="password"], input[name="new-password"]')`);
      console.log('Is password input present:', hasPwdInput);

      if (hasPwdInput) {
        console.log('Entering password...');
        
        // Type the password using actType (keyboard mode)
        const typeRes = await actType(tabId, USER_ID, {
          selector: 'input[autocomplete="new-password"], input[autocomplete="current-password"], input[type="password"], input[name="password"], input[id="password"]',
          text: 'MAxXXo@123456',
          mode: 'keyboard',
          submit: false
        }, { timeoutMs: 10000 });
        console.log('actType response:', JSON.stringify(typeRes));

        // Dispatch DOM events to make sure React registers it
        await evalJson(tabId, USER_ID, `
          (() => {
            const input = document.querySelector('input[type="password"], input[name="password"], input[name="new-password"]');
            if (input) {
              input.dispatchEvent(new Event('input', { bubbles: true }));
              input.dispatchEvent(new Event('change', { bubbles: true }));
              input.blur();
            }
          })()
        `);

        await new Promise(r => setTimeout(r, 1500));
        await saveScreenshot(tabId, USER_ID, '04_after_typing_password.png');

        console.log('Dispatching native submit event on the form...');
        const nativeSubmitRes = await evalJson(tabId, USER_ID, `
          (() => {
            const form = document.querySelector('form');
            if (form) {
              try {
                // Bypass JS overrides by using prototype submit
                HTMLFormElement.prototype.submit.call(form);
                return { ok: true, msg: 'native prototype submit invoked' };
              } catch (e) {
                return { ok: false, error: e.message };
              }
            }
            return { ok: false, error: 'no-form' };
          })()
        `);
        console.log('nativeSubmitRes:', JSON.stringify(nativeSubmitRes));

        console.log('Waiting 8s for submission navigation...');
        await new Promise(r => setTimeout(r, 8000));
        await saveScreenshot(tabId, USER_ID, '05_after_submitting_password.png');

        const postSubmitStatus = await evalJson(tabId, USER_ID, `
          (() => {
            const url = location.href;
            const body = document.body ? document.body.innerText : '';
            const hasPwd = !!document.querySelector('input[type="password"]');
            
            // Inspect validation details
            const input = document.querySelector('input[type="password"], input[name="password"], input[name="new-password"]');
            const validationMessage = input ? input.validationMessage : '';
            const isInvalidAttr = input ? input.getAttribute('aria-invalid') : '';
            const validity = input ? JSON.stringify(input.validity) : '';
            
            // Check button attributes
            const btn = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]'))
              .find(el => {
                const t = (el.innerText || el.textContent || el.value || '').trim().toLowerCase();
                return t === 'continue' || t === 'next' || t === 'tiếp tục';
              });
            
            const getParentChain = el => {
              const chain = [];
              let p = el;
              while (p) {
                chain.push(p.tagName + (p.id ? '#' + p.id : '') + (p.className ? '.' + p.className.split(' ').join('.') : ''));
                p = p.parentElement;
              }
              return chain.reverse().join(' > ');
            };

            const btnDetails = btn ? {
              outerHTML: btn.outerHTML,
              disabled: btn.disabled,
              ariaDisabled: btn.getAttribute('aria-disabled'),
              parentChain: getParentChain(btn)
            } : null;

            const inputChain = input ? getParentChain(input) : null;
            
            const forms = Array.from(document.querySelectorAll('form')).map(f => ({
              id: f.id,
              action: f.getAttribute('action'),
              outerHTML: f.outerHTML.slice(0, 200),
              inputs: Array.from(f.querySelectorAll('input')).map(i => ({
                name: i.name,
                id: i.id,
                value: i.value,
                type: i.type,
                outerHTML: i.outerHTML.slice(0, 150)
              })),
              buttons: Array.from(f.querySelectorAll('button')).map(b => b.innerText || b.textContent)
            }));

            // Check for error text in DOM
            const errorEls = Array.from(document.querySelectorAll('[class*="error" i], [id*="error" i], [role="alert"]'))
              .map(el => el.tagName + '#' + el.id + '.' + el.className + ': ' + el.innerText);

            return { url, body: body.slice(0, 300), hasPwd, validationMessage, isInvalidAttr, validity, btnDetails, inputChain, forms, errorEls };
          })()
        `);
        console.log('Post password submit status:', JSON.stringify(postSubmitStatus, null, 2));
      }
    }

  } catch (err) {
    console.error('❌ Test execution failed:', err);
  } finally {
    if (tabId) {
      console.log('Cleaning up tab...');
      await camofoxDelete(`/tabs/${tabId}?userId=${USER_ID}`).catch(() => {});
    }
  }
}

runTest();
