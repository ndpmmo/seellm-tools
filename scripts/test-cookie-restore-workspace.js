#!/usr/bin/env node
/**
 * scripts/test-cookie-restore-workspace.js
 * 
 * Target account: rafaelfreemaniorz@hotmail.com (acc_b7468014)
 * Purpose: Test workspace selection when RESTORING COOKIES (Session restore).
 * Steps:
 *  1. Load stored cookies and proxy of acc_b7468014 from data/vault.db.
 *  2. Launch a Camofox tab with the account's proxy.
 *  3. Inject the cookies into the Camofox session.
 *  4. Navigate to https://chatgpt.com/workspace or https://chatgpt.com/
 *  5. Check page state, dump DOM, capture screenshots at every step.
 *  6. Invoke `selectPersonalWorkspaceOnWorkspacePage()` to select "Personal account".
 *  7. Confirm we reach the logged-in Chat Dashboard.
 */

import { CAMOUFOX_API } from './config.js';
import { camofoxPost, camofoxGet, camofoxDelete, evalJson, navigate } from './lib/camofox.js';
import { getState, selectPersonalWorkspaceOnWorkspacePage } from './lib/openai-login-flow.js';
import { normalizeProxyUrl } from './lib/proxy-diag.js';
import Database from 'better-sqlite3';
import fs from 'node:fs/promises';
import path from 'node:path';

const EMAIL = 'rafaelfreemaniorz@hotmail.com';
const USER_ID = `cookie_restore_ws_${Date.now()}`;
const DATA_DIR = path.resolve('data', 'screenshots', `workspace_restore_acc_b7468014`);

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
      log('SCREENSHOT', `Saved screenshot: ${filepath}`);
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
    log('START', `Starting cookie restoration workspace test for ${EMAIL}`);

    // 1. Fetch account cookies and proxy from database
    const DB_PATH = path.resolve('data/vault.db');
    log('DB', `Loading credentials from ${DB_PATH}...`);
    const db = new Database(DB_PATH);
    const account = db.prepare('SELECT id, proxy_url, cookies FROM vault_accounts WHERE email = ?').get(EMAIL);

    if (!account) {
      throw new Error(`Account ${EMAIL} not found in database!`);
    }
    if (!account.cookies) {
      throw new Error(`Account ${EMAIL} has no cookies in database!`);
    }

    const cookies = JSON.parse(account.cookies);
    log('DB', `Loaded ${cookies.length} cookies from DB.`);
    
    let proxyConfig = undefined;
    if (account.proxy_url) {
      proxyConfig = normalizeProxyUrl(account.proxy_url);
      log('PROXY', `Using proxy: ${JSON.stringify(proxyConfig)}`);
    } else {
      log('PROXY', `No proxy configured in DB.`);
    }

    // 2. Launch Camofox Tab
    const launchOptions = {
      userId: USER_ID,
      sessionKey: `restore_ws_test_${Date.now()}`,
      url: 'about:blank', // start on neutral domain
      persistent: false,
      os: 'macos',
      screen: { width: 1440, height: 900 },
      headless: false,
      proxy: proxyConfig || undefined
    };

    log('CAMOFOX', 'Opening Camoufox tab...');
    const opened = await camofoxPost('/tabs', launchOptions, { timeoutMs: 35000 });
    tabId = opened.tabId;
    log('CAMOFOX', `Tab opened successfully: ${tabId}`);

    // Wait on neutral page
    await new Promise(r => setTimeout(r, 4000));
    await takeScreenshotAndSave(tabId, '01_neutral_page_loaded.png');

    // 3. Inject Cookies
    log('COOKIES', `Injecting ${cookies.length} cookies into browser session...`);
    const injectRes = await fetch(`${CAMOUFOX_API}/sessions/${USER_ID}/cookies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookies })
    });
    
    if (injectRes.ok) {
      log('COOKIES', 'Cookies successfully injected!');
    } else {
      throw new Error(`Failed to inject cookies into session: ${injectRes.status}`);
    }

    // 4. Navigate to ChatGPT Home
    const targetUrl = 'https://chatgpt.com/';
    log('NAVIGATE', `Navigating to ChatGPT: ${targetUrl}`);
    await navigate(tabId, USER_ID, targetUrl, 30000);
    
    log('WAIT', 'Waiting 8 seconds for page to settle and load...');
    await new Promise(r => setTimeout(r, 8000));
    await takeScreenshotAndSave(tabId, '02_workspace_landing_page.png');

    // 5. Evaluate and diagnose workspace screen DOM
    const currentUrl = await evalJson(tabId, USER_ID, 'location.href');
    log('DIAG', `Current URL: ${currentUrl}`);

    let state = await getState(tabId, USER_ID);
    log('STATE', `Page State: ${JSON.stringify(state)}`);

    // Let's dump all button/div/option elements to inspect DOM layout on this ChatGPT page
    const elementsDump = await evalJson(tabId, USER_ID, `(() => {
      const results = [];
      const clickables = document.querySelectorAll('button, [role="button"], [role="option"], a, div');
      for (const el of clickables) {
        if (el.offsetParent === null) continue;
        const text = (el.textContent || '').trim();
        if (!text || text.length > 200) continue;
        const tagName = el.tagName.toLowerCase();
        
        // Extract attributes
        const attrs = {};
        for (const attr of el.attributes) {
          attrs[attr.name] = attr.value;
        }
        
        results.push({
          tag: el.tagName,
          text,
          classes: el.className,
          attributes: attrs
        });
      }
      return results;
    })()`);

    log('DOM_DUMP', `Found ${elementsDump.length} visible elements. Saving DOM dump JSON...`);
    const dumpPath = path.join(DATA_DIR, 'workspace_dom_dump.json');
    await fs.writeFile(dumpPath, JSON.stringify(elementsDump, null, 2));
    log('DOM_DUMP', `DOM dump saved to: ${dumpPath}`);

    // 6. Select the Personal Workspace using library method
    log('SELECT_WS', 'Invoking selectPersonalWorkspaceOnWorkspacePage()...');
    const wsResult = await selectPersonalWorkspaceOnWorkspacePage(tabId, USER_ID, { timeoutMs: 25000, waitRedirect: true });
    log('SELECT_WS_RESULT', `Result: ${JSON.stringify(wsResult)}`);
    
    await new Promise(r => setTimeout(r, 6000));
    await takeScreenshotAndSave(tabId, '03_after_workspace_selection.png');

    // 7. Verify final dashboard landing
    const finalUrl = await evalJson(tabId, USER_ID, 'location.href');
    log('FINAL', `Final URL: ${finalUrl}`);
    
    const finalState = await getState(tabId, USER_ID);
    log('FINAL_STATE', `Final State: ${JSON.stringify(finalState)}`);
    
    await takeScreenshotAndSave(tabId, '04_final_dashboard_page.png');

    if (finalState.looksLoggedIn && finalUrl.includes('chatgpt.com') && !finalUrl.includes('/workspace')) {
      log('SUCCESS', '🎉 Successfully bypassed/selected personal workspace and reached logged-in chat dashboard!');
    } else {
      log('FAILURE', '❌ Failed to reach logged-in chat dashboard after workspace selection.');
    }

  } catch (err) {
    log('ERROR', `Error in main: ${err.message}`);
    console.error(err);
  } finally {
    if (tabId) {
      log('CLEANUP', 'Closing Camofox tab...');
      await camofoxDelete(`/tabs/${tabId}?userId=${USER_ID}`);
      log('CLEANUP', 'Tab closed.');
    }
  }
}

main();
