#!/usr/bin/env node
/**
 * Test Workspace Error Page — Follows exact auto-worker captureAndReport flow
 * 
 * Purpose: Reproduce the exact OAuth PKCE flow for the failing account
 * to understand why "Workspaces not found" error page appears.
 * 
 * Usage:
 *   node scripts/test-workspace-selection.js
 */

import { CAMOUFOX_API } from './config.js';
import { camofoxPost, camofoxGet, camofoxDelete, evalJson, navigate } from './lib/camofox.js';
import { getFreshTOTP } from './lib/totp.js';
import { getState, fillEmail, fillPassword, fillMfa, tryAcceptCookies, dismissGooglePopupAndClickLogin, selectPersonalWorkspaceOnWorkspacePage } from './lib/openai-login-flow.js';
import { generatePKCE, buildOAuthURL, exchangeCodeForTokens } from './lib/openai-oauth.js';

const LOGIN_URL = 'https://chatgpt.com/auth/login';
const EMAIL = 'iphigeniadulciegrace8925@hotmail.com';
const PASSWORD = '&uv#o9sE6@hmz&mY';
const TOTP_SECRET = 'WOII2DRFWHPQCSZWNYVTWGRJIMQIPUHO';
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CHATGPT_CLIENT_ID = 'app_X8zY6vW2pQ9tR3dE7nK1jL5gH';
const REDIRECT_URI = 'http://localhost:1455/callback';
const USER_ID = `ws_test_${Date.now()}`;

function log(label, data) {
  console.log(`[${label}] ${typeof data === 'object' ? JSON.stringify(data, null, 2) : data}`);
}

async function captureDiag(tabId, userId, stepName) {
  const url = await evalJson(tabId, userId, 'location.href', 3000);
  const title = await evalJson(tabId, userId, 'document.title', 3000);
  const state = await getState(tabId, userId);
  const bodyText = await evalJson(tabId, userId, 'document.body?.innerText?.slice(0, 500) || ""', 3000) || '';
  const cookies = await evalJson(tabId, userId, 'document.cookie', 3000) || '';
  
  // Decode oai-client-auth-session if present
  let authSessionDecoded = null;
  const authSessionMatch = cookies.split(';').map(c => c.trim()).find(c => c.startsWith('oai-client-auth-session'));
  if (authSessionMatch) {
    const val = authSessionMatch.split('=').slice(1).join('=');
    try {
      const segments = val.split('.');
      for (const seg of segments.slice(0, 2)) {
        const pad = '='.repeat((4 - (seg.length % 4)) % 4);
        const decoded = atob(seg.replace(/-/g, '+').replace(/_/g, '/') + pad);
        const parsed = JSON.parse(decoded);
        if (parsed) { authSessionDecoded = parsed; break; }
      }
    } catch (_) {}
  }

  log(`📋 ${stepName}`, {
    url: url?.slice(0, 120),
    title,
    state,
    bodyText: bodyText?.slice(0, 300),
    authSession: authSessionDecoded,
  });
}

