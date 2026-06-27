/**
 * Diagnose ChatGPT composer submit behavior through Camofox.
 *
 * This script intentionally does not update account state. It opens ChatGPT
 * with the same account/proxy/cookies as warmup, then records DOM/screenshot
 * evidence before and after each submit strategy.
 */

import { CAMOUFOX_API, TOOLS_API_URL } from './config.js';
import { camofoxPost, camofoxGet, camofoxDelete, navigate, pressKey, evalJson, getSnapshot } from './lib/camofox.js';
import { normalizeProxyUrl, assertProxyApplied } from './lib/proxy-diag.js';
import Database from 'better-sqlite3';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function parseArgs() {
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const val = process.argv[i + 1];
    if (val && !val.startsWith('--')) {
      args[key] = val;
      i++;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function safeName(value) {
  return String(value || 'unknown').replace(/[^a-zA-Z0-9_.-]+/g, '_').slice(0, 80);
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, JSON.stringify(value, null, 2));
}

function safeParseJson(value, fallback) {
  if (Array.isArray(value) || (value && typeof value === 'object')) return value;
  try {
    return value ? JSON.parse(value) : fallback;
  } catch (_) {
    return fallback;
  }
}

async function getAccount(accountId) {
  try {
    const accountRes = await fetch(`${TOOLS_API_URL}/api/vault/accounts/${encodeURIComponent(accountId)}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (accountRes.ok) {
      const { account } = await accountRes.json();
      return { ...account, source: 'api' };
    }
    console.log(`[Diag] Local API returned ${accountRes.status}; falling back to data/vault.db`);
  } catch (err) {
    console.log(`[Diag] Local API unavailable (${err.message}); falling back to data/vault.db`);
  }

  const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dbPath = path.join(rootDir, 'data', 'vault.db');
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const account = db.prepare('SELECT * FROM vault_accounts WHERE id = ?').get(accountId);
    if (!account) throw new Error(`Account ${accountId} not found in ${dbPath}`);
    return {
      ...account,
      cookies: safeParseJson(account.cookies, []),
      tags: safeParseJson(account.tags, []),
      provider_specific_data: safeParseJson(account.provider_specific_data, {}),
      source: 'sqlite',
    };
  } finally {
    db.close();
  }
}

async function saveScreenshot(tabId, userId, outDir, label) {
  const filename = `${safeName(label)}.png`;
  try {
    const res = await fetch(`${CAMOUFOX_API}/tabs/${tabId}/screenshot?userId=${encodeURIComponent(userId)}&fullPage=false`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      await fs.writeFile(path.join(outDir, `${safeName(label)}.screenshot-error.txt`), `HTTP ${res.status}: ${await res.text()}`);
      return null;
    }
    const filePath = path.join(outDir, filename);
    await fs.writeFile(filePath, Buffer.from(await res.arrayBuffer()));
    return filePath;
  } catch (err) {
    await fs.writeFile(path.join(outDir, `${safeName(label)}.screenshot-error.txt`), err.message || String(err));
    return null;
  }
}

async function dumpState(tabId, userId, outDir, label) {
  const dom = await evalJson(tabId, userId, `(() => {
    const rectOf = el => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
    };
    const visible = el => !!(el && el.offsetParent !== null);
    const attrsOf = el => {
      if (!el) return {};
      const attrs = {};
      for (const attr of el.attributes || []) attrs[attr.name] = attr.value;
      return attrs;
    };
    const textOf = el => ((el?.innerText || el?.textContent || el?.value || '') + '').trim();
    const short = text => String(text || '').replace(/\\s+/g, ' ').slice(0, 500);
    const editor = document.querySelector('#prompt-textarea');
    const active = document.activeElement;
    const buttons = Array.from(document.querySelectorAll('button, [role="button"], [type="submit"], [aria-label], [data-testid]'))
      .map((el, idx) => {
        const label = el.getAttribute('aria-label') || '';
        const testId = el.getAttribute('data-testid') || '';
        const cls = typeof el.className === 'string' ? el.className : '';
        const txt = textOf(el);
        const rect = rectOf(el);
        const nearComposer = !!(editor && rect && Math.abs(rect.y - editor.getBoundingClientRect().y) < 220);
        const looksSubmit = /send|submit|prompt|composer|arrow|stop/i.test([label, testId, cls, txt].join(' '));
        return {
          idx,
          tag: el.tagName,
          role: el.getAttribute('role') || '',
          type: el.getAttribute('type') || '',
          ariaLabel: label,
          dataTestId: testId,
          disabled: !!el.disabled || el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true',
          visible: visible(el),
          text: short(txt),
          className: cls.slice(0, 300),
          rect,
          nearComposer,
          looksSubmit,
          html: el.outerHTML.slice(0, 1000),
        };
      })
      .filter(item => item.visible && (item.nearComposer || item.looksSubmit))
      .slice(0, 80);
    const forms = Array.from(document.querySelectorAll('form')).map((form, idx) => ({
      idx,
      visible: visible(form),
      rect: rectOf(form),
      text: short(textOf(form)),
      attrs: attrsOf(form),
      html: form.outerHTML.slice(0, 2000),
    }));
    const userMessageSelectors = [
      '[data-message-author-role="user"]',
      '[data-testid*="conversation-turn"] [data-message-author-role="user"]',
      'article [data-message-author-role="user"]',
      'main article',
    ];
    const userMessages = Array.from(document.querySelectorAll(userMessageSelectors.join(',')))
      .filter(el => visible(el) && !el.closest('form') && !el.closest('[contenteditable="true"]') && !el.closest('#prompt-textarea'))
      .map((el, idx) => ({ idx, tag: el.tagName, attrs: attrsOf(el), rect: rectOf(el), text: short(textOf(el)), html: el.outerHTML.slice(0, 1500) }))
      .slice(0, 20);
    const bodyText = document.body?.innerText || '';
    return {
      url: location.href,
      title: document.title,
      bodyTextSample: short(bodyText),
      bodyHasSessionExpired: /your session has expired|please log in again|try signing in again/i.test(bodyText),
      activeElement: active ? { tag: active.tagName, attrs: attrsOf(active), text: short(textOf(active)), rect: rectOf(active) } : null,
      composer: editor ? {
        exists: true,
        visible: visible(editor),
        tag: editor.tagName,
        role: editor.getAttribute('role') || '',
        contentEditable: editor.getAttribute('contenteditable') || '',
        attrs: attrsOf(editor),
        rect: rectOf(editor),
        value: editor.value || '',
        innerText: editor.innerText || '',
        textContent: editor.textContent || '',
        html: editor.outerHTML.slice(0, 3000),
        parentHtml: editor.parentElement?.outerHTML?.slice(0, 3000) || '',
      } : { exists: false },
      buttons,
      forms,
      userMessages,
    };
  })()`, { timeoutMs: 12000, maxRetries: 1 });

  const snapshot = await getSnapshot(tabId, userId, { timeoutMs: 12000 }).catch(err => ({ error: err.message }));
  const screenshot = await saveScreenshot(tabId, userId, outDir, label);
  await writeJson(path.join(outDir, `${safeName(label)}.dom.json`), dom);
  await writeJson(path.join(outDir, `${safeName(label)}.snapshot.json`), snapshot);
  return { label, screenshot, dom, snapshot };
}

async function clearAndType(tabId, userId, prompt) {
  await evalJson(tabId, userId, `(() => {
    const editor = document.querySelector('#prompt-textarea');
    if (!editor) return false;
    editor.focus();
    if ('value' in editor) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
        || Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      if (setter) setter.call(editor, '');
      else editor.value = '';
    } else {
      editor.replaceChildren();
    }
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', data: null }));
    return true;
  })()`, { timeoutMs: 8000 });
  await delay(500);
  await camofoxPost(`/tabs/${tabId}/type`, { userId, selector: '#prompt-textarea', text: prompt, mode: 'keyboard', delay: 5 }, { timeoutMs: 20000 });
  await delay(1000);
}

async function clickCandidateByDom(tabId, userId) {
  return evalJson(tabId, userId, `(() => {
    const editor = document.querySelector('#prompt-textarea');
    const candidates = Array.from(document.querySelectorAll('button, [role="button"], [type="submit"]'))
      .filter(el => el && el.offsetParent !== null && !el.disabled && !el.hasAttribute('disabled') && el.getAttribute('aria-disabled') !== 'true')
      .map(el => {
        const r = el.getBoundingClientRect();
        const label = el.getAttribute('aria-label') || '';
        const testId = el.getAttribute('data-testid') || '';
        const cls = typeof el.className === 'string' ? el.className : '';
        const txt = (el.innerText || el.textContent || '').trim();
        const near = editor ? Math.abs(r.y - editor.getBoundingClientRect().y) < 220 : true;
        const score = (near ? 10 : 0)
          + (/send|prompt|submit/i.test(label) ? 10 : 0)
          + (/send|prompt|submit/i.test(testId) ? 10 : 0)
          + (/composer-submit/i.test(cls) ? 8 : 0)
          + (r.width <= 80 && r.height <= 80 ? 2 : 0);
        return { el, score, label, testId, cls, txt, rect: { x: r.x, y: r.y, width: r.width, height: r.height } };
      })
      .sort((a, b) => b.score - a.score);
    const target = candidates[0];
    if (!target) return { ok: false, reason: 'no-candidate' };
    target.el.click();
    target.el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return { ok: true, label: target.label, testId: target.testId, text: target.txt, score: target.score, rect: target.rect };
  })()`, { timeoutMs: 8000, maxRetries: 1 });
}

async function run() {
  const args = parseArgs();
  const accountId = args.accountId;
  const prompt = args.prompt || 'Diagnostic test: please reply with one short sentence.';
  if (!accountId) {
    console.error('Usage: node scripts/diagnose-chatgpt-submit.js --accountId acc_xxx [--prompt "..."] [--keepOpen]');
    process.exit(1);
  }

  const started = new Date().toISOString().replace(/[:.]/g, '-');
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'diagnostics', `chatgpt-submit-${safeName(accountId)}-${started}`);
  await fs.mkdir(root, { recursive: true });
  console.log(`[Diag] Output: ${root}`);

  const account = await getAccount(accountId);
  await writeJson(path.join(root, 'account-source.json'), { source: account.source, id: account.id, email: account.email, cookies: Array.isArray(account.cookies) ? account.cookies.length : 0 });
  const effectiveProxy = normalizeProxyUrl(account.proxy_url || account.proxyUrl || account.proxy || null);
  const userId = `seellm_warmup_${account.id}`;
  const sessionKey = `warmup_${account.id}`;
  let tabId = null;

  try {
    if (effectiveProxy && !args.skipPreflight) {
      console.log(`[Diag] Proxy preflight: ${effectiveProxy}`);
      try {
        const preflight = await assertProxyApplied(effectiveProxy);
        console.log(`[Diag] Exit IP: ${preflight.exitIp}`);
        await writeJson(path.join(root, 'proxy-preflight.json'), preflight);
      } catch (err) {
        await writeJson(path.join(root, 'proxy-preflight-error.json'), { error: err.message || String(err) });
        throw err;
      }
    } else if (effectiveProxy) {
      console.log('[Diag] Skipping proxy preflight (--skipPreflight).');
    }

    const opened = await camofoxPost('/tabs', {
      userId,
      sessionKey,
      url: 'about:blank',
      proxy: effectiveProxy || undefined,
      persistent: true,
      os: 'macos',
      screen: { width: 1440, height: 900 },
      humanize: true,
      headless: false,
      blockResources: true,
    }, { timeoutMs: 35000 });
    tabId = opened.tabId;
    await writeJson(path.join(root, 'tab-opened.json'), opened);
    await delay(2500);

    if (Array.isArray(account.cookies) && account.cookies.length > 0) {
      console.log(`[Diag] Import cookies: ${account.cookies.length}`);
      const res = await fetch(`${CAMOUFOX_API}/sessions/${encodeURIComponent(userId)}/cookies`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cookies: account.cookies }),
      });
      await writeJson(path.join(root, 'cookie-import.json'), { ok: res.ok, status: res.status, text: await res.text().catch(() => '') });
      await delay(1500);
    }

    console.log('[Diag] Navigate ChatGPT');
    await navigate(tabId, userId, 'https://chatgpt.com/', { timeoutMs: 30000, waitUntil: 'commit' });
    await delay(8000);
    await dumpState(tabId, userId, root, '00_loaded');

    const attempts = [
      {
        name: '01_enter',
        action: async () => {
          await pressKey(tabId, userId, 'Enter');
          return { method: 'press-enter' };
        },
      },
      {
        name: '02_camofox_click_send_selector',
        action: async () => camofoxPost(`/tabs/${tabId}/click`, {
          userId,
          selector: 'button[data-testid="send-button"], button[aria-label="Send prompt"], button[class*="composer-submit"]',
          timeoutMs: 5000,
        }, { timeoutMs: 8000 }),
      },
      {
        name: '03_dom_click_best_candidate',
        action: async () => clickCandidateByDom(tabId, userId),
      },
      {
        name: '04_type_with_press_enter',
        action: async () => camofoxPost(`/tabs/${tabId}/type`, {
          userId,
          selector: '#prompt-textarea',
          text: '',
          mode: 'keyboard',
          pressEnter: true,
          delay: 5,
        }, { timeoutMs: 15000 }),
      },
    ];

    for (const attempt of attempts) {
      console.log(`[Diag] Attempt ${attempt.name}`);
      await clearAndType(tabId, userId, prompt);
      await dumpState(tabId, userId, root, `${attempt.name}_before`);
      const actionResult = await attempt.action().catch(err => ({ ok: false, error: err.message }));
      await writeJson(path.join(root, `${safeName(attempt.name)}.action.json`), actionResult);
      await delay(5000);
      const after = await dumpState(tabId, userId, root, `${attempt.name}_after`);
      const hasMessage = after?.dom?.userMessages?.some(msg => msg.text.includes(prompt.slice(0, 40)));
      console.log(`[Diag] ${attempt.name}: hasUserMessage=${!!hasMessage}, composerLen=${after?.dom?.composer?.innerText?.length || after?.dom?.composer?.textContent?.length || 0}, sessionExpired=${after?.dom?.bodyHasSessionExpired}`);
      if (hasMessage || after?.dom?.bodyHasSessionExpired) break;
    }

    console.log(`[Diag] Done. Output: ${root}`);
    if (args.keepOpen) {
      console.log('[Diag] --keepOpen set; leaving tab open.');
      return;
    }
  } finally {
    if (tabId && !args.keepOpen) {
      await camofoxDelete(`/tabs/${tabId}?userId=${encodeURIComponent(userId)}`).catch(() => {});
    }
  }
}

run().catch(err => {
  console.error(`[Diag] FAILED: ${err.stack || err.message || err}`);
  process.exit(1);
});
