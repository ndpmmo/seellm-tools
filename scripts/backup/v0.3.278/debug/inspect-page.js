#!/usr/bin/env node
/**
 * scripts/debug/inspect-page.js
 * 
 * Debug script to inspect ChatGPT login/signup page and extract DOM information.
 * Helps identify selectors, IDs, data-testid attributes, and XPath for elements.
 */

import { camofoxPost, camofoxGet, camofoxDelete } from '../lib/camofox.js';
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

async function inspectPage() {
  try {
    console.log('==========================================');
    console.log('🔍 ChatGPT Login/Signup Page Inspector');
    console.log('==========================================\n');

    // Create tab
    console.log('[1] Creating tab...');
    const tabRes = await camofoxPost('/tabs', {
      userId: USER_ID,
      url: 'https://chatgpt.com/auth/login',
      headless: false,
      humanize: true,
    });
    tabId = tabRes.tabId;
    console.log(`✅ Tab ID: ${tabId}\n`);

    // Wait for page to load
    await new Promise(r => setTimeout(r, 5000));

    // Get snapshot
    console.log('[2] Getting page snapshot...');
    const snapshot = await camofoxGet(`/tabs/${tabId}/snapshot?userId=${USER_ID}`);
    console.log(`📄 URL: ${snapshot.url}`);
    console.log(`📄 Title: ${snapshot.title}\n`);

    // Extract DOM information
    console.log('[3] Extracting DOM elements...\n');
    
    const domInfo = await camofoxPost(`/tabs/${tabId}/evaluate`, {
      userId: USER_ID,
      expression: `(() => {
        const result = {
          url: location.href,
          title: document.title,
          buttons: [],
          inputs: [],
          links: [],
          allClickable: [],
          rawHTML: document.body.innerHTML.slice(0, 5000)
        };

        // Helper to generate XPath
        function getXPath(element) {
          if (element.id) {
            return '//*[@id="' + element.id + '"]';
          }
          if (element === document.body) {
            return element.tagName.toLowerCase();
          }
          
          let ix = Array.from(element.parentNode.children).indexOf(element) + 1;
          let name = element.tagName.toLowerCase();
          
          if (element.className) {
            const classes = element.className.split(' ').filter(c => c).slice(0, 2);
            if (classes.length > 0) {
              return '//' + name + '[contains(@class, "' + classes[0] + '")][' + ix + ']';
            }
          }
          
          return '//' + name + '[' + ix + ']';
        }

        // Extract buttons
        try {
          const btns = document.querySelectorAll('button');
          btns.forEach(btn => {
            const text = (btn.innerText || btn.textContent || '').trim().slice(0, 50);
            result.buttons.push({
              text: text,
              id: btn.id || null,
              className: btn.className || null,
              dataTestId: btn.getAttribute('data-testid') || null,
              type: btn.type || null,
              xpath: getXPath(btn),
              visible: btn.offsetWidth > 0 && btn.offsetHeight > 0
            });
          });
        } catch (e) {
          result.buttons = [{ error: String(e) }];
        }

        // Extract inputs
        try {
          const inps = document.querySelectorAll('input');
          inps.forEach(input => {
            result.inputs.push({
              type: input.type || null,
              name: input.name || null,
              id: input.id || null,
              className: input.className || null,
              placeholder: input.placeholder || null,
              dataTestId: input.getAttribute('data-testid') || null,
              xpath: getXPath(input),
              visible: input.offsetWidth > 0 && input.offsetHeight > 0
            });
          });
        } catch (e) {
          result.inputs = [{ error: String(e) }];
        }

        // Extract links with role="button"
        try {
          const links = document.querySelectorAll('a[role="button"], a.btn, button');
          links.forEach(link => {
            const text = (link.innerText || link.textContent || '').trim().slice(0, 50);
            const isButton = link.tagName === 'BUTTON' || link.getAttribute('role') === 'button';
            if (isButton) {
              result.allClickable.push({
                tag: link.tagName,
                text: text,
                id: link.id || null,
                className: link.className || null,
                dataTestId: link.getAttribute('data-testid') || null,
                role: link.getAttribute('role') || null,
                xpath: getXPath(link),
                visible: link.offsetWidth > 0 && link.offsetHeight > 0
              });
            }
          });
        } catch (e) {
          result.allClickable.push({ error: String(e) });
        }

        // Extract all elements with data-testid
        try {
          const els = document.querySelectorAll('[data-testid]');
          els.forEach(el => {
            result.allClickable.push({
              tag: el.tagName,
              dataTestId: el.getAttribute('data-testid'),
              id: el.id || null,
              className: el.className || null,
              text: (el.innerText || el.textContent || '').trim().slice(0, 30),
              xpath: getXPath(el),
              visible: el.offsetWidth > 0 && el.offsetHeight > 0
            });
          });
        } catch (e) {
          // Ignore
        }

        return result;
      })()`
    });

    console.log('📄 Raw response from camofox:', JSON.stringify(domInfo).slice(0, 500));
    
    // Camofox returns result in .result property
    const data = domInfo.result || domInfo;
    console.log('📄 data.buttons:', data.buttons);
    console.log('📄 data.inputs:', data.inputs);
    console.log('📄 data.allClickable:', data.allClickable?.length || 0);

    console.log('📊 BUTTONS:');
    console.log('─'.repeat(80));
    if (data.buttons && data.buttons.length > 0) {
      data.buttons.forEach((btn, i) => {
        console.log(`${i + 1}. Text: "${btn.text}"`);
        if (btn.id) console.log(`   ID: #${btn.id}`);
        if (btn.className) console.log(`   Class: ${btn.className.slice(0, 80)}`);
        if (btn.dataTestId) console.log(`   data-testid: ${btn.dataTestId}`);
        console.log(`   XPath: ${btn.xpath}`);
        console.log(`   Visible: ${btn.visible}`);
        console.log();
      });
    } else {
      console.log('   No buttons found');
    }

    console.log('\n📊 INPUTS:');
    console.log('─'.repeat(80));
    if (data.inputs && data.inputs.length > 0) {
      data.inputs.forEach((input, i) => {
        console.log(`${i + 1}. Type: ${input.type || 'text'}`);
        if (input.name) console.log(`   Name: ${input.name}`);
        if (input.id) console.log(`   ID: #${input.id}`);
        if (input.placeholder) console.log(`   Placeholder: ${input.placeholder}`);
        if (input.className) console.log(`   Class: ${input.className.slice(0, 80)}`);
        if (input.dataTestId) console.log(`   data-testid: ${input.dataTestId}`);
        console.log(`   XPath: ${input.xpath}`);
        console.log(`   Visible: ${input.visible}`);
        console.log();
      });
    } else {
      console.log('   No inputs found');
    }

    console.log('\n📊 ALL CLICKABLE ELEMENTS (with data-testid or role="button"):');
    console.log('─'.repeat(80));
    if (data.allClickable && data.allClickable.length > 0) {
      data.allClickable.forEach((el, i) => {
        console.log(`${i + 1}. Tag: ${el.tag}`);
        if (el.text) console.log(`   Text: "${el.text}"`);
        if (el.id) console.log(`   ID: #${el.id}`);
        if (el.dataTestId) console.log(`   data-testid: ${el.dataTestId}`);
        if (el.role) console.log(`   Role: ${el.role}`);
        if (el.className) console.log(`   Class: ${el.className.slice(0, 80)}`);
        console.log(`   XPath: ${el.xpath}`);
        console.log(`   Visible: ${el.visible}`);
        console.log();
      });
    } else {
      console.log('   No clickable elements found');
    }

    // Save to JSON file
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const outputFile = path.join(__dirname, '..', '..', 'data', 'debug', `page-inspector-${Date.now()}.json`);
    
    await fs.mkdir(path.dirname(outputFile), { recursive: true });
    await fs.writeFile(outputFile, JSON.stringify(data, null, 2));
    console.log(`💾 Full data saved to: ${outputFile}`);

    console.log('\\n==========================================');
    console.log('✅ Inspection complete');
    console.log('==========================================');
    console.log('\\n💡 Tip: Tab is still open. You can manually inspect the page.');
    console.log('Press Ctrl+C to exit and close the tab.\n');

    // Keep tab open for manual inspection
    await new Promise(resolve => {
      process.on('SIGINT', resolve);
    });

  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
  } finally {
    await cleanup();
  }
}

inspectPage();
