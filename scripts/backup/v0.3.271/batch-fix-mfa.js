#!/usr/bin/env node
/**
 * batch-fix-mfa.js
 *
 * Tự động retry cài đặt 2FA cho các tài khoản bị thiếu (status = mfa_pending / two_fa_secret trống).
 * Reuse setupMFA library + regenerate-2fa-result API endpoint.
 *
 * Usage:
 *   node scripts/batch-fix-mfa.js                         # Fix tất cả mfa_pending
 *   node scripts/batch-fix-mfa.js --dry-run               # Xem danh sách mà không chạy
 *   node scripts/batch-fix-mfa.js --account-id acc_xxx    # Fix 1 account cụ thể
 *   node scripts/batch-fix-mfa.js --concurrency 2         # Chạy 2 accounts song song
 *   node scripts/batch-fix-mfa.js --include-dead          # Bao gồm cả accounts status=dead
 */

import { TOOLS_API_URL } from './config.js';
import { camofoxPost, camofoxDelete } from './lib/camofox.js';
import { normalizeProxyUrl } from './lib/proxy-diag.js';
import { setupMFA } from './lib/mfa-setup.js';
import {
  getState,
  fillEmail,
  fillPassword,
  fillMfa,
  tryAcceptCookies,
  dismissGooglePopupAndClickLogin,
} from './lib/openai-login-flow.js';
import { waitForOTPCode } from './lib/ms-graph-email.js';
import { createHmac } from 'node:crypto';

// Local TOTP generator
function generateTOTP(secret) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secret.toUpperCase().replace(/=+$/, '')) {
    const v = alphabet.indexOf(c);
    if (v < 0) continue;
    bits += v.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  const counter = Math.floor(Date.now() / 1000 / 30);
  const cb = Buffer.alloc(8);
  cb.writeBigInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', Buffer.from(bytes)).update(cb).digest();
  const off = hmac[hmac.length - 1] & 0xf;
  const code = ((hmac[off] & 0x7f) << 24 | hmac[off+1] << 16 | hmac[off+2] << 8 | hmac[off+3]) % 1_000_000;
  return code.toString().padStart(6, '0');
}

const delay = ms => new Promise(r => setTimeout(r, ms));

function parseArgs() {
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const val = process.argv[i + 1];
      if (val && !val.startsWith('--')) { args[key] = val; i++; }
      else args[key] = true;
    }
  }
  return args;
}

async function evalOnTab(tabId, userId, expression) {
  const r = await camofoxPost(`/tabs/${tabId}/evaluate`, { userId, expression });
  return r?.result;
}

async function dismissOnboardingModals(tabId, userId) {
  return await evalOnTab(tabId, userId, `(() => {
    let clicked = false;
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
    for (const btn of buttons) {
      if (btn.offsetParent === null) continue;
      const text = (btn.innerText || btn.textContent || '').trim().toLowerCase();
      if (['okay', 'ok', 'got it', 'done', 'next', 'tiếp tục', 'bắt đầu', 'continue'].includes(text) ||
          text.includes("let's go") || text.includes("let's get started")) {
        btn.click(); clicked = true;
      }
    }
    return clicked;
  })()`).catch(() => false);
}

