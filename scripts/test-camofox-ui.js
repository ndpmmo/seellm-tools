/**
 * Test script để khám phá UI ChatGPT landing page mới
 * Mở tab, lấy snapshot, thử click các nút để tìm đúng selector
 */
import { camofoxPost, camofoxGet, evalJson } from './lib/camofox.js';

const CAMOUFOX_API = 'http://localhost:3144';
const TEST_USER_ID = 'test_ui_discovery';
const TEST_SESSION_KEY = 'test_session';
// Test KHÔNG dùng proxy - lấy DOM thực tế
const TEST_PROXY = null;

async function testCamofoxUI() {
  console.log('🔬 Bắt đầu test Camofox UI discovery...\n');

  try {
    // 1. Mở tab tới ChatGPT login KHÔNG dùng proxy
    console.log('[1] Mở tab tới https://chatgpt.com/auth/login (không proxy)');
    const { tabId } = await camofoxPost('/tabs', {
      userId: TEST_USER_ID,
      sessionKey: TEST_SESSION_KEY,
      url: 'https://chatgpt.com/auth/login',
      proxy: TEST_PROXY || undefined,
      persistent: false,
      os: 'macos',
      screen: { width: 1440, height: 900 },
      humanize: true,
      headless: false,
    }, { timeoutMs: 60000 });
    console.log(`✅ Tab mở thành công: ${tabId}\n`);

    // Đợi page load lâu hơn
    await new Promise(r => setTimeout(r, 5000));

    // 2. Lấy snapshot đầu tiên
    console.log('[2] Lấy snapshot ban đầu...');
    const snap1 = await camofoxGet(`/tabs/${tabId}/snapshot?userId=${TEST_USER_ID}`);
    console.log(`URL: ${snap1.url}`);
    console.log(`Title: ${snap1.title}`);
    console.log(`Snapshot length: ${(snap1.snapshot || '').length} chars\n`);

    // 3. Debug DOM structure
    console.log('[3] Debug DOM structure...');
    const domInfo = await evalJson(tabId, TEST_USER_ID, `
      (async () => {
        const isVisible = (el) => {
          if (!el) return false;
          const s = window.getComputedStyle(el);
          const r = el.getBoundingClientRect();
          return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
        };

        // Tất cả buttons/links visible
        const allButtons = Array.from(document.querySelectorAll('button, a, [role="button"], div[role="button"]'))
          .filter(isVisible)
          .slice(0, 20)
          .map(el => ({
            tag: el.tagName.toLowerCase(),
            text: (el.innerText || el.textContent || '').trim().slice(0, 50),
            dataTestId: el.getAttribute('data-testid') || null,
            ariaLabel: el.getAttribute('aria-label') || null,
            ariaExpanded: el.getAttribute('aria-expanded') || null,
            href: el.getAttribute('href') || null,
            id: el.id || null,
            className: el.className || null,
          }));

        // Tất cả inputs visible
        const allInputs = Array.from(document.querySelectorAll('input, textarea'))
          .filter(isVisible)
          .slice(0, 10)
          .map(el => ({
            tag: el.tagName.toLowerCase(),
            type: el.type || null,
            name: el.name || null,
            id: el.id || null,
            placeholder: el.getAttribute('placeholder') || null,
            autocomplete: el.getAttribute('autocomplete') || null,
          }));

        // Form elements
        const forms = Array.from(document.querySelectorAll('form'))
          .map(f => ({
            action: f.action || null,
            method: f.method || null,
            inputCount: f.querySelectorAll('input').length,
          }));

        return {
          url: location.href,
          title: document.title,
          buttons: allButtons,
          inputs: allInputs,
          forms,
        };
      })()
    `, 10000);

    console.log('\n=== BUTTONS VISIBLE ===');
    domInfo.buttons.forEach((btn, i) => {
      console.log(`[${i}] ${btn.tag} | text: "${btn.text}" | testId: ${btn.dataTestId} | aria-label: ${btn.ariaLabel} | aria-expanded: ${btn.ariaExpanded} | href: ${btn.href}`);
    });

    console.log('\n=== INPUTS VISIBLE ===');
    domInfo.inputs.forEach((inp, i) => {
      console.log(`[${i}] ${inp.tag} | type: ${inp.type} | name: ${inp.name} | id: ${inp.id} | placeholder: ${inp.placeholder} | autocomplete: ${inp.autocomplete}`);
    });

    console.log('\n=== FORMS ===');
    domInfo.forms.forEach((f, i) => {
      console.log(`[${i}] action: ${f.action} | method: ${f.method} | inputs: ${f.inputCount}`);
    });

    // 4. Check Google popup overlay
    console.log('\n[4] Check Google popup overlay...');
    const overlayInfo = await evalJson(tabId, TEST_USER_ID, `
      (async () => {
        const isVisible = (el) => {
          if (!el) return false;
          const s = window.getComputedStyle(el);
          const r = el.getBoundingClientRect();
          return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
        };

        // Google iframes
        const googleIframes = Array.from(document.querySelectorAll('iframe')).filter(isVisible)
          .map(iframe => ({
            src: iframe.src || '',
            width: iframe.width,
            height: iframe.height,
          }));

        // Dialogs/modals
        const dialogs = Array.from(document.querySelectorAll('[role="dialog"], .modal, .popup, [class*="overlay" i]'))
          .filter(isVisible)
          .map(el => ({
            tag: el.tagName.toLowerCase(),
            className: el.className || null,
            text: (el.innerText || el.textContent || '').trim().slice(0, 100),
          }));

        // Close buttons
        const closeButtons = Array.from(document.querySelectorAll('button, div[role="button"]'))
          .filter(isVisible)
          .filter(el => {
            const text = (el.innerText || el.textContent || '').trim().toLowerCase();
            const aria = (el.getAttribute('aria-label') || '').toLowerCase();
            return text === '✕' || text === '×' || text === 'x' || aria.includes('close');
          })
          .map(el => ({
            text: (el.innerText || el.textContent || '').trim(),
            ariaLabel: el.getAttribute('aria-label'),
          }));

        return { googleIframes, dialogs, closeButtons };
      })()
    `, 5000);

    console.log('=== GOOGLE IFRAMES ===');
    overlayInfo.googleIframes.forEach((f, i) => {
      console.log(`[${i}] src: ${f.src} | ${f.width}x${f.height}`);
    });

    console.log('\n=== DIALOGS/MODALS ===');
    overlayInfo.dialogs.forEach((d, i) => {
      console.log(`[${i}] ${d.tag} | class: ${d.className} | text: "${d.text}"`);
    });

    console.log('\n=== CLOSE BUTTONS ===');
    overlayInfo.closeButtons.forEach((c, i) => {
      console.log(`[${i}] text: "${c.text}" | aria-label: ${c.ariaLabel}`);
    });

    // 5. Thử click "Log in" trực tiếp
    console.log('\n[5] Thử click "Log in" button...');
    const clickResult = await evalJson(tabId, TEST_USER_ID, `
      (async () => {
        const isVisible = (el) => {
          if (!el) return false;
          const s = window.getComputedStyle(el);
          const r = el.getBoundingClientRect();
          return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
        };

        const loginBtn = document.querySelector('button[data-testid="login-button"]');
        if (!loginBtn || !isVisible(loginBtn)) {
          return { ok: false, reason: 'not-found-or-hidden' };
        }

        // Click với mouse events
        try {
          loginBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
          loginBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
        } catch (_) {}
        loginBtn.click();

        await new Promise(r => setTimeout(r, 2000));

        return { 
          ok: true, 
          url: location.href,
          hasEmailInput: !!document.querySelector('input[type="email"], input[name="email"]'),
          hasPasswordInput: !!document.querySelector('input[type="password"]'),
        };
      })()
    `, 8000);

    console.log('Click result:', clickResult);

    // 6. Lấy snapshot sau click
    console.log('\n[6] Lấy snapshot sau khi click "Log in"...');
    await new Promise(r => setTimeout(r, 3000));
    const snap2 = await camofoxGet(`/tabs/${tabId}/snapshot?userId=${TEST_USER_ID}`);
    console.log(`URL sau click: ${snap2.url}`);
    console.log(`Snapshot length: ${(snap2.snapshot || '').length} chars`);

    // Debug lại DOM sau click
    const domInfo2 = await evalJson(tabId, TEST_USER_ID, `
      (async () => {
        const isVisible = (el) => {
          if (!el) return false;
          const s = window.getComputedStyle(el);
          const r = el.getBoundingClientRect();
          return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
        };

        const allInputs = Array.from(document.querySelectorAll('input, textarea'))
          .filter(isVisible)
          .slice(0, 15)
          .map(el => ({
            tag: el.tagName.toLowerCase(),
            type: el.type || null,
            name: el.name || null,
            id: el.id || null,
            placeholder: el.getAttribute('placeholder') || null,
          }));

        return { inputs: allInputs };
      })()
    `, 10000);

    console.log('\n=== INPUTS SAU CLICK LOG IN ===');
    domInfo2.inputs.forEach((inp, i) => {
      console.log(`[${i}] ${inp.tag} | type: ${inp.type} | name: ${inp.name} | id: ${inp.id} | placeholder: ${inp.placeholder}`);
    });

    // 5. Lưu screenshot
    console.log('\n[6] Lưu screenshot...');
    const screenshot = await camofoxGet(`/tabs/${tabId}/screenshot?userId=${TEST_USER_ID}`);
    console.log(`Screenshot saved: ${screenshot.path || 'unknown'}`);

  } catch (err) {
    console.error('❌ Lỗi:', err.message);
    console.error(err.stack);
  } finally {
    // Đóng tab
    try {
      const tabs = await camofoxGet(`/tabs?userId=${TEST_USER_ID}`);
      if (Array.isArray(tabs)) {
        for (const tab of tabs) {
          await camofoxPost(`/tabs/${tab.tabId}?userId=${TEST_USER_ID}`, null, { method: 'DELETE' });
        }
      }
      console.log('\n🧹 Đã đóng test tab');
    } catch (_) {}
  }
}

// Chạy test
testCamofoxUI().catch(console.error);
