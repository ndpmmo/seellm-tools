/**
 * SeeLLM Tools - Auto-Register Worker
 * 
 * Worker tự động tạo tài khoản ChatGPT qua trình duyệt (Camoufox).
 * Format Input yêu cầu: email|password|refresh_token|client_id
 * (Ví dụ: abc@hotmail.com|pass123|R_TOKEN|C_ID)
 * 
 * Sau khi đăng ký xong, Worker sẽ KIẾT KẾT bật tính năng 2FA (MFA)
 * để lấy Secret Key lưu lại, giúp các lần đăng nhập sau không cần lấy OTP từ Mail.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import { CAMOUFOX_API, GATEWAY_URL, WORKER_AUTH_TOKEN, TOOLS_API_URL } from './config.js';
import { camofoxPost, camofoxGet, camofoxDelete, evalJson, navigate, waitForSelector, pressKey } from './lib/camofox.js';
import { getTOTP } from './lib/totp.js';
import { extractIpFromText, normalizeProxyUrl, getLocalPublicIp, probeProxyExitIp } from './lib/proxy-diag.js';
import { createSaveStep } from './lib/screenshot.js';
import { waitForOTPCode } from './lib/ms-graph-email.js';
import { firstNames, lastNames } from './lib/names.js';
import { setupMFA } from './lib/mfa-setup.js';
import { generatePKCE, buildOAuthURL, exchangeCodeForTokens, CODEX_CONSENT_URL, decodeAuthSessionCookie, extractWorkspaceId, performWorkspaceConsentBypass } from './lib/openai-oauth.js';
import { getState, fillEmail, fillPassword, fillMfa } from './lib/openai-login-flow.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(__dirname, '..');
const IMAGES_DIR = path.join(ROOT_DIR, 'data', 'screenshots');

const OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const OAUTH_URL = 'https://auth.openai.com';
const OPENAI_AUTH = 'https://auth.openai.com';

// ============================================
// OAUTH HELPERS
// ============================================

async function performCodexOAuth(tabId, userId, proxyUrl, saveStep, creds = {}) {
  console.log(`[OAuth] Starting Codex OAuth PKCE flow...`);
  const pkce = generatePKCE();
  const authUrl = buildOAuthURL(pkce);
  console.log(`[OAuth] Navigating to: ${authUrl.slice(0, 80)}...`);

  await navigate(tabId, userId, authUrl, { timeoutMs: 20000 });
  await new Promise(r => setTimeout(r, 3000));
  await saveStep('oauth_start');

  // Track which login steps already performed (avoid re-fill loops)
  let emailFilled = false;
  let passwordFilled = false;
  let mfaFilled = false;

  // Poll for callback with ?code=
  let authCode = '';
  for (let i = 0; i < 40; i++) {
    const currentUrl = await evalJson(tabId, userId, 'location.href', { timeoutMs: 4000 });
    console.log(`[OAuth] Poll #${i + 1}: ${(currentUrl || '').slice(0, 80)}`);

    if (currentUrl && currentUrl.includes('code=')) {
      try {
        const url = new URL(currentUrl);
        authCode = url.searchParams.get('code') || '';
        if (authCode) {
          console.log(`[OAuth] ✅ Code received: ${authCode.slice(0, 20)}...`);
          break;
        }
      } catch (e) {
        console.log(`[OAuth] URL parse error: ${e.message}`);
      }
    }

    const state = await getState(tabId, userId);

    // ── auth.openai.com requires re-login → fill credentials we just created ──
    if (state?.hasEmailInput && !emailFilled && creds.email) {
      console.log(`[OAuth] 📧 Email input detected, filling: ${creds.email}`);
      const r = await fillEmail(tabId, userId, creds.email);
      console.log(`[OAuth] fillEmail →`, JSON.stringify(r));
      emailFilled = true;
      await new Promise(r2 => setTimeout(r2, 4000));
      await saveStep('oauth_email_filled');
      continue;
    }

    if (state?.hasPasswordInput && !passwordFilled && creds.password) {
      console.log(`[OAuth] 🔑 Password input detected, filling`);
      const r = await fillPassword(tabId, userId, creds.password);
      console.log(`[OAuth] fillPassword →`, JSON.stringify(r));
      passwordFilled = true;
      await new Promise(r2 => setTimeout(r2, 4000));
      await saveStep('oauth_password_filled');
      continue;
    }

    if (state?.hasMfaInput && !mfaFilled && creds.mfaSecret) {
      try {
        const otp = getTOTP(creds.mfaSecret);
        console.log(`[OAuth] 🔐 MFA input detected, filling TOTP: ${otp}`);
        const r = await fillMfa(tabId, userId, otp);
        console.log(`[OAuth] fillMfa →`, JSON.stringify(r));
        mfaFilled = true;
        await new Promise(r2 => setTimeout(r2, 5000));
        await saveStep('oauth_mfa_filled');
        continue;
      } catch (e) {
        console.log(`[OAuth] MFA fill error: ${e.message}`);
      }
    }

    // Check if phone screen appears → try conditional bypass
    if (state?.hasPhoneScreen) {
      console.log(`[OAuth] Phone screen detected, trying conditional bypass...`);
      const bypassResult = await performWorkspaceConsentBypass(evalJson, tabId, userId);
      if (bypassResult.ok && bypassResult.code) {
        authCode = bypassResult.code;
        console.log(`[OAuth] ✅ Bypass succeeded, code: ${authCode.slice(0, 20)}...`);
        break;
      } else {
        console.log(`[OAuth] Bypass failed: ${bypassResult.error}`);
        return { success: false, error: 'NEED_PHONE', bypassResult };
      }
    }

    await new Promise(r => setTimeout(r, 1500));
  }

  if (!authCode) {
    return { success: false, error: 'No authorization code received' };
  }

  // Exchange code for tokens
  console.log(`[OAuth] Exchanging code for tokens...`);
  try {
    const tokens = await exchangeCodeForTokens(authCode, pkce, proxyUrl);
    console.log(`[OAuth] ✅ Token exchange successful`);
    return { success: true, tokens };
  } catch (err) {
    console.log(`[OAuth] Token exchange failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}

// ============================================
// HELPERS
// ============================================
// Wrapper for camofoxPost that injects sessionKey (auto-register specific)
async function camofoxPostWithSessionKey(endpoint, body, timeoutMs = 30000) {
  const payload = { ...body, sessionKey: WORKER_AUTH_TOKEN };
  return camofoxPost(endpoint, payload, { timeoutMs });
}

function generateRandomUserInfo() {
  // Độ tuổi ngẫu nhiên từ 18 đến 40
  const age = Math.floor(Math.random() * (40 - 18 + 1)) + 18;
  const currentYear = new Date().getFullYear();
  const year = currentYear - age;

  // Ngày, tháng ngẫu nhiên cho form cũ (Nếu bị bắt nhập DOB)
  const month = String(Math.floor(Math.random() * 12) + 1).padStart(2, '0');
  const day = String(Math.floor(Math.random() * 28) + 1).padStart(2, '0');

  const fName = firstNames[Math.floor(Math.random() * firstNames.length)];
  const lName = lastNames[Math.floor(Math.random() * lastNames.length)];

  return {
    name: `${fName} ${lName}`,
    birthdate: `${year}-${month}-${day}`, // Dùng cho input [DD/MM/YYYY] cổ điển
    age: age // Dùng cho input [Age] đời mới
  };
}


async function updatePoolStatus(email, data) {
  try {
    await fetch(`${TOOLS_API_URL}/api/vault/email-pool`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, ...data }),
    });
  } catch (err) {
    console.log(`[Pool] Update failed for ${email}: ${err.message}`);
  }
}

async function getCookies(tabId, userId) {
  const res = await fetch(`${CAMOUFOX_API}/tabs/${tabId}/cookies?userId=${userId}`);
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data.cookies) ? data.cookies : (Array.isArray(data) ? data : []);
}


// ============================================
// MAIN REGISTER FLOW
// ============================================

export async function runAutoRegister(taskInput) {
  const parts = taskInput.split('|');
  let email, emailPassword, authMethod, refreshToken, clientId, proxyUrl, oauthFlag;

  if (parts.length >= 5) {
    [email, emailPassword, authMethod, refreshToken, clientId, proxyUrl, oauthFlag] = parts;
  } else {
    // Fallback format cũ: email|password|refresh_token|client_id
    [email, emailPassword, refreshToken, clientId] = parts;
    authMethod = 'graph';
  }
  proxyUrl = normalizeProxyUrl(proxyUrl);

  // Parse oauth flag (format: oauth=1 or oauth=true)
  const enableOAuth = oauthFlag && (oauthFlag.includes('oauth=1') || oauthFlag.includes('oauth=true'));
  console.log(`[Register] OAuth flow: ${enableOAuth ? 'ENABLED' : 'DISABLED'}`);

  if (!email || !refreshToken || !clientId) {
    throw new Error("Input string is invalid (expected email|pass|method|refresh_token|client_id[|proxyUrl])");
  }

  // Update pool status to processing
  await updatePoolStatus(email, { chatgpt_status: 'processing' });

  // Tạo mật khẩu ngẫu nhiên đủ mạnh (16 ký tự: chữ thường, chữ hoa, số, ký tự đặc biệt)
  const CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
  const chatGptPassword = Array.from({ length: 16 }, () => CHARS[Math.floor(Math.random() * CHARS.length)]).join('');

  console.log(`==========================================`);
  console.log(`🚀 [Auto-Register] Bắt đầu đăng ký: ${email}`);
  console.log(`==========================================`);

  const USER_ID = `register_${Date.now()}`;
  console.log(`SESSION_ID: ${USER_ID}`); // Quan trọng để frontend link ảnh chụp
  const runDir = path.join(IMAGES_DIR, USER_ID);
  await fs.mkdir(runDir, { recursive: true }).catch(() => { });

  let tabId = null;
  let saveStep = null;

  try {
    // 1. Khởi động - Đi từ trang login để tránh bị blank page
    console.log(`🚀 [Phase 1] Truy cập trang Login...`);
    const tabRes = await camofoxPostWithSessionKey('/tabs', {
      userId: USER_ID,
      url: "https://chatgpt.com/auth/login",
      headless: false,
      humanize: true,
      ...(proxyUrl ? { proxy: proxyUrl } : {})
    });
    console.log(proxyUrl ? `🔌 Dùng proxy: ${proxyUrl}` : '🌐 Không dùng proxy');
    tabId = tabRes.tabId;
    console.log(`Tab ID: ${tabId}`);

    saveStep = createSaveStep(runDir, { tabId, userId: USER_ID });

    await new Promise(r => setTimeout(r, 5000));

    // 🔍 [Diagnostic] Kiểm tra IP thoát của Proxy bằng tab probe riêng (tránh false-fail do CORS)
    try {
      console.log(`🔍 [Diagnostic] Đang kiểm tra IP thoát qua Proxy...`);
      const ipCheck = await probeProxyExitIp(USER_ID, proxyUrl, true);
      if (ipCheck && ipCheck.ip) {
        console.log(`✅ [Diagnostic] Exit IP: ${ipCheck.ip}`);
        if (proxyUrl) {
          const localIp = await getLocalPublicIp();
          if (localIp) {
            console.log(`ℹ️ [Diagnostic] Host Public IP: ${localIp}`);
            if (String(localIp).toLowerCase() === String(ipCheck.ip).toLowerCase()) {
              throw new Error(`Proxy chưa được áp dụng (Exit IP trùng Host Public IP).`);
            }
          } else {
            throw new Error(`Không thể xác định Host Public IP để xác thực proxy.`);
          }
        }
      } else if (ipCheck && ipCheck.error) {
        console.log(`⚠️ [Diagnostic] Lỗi kiểm tra IP: ${ipCheck.error}`);
        // [HARD-FAIL] Nếu có gán proxy mà kiểm tra thất bại thì dừng luôn
        if (proxyUrl) {
          throw new Error(`Proxy không hoạt động hoặc không thể kết nối (Diagnostic failed). Dừng tiến trình để bảo mật.`);
        }
      } else if (proxyUrl) {
        throw new Error(`Không lấy được Exit IP khi đã gán proxy.`);
      }
    } catch (err) {
      console.log(`⚠️ [Diagnostic] Không thể kiểm tra IP: ${err.message}`);
      if (proxyUrl) {
        throw err; // Re-throw để dừng tiến trình ở block catch chính
      }
    }

    await saveStep('01_login_page');

    // Click "Sign up" để sang luồng đăng ký
    console.log(`🖱️  Chuyển sang luồng Đăng ký...`);
    await evalJson(tabId, USER_ID, `(() => {
      const links = Array.from(document.querySelectorAll('a, button'));
      const signup = links.find(l => l.innerText.toLowerCase().includes('sign up'));
      if(signup) signup.click();
    })()`);
    await new Promise(r => setTimeout(r, 5000));
    await saveStep('02_register_page');

    // 2. Điền Email & Submit
    console.log(`📝 [Phase 2] Đang điền Email: ${email}...`);
    await evalJson(tabId, USER_ID, `
      (() => {
        const typeReact = (inputSelector, text) => {
          const input = document.querySelector(inputSelector);
          if(!input) return false;
          const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          nativeSetter.call(input, text);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        };

        typeReact('input[name="email"], input[name="identifier"]', "${email}");
        const btn = Array.from(document.querySelectorAll('button')).find(b => {
            const text = b.innerText.trim();
            return text === 'Continue' || text === 'Tiếp tục';
        });
        if (btn) btn.click();
      })()
    `);

    // Đợi nhảy sang trang Password
    console.log("⏳ Chờ OpenAI xử lý Email và chuyển qua trang Password...");
    await new Promise(r => setTimeout(r, 12000));
    await saveStep('02_password_load');

    // 3. Form Điền Mật khẩu (create-account/password)
    console.log(`[3] Điền Password -> ${chatGptPassword}`);
    await evalJson(tabId, USER_ID, `
          (() => {
            const typeReact = (inputSelector, text) => {
              const input = document.querySelector(inputSelector);
              if(!input) return false;
              const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
              nativeSetter.call(input, text);
              input.dispatchEvent(new Event('input', { bubbles: true }));
              return true;
            };

            const isVisible = el => el && el.getBoundingClientRect().width > 0;
            // Dùng Selector mới toanh vừa bắt được
            typeReact('input[name="new-password"], input[type="password"]', "${chatGptPassword}");
            
            // Tìm nút Tiếp tục / Continue
            const btn = Array.from(document.querySelectorAll('button')).find(b => 
                (b.textContent.includes('Continue') || b.textContent.includes('Tiếp tục') || b.textContent.includes('Create account') || b.textContent.includes('Next')) 
                && isVisible(b)
            );
            if (btn) btn.click();
          })()
        `);
    await new Promise(r => setTimeout(r, 8000));
    await saveStep('03_after_password_submit');

    // 4. Giải OTP
    console.log(`[4] Đang phân tích luồng chờ mã Pin Verify...`);
    const isVerifyEmailUrl = await evalJson(tabId, USER_ID, `location.href.includes('email-verification')`);

    if (isVerifyEmailUrl || await evalJson(tabId, USER_ID, `document.body.innerText.toLowerCase().includes('verify')`)) {
      console.log(`[4.1] Đã nhận diện được giao diện nhập mã PIN!`);
      const otpCode = await waitForOTPCode({ email, refreshToken, clientId, senderDomain: 'openai.com', maxWaitSecs: 90 });
      if (!otpCode) throw new Error("Thất bại: Không lấy được mã OTP từ Mail sau 90s.");

      console.log(`[4.2] Nhập mã PIN ${otpCode} lên web...`);
      await evalJson(tabId, USER_ID, `
              (() => {
                 const typeReact = (inputSelector, text) => {
                   const input = document.querySelector(inputSelector);
                   if(!input) return false;
                   const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                   nativeSetter.call(input, text);
                   input.dispatchEvent(new Event('input', { bubbles: true }));
                   return true;
                 };

                 typeReact('input[name="code"], input[autocomplete="one-time-code"]', "${otpCode}");
                 
                 const isVisible = el => el && el.getBoundingClientRect().width > 0;
                 const btn = Array.from(document.querySelectorAll('button')).find(b => 
                    (b.textContent.includes('Continue') || b.textContent.includes('Tiếp tục') || b.textContent.includes('Next')) && 
                    !b.textContent.includes('with') && isVisible(b)
                 );
                 if (btn) btn.click();
              })()
            `);
      await new Promise(r => setTimeout(r, 6000));
      await saveStep('04_pin_verified');
    }

    // 5. Cấp User Info (tên, ngày sinh)
    console.log(`[5] Bypass thông tin Form About...`);
    const userInfo = generateRandomUserInfo();
    await new Promise(r => setTimeout(r, 3000)); // đợi form render xong
    await saveStep('04b_before_about');

    const aboutFillInfo = await evalJson(tabId, USER_ID, `
          (() => {
             const typeReact = (el, text) => {
               if (!el) return false;
               const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
               nativeSetter.call(el, text);
               el.dispatchEvent(new Event('input', { bubbles: true }));
               el.dispatchEvent(new Event('change', { bubbles: true }));
               return true;
             };

             const filled = { name: false, bday: false, btn: false };

             // Điền Name — thử nhiều selector
             const nameSelectors = [
               'input[name="name"]',
               'input[name="fullname"]', 
               'input[name="full_name"]',
               'input[autocomplete="name"]',
               'input[placeholder="Full name"]',
               'input[placeholder="Name"]',
             ];
             let nameEl = null;
             for (const s of nameSelectors) {
               nameEl = document.querySelector(s);
               if (nameEl) break;
             }
             if (nameEl) {
                 typeReact(nameEl, '${userInfo.name}');
                 filled.name = 'fullname';
             } else {
                 // thử split first/last name
                 const firstName = document.querySelector('input[name="first_name"], input[placeholder*="first" i], input[placeholder*="First" i]');
                 const lastName  = document.querySelector('input[name="last_name"],  input[placeholder*="last" i],  input[placeholder*="Last" i]');
                 const parts = '${userInfo.name}'.split(' ');
                 if (firstName) { typeReact(firstName, parts[0] || ''); filled.name = 'first'; }
                 if (lastName)  { typeReact(lastName,  parts[1] || parts[0]); filled.name = filled.name + '+last'; }
             }

             // Điền ngày sinh / tuổi
             const ageEl = document.querySelector('input[name="age"], input[placeholder="Age"], input[placeholder*="age" i]') ||
                           document.querySelector('input[type="number"]');
             const dobEl = document.querySelector('input[name="birthday"], input[name="dob"], input[type="date"]') ||
                           document.querySelector('input[placeholder*="DD"], input[placeholder*="MM/DD"], input[placeholder*="YYYY"]');
             
             if (ageEl && ageEl.type !== 'date') {
                 typeReact(ageEl, '${userInfo.age.toString()}');
                 filled.bday = 'age';
             } else if (dobEl) {
                 // format DD/MM/YYYY hoặc MM/DD/YYYY
                 const placeholder = dobEl.placeholder || '';
                 let dobStr;
                 if (placeholder.startsWith('MM')) {
                     dobStr = '${userInfo.birthdate.slice(5, 7)}/${userInfo.birthdate.slice(8, 10)}/${userInfo.birthdate.slice(0, 4)}';
                 } else {
                     dobStr = '${userInfo.birthdate.slice(8, 10)}/${userInfo.birthdate.slice(5, 7)}/${userInfo.birthdate.slice(0, 4)}';
                 }
                 typeReact(dobEl, dobStr);
                 filled.bday = 'dob';
             }

             // Click nút Agree / Continue / Finish creating account
             const btn = Array.from(document.querySelectorAll('button')).find(b => {
                 const txt = b.textContent.toLowerCase().trim();
                 return txt === 'agree' || txt === 'i agree' || txt === 'continue' || 
                        txt === 'finish' || txt.includes('creating account') ||
                        txt.includes('create account') || txt.includes('finish creating') ||
                        txt.includes('ti\u1ebfp t\u1ee5c') || txt.includes('\u0111\u1ed3ng \u00fd');
             });
             if (btn) { btn.click(); filled.btn = btn.textContent.trim(); }
             else { filled.btn = 'NOT_FOUND: ' + Array.from(document.querySelectorAll('button')).map(b => b.textContent.trim()).join(' | '); }

             return filled;
          })()
        `);
    console.log(`[5.1] Kết quả điền About: ${JSON.stringify(aboutFillInfo || {})}`);

    // Nếu btn bị NOT_FOUND, thử thêm 1 lần nữa
    if (typeof aboutFillInfo?.btn === 'string' && aboutFillInfo.btn.startsWith('NOT_FOUND')) {
      console.log(`[5.2] Btn không tìm thấy, thử lại sau 2s...`);
      await new Promise(r => setTimeout(r, 2000));
      await evalJson(tabId, USER_ID, `
        const btn = Array.from(document.querySelectorAll('button')).find(b => {
            const t = b.textContent.toLowerCase().trim();
            return t.includes('creating') || t.includes('finish') || t === 'continue' || t.includes('agree');
        });
        if (btn) btn.click();
        return btn?.textContent || 'still_not_found';
      `);
    }

    await new Promise(r => setTimeout(r, 6000)); // được redirect vào dashboard sau click
    await saveStep('05_about_completed');

    // 6. Nhẩy Bypass Phone & Nhẩy vào Workspace
    console.log(`[6] Tiến hành Bypass Screen (if Phone requested) và lấy Access Token...`);
    const pageUrl = await evalJson(tabId, USER_ID, `location.href`);
    if (pageUrl.includes('add-phone')) {
      console.log(`[6.1] Phát hiện add-phone → thử conditional bypass trước...`);
      const bypassResult = await performWorkspaceConsentBypass(evalJson, tabId, USER_ID);
      if (bypassResult.ok && bypassResult.code) {
        console.log(`[6.1] ✅ Conditional bypass thành công! Code: ${bypassResult.code.slice(0, 20)}...`);
        // Store code for later use if OAuth is enabled
        await saveStep('06b_phone_bypass_success');
      } else {
        console.log(`[6.1] ❌ Conditional bypass thất bại: ${bypassResult.error}. Redirecting to home...`);
        await camofoxPostWithSessionKey(`/tabs/${tabId}/navigate`, { userId: USER_ID, url: 'https://chatgpt.com/' });
        await new Promise(r => setTimeout(r, 8000));
      }
    }

    // Thao tác các bước cuối
    console.log(`[6] Hoàn tất và bỏ qua form khảo sát...`);
    await evalJson(tabId, USER_ID, `
      (() => {
        const skipElements = Array.from(document.querySelectorAll('button, a, div[role="button"]'));
        const skipBtn = skipElements.find(b => {
            const txt = b.textContent.toLowerCase().trim();
            return txt === 'skip' || txt === 'bỏ qua';
        });
        
        if (skipBtn) {
            skipBtn.click();
        } else {
            const personalUse = skipElements.find(e => {
                const txt = e.textContent.toLowerCase();
                return txt.includes('personal') || txt.includes('cá nhân') || txt.includes('other') || txt.includes('khác');
            });
            if (personalUse) personalUse.click();
            
            setTimeout(() => {
                const nextBtn = Array.from(document.querySelectorAll('button')).find(b => {
                    const txt = b.textContent.toLowerCase();
                    return txt.includes('next') || txt.includes('tiếp theo') || txt.includes('continue');
                });
                if (nextBtn) nextBtn.click();
            }, 800);
        }
      })()
    `);
    await new Promise(r => setTimeout(r, 6000));
    await saveStep('06_skip_survey');

    // Thao tác đóng Welcome Modal (OK, let's go)
    console.log(`[6.1] Đóng Welcome Modal...`);
    await evalJson(tabId, USER_ID, `
      (() => {
        const findAndClickOk = () => {
            const buttons = Array.from(document.querySelectorAll('button'));
            const okBtn = buttons.find(b => {
                const t = b.textContent.toLowerCase();
                return t.includes('ok') || t.includes('tiến hành') || t.includes('let') || t.includes('xong') || t.includes('done');
            });
            if (okBtn) {
                okBtn.click();
                return true;
            }
            return false;
        };
        if (!findAndClickOk()) {
            setTimeout(findAndClickOk, 2000);
        }
      })()
    `);
    await new Promise(r => setTimeout(r, 5000));
    await saveStep('07_inside_chat');

    await saveStep('06_home_reached');

    // 7. SETUP 2FA (MFA) - dùng UI Automation thay vì API cũ (404)
    console.log(`==========================================`);
    console.log(`[7] BẬT BẢO MẬT 2FA / MFA CHO ACCOUNT NÀY...`);
    console.log(`==========================================`);

    const mfaResult = await setupMFA(tabId, USER_ID, camofoxPostWithSessionKey);
    let twoFaSecret = null;

    if (mfaResult.success) {
      twoFaSecret = mfaResult.secret;
      console.log(`[7.1] 🟢 Bật 2FA Thành Công! Secret: ${twoFaSecret}`);
    } else {
      console.log(`[7.1] 🔴 Lỗi MFA: ${mfaResult.error || 'Unknown'}. Account vẫn hoạt động bình thường.`);
    }

    // 7.5. Codex OAuth flow (if enabled)
    let codexRefreshToken = null;
    if (enableOAuth) {
      console.log(`==========================================`);
      console.log(`[7.5] CODEX OAUTH FLOW...`);
      console.log(`==========================================`);
      
      const oauthResult = await performCodexOAuth(tabId, USER_ID, proxyUrl, saveStep, {
        email,
        password: chatGptPassword,
        mfaSecret: twoFaSecret,
      });
      if (oauthResult.success && oauthResult.tokens) {
        codexRefreshToken = oauthResult.tokens.refresh_token || null;
        console.log(`[7.5] 🟢 Codex OAuth thành công! Refresh token: ${codexRefreshToken ? 'YES' : 'NO'}`);
        await saveStep('oauth_success');
      } else {
        console.log(`[7.5] 🔴 Codex OAuth thất bại: ${oauthResult.error}. Account vẫn được lưu với session token.`);
        await saveStep('oauth_failed');
        // Graceful fallback - continue with session token
      }
    }

    // 8. TỔNG KẾT
    const tokens = await getCookies(tabId, USER_ID);
    const sessionToken = tokens.find(t => t.name === '__Secure-next-auth.session-token')?.value || null;

    if (!sessionToken) {
      console.log(`[8] 🔴 Báo lỗi: Không tìm thấy session token.`);
      throw new Error('Registration failed (No Auth session). Check screenshots.');
    }

    console.log(`==========================================`);
    console.log(`✅ ĐĂNG KÝ HOÀN TẤT THÀNH CÔNG: ${email}`);
    console.log(`🔑 Secret 2FA (MFA): ${twoFaSecret || 'None'}`);
    console.log(`🔑 Mật khẩu ChatGPT: ${chatGptPassword}`);
    if (codexRefreshToken) {
      console.log(`🔑 Codex Refresh Token: ${codexRefreshToken.slice(0, 20)}...`);
    }
    console.log(`==========================================`);

    let accountId = null;

    // Lưu vào kho account (status=idle, chờ Deploy - KHÔNG phải sẽ được deploy ngay)
    const accRes = await fetch(`http://localhost:4000/api/vault/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        password: chatGptPassword,
        two_fa_secret: twoFaSecret || '',
        provider: 'openai',
        status: 'idle',
        skipSync: true,
        restore_deleted: true,
        tags: JSON.stringify(['auto-register', 'vault-register', ...(codexRefreshToken ? ['codex-oauth'] : [])]),
        notes: `[Auto-Register] Email Pool: ${email} | MS Pass: ${emailPassword} | ChatGPT Pass: ${chatGptPassword}${twoFaSecret ? ` | 2FA: ${twoFaSecret}` : ''}${codexRefreshToken ? ` | Codex RT: ${codexRefreshToken.slice(0, 30)}...` : ''} | Tạo: ${new Date().toISOString()}`
      }),
    });
    const accData = await accRes.json();

    // Cập nhật pool status
    await updatePoolStatus(email, {
      chatgpt_status: 'done',
      linked_chatgpt_id: accData.id,
      notes: `Thành công | PID: ${process.pid} | Acc ID: ${accData.id}`
    });

    return {
      success: true, email, password: chatGptPassword, twoFaSecret, sessionToken, createdAt: new Date().toISOString()
    };

  } catch (err) {
    console.log(`==========================================`);
    console.log(`🔴 THẤT BẠI: ${email}`);
    console.log(`❌ Lỗi: ${err.message}`);
    console.log(`==========================================`);

    // Update pool status to failed
    await updatePoolStatus(email, {
      chatgpt_status: 'failed',
      notes: `Error: ${err.message} at ${new Date().toISOString()}`
    });

    if (tabId) { await camofoxPostWithSessionKey(`/tabs/${tabId}?userId=${USER_ID}`, {}, 5000).catch(() => { }); }
    return { success: false, email, error: err.message || String(err) };
  }
}

// Nếu chạy từ Command Line
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const input = process.argv[2];
  if (!input) {
    console.error("Usage: node auto-register-worker.js <email|pass|ref_token|cli_id>");
    process.exit(1);
  }
  runAutoRegister(input).then((res) => {
    if (res?.success) {
      console.log(`\n🎉 HOÀN TẤT: ${res.email}`);
      process.exit(0);
    } else {
      console.error(`\n❌ THẤT BẠI: ${res?.error || 'Unknown error'}`);
      process.exit(1);
    }
  }).catch((err) => {
    console.error(`\n❌ THẤT BẠI: ${err?.message || String(err)}`);
    process.exit(1);
  });
}