async function fixMfaForAccount(account, opts = {}) {
  const { dryRun } = opts;
  const accountId = account.id;
  const label = `[BatchMFA:${accountId.slice(-6)}]`;

  console.log(`\n${label} ▶ Fix 2FA: ${account.email} [status: ${account.status}]`);

  if (dryRun) {
    console.log(`${label} [DRY-RUN] Bỏ qua.`);
    return { success: false, skipped: true };
  }

  // Fetch email credentials for OTP bypass
  let emailCreds = null;
  try {
    const r = await fetch(`${TOOLS_API_URL}/api/vault/email-pool/${encodeURIComponent(account.email)}`);
    if (r.ok) emailCreds = (await r.json()).item;
  } catch (e) {
    console.warn(`${label} ⚠️ Không lấy được email creds: ${e.message}`);
  }

  const USER_ID = `seellm_batchmfa_${accountId}`;
  const SESSION_KEY = `batchmfa_${accountId}`;
  const effectiveProxy = normalizeProxyUrl(account.proxy_url || account.proxyUrl || null);

  let tabId = null;
  let success = false;
  let newSecret = null;

  try {
    // Open tab
    console.log(`${label} 🦊 Mở Camofox tab...`);
    const opened = await camofoxPost('/tabs', {
      userId: USER_ID,
      sessionKey: SESSION_KEY,
      url: 'https://chatgpt.com',
      proxy: effectiveProxy || undefined,
      persistent: false,
      os: 'macos',
      screen: { width: 1440, height: 900 },
      humanize: true,
      headless: false,
    }, { timeoutMs: 35000 });
    tabId = opened.tabId;
    await delay(4000);

    // Login flow
    console.log(`${label} 🔑 Đăng nhập...`);
    let isLoggedIn = false;
    for (let i = 0; i < 30; i++) {
      const state = await getState(tabId, USER_ID).catch(() => null);
      if (!state) { await delay(2000); continue; }

      if (state.isLoggedIn) { isLoggedIn = true; break; }
      if (state.onAuthDomain) await tryAcceptCookies(tabId, USER_ID).catch(() => {});

      if (state.hasLoginForm && !state.emailFilled) {
        await fillEmail(tabId, USER_ID, account.email).catch(() => {});
        await delay(2000); continue;
      }
      if (state.hasPasswordForm) {
        await fillPassword(tabId, USER_ID, account.password).catch(() => {});
        await delay(4000); continue;
      }
      if (state.hasMfaForm) {
        if (account.two_fa_secret) {
          const totp = generateTOTP(account.two_fa_secret);
          await fillMfa(tabId, USER_ID, totp).catch(() => {});
          await delay(4000); continue;
        }
        if (emailCreds) {
          try {
            const otpCode = await waitForOTPCode(emailCreds.refresh_token || emailCreds.refreshToken, 120000);
            if (otpCode) { await fillMfa(tabId, USER_ID, otpCode).catch(() => {}); await delay(4000); continue; }
          } catch (e) { console.warn(`${label} ⚠️ OTP error: ${e.message}`); }
        }
      }
      if (!state.onAuthDomain && !state.isLoggedIn) {
        await dismissGooglePopupAndClickLogin(tabId, USER_ID).catch(() => {});
        await delay(3000); continue;
      }
      await delay(2000);
    }

    if (!isLoggedIn) throw new Error('Đăng nhập thất bại sau 30 iterations');

    // Dismiss modals
    for (let i = 0; i < 3; i++) {
      const d = await dismissOnboardingModals(tabId, USER_ID);
      if (d) await delay(2000); else break;
    }

    // Run setupMFA with up to 3 attempts
    console.log(`${label} 🛡️ Chạy setupMFA...`);
    const apiHelper = async (path, body) => camofoxPost(path, body);
    const MAX_RETRIES = 3;
    let mfaResult = null;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      console.log(`${label} setupMFA attempt ${attempt}/${MAX_RETRIES}...`);
      mfaResult = await setupMFA(tabId, USER_ID, apiHelper, {
        email: account.email,
        emailCreds,
        currentSecret: null,
      });
      if (mfaResult.success) break;
      console.log(`${label} ⚠️ Attempt ${attempt} failed: ${mfaResult.error}`);
      if (attempt < MAX_RETRIES) {
        await evalOnTab(tabId, USER_ID, `window.location.href = 'https://chatgpt.com'`).catch(() => {});
        await delay(5000);
      }
    }

    if (!mfaResult?.success) {
      throw new Error(`setupMFA thất bại sau ${MAX_RETRIES} lần: ${mfaResult?.error || 'Unknown'}`);
    }

    newSecret = mfaResult.secret;
    console.log(`${label} 🎉 2FA thành công! Secret: ${newSecret}`);

    // Save result
    const saveRes = await fetch(`${TOOLS_API_URL}/api/vault/accounts/${accountId}/regenerate-2fa-result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'success', secret: newSecret })
    });
    if (!saveRes.ok) throw new Error(`Lưu thất bại: ${await saveRes.text()}`);
    console.log(`${label} ✅ Đã lưu 2FA secret.`);
    success = true;

  } catch (err) {
    console.error(`${label} ❌ Lỗi: ${err.message}`);
    try {
      await fetch(`${TOOLS_API_URL}/api/vault/accounts/${accountId}/regenerate-2fa-result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'failed', error: err.message })
      });
    } catch (_) {}
  } finally {
    if (tabId) {
      await camofoxDelete(`/tabs/${tabId}?userId=${USER_ID}`).catch(() => {});
      console.log(`${label} 🧹 Đóng tab.`);
    }
  }

  return { success, secret: newSecret, accountId };
}

async function runWithConcurrency(tasks, limit) {
  const results = [];
  const running = new Set();
  for (const task of tasks) {
    const p = task().then(r => { running.delete(p); return r; });
    running.add(p);
    results.push(p);
    if (running.size >= limit) await Promise.race(running);
  }
  return Promise.all(results);
}

async function main() {
  const args = parseArgs();
  const dryRun = !!args['dry-run'];
  const concurrency = Math.max(1, parseInt(args['concurrency'] || '1', 10));
  const specificId = args['account-id'] || null;
  const includeDead = !!args['include-dead'];

  console.log(`\n🛡️ ===== BATCH FIX MFA =====`);
  if (dryRun) console.log(`⚠️  DRY-RUN mode`);
  console.log(`Concurrency: ${concurrency}`);
  console.log(`Include dead: ${includeDead}\n`);

  // Fetch all accounts
  let accounts = [];
  try {
    const res = await fetch(`${TOOLS_API_URL}/api/vault/accounts?limit=1000`);
    if (!res.ok) throw new Error(`API returned ${res.status}`);
    const data = await res.json();
    const all = data.accounts || data.items || data || [];
    accounts = all.filter(a => {
      if (a.deleted_at) return false;
      if (specificId) return a.id === specificId;
      const noMfa = !a.two_fa_secret || a.two_fa_secret.trim() === '';
      if (!noMfa) return false;
      if (a.status === 'dead' && !includeDead) return false;
      return true;
    });
  } catch (err) {
    console.error(`❌ Không lấy được danh sách tài khoản: ${err.message}`);
    process.exit(1);
  }

  if (accounts.length === 0) {
    console.log('✅ Không có tài khoản nào cần fix 2FA!');
    process.exit(0);
  }

  console.log(`📋 ${accounts.length} tài khoản cần fix:`);
  for (const a of accounts) {
    console.log(`   ${a.id}: ${a.email} [${a.status}]`);
  }
  console.log('');

  const tasks = accounts.map(account => () => fixMfaForAccount(account, { dryRun }));
  const results = await runWithConcurrency(tasks, concurrency);

  const succeeded = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success && !r.skipped).length;
  const skipped = results.filter(r => r.skipped).length;

  console.log(`\n🏁 ===== KẾT QUẢ =====`);
  console.log(`✅ Thành công: ${succeeded}`);
  console.log(`❌ Thất bại:  ${failed}`);
  if (skipped > 0) console.log(`⏭️  Bỏ qua (dry-run): ${skipped}`);
  console.log(`========================\n`);
}

main().catch(err => { console.error(err); process.exit(1); });
