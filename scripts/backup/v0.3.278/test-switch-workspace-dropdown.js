#!/usr/bin/env node
/**
 * scripts/test-switch-workspace-dropdown.js
 * 
 * Target account: rafaelfreemaniorz@hotmail.com (acc_b7468014)
 * Purpose: Test dismissing the wrong workspace modal and switching workspaces via the profile dropdown menu.
 */

import { CAMOUFOX_API } from './config.js';
import { camofoxPost, camofoxGet, camofoxDelete, evalJson, navigate } from './lib/camofox.js';
import { normalizeProxyUrl } from './lib/proxy-diag.js';
import Database from 'better-sqlite3';
import fs from 'node:fs/promises';
import path from 'node:path';

const EMAIL = 'rafaelfreemaniorz@hotmail.com';
const USER_ID = `dropdown_switch_test_${Date.now()}`;
const DATA_DIR = path.resolve('data', 'screenshots', `dropdown_switch_acc_b7468014`);

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
      log('SCREENSHOT', `Saved: ${filepath}`);
    }
  } catch (err) {
    log('SCREENSHOT', `Error: ${err.message}`);
  }
}

async function main() {
  let tabId = null;
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    log('START', `Starting dropdown workspace switch test for ${EMAIL}`);

    const DB_PATH = path.resolve('data/vault.db');
    const db = new Database(DB_PATH);
    const account = db.prepare('SELECT proxy_url, cookies FROM vault_accounts WHERE email = ?').get(EMAIL);

    if (!account || !account.cookies) {
      throw new Error('Account or cookies not found in DB!');
    }

    const cookies = JSON.parse(account.cookies);
    const proxyConfig = account.proxy_url ? normalizeProxyUrl(account.proxy_url) : undefined;

    // Launch tab
    const launchOptions = {
      userId: USER_ID,
      sessionKey: `dropdown_switch_test_${Date.now()}`,
      url: 'about:blank',
      persistent: false,
      os: 'macos',
      screen: { width: 1440, height: 900 },
      headless: false,
      proxy: proxyConfig
    };

    log('CAMOFOX', 'Opening Camoufox tab...');
    const opened = await camofoxPost('/tabs', launchOptions);
    tabId = opened.tabId;
    log('CAMOFOX', `Tab opened: ${tabId}`);
    await new Promise(r => setTimeout(r, 4000));

    // Inject cookies
    log('COOKIES', 'Injecting cookies...');
    await fetch(`${CAMOUFOX_API}/sessions/${USER_ID}/cookies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookies })
    });

    // Navigate to Chat homepage (triggers wrong workspace popup)
    log('NAVIGATE', 'Navigating to chatgpt.com (forces SeeLLM Codex workspace and plan popup)...');
    await navigate(tabId, USER_ID, 'https://chatgpt.com/', 30000);
    await new Promise(r => setTimeout(r, 8000));
    await takeScreenshotAndSave(tabId, '01_restricted_popup_showing.png');

    // 1. STEP 1: Dismiss the restricted plan popup (resolves backdrop block)
    log('DISMISS', 'Dismissing popup modal...');
    const dismissRes = await evalJson(tabId, USER_ID, `(() => {
      let actions = [];
      
      // Press Escape
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
      actions.push('escape_dispatched');

      // Click "Back to Codex" button
      const buttons = Array.from(document.querySelectorAll('button'));
      const backBtn = buttons.find(b => {
        const txt = (b.textContent || '').trim().toLowerCase();
        return txt.includes('back to codex') || txt.includes('codex');
      });
      
      if (backBtn) {
        backBtn.click();
        backBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        actions.push('clicked_back_to_codex');
      }

      // Click small close X button
      const closeBtn = buttons.find(b => {
        const label = (b.getAttribute('aria-label') || '').toLowerCase();
        const txt = (b.textContent || '').trim().toLowerCase();
        return label.includes('close') || txt === '✕' || txt === '×';
      });
      if (closeBtn) {
        closeBtn.click();
        closeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        actions.push('clicked_close_x');
      }

      return actions;
    })()`);
    
    log('DISMISS', `Dismiss Actions executed: ${JSON.stringify(dismissRes)}`);
    await new Promise(r => setTimeout(r, 4000));
    await takeScreenshotAndSave(tabId, '02_after_popup_dismissed.png');

    // 2. STEP 2: Open profile menu dropdown and select Personal Account
    log('SWITCH', 'Opening profile workspace menu...');
    const switchRes = await evalJson(tabId, USER_ID, `(async () => {
      const isVisible = el => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const s = window.getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
      };

      const profileBtn = document.querySelector('[data-testid="accounts-profile-button"]');
      if (!profileBtn || !isVisible(profileBtn)) return 'profile_button_not_visible';
      
      profileBtn.focus();
      profileBtn.click();
      profileBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      profileBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      profileBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      
      // Wait 2 seconds for menu
      await new Promise(r => setTimeout(r, 2000));
      
      // Dump menu items texts to see what is visible inRadix portal
      const menuItems = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"], button, div, a')).filter(isVisible);
      const itemsTexts = menuItems.map(el => (el.textContent || '').trim().slice(0, 50)).filter(Boolean);
      
      // Search for Personal account / workspace
      const personalKeywords = ['personal account', 'personal workspace', 'cá nhân', 'gabriel webb', 'personal'];
      const personalItem = menuItems.find(el => {
        const text = (el.textContent || '').toLowerCase().trim();
        if (!personalKeywords.some(k => text.includes(k))) return false;
        if (text.length > 120) return false;
        if (el === profileBtn || el.contains(profileBtn)) return false;
        
        // Ensure this is a leaf-like match (no child element also matches the personal keywords)
        const hasMatchingChild = Array.from(el.querySelectorAll('[role="menuitem"], [role="menuitemradio"], button, div, a')).some(child => {
          if (child === el) return false;
          const childText = (child.textContent || '').toLowerCase().trim();
          return personalKeywords.some(k => childText.includes(k)) && isVisible(child);
        });
        if (hasMatchingChild) return false;
        
        return true;
      });
      
      if (personalItem) {
        personalItem.focus();
        personalItem.click();
        personalItem.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        personalItem.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        personalItem.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        return 'clicked_personal_item_in_menu: ' + (personalItem.textContent || '').trim();
      }
      
      return 'personal_item_not_found_in_items: ' + JSON.stringify(itemsTexts.slice(0, 30));
    })()`);

    log('SWITCH', `Switch Result: ${switchRes}`);
    await new Promise(r => setTimeout(r, 6000));
    await takeScreenshotAndSave(tabId, '03_after_workspace_switch.png');

    const finalUrl = await evalJson(tabId, USER_ID, 'location.href');
    log('FINAL', `Final URL: ${finalUrl}`);
    await takeScreenshotAndSave(tabId, '04_final_state.png');

  } catch (err) {
    log('ERROR', `Error: ${err.message}`);
  } finally {
    if (tabId) {
      log('CLEANUP', 'Closing tab...');
      await camofoxDelete(`/tabs/${tabId}?userId=${USER_ID}`);
    }
  }
}

main();
