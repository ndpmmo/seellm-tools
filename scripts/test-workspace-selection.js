/**
 * Test script: verify workspace selection (Personal vs Business/Team)
 *
 * Usage:
 *   node scripts/test-workspace-selection.js <email> <password> <totp_secret>
 *
 * Example:
 *   node scripts/test-workspace-selection.js almirachadava9731@outlook.com '&kXMEv0AL0C%3rSp' GQXRMPR4XRDXD33YVCFDSW7TL4OEALYX
 */

import { camofoxPost, camofoxGet, camofoxDelete, evalJson, navigate } from './lib/camofox.js';
import { getFreshTOTP } from './lib/totp.js';
import { generatePKCE, buildOAuthURL, exchangeCodeForTokens } from './lib/openai-oauth.js';
import { getState, fillEmail, fillPassword, fillMfa, dismissGooglePopupAndClickLogin, tryAcceptCookies } from './lib/openai-login-flow.js';
import { extractAccountMeta } from './lib/openai-auth.js';

const CAMOUFOX_API = process.env.CAMOUFOX_API || 'http://localhost:9377';

function isPersonalWorkspace(ws) {
  if (!ws) return false;
  const kind = String(ws.kind || ws.type || ws.workspace_type || '').toLowerCase();
  if (kind === 'personal') return true;
  if (kind && kind !== 'personal') return false;
  const name = String(ws.name || ws.display_name || ws.title || '').toLowerCase();
  if (name.includes('personal')) return true;
  if (!ws.org_id && !ws.organization_id && !ws.team_id) return true;
  return false;
}

function pickPreferredWorkspace(workspaces) {
  if (!Array.isArray(workspaces) || !workspaces.length) return null;
  return workspaces.find(isPersonalWorkspace) || workspaces[0];
}

async function extractWorkspacesFromCookieInPage(tabId, userId) {
  try {
    return await evalJson(tabId, userId, `
      (() => {
        const getCookie = (name) => {
          const m = document.cookie.split(';').map(c => c.trim()).find(c => c.startsWith(name + '='));
          return m ? m.slice(name.length + 1) : '';
        };
        const raw = getCookie('oai-client-auth-session');
        if (!raw) return [];
        const segments = raw.split('.');
        for (const seg of segments.slice(0, 2)) {
          try {
            const pad = '='.repeat((4 - (seg.length % 4)) % 4);
            const decoded = atob(seg.replace(/-/g, '+').replace(/_/g, '/') + pad);
            const parsed = JSON.parse(decoded);
            const workspaces = parsed.workspaces || [];
            if (workspaces.length) return workspaces;
          } catch(_) {}
        }
        return [];
      })()
    `, 5000);
  } catch (_) { return []; }
}

async function takeScreenshot(tabId, userId, label) {
  try {
    const r = await camofoxGet(`/tabs/${tabId}/screenshot?userId=${userId}`, { timeoutMs: 8000 });
    if (r?.image) {
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      const dir = path.join(process.cwd(), 'data', 'screenshots', 'test-workspace');
      await fs.mkdir(dir, { recursive: true });
      const fp = path.join(dir, `${label}.png`);
      await fs.writeFile(fp, Buffer.from(r.image, 'base64'));
      console.log(`[Screenshot] saved ${fp}`);
    }
  } catch (_) {}
}

