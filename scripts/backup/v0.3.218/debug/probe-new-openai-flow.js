/**
 * Script probe flow đăng ký mới OpenAI
 * - Lặp lại nhiều lần để thu thập DOM/xpath/selector
 * - Focus vào: nút "Create with password" sau OTP screen
 * - Log chi tiết mọi element để debug
 */

import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { CAMOUFOX_API, WORKER_AUTH_TOKEN } from '../config.js';
import { camofoxPost, evalJson, navigate } from '../lib/camofox.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Wrapper inject sessionKey
async function camofoxPostWithSessionKey(endpoint, body, timeoutMs = 30000) {
  const payload = { ...body, sessionKey: WORKER_AUTH_TOKEN };
  return camofoxPost(endpoint, payload, { timeoutMs });
}

// Credential từ user
const EMAIL = 'jordanbertjohnson1551@hotmail.com';
const EMAIL_PASSWORD = 'jordan@414392';
const REFRESH_TOKEN = 'M.C550_BAY.0.U.-CvnWmQsHzBcWTOWISN!IH60eHJRONFhpKTVbzox!Xduk!EdFtT3NplVQ0c!!nPd9yw8PM2Dbwpeq21W8BNujz2k!jEJXkc8Ur8!jq7Rjjuy5hsfsEgVduuS67sIncNE9qaOF7ZluTZT*mo9Ip5RMQMMRdv*NMOgBsnZTap5Nyompv*h7uRPACR1XfgRTDNXsCOJtnr4g0yb55bnisDwAH37InQwkAhZqXirOG9rM7cVGbr1i9rwSLeX6GAUFBbCEaUwiSMMHOXaJNE*LoB8XKo7j1wwSUqGtNFJShXAbhbhK4dbEyzCu5nnJtSPq5kEvunlP6Z4uCqIX9OF3KKK6lDWHHfqW*SkM!3kV6VeGfTrzlvBYMnH1wjGs1cZp*ReWdA$$';
const CLIENT_ID = '9e5f94bc-e8a4-4e73-b8be-63364c29d753';

const USER_ID = `probe_${Date.now()}`;
const SCREENSHOT_DIR = path.join(__dirname, '..', '..', 'data', 'screenshots', USER_ID);

async function logDOM(tabId, label) {
  console.log(`\n========== ${label} ==========`);
  const dom = await evalJson(tabId, USER_ID, `
    (() => {
      const body = document.body?.innerText || '';
      const url = location.href;
      const title = document.title;
      
      // Get all visible buttons
      const buttons = Array.from(document.querySelectorAll('button'))
        .filter(b => {
          const r = b.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        })
        .map(b => ({
          text: (b.innerText || b.textContent || '').trim().slice(0, 50),
          id: b.id || '',
          className: b.className || '',
          dataTestId: b.getAttribute('data-testid') || '',
          ariaLabel: b.getAttribute('aria-label') || '',
          type: b.type || '',
        }));
      
      // Get all visible inputs
      const inputs = Array.from(document.querySelectorAll('input'))
        .filter(i => {
          const r = i.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        })
        .map(i => ({
          type: i.type || '',
          name: i.name || '',
          id: i.id || '',
          placeholder: i.placeholder || '',
          autocomplete: i.autocomplete || '',
          className: i.className || '',
        }));
      
      // Get all links
      const links = Array.from(document.querySelectorAll('a'))
        .filter(a => {
          const r = a.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        })
        .map(a => ({
          text: (a.innerText || a.textContent || '').trim().slice(0, 50),
          href: a.href || '',
          id: a.id || '',
        }));
      
      return { url, title, body: body.slice(0, 500), buttons, inputs, links };
    })()
  `, 5000);
  
  console.log(`URL: ${dom.url}`);
  console.log(`Title: ${dom.title}`);
  console.log(`Body preview: ${dom.body}`);
  console.log(`\n--- BUTTONS (${dom.buttons.length}) ---`);
  dom.buttons.forEach((b, i) => {
    console.log(`  [${i}] text="${b.text}" id="${b.id}" data-testid="${b.dataTestId}" aria-label="${b.ariaLabel}" type="${b.type}"`);
  });
  console.log(`\n--- INPUTS (${dom.inputs.length}) ---`);
  dom.inputs.forEach((i, idx) => {
    console.log(`  [${idx}] type="${i.type}" name="${i.name}" id="${i.id}" placeholder="${i.placeholder}" autocomplete="${i.autocomplete}"`);
  });
  console.log(`\n--- LINKS (${dom.links.length}) ---`);
  dom.links.forEach((l, i) => {
    console.log(`  [${i}] text="${l.text}" href="${l.href}"`);
  });
  
  return dom;
}

