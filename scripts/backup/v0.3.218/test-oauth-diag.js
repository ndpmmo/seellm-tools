/**
 * Diagnostic script: Test OAuth flow for a specific account
 * Captures detailed DOM, cookies, URL, and state at each step
 * to understand why some accounts hit "Unknown auth state"
 *
 * Usage:
 *   node scripts/test-oauth-diag.js
 */

import { CAMOUFOX_API } from './config.js';
import { camofoxPost, camofoxGet, camofoxDelete, camofoxGoto, evalJson, navigate, pressKey } from './lib/camofox.js';
import { getFreshTOTP } from './lib/totp.js';
import { getState, fillEmail, fillPassword, fillMfa, tryAcceptCookies, dismissGooglePopupAndClickLogin, waitForState, isPhoneVerificationScreen, isConsentScreen, selectPersonalWorkspaceOnWorkspacePage, MULTILANG } from './lib/openai-login-flow.js';
import { generatePKCE, buildOAuthURL, exchangeCodeForTokens, CODEX_CONSENT_URL, decodeAuthSessionCookie, extractWorkspaceId, performWorkspaceConsentBypass } from './lib/openai-oauth.js';
import { decodeJwtPayload, extractAccountMeta } from './lib/openai-auth.js';

// ═══════════════════════════════════════════════════════════════
// TEST ACCOUNT
// ═══════════════════════════════════════════════════════════════
const EMAIL = 'iphigeniadulciegrace8925@hotmail.com';
const PASSWORD = '&uv#o9sE6@hmz&mY';
const TOTP_SECRET = 'WOII2DRFWHPQCSZWNYVTWGRJIMQIPUHO'; // base32 for getFreshTOTP

const USER_ID = `diag_${Date.now()}`;
const LOGIN_URL = 'https://chatgpt.com/auth/login';

function log(label, data) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`📋 DIAG: ${label}`);
  console.log(`${'═'.repeat(60)}`);
  if (data !== undefined) {
    console.log(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  }
}

async function capturePageDiagnostics(tabId, userId, label) {
  log(`${label} — Full Diagnostics`);

  // 1. URL & title
  const url = await evalJson(tabId, userId, 'location.href', 4000);
  const title = await evalJson(tabId, userId, 'document.title', 3000);
  log(`${label} — URL`, url);
  log(`${label} — Title`, title);

  // 2. getState
  const state = await getState(tabId, userId);
  log(`${label} — getState`, state);

  // 3. All cookies (via Camoufox API)
  try {
    const ckRes = await camofoxGet(`/tabs/${tabId}/cookies?userId=${userId}`, { timeoutMs: 5000 });
    const cookies = Array.isArray(ckRes?.cookies) ? ckRes.cookies : (Array.isArray(ckRes) ? ckRes : []);
    log(`${label} — Cookies count`, cookies.length);
    for (const c of cookies) {
      const valPreview = (c.value || '').length > 80 ? c.value.slice(0, 80) + '...' : c.value;
      console.log(`  🍪 ${c.name} = ${valPreview} (domain=${c.domain || '?'})`);
    }

    // Try decode oai-client-auth-session
    const authSession = cookies.find(c => c.name?.includes('oai-client-auth-session'));
    if (authSession?.value) {
      const decoded = decodeAuthSessionCookie(authSession.value);
      log(`${label} — oai-client-auth-session decoded`, decoded);
    } else {
      log(`${label} — oai-client-auth-session`, 'NOT FOUND in cookies');
    }
  } catch (e) {
    log(`${label} — Cookies error`, e.message);
  }

  // 4. DOM snapshot (accessibility tree style)
  try {
    const snapshot = await evalJson(tabId, userId, `
      (() => {
        const body = document.body?.innerText || '';
        const html = document.documentElement?.outerHTML || '';
        // Extract all visible text content
        const allText = Array.from(document.querySelectorAll('h1,h2,h3,h4,p,span,button,a,label,li,div[role]'))
          .filter(el => el.offsetParent !== null && (el.textContent || '').trim().length > 0 && (el.textContent || '').trim().length < 200)
          .map(el => {
            const tag = el.tagName?.toLowerCase() || '?';
            const role = el.getAttribute('role') || '';
            const text = (el.textContent || '').trim().slice(0, 100);
            const testId = el.getAttribute('data-testid') || '';
            const href = el.getAttribute('href') || '';
            return '[' + tag + (role ? ' role=' + role : '') + (testId ? ' testid=' + testId : '') + (href ? ' href=' + href.slice(0, 60) : '') + '] ' + text;
          })
          .join('\\n');
        // Find forms
        const forms = Array.from(document.querySelectorAll('form')).map(f => ({
          action: f.action || f.getAttribute('action') || '',
          method: f.method || f.getAttribute('method') || '',
          id: f.id || '',
          inputs: Array.from(f.querySelectorAll('input,select,textarea')).map(i => ({
            type: i.type, name: i.name, id: i.id, value: i.value ? '***' : '', autocomplete: i.autocomplete || ''
          }))
        }));
        // Find all links
        const links = Array.from(document.querySelectorAll('a[href]')).filter(a => a.offsetParent !== null).map(a => ({
          text: (a.textContent || '').trim().slice(0, 60),
          href: (a.href || '').slice(0, 120)
        }));
        return { allText: allText.slice(0, 3000), forms, links: links.slice(0, 20), bodyLen: body.length, htmlLen: html.length };
      })()
    `, 8000);
    log(`${label} — DOM text`, snapshot?.allText || 'empty');
    log(`${label} — Forms`, snapshot?.forms || []);
    log(`${label} — Links`, snapshot?.links || []);
  } catch (e) {
    log(`${label} — DOM error`, e.message);
  }

  // 5. document.cookie (browser-side, may differ from Camoufox API)
  try {
    const docCookies = await evalJson(tabId, userId, `
      (() => {
        const cookies = {};
        document.cookie.split(';').forEach(c => {
          const [k, ...v] = c.trim().split('=');
          if (k) cookies[k.trim()] = v.join('=').slice(0, 80);
        });
        return cookies;
      })()
    `, 3000);
    log(`${label} — document.cookie keys`, Object.keys(docCookies));
    // Check specifically for oai-client-auth-session
    if (docCookies['oai-client-auth-session']) {
      log(`${label} — document.cookie oai-client-auth-session`, 'FOUND (length=' + docCookies['oai-client-auth-session'].length + ')');
    } else {
      log(`${label} — document.cookie oai-client-auth-session`, 'NOT FOUND');
    }
  } catch (e) {
    log(`${label} — document.cookie error`, e.message);
  }

  return { url, state };
}