// ─── MAIN ──────────────────────────────────────────────────────
async function main() {
  const [email, password, totpSecret] = process.argv.slice(2);
  if (!email || !password || !totpSecret) {
    console.error('Usage: node scripts/test-workspace-selection.js <email> <password> <totp_secret>');
    process.exit(1);
  }

  console.log(`\n[Test] Email: ${email}`);
  console.log(`[Test] Starting workspace selection test...\n`);

  const userId = `test_ws_${Date.now()}`;
  let tabId = null;

  try {
    // 1. Create tab
    console.log('[Test] Creating Camoufox tab...');
    const opened = await camofoxPost('/tabs', {
      userId,
      sessionKey: `test_ws_${email}`,
      url: 'https://chatgpt.com/auth/login',
      os: 'macos',
      screen: { width: 1440, height: 900 },
      humanize: true,
      headless: false,
      randomFonts: true,
      canvas: 'random',
    }, { timeoutMs: 25000 });
    tabId = opened.tabId;
    console.log(`[Test] Tab created: ${tabId}`);
    await new Promise(r => setTimeout(r, 5000));

    // Accept cookies
    await tryAcceptCookies(tabId, userId);

    // 2. Check state
    let state = await getState(tabId, userId);
    console.log(`[Test] Initial state: onAuth=${state?.onAuthDomain}, hasEmail=${state?.hasEmailInput}, hasPass=${state?.hasPasswordInput}, looksLoggedIn=${state?.looksLoggedIn}`);
    await takeScreenshot(tabId, userId, '01_initial');

    // Already logged in?
    if (state?.looksLoggedIn) {
      console.log('[Test] Already logged in, proceeding to OAuth...');
    } else {
      // Click Log in
      console.log('[Test] Clicking Log in...');
      const clickRes = await dismissGooglePopupAndClickLogin(tabId, userId);
      console.log(`[Test] dismissGooglePopupAndClickLogin:`, JSON.stringify(clickRes));
      await new Promise(r => setTimeout(r, 3000));
      await takeScreenshot(tabId, userId, '02_after_login_click');

      // Fill email
      state = await getState(tabId, userId);
      console.log(`[Test] After click: onAuth=${state?.onAuthDomain}, hasEmail=${state?.hasEmailInput}, hasPass=${state?.hasPasswordInput}`);
      if (state?.hasEmailInput) {
        console.log('[Test] Filling email...');
        const r = await fillEmail(tabId, userId, email);
        console.log(`[Test] fillEmail:`, JSON.stringify(r));
        await new Promise(r => setTimeout(r, 4000));
        await takeScreenshot(tabId, userId, '03_after_email');
      }

      // Fill password
      state = await getState(tabId, userId);
      if (state?.hasPasswordInput) {
        console.log('[Test] Filling password...');
        const r = await fillPassword(tabId, userId, password);
        console.log(`[Test] fillPassword:`, JSON.stringify(r));
        await new Promise(r => setTimeout(r, 5000));
        await takeScreenshot(tabId, userId, '04_after_password');
      }

      // MFA
      state = await getState(tabId, userId);
      if (state?.hasMfaInput) {
        console.log('[Test] Filling MFA...');
        const { otp } = await getFreshTOTP(totpSecret, 10);
        const r = await fillMfa(tabId, userId, otp);
        console.log(`[Test] fillMfa:`, JSON.stringify(r));
        await new Promise(r => setTimeout(r, 5000));
        await takeScreenshot(tabId, userId, '05_after_mfa');
      }

      // Wait for logged in (or consent/workspace redirect)
      console.log('[Test] Waiting for post-login redirect...');
      for (let i = 0; i < 30; i++) {
        state = await getState(tabId, userId);
        const href = state?.href || '';
        const onAuthLogin = href.includes('auth.openai.com') && (href.includes('/login') || href.includes('/mfa'));
        const success = state?.looksLoggedIn || href.includes('consent') || href.includes('workspace') || href.includes('organization') || href.includes('chatgpt.com');
        if (success && !onAuthLogin) {
          console.log(`[Test] ✅ Post-login state reached: ${href.slice(0, 80)}`);
          break;
        }
        if (state?.hasMfaInput && i > 2) {
          console.log('[Test] MFA still present, retrying...');
          const { otp } = await getFreshTOTP(totpSecret, 3);
          await fillMfa(tabId, userId, otp);
          await new Promise(r => setTimeout(r, 4000));
        }
        await new Promise(r => setTimeout(r, 2000));
      }
      state = await getState(tabId, userId);
      const finalHref = state?.href || '';
      if (finalHref.includes('auth.openai.com') && (finalHref.includes('/login') || finalHref.includes('/mfa'))) {
        console.error('[Test] ❌ Still on auth page after timeout');
        await takeScreenshot(tabId, userId, '99_login_timeout');
        process.exit(1);
      }
      await takeScreenshot(tabId, userId, '06_post_login');
    }

    // 3. PKCE + navigate to OAuth
    const pkce = generatePKCE();
    const authUrl = buildOAuthURL(pkce);
    console.log(`[Test] Navigating to OAuth: ${authUrl.slice(0, 120)}...`);

    // Set up interceptor before navigation
    await evalJson(tabId, userId, `
      (() => {
        window.__oauthCallbackUrl = null;
        try {
          const obs = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              if (entry.name && entry.name.includes('localhost:1455') && entry.name.includes('code=')) {
                window.__oauthCallbackUrl = entry.name;
              }
            }
          });
          obs.observe({ entryTypes: ['navigation', 'resource'] });
        } catch (_) {}
        return 'listener-set';
      })()
    `, 3000);

    await navigate(tabId, userId, authUrl, { timeoutMs: 20000 });
    await new Promise(r => setTimeout(r, 5000));
    await takeScreenshot(tabId, userId, '07_oauth_page');

    // Handle re-login if OAuth redirected to login page
    state = await getState(tabId, userId);
    if (state?.hasEmailInput) {
      console.log('[Test] OAuth redirected to login, re-authenticating...');
      const r = await fillEmail(tabId, userId, email);
      console.log(`[Test] Re-fillEmail:`, JSON.stringify(r));
      await new Promise(r => setTimeout(r, 4000));
      state = await getState(tabId, userId);
      if (state?.hasPasswordInput) {
        const r2 = await fillPassword(tabId, userId, password);
        console.log(`[Test] Re-fillPassword:`, JSON.stringify(r2));
        await new Promise(r => setTimeout(r, 5000));
      }
      state = await getState(tabId, userId);
      if (state?.hasMfaInput) {
        const { otp } = await getFreshTOTP(totpSecret, 10);
        const r3 = await fillMfa(tabId, userId, otp);
        console.log(`[Test] Re-fillMfa:`, JSON.stringify(r3));
        await new Promise(r => setTimeout(r, 5000));
      }
      // Wait for redirect after re-login
      for (let i = 0; i < 20; i++) {
        state = await getState(tabId, userId);
        const href = state?.href || '';
        if (href.includes('consent') || href.includes('workspace') || href.includes('chatgpt.com')) break;
        await new Promise(r => setTimeout(r, 2000));
      }
      await takeScreenshot(tabId, userId, '07b_after_relogin');
    }

    // 4. Check for consent page
    state = await getState(tabId, userId);
    console.log(`[Test] OAuth state: href=${state?.href?.slice(0, 80)}, isConsent=${state?.isConsentScreen}`);

    let preferred = null;
    let cookieWorkspaces = [];

    if (state?.isConsentScreen || state?.href?.includes('consent')) {
      console.log('[Test] 🔔 Consent page detected');
      await takeScreenshot(tabId, userId, '08_consent_before');

      // Extract workspaces from cookie
      cookieWorkspaces = await extractWorkspacesFromCookieInPage(tabId, userId);
      console.log(`[Test] Workspaces from cookie: ${cookieWorkspaces.length}`);
      cookieWorkspaces.forEach((ws, i) => {
        const kind = isPersonalWorkspace(ws) ? 'PERSONAL' : 'ENTERPRISE/TEAM';
        console.log(`  [${i + 1}] id=${ws.id} name="${ws.name || ws.display_name || '(no name)'}" kind=${kind}`);
      });

      preferred = pickPreferredWorkspace(cookieWorkspaces);
      console.log(`[Test] Preferred workspace: id=${preferred?.id} name="${preferred?.name || '(no name)'}" (${isPersonalWorkspace(preferred) ? 'PERSONAL' : 'ENTERPRISE/TEAM'})`);

      // Try select personal BEFORE clicking Continue
      const selectResult = await evalJson(tabId, userId, `(() => {
        const clickables = document.querySelectorAll('button, [role="radio"], [role="option"], label, li, a');
        let personalEl = null;
        let personalText = '';
        for (const el of clickables) {
          if (el.offsetParent === null) continue;
          const text = (el.textContent || '').trim().toLowerCase();
          if (text.includes('personal') && text.length < 100) {
            personalEl = el;
            personalText = text.slice(0, 60);
            break;
          }
        }
        if (!personalEl) return { ok: false, reason: 'no-personal-option' };
        personalEl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
        personalEl.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
        personalEl.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        personalEl.click();
        return { ok: true, text: personalText };
      })()`, { timeoutMs: 5000 });
      console.log(`[Test] Personal select result:`, selectResult);
      await new Promise(r => setTimeout(r, 1500));
      await takeScreenshot(tabId, userId, '09_after_select_personal');

      // Click Continue
      const clickResult = await evalJson(tabId, userId, `(() => {
        const sel = 'form[action*="consent"], form[action*="sign-in-with-chatgpt"]'; 
        const form = document.querySelector(sel);
        if (!form) return 'no-form';
        const buttons = form.querySelectorAll('button[type="submit"], input[type="submit"]');
        let target = Array.from(buttons).find(el => el.offsetParent !== null);
        if (!target) return 'no-button';
        if (typeof form.requestSubmit === 'function') { form.requestSubmit(target); return 'requestSubmit'; }
        target.click(); return 'click';
      })()`, { timeoutMs: 5000 });
      console.log(`[Test] Continue clicked: ${clickResult}`);
      await new Promise(r => setTimeout(r, 3000));
      await takeScreenshot(tabId, userId, '10_after_continue');
    } else {
      console.log('[Test] No consent page detected');
    }

    // 5. Capture callback URL
    let authCode = '';
    for (let poll = 0; poll < 30; poll++) {
      const pollUrl = await evalJson(tabId, userId, 'location.href', 3000) || '';
      if (pollUrl.includes('code=')) {
        try { authCode = new URL(pollUrl).searchParams.get('code') || ''; if (authCode) break; } catch (_) {}
      }
      const intercepted = await evalJson(tabId, userId, 'window.__oauthCallbackUrl || null', 2000) || '';
      if (intercepted?.includes('code=')) {
        try { authCode = new URL(intercepted).searchParams.get('code') || ''; if (authCode) break; } catch (_) {}
      }
      if (pollUrl.includes('about:neterror') || pollUrl.includes('about:blank')) {
        const int2 = await evalJson(tabId, userId, 'window.__oauthCallbackUrl || null', 2000) || '';
        if (int2?.includes('code=')) { try { authCode = new URL(int2).searchParams.get('code') || ''; if (authCode) break; } catch (_) {} }
      }
      await new Promise(r => setTimeout(r, 1500));
    }

    if (!authCode) {
      console.error('[Test] ❌ No callback code found');
      await takeScreenshot(tabId, userId, '99_no_code');
      process.exit(1);
    }
    console.log(`[Test] ✅ Callback code captured`);

    // 6. Exchange token
    console.log(`[Test] Exchanging code...`);
    const tokenData = await exchangeCodeForTokens(authCode, pkce);
    console.log(`[Test] ✅ Token exchange OK`);

    // 7. Decode and report
    const accessToken = tokenData.access_token || tokenData.accessToken;
    const meta = extractAccountMeta(accessToken);

    // Also decode id_token for more metadata
    const idTokenMeta = tokenData.id_token ? extractAccountMeta(tokenData.id_token) : null;

    console.log('\n══════════════════════════════════════════════════');
    console.log('RESULT:');
    console.log('══════════════════════════════════════════════════');
    console.log(`accountId:        ${meta.accountId}`);
    console.log(`userId:           ${meta.userId}`);
    console.log(`planType (access):   ${meta.planType}`);
    if (idTokenMeta) {
      console.log(`planType (id_token): ${idTokenMeta.planType}`);
    }
    console.log(`email (JWT):      ${meta.email}`);
    console.log(`organizations:    ${(meta.organizations || []).length}`);
    (meta.organizations || []).forEach((org, i) => {
      console.log(`  [${i + 1}] id=${org.id} title="${org.title}" role=${org.role} is_default=${org.is_default}`);
    });
    console.log('══════════════════════════════════════════════════\n');

    // Compare
    if (preferred) {
      const match = meta.accountId === preferred.id;
      console.log(`[Test] Selected workspace id: ${preferred.id}`);
      console.log(`[Test] Token accountId:       ${meta.accountId}`);
      console.log(`[Test] MATCH: ${match ? '✅ YES' : '❌ NO — token accountId differs from selected workspace!'}`);
      if (!match) {
        console.log(`[Test] ⚠️  This proves the consent selection did NOT translate to the token!`);
      } else {
        console.log(`[Test] ✅ Consent selection DID translate to the token correctly.`);
      }
    }

    console.log('[Test] Done.');
  } catch (err) {
    console.error('[Test] 💥 Error:', err.message);
    process.exit(1);
  } finally {
    if (tabId) {
      await camofoxDelete(`/tabs/${tabId}?userId=${userId}`);
      console.log('[Test] Tab closed.');
    }
  }
}

main();