async function findElementXPath(tabId, searchText) {
  return evalJson(tabId, USER_ID, `
    (() => {
      const all = Array.from(document.querySelectorAll('*'));
      for (const el of all) {
        const text = (el.innerText || el.textContent || '').trim();
        if (text.toLowerCase().includes('${searchText.toLowerCase()}')) {
          // Get XPath
          const getXPath = (element) => {
            if (element.id) {
              return '//*[@id="' + element.id + '"]';
            }
            if (element === document.body) {
              return element.tagName;
            }
            let ix = Array.from(element.parentNode.children).indexOf(element) + 1;
              return getXPath(element.parentNode) + '/' + element.tagName + '[' + ix + ']';
          };
          return {
            text: text.slice(0, 100),
            tagName: el.tagName,
            id: el.id,
            className: el.className,
            dataTestId: el.getAttribute('data-testid'),
            ariaLabel: el.getAttribute('aria-label'),
            xpath: getXPath(el)
          };
        }
      }
      return null;
    })()
  `, 5000);
}

async function runProbe(iteration = 1, maxIterations = 5) {
  console.log(`\n========================================`);
  console.log(`ITERATION ${iteration}/${maxIterations}`);
  console.log(`========================================`);
  
  let tabId = null;
  try {
    // Tạo tab
    const tabRes = await camofoxPostWithSessionKey('/tabs', {
      userId: USER_ID,
      url: 'https://chatgpt.com/auth/login',
      headless: false,
      humanize: true,
    });
    tabId = tabRes.tabId;
    console.log(`Tab ID: ${tabId}`);
    
    await new Promise(r => setTimeout(r, 5000));
    await logDOM(tabId, 'INITIAL LOGIN PAGE');
    
    // Click Sign up
    console.log(`\n>>> Clicking Sign up...`);
    await evalJson(tabId, USER_ID, `
      (() => {
        const hasEmailInput = !!document.querySelector('input[type="email"], input[name="email"]');
        if (hasEmailInput) return { skipped: true, reason: 'email-input-present' };
        
        const signup = Array.from(document.querySelectorAll('a, button, div[role="button"]'))
          .find(el => {
            const t = (el.innerText || el.textContent || '').toLowerCase().trim();
            return t === 'sign up' || t === 'sign up for free';
          });
        if (signup) {
          signup.click();
          return { clicked: true, text: signup.innerText.trim() };
        }
        return { skipped: true, reason: 'no-signup-found' };
      })()
    `, 5000);
    
    await new Promise(r => setTimeout(r, 4000));
    await logDOM(tabId, 'AFTER SIGNUP CLICK');
    
    // Điền email
    console.log(`\n>>> Filling email: ${EMAIL}`);
    await evalJson(tabId, USER_ID, `
      (() => {
        const emailInput = document.querySelector('input[type="email"], input[name="email"], input[autocomplete="email"]');
        if (!emailInput) return { error: 'no-email-input' };
        
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(emailInput, '${EMAIL}');
        emailInput.dispatchEvent(new Event('input', { bubbles: true }));
        emailInput.dispatchEvent(new Event('change', { bubbles: true }));
        
        // Find and click Continue button (NOT "with Google/Apple")
        const btn = Array.from(document.querySelectorAll('button'))
          .find(b => {
            const t = (b.innerText || b.textContent || '').toLowerCase();
            return !t.includes('with') && (t === 'continue' || t === 'tiếp tục');
          });
        if (btn) btn.click();
        return { ok: true };
      })()
    `, 5000);
    
    await new Promise(r => setTimeout(r, 5000));
    const afterEmailDom = await logDOM(tabId, 'AFTER EMAIL SUBMIT - NEW SCREEN');
    
    // Tìm nút "Create with password" hoặc tương tự
    console.log(`\n>>> Searching for "Create with password" button...`);
    const createPwdBtn = await findElementXPath(tabId, 'create with password');
    console.log(`Result:`, JSON.stringify(createPwdBtn, null, 2));
    
    // Tìm nút "password" liên quan
    console.log(`\n>>> Searching for elements with "password"...`);
    const passwordEls = await evalJson(tabId, USER_ID, `
      (() => {
        const all = Array.from(document.querySelectorAll('*'));
        return all
          .filter(el => {
            const text = (el.innerText || el.textContent || '').toLowerCase();
            return text.includes('password') && el.getBoundingClientRect().width > 0;
          })
          .map(el => ({
            tagName: el.tagName,
            text: (el.innerText || el.textContent || '').trim().slice(0, 80),
            id: el.id,
            className: el.className,
            dataTestId: el.getAttribute('data-testid'),
            ariaLabel: el.getAttribute('aria-label'),
            href: el.href || '',
            role: el.getAttribute('role'),
          }))
          .slice(0, 10);
      })()
    `, 5000);
    console.log(`Password-related elements:`, JSON.stringify(passwordEls, null, 2));
    
    // Tìm các nút "Continue" trên màn hình mới
    console.log(`\n>>> All "Continue" buttons on current screen...`);
    const continueBtns = await evalJson(tabId, USER_ID, `
      (() => {
        return Array.from(document.querySelectorAll('button, a, div[role="button"]'))
          .filter(b => {
            const text = (b.innerText || b.textContent || '').toLowerCase();
            const r = b.getBoundingClientRect();
            return text.includes('continue') && r.width > 0 && r.height > 0;
          })
          .map(b => ({
            text: (b.innerText || b.textContent || '').trim(),
            id: b.id,
            dataTestId: b.getAttribute('data-testid'),
            ariaLabel: b.getAttribute('aria-label'),
            tagName: b.tagName,
          }));
      })()
    `, 5000);
    console.log(`Continue buttons:`, JSON.stringify(continueBtns, null, 2));
    
    // Chụp screenshot
    console.log(`\n>>> Taking screenshot...`);
    try {
      const screenshotRes = await camofoxPostWithSessionKey(`/tabs/${tabId}/screenshot`, { userId: USER_ID });
      console.log(`Screenshot saved:`, screenshotRes);
    } catch (e) {
      console.log(`Screenshot failed: ${e.message}`);
    }

    // Cleanup
    await camofoxPostWithSessionKey(`/tabs/${tabId}?userId=${USER_ID}`, {}, 3000).catch(() => {});
    
    if (iteration < maxIterations) {
      console.log(`\nWaiting 10s before next iteration...`);
      await new Promise(r => setTimeout(r, 10000));
      return runProbe(iteration + 1, maxIterations);
    }
    
  } catch (err) {
    console.error(`ERROR in iteration ${iteration}:`, err.message);
    if (tabId) {
      await camofoxPostWithSessionKey(`/tabs/${tabId}?userId=${USER_ID}`, {}, 3000).catch(() => {});
    }
    throw err;
  }
}

// Run
runProbe(1, 3)
  .then(() => console.log('\n✅ Probe completed'))
  .catch(err => console.error('\n❌ Probe failed:', err));