async function main() {
  let tabId = null;

  try {
    // ═══ STEP 1: Open chatgpt.com/auth/login ═══
    log('STEP1', 'Opening chatgpt.com/auth/login...');
    const opened = await camofoxPost('/tabs', {
      userId: USER_ID,
      sessionKey: `ws_test_${Date.now()}`,
      url: LOGIN_URL,
      persistent: false,
      os: 'macos',
      screen: { width: 1440, height: 900 },
      headless: false,
      randomFonts: true,
      canvas: 'random',
    }, { timeoutMs: 25000 });
    tabId = opened.tabId;
    log('TAB_OPENED', { tabId });
    await new Promise(r => setTimeout(r, 5000));

    // Accept cookies
    try { await tryAcceptCookies(tabId, USER_ID); await new Promise(r => setTimeout(r, 1000)); } catch (_) {}

    // Click Log in
    await dismissGooglePopupAndClickLogin(tabId, USER_ID);
    await new Promise(r => setTimeout(r, 4000));

    // ═══ STEP 2: Login flow ═══
    // Fill email
    const emailState = await getState(tabId, USER_ID);
    if (emailState?.hasEmailInput) {
      log('STEP2A', 'Filling email...');
      await fillEmail(tabId, USER_ID, EMAIL);
      await new Promise(r => setTimeout(r, 3000));
      for (let wait = 0; wait < 10; wait++) {
        const s = await getState(tabId, USER_ID);
        if (s?.hasPasswordInput) { log('STEP2A', 'Password page appeared'); break; }
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    // Fill password
    const passState = await getState(tabId, USER_ID);
    if (passState?.hasPasswordInput) {
      log('STEP2B', 'Filling password...');
      await fillPassword(tabId, USER_ID, PASSWORD);
      await new Promise(r => setTimeout(r, 3000));
      for (let wait = 0; wait < 10; wait++) {
        const s = await getState(tabId, USER_ID);
        if (s?.hasMfaInput || s?.looksLoggedIn || s?.isWorkspaceScreen) break;
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    // Fill MFA
    for (let mfaAttempt = 0; mfaAttempt < 3; mfaAttempt++) {
      const mfaState = await getState(tabId, USER_ID);
      if (mfaState?.hasMfaInput) {
        log('STEP2C', `Filling MFA (attempt ${mfaAttempt + 1})...`);
        const { otp } = await getFreshTOTP(TOTP_SECRET, 8);
        await fillMfa(tabId, USER_ID, otp);
        await new Promise(r => setTimeout(r, 4000));
        const afterMfa = await getState(tabId, USER_ID);
        if (!afterMfa?.hasMfaInput) { log('STEP2C', 'MFA accepted!'); break; }
      } else break;
    }

    // Wait for login or workspace page
    for (let i = 0; i < 20; i++) {
      const state = await getState(tabId, USER_ID);
      if (state?.isWorkspaceScreen) {
        log('STEP2D', 'Workspace selection page found after login!');
        await captureDiag(tabId, USER_ID, 'BEFORE_WORKSPACE_CLICK');
        const wsResult = await selectPersonalWorkspaceOnWorkspacePage(tabId, USER_ID, { timeoutMs: 30000 });
        log('STEP2D_WORKSPACE_RESULT', wsResult);
        await new Promise(r => setTimeout(r, 5000));
        break;
      }
      if (state?.looksLoggedIn) { log('STEP2D', 'Logged in'); break; }
      await new Promise(r => setTimeout(r, 2000));
    }

    // ═══ STEP 3: After login — capture state ═══
    await captureDiag(tabId, USER_ID, 'AFTER_LOGIN');

    // ═══ STEP 4: Navigate to OAuth URL (Codex client_id) — same as auto-worker ═══
    log('STEP4', 'Navigating to OAuth URL (Codex client_id)...');
    
    // Use same PKCE generation as auto-worker
    const pkce = generatePKCE();
    const authUrl = buildOAuthURL(pkce);
    
    log('STEP4_AUTH_URL', authUrl.slice(0, 150) + '...');
    log('STEP4_PKCE', { state: pkce.state.slice(0, 12), codeVerifier: pkce.codeVerifier.slice(0, 20) + '...' });
    
    await navigate(tabId, USER_ID, authUrl, 20000);
    await new Promise(r => setTimeout(r, 5000));

    // ═══ STEP 5: Capture state after OAuth URL navigate ═══
    await captureDiag(tabId, USER_ID, 'AFTER_OAUTH_URL_NAVIGATE');

    // ═══ STEP 6: Check what page we're on and handle accordingly ═══
    for (let i = 0; i < 30; i++) {
      const currentUrl = await evalJson(tabId, USER_ID, 'location.href', 4000);
      const oauthState = await getState(tabId, USER_ID);
      
      log(`STEP6_LOOP_${i}`, {
        url: currentUrl?.slice(0, 120),
        looksLoggedIn: oauthState?.looksLoggedIn,
        hasEmailInput: oauthState?.hasEmailInput,
        hasPasswordInput: oauthState?.hasPasswordInput,
        hasMfaInput: oauthState?.hasMfaInput,
        isConsentScreen: oauthState?.isConsentScreen,
        isWorkspaceScreen: oauthState?.isWorkspaceScreen,
        hasError: oauthState?.hasError,
        hasPhoneScreen: oauthState?.hasPhoneScreen,
      });

      // Check for code in URL
      if (currentUrl?.includes('code=')) {
        log('STEP6_CODE', 'Authorization code found!');
        try {
          const urlObj = new URL(currentUrl);
          const code = urlObj.searchParams.get('code');
          log('STEP6_CODE_VALUE', code?.slice(0, 30) + '...');
            
          // Token exchange from Node.js (not browser — CORS blocks it)
          const tokenResult = await exchangeCodeForTokens(code, pkce, null);
          log('STEP6_TOKENS', {
            has_access_token: !!tokenResult?.access_token,
            has_refresh_token: !!tokenResult?.refresh_token,
            token_type: tokenResult?.token_type,
            expires_in: tokenResult?.expires_in,
            error: tokenResult?.error,
            scope: tokenResult?.scope,
          });
          if (tokenResult?.access_token) {
            const meta = { /* extract from JWT */ };
            try {
              const payload = JSON.parse(atob(tokenResult.access_token.split('.')[1]));
              meta.accountId = payload.sub || payload.account_id;
              meta.planType = payload.plan_type;
              meta.expiredAt = new Date((payload.exp || 0) * 1000).toISOString();
            } catch (_) {}
            log('STEP6_TOKEN_META', meta);
          }
        } catch (e) {
          log('STEP6_CODE_ERROR', e.message);
        }
        break;
      }

      // Handle consent page (with workspace selection embedded) — only when NO email/password/MFA inputs
      if (oauthState?.isConsentScreen && !oauthState?.hasEmailInput && !oauthState?.hasPasswordInput && !oauthState?.hasMfaInput && currentUrl?.includes('auth.openai.com')) {
        // Special case: /choose-an-account page
        if (currentUrl?.includes('/choose-an-account')) {
          log('STEP6_CHOOSE_ACCOUNT', 'Choose-an-account page detected');
          const chooseResult = await evalJson(tabId, USER_ID, `
            (() => {
              // Click the first account option (usually the only one)
              const clickables = document.querySelectorAll('button, [role="button"], [role="option"], a, div[class*="account"], div[class*="item"]');
              for (const el of clickables) {
                if (el.offsetParent === null) continue;
                const text = (el.textContent || '').trim().toLowerCase();
                if (text.includes('select account') || text.includes('jeremy') || text.includes('holmes')) {
                  el.click();
                  return 'clicked: ' + text.slice(0, 60);
                }
              }
              // Fallback: click "Select account" button
              const buttons = document.querySelectorAll('button');
              for (const el of buttons) {
                if (el.offsetParent === null) continue;
                const text = (el.textContent || '').trim().toLowerCase();
                if (text.includes('select')) {
                  el.click();
                  return 'clicked_select: ' + text.slice(0, 60);
                }
              }
              return null;
            })()
          `, 5000);
          log('STEP6_CHOOSE_ACCOUNT_RESULT', chooseResult);
          await new Promise(r => setTimeout(r, 3000));
          continue;
        }
        
        log('STEP6_CONSENT', 'Consent page detected');
        await captureDiag(tabId, USER_ID, 'OAUTH_CONSENT_PAGE');
        
        // Step 1: Click Personal workspace option (same logic as auto-worker)
        const wsClickResult = await evalJson(tabId, USER_ID, `
          (() => {
            // Strategy A: Find clickable element with "personal" text
            const clickables = document.querySelectorAll('button, [role="radio"], [role="option"], [role="listbox"] > *, [role="radiogroup"] > *, label, li, a, div[class*="item"], div[class*="option"], div[class*="radio"], div[class*="workspace"]');
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
            
            if (!personalEl) return { ok: false, reason: 'no-personal-option', clickables: clickables.length };
            
            // Click with full event sequence
            personalEl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
            personalEl.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
            personalEl.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
            personalEl.click();
            
            return { ok: true, text: personalText, tagName: personalEl.tagName };
          })()
        `, 5000);
        log('STEP6_WS_CLICK', wsClickResult);
        await new Promise(r => setTimeout(r, 2000));
        
        // Step 2: Click Continue button
        const consentResult = await evalJson(tabId, USER_ID, `
          (() => {
            const buttons = document.querySelectorAll('button, [role="button"]');
            for (const el of buttons) {
              if (el.offsetParent === null) continue;
              const text = (el.textContent || '').trim().toLowerCase();
              if (text.includes('continue') || text.includes('allow') || text.includes('authorize')) {
                // Try requestSubmit on parent form first
                const form = el.closest('form');
                if (form) {
                  try { form.requestSubmit(el); return 'requestSubmit: ' + text; } catch(_) {}
                }
                el.click();
                return 'click: ' + text;
              }
            }
            return null;
          })()
        `, 5000);
        log('STEP6_CONSENT_CLICK', consentResult);
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }

      // Handle workspace page (standalone, no consent)
      if (oauthState?.isWorkspaceScreen && !oauthState?.isConsentScreen && !oauthState?.looksLoggedIn) {
        log('STEP6_WORKSPACE', 'Workspace page in OAuth flow');
        await captureDiag(tabId, USER_ID, 'OAUTH_WORKSPACE_PAGE');
        const wsResult = await selectPersonalWorkspaceOnWorkspacePage(tabId, USER_ID, { timeoutMs: 15000 });
        log('STEP6_WORKSPACE_RESULT', wsResult);
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }

      // Handle password input (check BEFORE email to avoid re-filling email)
      if (oauthState?.hasPasswordInput) {
        log('STEP6_PASSWORD', 'Password input detected — filling...');
        await fillPassword(tabId, USER_ID, PASSWORD);
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }

      // Handle email input (only if no password input)
      if (oauthState?.hasEmailInput && !oauthState?.hasPasswordInput) {
        log('STEP6_EMAIL', 'Email input detected — filling...');
        await fillEmail(tabId, USER_ID, EMAIL);
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }

      // Handle MFA
      if (oauthState?.hasMfaInput) {
        log('STEP6_MFA', 'MFA input detected — filling...');
        const { otp } = await getFreshTOTP(TOTP_SECRET, 8);
        await fillMfa(tabId, USER_ID, otp);
        await new Promise(r => setTimeout(r, 4000));
        continue;
      }

      // Handle error page — read body text
      if (oauthState?.hasError || (!oauthState?.hasEmailInput && !oauthState?.hasPasswordInput && !oauthState?.hasMfaInput && !oauthState?.looksLoggedIn)) {
        log('STEP6_ERROR', 'Unknown/error state — reading page text...');
        const bodyText = await evalJson(tabId, USER_ID, 'document.body?.innerText?.toLowerCase() || ""', 3000) || '';
        log('STEP6_ERROR_TEXT', bodyText.slice(0, 500));
        
        if (bodyText.includes('authentication error') || bodyText.includes('workspaces not found') || bodyText.includes('oops, an error occurred') || bodyText.includes('invalid authorize request')) {
          log('STEP6_AUTH_ERROR', '🚨 Auth error page! Codex session has no workspace data.');
          log('STEP6_AUTH_ERROR_REASON', 'Server-side session is corrupted for Codex client. Cookies cannot fix this. Need fresh tab + fresh login.');
          
          // Close current tab and open a NEW tab for OAuth flow
          log('STEP6_NEW_TAB', 'Opening NEW tab with DIFFERENT userId for fresh OAuth login...');
          try {
            await camofoxDelete(`/tabs/${tabId}?userId=${USER_ID}`);
            log('STEP6_OLD_TAB_CLOSED', 'Old tab closed');
          } catch (_) {}
          
          // Use DIFFERENT userId to avoid sharing corrupted session cookies
          const OAUTH_USER_ID = `ws_oauth_${Date.now()}`;
          const newTab = await camofoxPost('/tabs', {
            userId: OAUTH_USER_ID,
            sessionKey: `ws_oauth_${Date.now()}`,
            url: authUrl,
            persistent: false,
            os: 'macos',
            screen: { width: 1440, height: 900 },
            headless: false,
            randomFonts: true,
            canvas: 'random',
          }, { timeoutMs: 25000 });
          tabId = newTab.tabId;
          // Update USER_ID for subsequent calls
          const oldUserId = USER_ID;
          // We'll use OAUTH_USER_ID from now on
          log('STEP6_NEW_TAB_OPENED', { tabId, newUserId: OAUTH_USER_ID });
          await new Promise(r => setTimeout(r, 8000));
          
          // Check state — should show login page now (no existing session)
          const newState = await getState(tabId, OAUTH_USER_ID);
          log('STEP6_NEW_TAB_STATE', newState);
          
          // If login page, fill credentials
          if (newState?.hasEmailInput) {
            log('STEP6_NEW_TAB_LOGIN', 'Login page detected! Filling credentials...');
            await fillEmail(tabId, OAUTH_USER_ID, EMAIL);
            await new Promise(r => setTimeout(r, 3000));
            for (let wait = 0; wait < 10; wait++) {
              const s = await getState(tabId, OAUTH_USER_ID);
              if (s?.hasPasswordInput) break;
              await new Promise(r => setTimeout(r, 1000));
            }
            const passState2 = await getState(tabId, OAUTH_USER_ID);
            if (passState2?.hasPasswordInput) {
              await fillPassword(tabId, OAUTH_USER_ID, PASSWORD);
              await new Promise(r => setTimeout(r, 3000));
            }
            for (let wait = 0; wait < 10; wait++) {
              const s = await getState(tabId, OAUTH_USER_ID);
              if (s?.hasMfaInput || s?.isWorkspaceScreen || s?.isConsentScreen) break;
              await new Promise(r => setTimeout(r, 1000));
            }
            const mfaState2 = await getState(tabId, OAUTH_USER_ID);
            if (mfaState2?.hasMfaInput) {
              const { otp } = await getFreshTOTP(TOTP_SECRET, 8);
              await fillMfa(tabId, OAUTH_USER_ID, otp);
              await new Promise(r => setTimeout(r, 4000));
            }
          }
          
          // Continue loop with new userId — but we need to update the loop's evalJson calls
          // For simplicity, just capture final state after login attempts
          await new Promise(r => setTimeout(r, 5000));
          const finalUrl = await evalJson(tabId, OAUTH_USER_ID, 'location.href', 3000);
          const finalState = await getState(tabId, OAUTH_USER_ID);
          log('STEP6_NEW_TAB_FINAL', { url: finalUrl?.slice(0, 120), state: finalState });
          
          // If we got a code, exchange it
          if (finalUrl?.includes('code=')) {
            try {
              const urlObj = new URL(finalUrl);
              const code = urlObj.searchParams.get('code');
              log('STEP6_NEW_TAB_CODE', code?.slice(0, 30) + '...');
              const tokenResult = await evalJson(tabId, OAUTH_USER_ID, `
                (async () => {
                  try {
                    const res = await fetch('https://auth.openai.com/oauth/token', {
                      method: 'POST',
                      headers: { 'content-type': 'application/json' },
                      body: JSON.stringify({
                        client_id: '${CODEX_CLIENT_ID}',
                        grant_type: 'authorization_code',
                        code: '${code}',
                        code_verifier: '${pkce.codeVerifier}',
                        redirect_uri: '${REDIRECT_URI}',
                      }),
                    });
                    return await res.json();
                  } catch(e) { return { error: e.message }; }
                })()
              `, 10000);
              log('STEP6_NEW_TAB_TOKENS', {
                has_access_token: !!tokenResult?.access_token,
                has_refresh_token: !!tokenResult?.refresh_token,
                token_type: tokenResult?.token_type,
                expires_in: tokenResult?.expires_in,
                error: tokenResult?.error,
              });
            } catch (e) {
              log('STEP6_NEW_TAB_CODE_ERROR', e.message);
            }
          }
          
          // Handle workspace/consent in new tab
          if (finalState?.isWorkspaceScreen) {
            log('STEP6_NEW_TAB_WORKSPACE', 'Workspace page in new tab!');
            const wsResult = await selectPersonalWorkspaceOnWorkspacePage(tabId, OAUTH_USER_ID, { timeoutMs: 15000 });
            log('STEP6_NEW_TAB_WORKSPACE_RESULT', wsResult);
            await new Promise(r => setTimeout(r, 5000));
            const afterWsUrl = await evalJson(tabId, OAUTH_USER_ID, 'location.href', 3000);
            const afterWsState = await getState(tabId, OAUTH_USER_ID);
            log('STEP6_NEW_TAB_AFTER_WORKSPACE', { url: afterWsUrl?.slice(0, 120), state: afterWsState });
          }
          
          if (finalState?.isConsentScreen) {
            log('STEP6_NEW_TAB_CONSENT', 'Consent page in new tab!');
            const consentResult = await evalJson(tabId, OAUTH_USER_ID, `
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
                return null;
              })()
            `, 5000);
            log('STEP6_NEW_TAB_CONSENT_CLICK', consentResult);
            await new Promise(r => setTimeout(r, 5000));
            const afterConsentUrl = await evalJson(tabId, OAUTH_USER_ID, 'location.href', 3000);
            log('STEP6_NEW_TAB_AFTER_CONSENT', { url: afterConsentUrl?.slice(0, 120) });
            
            if (afterConsentUrl?.includes('code=')) {
              try {
                const urlObj = new URL(afterConsentUrl);
                const code = urlObj.searchParams.get('code');
                log('STEP6_NEW_TAB_FINAL_CODE', code?.slice(0, 30) + '...');
                const tokenResult = await evalJson(tabId, OAUTH_USER_ID, `
                  (async () => {
                    try {
                      const res = await fetch('https://auth.openai.com/oauth/token', {
                        method: 'POST',
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({
                          client_id: '${CODEX_CLIENT_ID}',
                          grant_type: 'authorization_code',
                          code: '${code}',
                          code_verifier: '${pkce.codeVerifier}',
                          redirect_uri: '${REDIRECT_URI}',
                        }),
                      });
                      return await res.json();
                    } catch(e) { return { error: e.message }; }
                  })()
                `, 10000);
                log('STEP6_FINAL_TOKENS', {
                  has_access_token: !!tokenResult?.access_token,
                  has_refresh_token: !!tokenResult?.refresh_token,
                  token_type: tokenResult?.token_type,
                  expires_in: tokenResult?.expires_in,
                  error: tokenResult?.error,
                });
              } catch (e) {
                log('STEP6_FINAL_CODE_ERROR', e.message);
              }
            }
          }
          
          break; // Exit loop after new tab flow
        }
        
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }

      // Logged in but no code
      if (oauthState?.looksLoggedIn) {
        log('STEP6_LOGGED_IN', 'Looks logged in but no code in URL');
        break;
      }

      await new Promise(r => setTimeout(r, 2000));
    }

    // Final state
    await captureDiag(tabId, USER_ID, 'FINAL');

  } catch (err) {
    log('ERROR', err.message);
    console.error(err);
  } finally {
    if (tabId) {
      await camofoxDelete(`/tabs/${tabId}?userId=${USER_ID}`);
      log('CLEANUP', 'Tab closed');
    }
  }
}

main().catch(console.error);