// ═══════════════════════════════════════════════════════════════
// MAIN FLOW
// ═══════════════════════════════════════════════════════════════
async function main() {
  let tabId = null;
  const effectiveProxy = null; // No proxy for diagnostic test

  try {
    log('STEP 1', 'Opening chatgpt.com/auth/login...');
    const opened = await camofoxPost('/tabs', {
      userId: USER_ID,
      sessionKey: `diag_${Date.now()}`,
      url: LOGIN_URL,
      persistent: false,
      os: 'macos',
      screen: { width: 1440, height: 900 },
      humanize: true,
      headless: false,
      randomFonts: true,
      canvas: 'random',
    }, { timeoutMs: 25000 });
    tabId = opened.tabId;
    log('Tab opened', { tabId });
    await new Promise(r => setTimeout(r, 5000));

    // Check initial state
    const initDiag = await capturePageDiagnostics(tabId, USER_ID, 'STEP 1 — After open login page');

    // If already logged in
    if (initDiag.state?.looksLoggedIn) {
      log('STEP 2', 'Already logged in! Proceeding to OAuth test...');
    } else {
      // Need to login
      log('STEP 2', 'Not logged in, performing login...');

      // Accept cookies first
      try {
        await tryAcceptCookies(tabId, USER_ID);
        await new Promise(r => setTimeout(r, 1000));
      } catch(_) {}

      // Dismiss Google popup & click Log in
      await dismissGooglePopupAndClickLogin(tabId, USER_ID);
      await new Promise(r => setTimeout(r, 4000));

      // Fill email
      const emailState = await getState(tabId, USER_ID);
      if (emailState?.hasEmailInput) {
        log('STEP 2a', 'Filling email...');
        await fillEmail(tabId, USER_ID, EMAIL);
        await pressKey(tabId, USER_ID, 'Enter');
        await new Promise(r => setTimeout(r, 4000));
      }

      // Fill password
      const passState = await getState(tabId, USER_ID);
      if (passState?.hasPasswordInput) {
        log('STEP 2b', 'Filling password...');
        await fillPassword(tabId, USER_ID, PASSWORD);
        await pressKey(tabId, USER_ID, 'Enter');
        await new Promise(r => setTimeout(r, 4000));
      }

      // Check for MFA and fill if needed
      for (let mfaAttempt = 0; mfaAttempt < 5; mfaAttempt++) {
        const mfaState = await getState(tabId, USER_ID);
        if (mfaState?.hasMfaInput && TOTP_SECRET) {
          log('STEP 2c', `Filling MFA (attempt ${mfaAttempt + 1})...`);
          const { otp } = await getFreshTOTP(TOTP_SECRET, 10);
          await fillMfa(tabId, USER_ID, otp);
          await pressKey(tabId, USER_ID, 'Enter');
          await new Promise(r => setTimeout(r, 5000));
          // Check if MFA was accepted
          const afterMfa = await getState(tabId, USER_ID);
          if (afterMfa?.looksLoggedIn || (!afterMfa?.hasMfaInput && !afterMfa?.hasPasswordInput)) {
            log('STEP 2c', 'MFA accepted!');
            break;
          }
          log('STEP 2c', 'MFA may not have been accepted, retrying...');
        } else if (mfaState?.looksLoggedIn) {
          log('STEP 2d', 'Login successful (no MFA needed)!');
          break;
        } else if (!mfaState?.hasMfaInput && !mfaState?.hasPasswordInput && !mfaState?.hasEmailInput) {
          // Might be in a loading state or phone screen
          log('STEP 2e', `State after login: looksLoggedIn=${mfaState?.looksLoggedIn} phone=${mfaState?.hasPhoneScreen} error=${mfaState?.hasError}`);
          break;
        }
        await new Promise(r => setTimeout(r, 2000));
      }

      // Wait for login to complete
      for (let i = 0; i < 15; i++) {
        const s = await getState(tabId, USER_ID);
        if (s?.looksLoggedIn) {
          log('STEP 2f', 'Login successful!');
          break;
        }
        // Handle workspace selection page
        if (s?.isWorkspaceScreen && !s?.looksLoggedIn) {
          log('STEP 2f', 'Workspace selection page detected → clicking Personal account...');
          const wsResult = await selectPersonalWorkspaceOnWorkspacePage(tabId, USER_ID, { timeoutMs: 15000 });
          if (wsResult?.ok) {
            log('STEP 2f', `Personal workspace selected: ${wsResult.text || ''} → ${wsResult.reason}`);
          } else {
            log('STEP 2f', `Workspace selection failed: ${wsResult?.reason || 'unknown'}`);
          }
          break;
        }
        log('STEP 2f', `Waiting for login... (${i + 1}/15) url=${s?.href?.slice(0, 80)}`);
        await new Promise(r => setTimeout(r, 2000));
      }

      // Capture post-login diagnostics
      await capturePageDiagnostics(tabId, USER_ID, 'STEP 2 — After login');
    }

    // ══════════════════════════════════════════════════════════════
    // STEP 2b: Navigate to chatgpt.com to establish session
    // ══════════════════════════════════════════════════════════════
    log('STEP 2b', 'Navigating to chatgpt.com to establish session...');
    await navigate(tabId, USER_ID, 'https://chatgpt.com', 15000);
    await new Promise(r => setTimeout(r, 5000));

    // Check session is established
    const chatgptDiag = await capturePageDiagnostics(tabId, USER_ID, 'STEP 2b — On chatgpt.com');

    // ══════════════════════════════════════════════════════════════
    // STEP 3: Navigate to OAuth URL and capture diagnostics
    // ══════════════════════════════════════════════════════════════
    log('STEP 3', 'Generating PKCE and navigating to OAuth URL...');
    const pkce = generatePKCE();
    const authUrl = buildOAuthURL(pkce);
    log('OAuth URL', authUrl.slice(0, 120) + '...');

    await navigate(tabId, USER_ID, authUrl, 20000);
    await new Promise(r => setTimeout(r, 5000));

    // Capture diagnostics AFTER navigate
    const afterNavDiag = await capturePageDiagnostics(tabId, USER_ID, 'STEP 3 — After navigate authUrl');

    // ══════════════════════════════════════════════════════════════
    // STEP 3b: Handle workspace selection page (appears for Codex client_id)
    // ══════════════════════════════════════════════════════════════
    if (afterNavDiag.state?.isWorkspaceScreen) {
      log('STEP 3b', 'Workspace selection page detected after OAuth navigate → clicking Personal account...');
      const wsResult = await selectPersonalWorkspaceOnWorkspacePage(tabId, USER_ID, { timeoutMs: 15000 });
      if (wsResult?.ok) {
        log('STEP 3b', `Personal workspace selected: ${wsResult.text || ''} → ${wsResult.reason}`);
        await new Promise(r => setTimeout(r, 3000));
        // Capture state after workspace selection
        await capturePageDiagnostics(tabId, USER_ID, 'STEP 3b — After workspace selection');
      } else {
        log('STEP 3b', `Workspace selection failed: ${wsResult?.reason || 'unknown'}`);
      }
    }

    // ══════════════════════════════════════════════════════════════
    // STEP 3c: Handle consent page (click Continue)
    // ══════════════════════════════════════════════════════════════
    const consentState = await getState(tabId, USER_ID);
    if (consentState?.isConsentScreen && consentState?.onAuthDomain) {
      log('STEP 3c', 'Consent page detected → clicking Continue...');
      // Try clicking Continue button
      const clickResult = await evalJson(tabId, USER_ID, `
        (() => {
          const buttons = document.querySelectorAll('button, [role="button"]');
          for (const el of buttons) {
            if (el.offsetParent === null) continue;
            const text = (el.textContent || '').trim().toLowerCase();
            if (text.includes('continue') || text.includes('allow') || text.includes('authorize')) {
              el.click();
              return text;
            }
          }
          // Try form submit
          const form = document.querySelector('form[action*="consent"], form[action*="sign-in-with-chatgpt"]');
          if (form) {
            if (typeof form.requestSubmit === 'function') { form.requestSubmit(); return 'form-requestSubmit'; }
            form.submit(); return 'form-submit';
          }
          return null;
        })()
      `, 5000);
      log('STEP 3c', `Consent click result: ${clickResult}`);
      await new Promise(r => setTimeout(r, 5000));

      // Check if we got redirected to callback with code
      const afterConsentUrl = await evalJson(tabId, USER_ID, 'location.href', 4000) || '';
      if (afterConsentUrl.includes('code=')) {
        log('STEP 3c', `✅ Got OAuth code! URL: ${afterConsentUrl.slice(0, 120)}`);
        try {
          const code = new URL(afterConsentUrl).searchParams.get('code');
          if (code) {
            log('STEP 3c', `Code: ${code.slice(0, 30)}...`);
            // Try to exchange code for tokens
            log('STEP 3c', 'Exchanging code for tokens...');
            const tokens = await exchangeCodeForTokens(code, pkce.codeVerifier, effectiveProxy);
            if (tokens?.access_token) {
              log('STEP 3c', `✅ ACCESS TOKEN obtained! Length: ${tokens.access_token.length}`);
              log('STEP 3c', `Refresh token: ${tokens.refresh_token ? 'YES' : 'NO'}`);
            } else {
              log('STEP 3c', `Token exchange failed: ${JSON.stringify(tokens).slice(0, 500)}`);
            }
          }
        } catch (e) {
          log('STEP 3c', `Code extraction/exchange error: ${e.message}`);
        }
      } else {
        log('STEP 3c', `After consent URL: ${afterConsentUrl.slice(0, 120)}`);
        await capturePageDiagnostics(tabId, USER_ID, 'STEP 3c — After consent click');
      }
    }

    // ══════════════════════════════════════════════════════════════
    // STEP 4: If on auth.openai.com but unknown state, try workspace select VIA API
    // (This tests the fix: navigate to auth.openai.com first, then call workspace/select)
    // ══════════════════════════════════════════════════════════════
    if (afterNavDiag.state?.onAuthDomain && !afterNavDiag.state?.isConsentScreen && !afterNavDiag.state?.isWorkspaceScreen) {
      log('STEP 4', 'On auth.openai.com but UNKNOWN state — testing workspace/select API...');

      // Now we're on auth.openai.com, so fetch to same domain should work (no CORS)
      const wsSelectResult = await evalJson(tabId, USER_ID, `
        (async () => {
          try {
            // First, try to get workspace data from cookie
            const cookies = {};
            document.cookie.split(';').forEach(c => {
              const [k, ...v] = c.trim().split('=');
              if (k) cookies[k.trim()] = v.join('=');
            });
            const authSession = cookies['oai-client-auth-session'] || '';

            let workspaceId = '';
            if (authSession) {
              const segments = authSession.split('.');
              for (const seg of segments.slice(0, 2)) {
                try {
                  const pad = '='.repeat((4 - (seg.length % 4)) % 4);
                  const decoded = atob(seg.replace(/-/g, '+').replace(/_/g, '/') + pad);
                  const parsed = JSON.parse(decoded);
                  const workspaces = parsed.workspaces || [];
                  if (workspaces.length) {
                    return { source: 'cookie', workspaces, raw: parsed };
                  }
                } catch(_) {}
              }
            }

            // Try fetch consent page to get workspace info
            const consentRes = await fetch('https://auth.openai.com/sign-in-with-chatgpt/codex/consent', {
              credentials: 'include',
              headers: { 'accept': 'text/html' },
              redirect: 'follow',
            });
            const consentHtml = await consentRes.text();

            // Extract workspace IDs from HTML
            const uuidRe = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi;
            const uuids = [...new Set(consentHtml.match(uuidRe) || [])];

            // Try workspace/select with each UUID
            for (const wid of uuids.slice(0, 3)) {
              const res = await fetch('https://auth.openai.com/api/accounts/workspace/select', {
                method: 'POST',
                credentials: 'include',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ workspace_id: wid }),
                redirect: 'manual',
              });
              const status = res.status;
              let body = '';
              let redirectUrl = '';
              if (status >= 300 && status < 400) {
                redirectUrl = res.headers.get('location') || '';
              } else {
                try { body = await res.text(); } catch(_) {}
              }
              if (status >= 200 && status < 300) {
                return { source: 'api', workspaceId: wid, status, body: body.slice(0, 500), redirectUrl };
              }
            }

            return { source: 'none', cookieExists: !!authSession, consentHtmlLen: consentHtml.length, uuids, consentHtmlSnippet: consentHtml.slice(0, 2000) };
          } catch(e) {
            return { error: e.message };
          }
        })()
      `, 20000);
      log('STEP 4 — workspace/select result', wsSelectResult);

      // If we got consent HTML, show it
      if (wsSelectResult?.consentHtmlSnippet) {
        log('STEP 4 — Consent HTML snippet', wsSelectResult.consentHtmlSnippet);
      }
    }

    // ══════════════════════════════════════════════════════════════
    // STEP 5: Try the consent page directly
    // ══════════════════════════════════════════════════════════════
    log('STEP 5', 'Navigating to consent URL directly...');
    await navigate(tabId, USER_ID, CODEX_CONSENT_URL, 15000);
    await new Promise(r => setTimeout(r, 3000));
    const consentDiag = await capturePageDiagnostics(tabId, USER_ID, 'STEP 5 — After navigate consent URL');

    // ══════════════════════════════════════════════════════════════
    // STEP 6: Try session endpoint
    // ══════════════════════════════════════════════════════════════
    log('STEP 6', 'Navigating back to chatgpt.com for session...');
    await navigate(tabId, USER_ID, 'https://chatgpt.com', 10000);
    await new Promise(r => setTimeout(r, 3000));

    const sessionRes = await evalJson(tabId, USER_ID, `
      (async () => {
        try {
          const r = await fetch('https://chatgpt.com/api/auth/session', {
            credentials: 'include',
            headers: { 'Accept': 'application/json' },
          });
          const text = await r.text();
          const data = JSON.parse(text);
          return {
            ok: r.ok,
            hasAccessToken: !!data.accessToken,
            accessTokenLen: data.accessToken?.length || 0,
            user: data.user ? { id: data.user.id, email: data.user.email, name: data.user.name } : null,
            accountId: data.accessToken ? (() => { try { const p = JSON.parse(atob(data.accessToken.split('.')[1])); return p['https://api.openai.com/auth']?.user_id || p.sub || null; } catch(_) { return null; } })() : null,
          };
        } catch (e) {
          return { error: String(e) };
        }
      })()
    `, 10000);
    log('STEP 6 — Session result', sessionRes);

    log('DONE', 'Diagnostics complete. Review output above.');

  } catch (err) {
    log('FATAL ERROR', err.message);
    console.error(err);
  } finally {
    if (tabId) {
      try {
        await camofoxDelete(`/tabs/${tabId}?userId=${USER_ID}`, { timeoutMs: 5000 });
        log('Cleanup', `Tab ${tabId} closed`);
      } catch (_) {}
    }
  }
}

main().catch(console.error);
