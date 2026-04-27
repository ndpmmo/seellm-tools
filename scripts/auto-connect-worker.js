/**
 * SeeLLM Tools - Auto-Connect Worker v2 (Direct ChatGPT Login)
 *
 * Fix v2:
 *  - Điều hướng thẳng đến https://chatgpt.com/auth/login (bỏ bước click nút Login trên homepage)
 *  - Fix looksLoggedIn: ChatGPT hiển thị "New chat" kể cả khi CHƯA đăng nhập
 *    → Chỉ coi là logged in khi KHÔNG có "Sign up" và CÓ profile indicator hoặc URL đặc trưng
 *  - Log đầy đủ mọi state để dễ debug
 *  - Thêm fallback: nếu auth.openai.com redirect → phát hiện đúng email/password input
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import { CAMOUFOX_API, POLL_INTERVAL_MS, MAX_THREADS } from './config.js';
import { camofoxPost, camofoxGet, camofoxDelete, evalJson, navigate, pressKey } from './lib/camofox.js';
import { getTOTP, getFreshTOTP } from './lib/totp.js';
import { extractIpFromText, normalizeProxyUrl, getLocalPublicIp, probeProxyExitIp } from './lib/proxy-diag.js';
import { createSaveStep } from './lib/screenshot.js';
import { decodeJwtPayload, extractAccountMeta } from './lib/openai-auth.js';
import { getState, fillEmail, fillPassword, fillMfa, tryAcceptCookies, dismissGooglePopupAndClickLogin, waitForState } from './lib/openai-login-flow.js';
import { generatePKCE, buildOAuthURL, exchangeCodeForTokens, CODEX_CONSENT_URL, decodeAuthSessionCookie, extractWorkspaceId, performWorkspaceConsentBypass } from './lib/openai-oauth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IMAGES_DIR = path.join(__dirname, '..', 'data', 'screenshots');

// ================================================================
// PAGE STATE DETECTION (wrapper around shared lib for logging)
// ================================================================
async function getStateWithLogging(tabId, userId) {
  const state = await getState(tabId, userId);
  if (state) {
    console.log(`[Connect] 📍 State: ${state.href.slice(0, 70)}`);
    console.log(`[Connect]    loggedIn=${state.looksLoggedIn} | email=${state.hasEmailInput} | pass=${state.hasPasswordInput} | mfa=${state.hasMfaInput} | signUp=${state.hasSignUpInPage} | profile=${state.hasProfileBtn}`);
  } else {
    console.log(`[Connect] ⚠️ getState returned null`);
  }
  return state;
}

// ================================================================
// FETCH SESSION IN-PAGE (auto-connect specific)
// ================================================================
async function fetchSessionInPage(tabId, userId) {
    return evalJson(tabId, userId, `
    (async () => {
      try {
        const r = await fetch('https://chatgpt.com/api/auth/session', {
          credentials: 'include',
          headers: { 'Accept': 'application/json' },
        });
        const text = await r.text();
        return { ok: r.ok, status: r.status, body: text };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    })()
  `, 12000);
}

// ================================================================
// CORE CONNECT FLOW
// ================================================================
async function runConnectFlow(task) {
    const USER_ID = `seellm_connect_${task.id}`;
    const effectiveProxy = normalizeProxyUrl(task.proxyUrl || task.proxy_url || null);
    if (effectiveProxy) {
        task.proxyUrl = effectiveProxy;
        task.proxy_url = effectiveProxy;
    }
    const { email, password } = task;
    const totpSecret = task.twoFaSecret || task.two_fa_secret || null;

    console.log(`\n[Connect] ════════════════════════════════`);
    console.log(`[Connect] 🔌 Bắt đầu: ${email}`);
    console.log(`[Connect] ════════════════════════════════`);
    if (effectiveProxy) console.log(`[Connect] 🔌 Proxy: ${effectiveProxy}`);

    if (!email || !password) {
        return sendConnectResult(task, 'error', 'Thiếu email hoặc password');
    }

    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const runDir = path.join(IMAGES_DIR, `connect_${task.id}_${ts}`);
    await fs.mkdir(runDir, { recursive: true });

    let tabId = null;
    let saveStep = null;

    try {
        // ── BƯỚC 1: Mở thẳng trang ĐĂNG NHẬP (không qua homepage) ──────
        // Auth URL trực tiếp để tránh bấm nút "Log in" trên homepage
        const LOGIN_URL = 'https://chatgpt.com/auth/login';
        console.log(`[Connect] [1] Mở ${LOGIN_URL}...`);
        const opened = await camofoxPost('/tabs', {
            userId: USER_ID,
            sessionKey: `cg_connect_${task.id}`,
            url: LOGIN_URL,
            proxy: effectiveProxy || undefined,
            persistent: false,
            os: 'macos',
            screen: { width: 1440, height: 900 },
            humanize: true,
            headless: false,
            randomFonts: true,
            canvas: 'random',
        }, 25000);
        tabId = opened.tabId;
        console.log(`[Connect] [1] Tab: ${tabId}`);

        saveStep = createSaveStep(runDir, { tabId, userId: USER_ID });

        // Đợi trang tải hoàn toàn (chatgpt landing page chậm)
        await new Promise(r => setTimeout(r, 5000));
        
        // 🔍 [Diagnostic] Kiểm tra IP thoát của Proxy bằng tab probe riêng (tránh false-fail do CORS)
        // [HARD-FAIL]: Nếu không probe được IP thì abort luôn — không cho chạy tiếp với network không xác định
        try {
          console.log(`[Connect] 🔍 [Diagnostic] Đang kiểm tra IP thoát qua Proxy...`);
          const ipCheck = await probeProxyExitIp(USER_ID, effectiveProxy || null, true);
          if (ipCheck && ipCheck.ip) {
            console.log(`[Connect] ✅ [Diagnostic] Exit IP: ${ipCheck.ip}`);
            if (effectiveProxy) {
              const localIp = await getLocalPublicIp();
              if (localIp) {
                console.log(`[Connect] ℹ️ [Diagnostic] Host Public IP: ${localIp}`);
                if (String(localIp).toLowerCase() === String(ipCheck.ip).toLowerCase()) {
                  throw new Error(`Proxy chưa được áp dụng (Exit IP trùng Host Public IP).`);
                }
              } else {
                throw new Error(`Không thể xác định Host Public IP để xác thực proxy.`);
              }
            }
          } else if (ipCheck && ipCheck.error) {
            console.log(`[Connect] ⚠️ [Diagnostic] Lỗi kiểm tra IP: ${ipCheck.error}`);
            throw new Error(`Proxy/Network không hoạt động (${ipCheck.error}). Dừng tiến trình.`);
          } else {
            throw new Error(`Không lấy được Exit IP. Dừng tiến trình.`);
          }
        } catch (err) {
          console.log(`[Connect] ❌ [Diagnostic] Hard-fail: ${err.message}`);
          throw err;
        }

        await saveStep('01_login_page');

        let state = await getStateWithLogging(tabId, USER_ID);

        // ── Nếu đã logged in (cookie còn hạn) ────────────────────────────
        if (state?.looksLoggedIn) {
            console.log(`[Connect] ✅ Đã có session trước! Lấy token ngay...`);
            await captureAndReport(tabId, USER_ID, runDir, task, email, saveStep);
            return;
        }

        // ── Accept cookies banner nếu có ────────────────────────────────
        console.log(`[Connect] 🍪 Accept cookie banner...`);
        await tryAcceptCookies(tabId, USER_ID);
        await new Promise(r => setTimeout(r, 1500));

        // ── Dismiss Google popup + bấm nút "Log in" ──────────────────────
        // Trang chatgpt.com/auth/login hiện ra landing page với:
        //   - Popup "Sign in with Google" overlay
        //   - Nút "Log in" (xanh dương)
        //   - Nút "Sign up for free"
        // Phải dismiss popup rồi bấm "Log in" để redirect sang auth.openai.com
        console.log(`[Connect] [1b] Dismiss Google popup + bấm Log in...`);
        const loginClick = await dismissGooglePopupAndClickLogin(tabId, USER_ID);
        console.log(`[Connect] [1b] Result:`, JSON.stringify(loginClick));
        await new Promise(r => setTimeout(r, 4000));
        await saveStep('01b_after_login_click');
        state = await getStateWithLogging(tabId, USER_ID);

        // ── Retry: nếu vẫn chưa ở auth domain ────────────────────────────
        if (!state?.onAuthDomain && !state?.hasEmailInput && !state?.looksLoggedIn) {
            console.log(`[Connect] [1c] Chưa redirect, thử bấm Log in lần 2...`);
            await dismissGooglePopupAndClickLogin(tabId, USER_ID);
            await new Promise(r => setTimeout(r, 5000));
            await saveStep('01c_retry');
            state = await getStateWithLogging(tabId, USER_ID);
        }

        // ── Fallback cuối: nếu chưa redirect → navigate bằng auth0 authorize URL ─
        if (!state?.onAuthDomain && !state?.hasEmailInput && !state?.looksLoggedIn) {
            console.log(`[Connect] [1d] Fallback: dùng auth.openai.com/authorize URL trực tiếp...`);
            await navigate(tabId, USER_ID,
                'https://auth.openai.com/authorize?client_id=DRivsnm2Mu42T3KOpqdtwB3NYviHYzwD' +
                '&audience=https%3A%2F%2Fapi.openai.com%2Fv1' +
                '&redirect_uri=https%3A%2F%2Fchatgpt.com%2Fapi%2Fauth%2Fcallback%2Flogin-web' +
                '&scope=openid+email+profile+offline_access+model.request+model.read+organization.read+organization.write' +
                '&response_type=code&response_mode=query&state=login&prompt=login',
                15000);
            await new Promise(r => setTimeout(r, 5000));
            await saveStep('01d_fallback');
            state = await getStateWithLogging(tabId, USER_ID);
        }

        // ── BƯỚC 2: Điền EMAIL ───────────────────────────────────────────
        let emailDone = false;
        for (let attempt = 0; attempt < 8 && !emailDone; attempt++) {
            if (state?.looksLoggedIn) { emailDone = true; break; }
            if (state?.hasPasswordInput) { emailDone = true; break; }

            if (state?.hasEmailInput) {
                console.log(`[Connect] [2] [Technical: DOM Manipulation] Đang điền email nhanh (gán giá trị trực tiếp vào ô input)...`);
                const r = await fillEmail(tabId, USER_ID, email);
                console.log(`[Connect] [2] fillEmail result:`, JSON.stringify(r));
                await new Promise(r2 => setTimeout(r2, 3000));
                await saveStep(`02_email_${attempt + 1}`);
                state = await getStateWithLogging(tabId, USER_ID);
                if (r?.ok) emailDone = true;
            } else {
                console.log(`[Connect] [2] Chưa thấy email input, đợi thêm...`);
                await new Promise(r => setTimeout(r, 2500));
                state = await getStateWithLogging(tabId, USER_ID);
            }
        }

        if (!emailDone && !state?.hasPasswordInput && !state?.looksLoggedIn) {
            await saveStep('02_failed');
            return sendConnectResult(task, 'error', `Không tìm thấy email input sau 8 lần thử. URL: ${state?.href}`);
        }

        // ── BƯỚC 3: Điền PASSWORD ────────────────────────────────────────
        let passDone = false;
        for (let attempt = 0; attempt < 5 && !passDone; attempt++) {
            if (state?.looksLoggedIn) { passDone = true; break; }
            if (state?.hasMfaInput) { passDone = true; break; }

            if (state?.hasPasswordInput) {
                console.log(`[Connect] [3] [Technical: DOM Manipulation] Điền password (lần ${attempt + 1})`);
                const r = await fillPassword(tabId, USER_ID, password);
                console.log(`[Connect] [3] fillPassword →`, JSON.stringify(r));
                await new Promise(r2 => setTimeout(r2, 3500));
                await saveStep(`03_password_${attempt + 1}`);
                state = await getStateWithLogging(tabId, USER_ID);
                if (r?.ok) passDone = true;
            } else {
                console.log(`[Connect] [3] Chưa thấy password input, đợi...`);
                await new Promise(r => setTimeout(r, 2500));
                state = await getStateWithLogging(tabId, USER_ID);
            }
        }

        // ── BƯỚC 4: MFA ──────────────────────────────────────────────────
        if (state?.hasMfaInput) {
            if (!totpSecret) {
                await saveStep('04_mfa_no_secret');
                return sendConnectResult(task, 'error', 'MFA required nhưng account chưa có 2FA secret');
            }
            console.log(`[Connect] [4] [Technical: DOM Manipulation] Màn hình MFA → sinh TOTP...`);
            const { otp } = await getFreshTOTP(totpSecret, 8);
            const r = await fillMfa(tabId, USER_ID, otp);
            console.log(`[Connect] [4] fillMfa →`, JSON.stringify(r));
            await new Promise(r2 => setTimeout(r2, 4000));
            await saveStep('04_mfa');
            state = await getStateWithLogging(tabId, USER_ID);

            // Retry MFA nếu vẫn còn ở màn MFA
            if (state?.hasMfaInput) {
                console.log(`[Connect] [4] MFA retry...`);
                const { otp: otp2 } = await getFreshTOTP(totpSecret, 3);
                await fillMfa(tabId, USER_ID, otp2);
                await new Promise(r2 => setTimeout(r2, 4000));
                await saveStep('04b_mfa_retry');
                state = await getStateWithLogging(tabId, USER_ID);
            }
        }

        // ── BƯỚC 5: Đợi login hoàn tất (poll tối đa 60s) ─────────────────
        console.log(`[Connect] [5] Đợi redirect về chatgpt.com sau login...`);
        
        // Use waitForState for cleaner polling
        const finalState = await waitForState(tabId, USER_ID, { looksLoggedIn: true }, { timeoutMs: 60000, intervalMs: 2000 });
        
        if (!finalState) {
            // Timeout - check for phone screen error
            const currentState = await getStateWithLogging(tabId, USER_ID);
            if (currentState?.hasPhoneScreen) {
                await saveStep('05_phone_required');
                return sendConnectResult(task, 'error', 'NEED_PHONE: Tài khoản yêu cầu xác minh số điện thoại');
            }
            return sendConnectResult(task, 'error', `Timeout 60s: Không đăng nhập được. URL cuối: ${currentState?.href}`);
        }
        
        console.log(`[Connect] ✅ Đã đăng nhập!`);
        await saveStep('05_post_login');

        await captureAndReport(tabId, USER_ID, runDir, task, email, saveStep);

    } catch (err) {
        console.error(`[Connect] ❌ Exception: ${err.message}`);
        if (tabId) await saveStep('error').catch(() => { });
        await sendConnectResult(task, 'error', `Exception: ${err.message}`);
    } finally {
        if (tabId) {
            await camofoxDelete(`/tabs/${tabId}?userId=${USER_ID}`);
            console.log(`[Connect] 🧹 Đóng tab ${tabId}`);
        }
    }
}

// ================================================================
// CAPTURE SESSION & REPORT
// ================================================================
async function captureAndReport(tabId, userId, runDir, task, email, saveStep) {
    console.log(`[Connect] 🔍 Bắt đầu lấy OAuth tokens (PKCE flow)...`);

    // ── BƯỚC A: Tạo OAuth PKCE params ──────────────────────────────────
    const pkce = generatePKCE();
    const authUrl = buildOAuthURL(pkce);
    console.log(`[Connect] [A] PKCE state=${pkce.state.slice(0, 12)}...`);
    console.log(`[Connect] [A] Navigating đến OAuth authorize URL...`);

    // ── BƯỚC B: Mở OAuth URL trong tab browser (user đã logged in → auto-approve) ──
    // Trước khi navigate, set up listener để bắt redirect URL
    // (vì localhost:1455 không có server, browser sẽ báo connection refused
    //  nhưng ta vẫn cần bắt được URL chứa ?code=)
    await evalJson(tabId, userId, `
    (() => {
        // Intercept navigation bằng cách listen beforeunload và lưu URL
        window.__oauthCallbackUrl = null;
        const origFetch = window.fetch;
        const origOpen = XMLHttpRequest.prototype.open;
        
        // Override window.location setter to intercept redirects
        // Lưu ý: không thể override location trực tiếp, nhưng có thể dùng
        // navigation performance entries hoặc MutationObserver
        
        // Dùng PerformanceObserver để bắt navigation
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

    await navigate(tabId, userId, authUrl, 20000);
    await new Promise(r => setTimeout(r, 3000));
    await saveStep('07_oauth_redirect');

    // ── BƯỚC C: Đợi redirect callback với ?code= ──────────────────────
    let authCode = '';
    let callbackState = '';
    const { password } = task;
    const totpSecret = task.twoFaSecret || task.two_fa_secret || null;
    let oauthLoginHandled = false;

    for (let i = 0; i < 30; i++) {
        const currentUrl = await evalJson(tabId, userId, 'location.href', 4000);
        console.log(`[Connect] [C] Poll oauth #${i + 1}: ${(currentUrl || '').slice(0, 100)}`);

        // ── Kiểm tra đã nhận được ?code= chưa ──
        if (currentUrl && currentUrl.includes('code=')) {
            try {
                const url = new URL(currentUrl);
                authCode = url.searchParams.get('code') || '';
                callbackState = url.searchParams.get('state') || '';
                if (authCode) {
                    console.log(`[Connect] ✅ OAuth code received: ${authCode.slice(0, 20)}...`);
                    break;
                }
            } catch (e) {
                console.log(`[Connect] ⚠️ URL parse error: ${e.message}`);
            }
        }

        // ── Nếu redirect về localhost:1455 (callback URL) ──
        if (currentUrl && currentUrl.includes('localhost:1455')) {
            try {
                const url = new URL(currentUrl);
                authCode = url.searchParams.get('code') || '';
                callbackState = url.searchParams.get('state') || '';
                if (authCode) {
                    console.log(`[Connect] ✅ OAuth code intercepted from localhost redirect: ${authCode.slice(0, 20)}...`);
                    break;
                }
            } catch (_) { }
        }

        // ── Browser lỗi connection (about:neterror / ERR_CONNECTION_REFUSED) ──
        // Khi localhost:1455 không chạy, Firefox/Chrome có thể hiển thị trang lỗi
        // Thử lấy URL từ interceptor hoặc từ browser address bar qua window.__oauthCallbackUrl
        if (currentUrl && (currentUrl.includes('about:neterror') || currentUrl.includes('about:blank') || currentUrl === '')) {
            const intercepted = await evalJson(tabId, userId, 'window.__oauthCallbackUrl || null', 2000);
            if (intercepted && intercepted.includes('code=')) {
                try {
                    const url = new URL(intercepted);
                    authCode = url.searchParams.get('code') || '';
                    if (authCode) {
                        console.log(`[Connect] ✅ OAuth code recovered from interceptor: ${authCode.slice(0, 20)}...`);
                        break;
                    }
                } catch (_) { }
            }
        }

        // ── Nếu auth.openai.com yêu cầu login lại → điền email/password/MFA ──
        const oauthState = await getStateWithLogging(tabId, userId);

        // ── /add-phone: Bỏ qua, dùng API để lấy workspace và lấy code (shared helper) ──
        if (oauthState?.hasPhoneScreen) {
            console.log(`[Connect] [C] [Technical: Background API Calls] Phát hiện màn hình yêu cầu SĐT → Đang thực hiện luồng gọi API ngầm (Fetch) để lấy workspaceId và vượt qua bằng lệnh workspace/select...`);
            await saveStep('08b_skip_phone_consent');

            const codeResult = await performWorkspaceConsentBypass(evalJson, tabId, userId);

            console.log(`[Connect] [C] [Technical: Background API Calls] Kết quả xử lý API ngầm:`, JSON.stringify(codeResult));

            if (codeResult?.code) {
                authCode = codeResult.code;
                console.log(`[Connect] ✅ OAuth code via workspace API: ${authCode.slice(0, 20)}...`);
                break;
            } else {
                console.log(`[Connect] ⚠️ Workspace API thất bại: ${codeResult?.error || JSON.stringify(codeResult)}`);
                await saveStep('08_error_need_phone');
                return sendConnectResult(task, 'error', 'NEED_PHONE: Tài khoản yêu cầu xác minh số điện thoại');
            }
        }

        if (oauthState?.hasEmailInput && !oauthLoginHandled) {
            console.log(`[Connect] [C] [Technical: DOM Manipulation] OAuth yêu cầu login lại → đang gán giá trị email nhanh vào ô input...`);
            const emailResult = await fillEmail(tabId, userId, email);
            console.log(`[Connect] [C] fillEmail result:`, JSON.stringify(emailResult));
            await new Promise(r => setTimeout(r, 3000));
            oauthLoginHandled = true;
            continue;
        }

        if (oauthState?.hasPasswordInput) {
            console.log(`[Connect] [C] [Technical: DOM Manipulation] Đang điền mật khẩu nhanh (thao tác trực tiếp vào cây DOM)...`);
            const passResult = await fillPassword(tabId, userId, password);
            console.log(`[Connect] [C] fillPassword result:`, JSON.stringify(passResult));
            await new Promise(r => setTimeout(r, 3500));
            continue;
        }

        if (oauthState?.hasMfaInput) {
            if (totpSecret) {
                console.log(`[Connect] [C] [Technical: DOM Manipulation] Đang sinh mã TOTP và điền mã 2FA nhanh vào ô input...`);
                const { otp } = await getFreshTOTP(totpSecret, 8);
                const mfaResult = await fillMfa(tabId, userId, otp);
                console.log(`[Connect] [C] fillMfa result:`, JSON.stringify(mfaResult));
                await new Promise(r => setTimeout(r, 4000));
                continue;
            } else {
                console.log(`[Connect] [C] ⚠️ MFA required nhưng không có secret`);
            }
        }

        // ── Nếu có nút consent/authorize → click ──
        if (currentUrl && currentUrl.includes('auth.openai.com') && !oauthState?.hasEmailInput && !oauthState?.hasPasswordInput && !oauthState?.hasMfaInput && !oauthState?.hasPhoneScreen) {
            console.log(`[Connect] [C] [Technical: Programmatic Click] Đang tìm và nhấn nút Allow/Authorize qua mã lệnh (hoặc API fallback)...`);

            // Inject script to extract exact workspace & org IDs and call API via fetch IF click doesn't redirect
            const codeResult = await evalJson(tabId, userId, `
            (async () => {
                const AUTH_BASE = 'https://auth.openai.com';
                const CONSENT_URL = AUTH_BASE + '/sign-in-with-chatgpt/codex/consent';

                const getAllCookies = () => {
                    const result = {};
                    document.cookie.split(';').forEach(c => {
                        const [k, ...v] = c.trim().split('=');
                        if (k) result[k.trim()] = v.join('=');
                    });
                    return result;
                };

                // THỬ CLICK BUTTON TRƯỚC (Cách 1)
                const isVisible = el => {
                    if (!el) return false;
                    const s = window.getComputedStyle(el);
                    const r = el.getBoundingClientRect();
                    return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
                };
                const btn = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]'))
                    .filter(isVisible)
                    .find(el => {
                        const t = (el.innerText || el.textContent || '').trim().toLowerCase();
                        return t.includes('allow') || t.includes('authorize') || t.includes('continue') || t.includes('accept') || t.includes('cho phép') || t.includes('chấp nhận');
                    });
                
                if (btn) { 
                    btn.click();
                    // Đợi 1 chút xem có redirect không, browser sẽ ngắt script này nếu page unload
                    await new Promise(r => setTimeout(r, 2000));
                }

                // NẾU VẪN Ở ĐÂY, THỬ GỌI API (Cách 2)
                try {
                    const cookies = getAllCookies();
                    const authSession = cookies['oai-client-auth-session'] || '';
                    const deviceId = cookies['oai-did'] || '';
                    let workspaceId = '';

                    // NẾU LÀ MÀN HÌNH WORKSPACE SELECTION HOẶC CONSENT
                    if (authSession) {
                        try {
                            const segments = authSession.split('.');
                            const payload = segments[0];
                            const pad = '='.repeat((4 - (payload.length % 4)) % 4);
                            const decoded = atob(payload.replace(/-/g, '+').replace(/_/g, '/') + pad);
                            const parsed = JSON.parse(decoded);
                            const ws = (parsed.workspaces || [])[0];
                            workspaceId = (ws && ws.id) ? ws.id : '';
                        } catch(e) { }
                    }

                    if (!workspaceId) {
                        const html = document.documentElement.innerHTML;
                        const matches = html.match(/"id"\\s*[:|,]\\s*"([0-9a-f-]{36})"/gi) || [];
                        for (const m of matches) {
                            const idMatch = m.match(/([0-9a-f-]{36})/i);
                            if (idMatch && idMatch[1]) { workspaceId = idMatch[1]; break; }
                        }
                    }

                    if (!workspaceId) {
                        return { ok: false, error: 'No workspace found to bypass consent manually' };
                    }

                    const commonHeaders = {
                        'content-type': 'application/json',
                        'accept': 'application/json',
                        'referer': location.href,
                        'origin': AUTH_BASE,
                        'oai-device-id': deviceId
                    };

                    const wsRes = await fetch(AUTH_BASE + '/api/accounts/workspace/select', {
                        method: 'POST',
                        credentials: 'include',
                        headers: commonHeaders,
                        body: JSON.stringify({ workspace_id: workspaceId }),
                        redirect: 'manual',
                    });

                    let continueUrl = wsRes.headers.get('location') || '';
                    let wsData = {};
                    if (!continueUrl) {
                        try {
                            wsData = await wsRes.json();
                            continueUrl = wsData.continue_url || wsData.redirect_uri || '';
                        } catch(_) {}
                    }

                    const orgs = (wsData?.data?.orgs) || [];
                    if (!continueUrl && orgs.length > 0 && orgs[0].id) {
                        let orgBody = { org_id: orgs[0].id };
                        if (orgs[0].projects && orgs[0].projects[0]) {
                            orgBody.project_id = orgs[0].projects[0].id;
                        }

                        const orgRes = await fetch(AUTH_BASE + '/api/accounts/organization/select', {
                            method: 'POST',
                            credentials: 'include',
                            headers: commonHeaders,
                            body: JSON.stringify(orgBody),
                            redirect: 'manual'
                        });
                        continueUrl = orgRes.headers.get('location') || '';
                        if (!continueUrl) {
                            try {
                                const orgData = await orgRes.json();
                                continueUrl = orgData.continue_url || orgData.redirect_uri || '';
                            } catch(_) {}
                        }
                    }

                    let code = '';
                    let tempUrl = continueUrl;
                    if (tempUrl && !tempUrl.startsWith('http')) tempUrl = AUTH_BASE + tempUrl;

                    for (let i = 0; i < 5 && tempUrl; i++) {
                        if (tempUrl.includes('code=')) {
                            code = new URL(tempUrl).searchParams.get('code') || '';
                            if (code) break;
                        }
                        const rRes = await fetch(tempUrl, { credentials: 'include', redirect: 'manual' });
                        const loc = rRes.headers.get('location');
                        if (!loc) {
                             // Thử parse body nếu là JSON
                             try {
                                 const b = await rRes.json();
                                 tempUrl = b.continue_url || b.redirect_uri || '';
                             } catch(_) { break; }
                        } else {
                            tempUrl = loc.startsWith('http') ? loc : AUTH_BASE + loc;
                        }
                    }

                    return { ok: !!code, code, method: btn ? 'click+api' : 'api_only' };
                } catch(e) {
                    return { ok: false, error: e.message, clicked: !!btn };
                }
            })();
            `, 15000);

            if (codeResult?.code) {
                authCode = codeResult.code;
                console.log(`[Connect] ✅ OAuth code extracted via injected API fallback: ${authCode.slice(0, 20)}...`);
                break;
            } else if (codeResult?.clicked || codeResult?.method === 'click+api') {
                console.log(`[Connect] [C] Clicked authorize/continue button.`);
            } else {
                console.log(`[Connect] [C] Failed auto-consent:`, JSON.stringify(codeResult));
            }
        }

        await new Promise(r => setTimeout(r, 1500));
    }

    await saveStep('08_oauth_callback');

    // ── BƯỚC D: Exchange code → tokens ──────────────────────────────────
    if (authCode) {
        console.log(`[Connect] [D] Exchanging code for tokens...`);
        try {
            const tokenData = await exchangeCodeForTokens(authCode, pkce, effectiveProxy);
            const accessToken = tokenData.access_token || '';
            const refreshToken = tokenData.refresh_token || '';
            const idToken = tokenData.id_token || '';
            const expiresIn = tokenData.expires_in || 0;

            console.log(`[Connect] ✅ Token exchange thành công!`);
            console.log(`[Connect]    access_token: ${accessToken ? accessToken.slice(0, 30) + '...' : 'MISSING'}`);
            console.log(`[Connect]    refresh_token: ${refreshToken ? refreshToken.slice(0, 20) + '...' : 'MISSING'}`);
            console.log(`[Connect]    id_token: ${idToken ? 'present' : 'MISSING'}`);
            console.log(`[Connect]    expires_in: ${expiresIn}s`);

            if (!accessToken) {
                return sendConnectResult(task, 'error', 'Token exchange trả về nhưng không có access_token');
            }

            const meta = extractAccountMeta(accessToken);
            console.log(`[Connect] ✅ Meta: id=${meta.accountId} plan=${meta.planType} email=${meta.email}`);

            // Lấy cookies (deviceId, sessionToken)
            let sessionToken = '';
            let deviceId = '';
            try {
                const ck = await camofoxGet(`/tabs/${tabId}/cookies?userId=${userId}`, 6000);
                const cookies = Array.isArray(ck?.cookies) ? ck.cookies : (Array.isArray(ck) ? ck : []);
                const sessC = cookies.find(c =>
                    c.name === '__Secure-next-auth.session-token' ||
                    c.name === 'next-auth.session-token' ||
                    (c.name && c.name.includes('session-token'))
                );
                sessionToken = sessC?.value || '';
                const deviceC = cookies.find(c => c.name === 'oai-device-id');
                deviceId = deviceC?.value || '';
            } catch (_) { }

            return sendConnectResult(task, 'success', 'OAuth PKCE login + token exchange thành công', {
                ...tokenData,        // Truyền full raw response: access_token, refresh_token, id_token, token_type, v.v..
                accessToken,         // Fallback cho backend cũ (tạm thời)
                refreshToken,
                idToken,
                sessionToken,
                deviceId,
                expiresIn,
                accountId: meta.accountId,
                userId: meta.userId,
                organizationId: meta.organizationId,
                planType: meta.planType,
                expiredAt: meta.expiredAt,
                email: meta.email || email,
            });

        } catch (exchangeErr) {
            console.error(`[Connect] ❌ Token exchange lỗi: ${exchangeErr.message}`);
            // Fallback: thử lấy từ session nếu exchange thất bại
            console.log(`[Connect] 🔄 Fallback: lấy token từ /api/auth/session...`);
        }
    } else {
        console.log(`[Connect] ⚠️ Không lấy được OAuth code, fallback lấy session token...`);
    }

    // ── FALLBACK: Lấy access token từ /api/auth/session (không có refresh_token) ──
    console.log(`[Connect] 🔄 Fallback: Dùng session endpoint...`);
    // Navigate về ChatGPT trước
    await navigate(tabId, userId, 'https://chatgpt.com', 10000);
    await new Promise(r => setTimeout(r, 2000));

    let accessToken = '';
    let sessionData = null;

    for (let attempt = 0; attempt < 5; attempt++) {
        if (attempt === 2) {
            await navigate(tabId, userId, 'https://chatgpt.com', 10000);
            await new Promise(r => setTimeout(r, 2000));
        }

        const delay = [1500, 2000, 3000, 4000, 5000][attempt];
        await new Promise(r => setTimeout(r, delay));

        const sessionRes = await fetchSessionInPage(tabId, userId);
        console.log(`[Connect] 🔍 Session probe #${attempt + 1}: status=${sessionRes?.status}, ok=${sessionRes?.ok}`);

        if (sessionRes?.ok && sessionRes.body && sessionRes.body.length > 10) {
            try {
                sessionData = JSON.parse(sessionRes.body);
                accessToken = sessionData?.accessToken || '';
                if (accessToken) {
                    console.log(`[Connect] ✅ Fallback: Lấy được access_token (no refresh_token)`);
                    break;
                }
            } catch (_) { }
        }
    }

    await saveStep('06_session_captured');

    if (!accessToken) {
        return sendConnectResult(task, 'error',
            `Cả OAuth PKCE và session fallback đều thất bại. SessionData keys: ${Object.keys(sessionData || {}).join(',') || 'empty'}`
        );
    }

    const meta = extractAccountMeta(accessToken);
    console.log(`[Connect] ⚠️ Fallback mode: CHỈ có access_token, KHÔNG có refresh_token`);

    // Lấy cookies
    let sessionToken = '';
    let deviceId = '';
    try {
        const ck = await camofoxGet(`/tabs/${tabId}/cookies?userId=${userId}`, 6000);
        const cookies = Array.isArray(ck?.cookies) ? ck.cookies : (Array.isArray(ck) ? ck : []);
        const sessC = cookies.find(c =>
            c.name === '__Secure-next-auth.session-token' ||
            c.name === 'next-auth.session-token' ||
            (c.name && c.name.includes('session-token'))
        );
        sessionToken = sessC?.value || '';
        const deviceC = cookies.find(c => c.name === 'oai-device-id');
        deviceId = deviceC?.value || '';
    } catch (_) { }

    await sendConnectResult(task, 'success', 'Đăng nhập thành công (fallback - chỉ access_token, không refresh_token)', {
        access_token: accessToken,
        refresh_token: '',
        accessToken,
        refreshToken: '', // ⚠️ Không có refresh_token trong fallback mode
        sessionToken,
        deviceId,
        accountId: meta.accountId,
        userId: meta.userId,
        organizationId: meta.organizationId,
        planType: meta.planType,
        expiredAt: meta.expiredAt,
        email: meta.email || email,
    });
}

// ================================================================
// SEND RESULT
// ================================================================
async function sendConnectResult(task, status, message, tokens = null) {
    const preview = message.slice(0, 100);
    console.log(`[Connect] 📡 ${status.toUpperCase()}: ${preview}`);
    try {
        const res = await fetch('http://localhost:4000/api/vault/accounts/connect-result', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: task.id, status, message, tokens }),
            signal: AbortSignal.timeout(30000),
        });
        console.log(`[Connect] 📡 Tools HTTP ${res.status}`);
    } catch (e) {
        console.log(`[Connect] ⚠️ sendResult failed: ${e.message}`);
    }
}

// ================================================================
// POLLING
// ================================================================
let activeConnect = 0;
const connectingIds = new Set();

async function fetchConnectTask() {
    try {
        const exclude = [...connectingIds].join(',');
        const res = await fetch(
            `http://localhost:4000/api/vault/accounts/connect-task${exclude ? `?exclude=${exclude}` : ''}`,
            { signal: AbortSignal.timeout(4000) }
        );
        if (res.ok) {
            const d = await res.json();
            return d?.task || null;
        }
    } catch (_) { }
    return null;
}

async function pollConnect() {
    if (activeConnect >= MAX_THREADS) return;
    try {
        const task = await fetchConnectTask();
        if (!task?.id || connectingIds.has(task.id)) return;

        connectingIds.add(task.id);
        activeConnect++;
        console.log(`[Connect] 🚀 Bắt đầu luồng: ${task.email} (${activeConnect}/${MAX_THREADS})`);

        runConnectFlow(task).finally(() => {
            activeConnect = Math.max(0, activeConnect - 1);
            connectingIds.delete(task.id);
            console.log(`[Connect] 🏁 Kết thúc luồng: ${task.email}`);
            if (activeConnect < MAX_THREADS) setTimeout(pollConnect, 1000);
        });

        if (activeConnect < MAX_THREADS) setTimeout(pollConnect, 2000);
    } catch (e) {
        console.error(`[Connect] Poll error: ${e.message}`);
    }
}

// ================================================================
// STARTUP
// ================================================================
console.log(`\n====================================`);
console.log(`🔌 SEELLM AUTO-CONNECT WORKER v2`);
console.log(`====================================`);
console.log(`CAMOFOX : ${CAMOUFOX_API}`);
console.log(`THREADS : ${MAX_THREADS}`);
console.log(`POLL    : ${POLL_INTERVAL_MS}ms`);
console.log(`====================================\n`);

setInterval(pollConnect, POLL_INTERVAL_MS);
pollConnect();
