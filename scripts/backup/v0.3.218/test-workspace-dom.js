#!/usr/bin/env node
/**
 * scripts/test-workspace-dom.js
 * 
 * Target account: rafaelfreemaniorz@hotmail.com (acc_b7468014)
 * Purpose: Open a Camofox tab, load cookies from local SQLite vault db, navigate to chatgpt.com,
 * wait for the workspace selection page, and dump all DOM element structures (specifically row buttons and personal keywords)
 * to data/workspace-dom-dump.json.
 */

import { CAMOUFOX_API, TOOLS_API_URL } from './config.js';
import { camofoxPost, camofoxDelete, evalJson, navigate, getSnapshot } from './lib/camofox.js';
import fs from 'node:fs/promises';
import path from 'node:path';

import Database from "better-sqlite3";

const EMAIL = 'rafaelfreemaniorz@hotmail.com';
const USER_ID = `test_dom_${Date.now()}`;

async function main() {
  let tabId = null;
  try {
    // Load directly from local SQLite vault db
    const db = new Database('./data/vault.db');
    const account = db.prepare("SELECT * FROM vault_accounts WHERE email = ?").get(EMAIL);
    if (!account) {
      throw new Error(`Account ${EMAIL} not found in vault db!`);
    }

    console.log(`[DOM-Test] Found account ID: ${account.id}. Fetching full credentials + cookies...`);
    const cookiesJson = db.prepare("SELECT cookies FROM vault_accounts WHERE id = ?").get(account.id)?.cookies;
    let cookies = [];
    try {
      cookies = cookiesJson ? JSON.parse(cookiesJson) : [];
    } catch (_) {}
    console.log(`[DOM-Test] Fetched! Cookie count: ${cookies.length}`);

    if (cookies.length === 0) {
      console.log(`[DOM-Test] WARNING: No cookies found for ${EMAIL}. We might see login screen instead.`);
    }

    // Initialize Camoufox Tab with our proxies (if any)
    const launchOptions = {
      userId: USER_ID,
      sessionKey: `dom_test_${Date.now()}`,
      url: 'https://chatgpt.com',
      persistent: false,
      os: 'macos',
      screen: { width: 1440, height: 900 },
      headless: false,
    };

    // If account has a proxy, set it
    if (account.proxy) {
      console.log(`[DOM-Test] Using proxy: ${account.proxy}`);
      launchOptions.proxy = account.proxy;
    }

    console.log(`[DOM-Test] Launching Camofox tab...`);
    const opened = await camofoxPost('/tabs', launchOptions, { timeoutMs: 30000 });
    tabId = opened.tabId;
    console.log(`[DOM-Test] Tab opened: ${tabId}`);

    // Wait a bit
    await new Promise(r => setTimeout(r, 4000));

    // Import cookies into the session if we have them
    if (cookies && cookies.length > 0) {
      console.log(`[DOM-Test] Importing cookies...`);
      await camofoxPost(`/sessions/${USER_ID}/cookies`, {
        userId: USER_ID,
        cookies: cookies
      });
      console.log(`[DOM-Test] Cookies loaded! Refreshing tab...`);
      await navigate(tabId, USER_ID, 'https://chatgpt.com');
      await new Promise(r => setTimeout(r, 8000));
    }

    // Wait and inspect
    console.log(`[DOM-Test] Taking snapshot and diagnosing current page URL...`);
    const currentUrl = await evalJson(tabId, USER_ID, 'location.href', { timeoutMs: 5000 });
    console.log(`[DOM-Test] Current URL: ${currentUrl}`);

    // Dump page source/snapshot
    const snapshot = await getSnapshot(tabId, USER_ID, { includeScreenshot: true });
    console.log(`[DOM-Test] Current title: ${snapshot.title}`);

    // Let's dump all clickable / row elements
    console.log(`[DOM-Test] Analysing DOM for buttons and text matching workspace selection...`);
    const domDump = await evalJson(tabId, USER_ID, `
      (() => {
        const results = [];
        const allEls = document.querySelectorAll('*');
        for (const el of allEls) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          
          const text = (el.innerText || el.textContent || '').trim();
          if (!text) continue;
          
          // Let's filter to interesting ones: buttons, list items, grids, or containers containing "workspace" or "open"
          const tagName = el.tagName.toLowerCase();
          const isInteractive = ['button', 'a', 'li'].includes(tagName) || 
                               el.getAttribute('role') === 'button' ||
                               el.getAttribute('role') === 'listitem' ||
                               el.getAttribute('role') === 'option';
                               
          const textLower = text.toLowerCase();
          const hasKeyword = textLower.includes('personal') || 
                             textLower.includes('workspace') || 
                             textLower.includes('open') || 
                             textLower.includes('mở') ||
                             textLower.includes('gabriel') ||
                             textLower.includes('seellm');
                             
          if (isInteractive || (hasKeyword && text.length < 300)) {
            // Get attributes
            const attrs = {};
            for (const attr of el.attributes) {
              attrs[attr.name] = attr.value;
            }
            
            results.push({
              tag: el.tagName,
              text: text.slice(0, 150),
              rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
              classes: el.className,
              attributes: attrs,
              childrenCount: el.childElementCount
            });
          }
        }
        return results;
      })()
    `, { timeoutMs: 10000 });

    const outputDir = './data';
    await fs.mkdir(outputDir, { recursive: true });
    const outputPath = path.join(outputDir, 'workspace-dom-dump.json');
    await fs.writeFile(outputPath, JSON.stringify({
      url: currentUrl,
      title: snapshot.title,
      elements: domDump
    }, null, 2));
    
    console.log(`[DOM-Test] DOM analysis successfully written to ${outputPath}!`);

    // Let's take a screenshot for visual validation
    if (snapshot.screenshot) {
      const screenshotPath = path.join(outputDir, 'workspace-screenshot.png');
      await fs.writeFile(screenshotPath, Buffer.from(snapshot.screenshot, 'base64'));
      console.log(`[DOM-Test] Screenshot saved to ${screenshotPath}`);
    }

  } catch (err) {
    console.error(`[DOM-Test] Error occurred:`, err);
  } finally {
    if (tabId) {
      console.log(`[DOM-Test] Cleaning up tab...`);
      await camofoxDelete(`/tabs/${tabId}?userId=${USER_ID}`);
      console.log(`[DOM-Test] Done.`);
    }
  }
}

main();
