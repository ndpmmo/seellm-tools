/**
 * SeeLLM Tools - ChatGPT Account Warmup Module
 * Automates conversational Q&A interactions using Camofox to maintain account health.
 */

import { CAMOUFOX_API, TOOLS_API_URL, WARMUP_SCREENSHOTS } from './config.js';
import { camofoxPost, camofoxGet, camofoxDelete, navigate, pressKey, evalJson, getSnapshot, clickRef } from './lib/camofox.js';
import { normalizeProxyUrl, assertProxyApplied, probeProxyExitIp, getLocalPublicIp, isLocalRelayProxy } from './lib/proxy-diag.js';
import { getFreshTOTP } from './lib/totp.js';
import { generateWarmupPrompts } from './lib/warmup-prompts.js';
import { createStepRecorder } from './lib/screenshot.js';
import { waitForOTPCode } from './lib/ms-graph-email.js';
import {
  getState,
  fillEmail,
  fillPassword,
  fillMfa,
  tryAcceptCookies,
  dismissGooglePopupAndClickLogin,
  selectPersonalWorkspaceOnWorkspacePage,
  clickContinueWithPassword,
  tryDismissPasskeyEnrollment,
} from './lib/openai-login-flow.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';



// Helper to get random number between min and max inclusive
function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Wait helper
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Parse command line arguments
function parseArgs() {
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const val = process.argv[i + 1];
      if (val && !val.startsWith('--')) {
        args[key] = val;
        i++;
      } else {
        args[key] = true;
      }
    }
  }
  return args;
}

/**
 * Polls the DOM to detect when ChatGPT has finished generating the AI response.
 * Uses multiple strategies for bulletproof detection.
 */
async function waitForGenerationComplete(tabId, userId, timeoutMs = 150000) {
  const startTime = Date.now();
  console.log(`[Warmup] ⏳ Chờ ChatGPT phản hồi xong...`);
  
  let hasStarted = false;
  const startTimeout = 8000; // 8 seconds to start generating
  
  while (Date.now() - startTime < timeoutMs) {
    const state = await evalJson(tabId, userId, `(() => {
      // 1. Check for visible "Stop generating" button
      const stopBtn = document.querySelector('button[aria-label="Stop generating"], button[data-testid="stop-generating-button"], button[class*="composer-submit"] svg[use*="stop"]');
      const isStopVisible = stopBtn && stopBtn.offsetParent !== null;
      
      // 2. Check for active streaming classes or selectors
      const streamingEl = document.querySelector('.result-streaming, .streaming, [class*="streaming"]');
      const isStreaming = !!streamingEl;
      
      // 3. Check submit/voice button state
      const submitBtn = document.querySelector('button[class*="composer-submit"], button[aria-label="Send prompt"], button[data-testid="send-button"]');
      let isSubmitStop = false;
      if (submitBtn && submitBtn.offsetParent !== null) {
        const ariaLabel = (submitBtn.getAttribute('aria-label') || '').toLowerCase();
        const className = (submitBtn.className || '').toLowerCase();
        const hasStopSvg = !!submitBtn.querySelector('svg[use*="stop"]') || !!submitBtn.querySelector('svg rect');
        
        if (ariaLabel.includes('stop') || className.includes('stop') || hasStopSvg) {
          isSubmitStop = true;
        }
      }
      
      return {
        isGenerating: isStopVisible || isStreaming || isSubmitStop,
        generatingReason: isStopVisible ? 'stop-button' : (isStreaming ? 'streaming-element' : (isSubmitStop ? 'submit-stop' : 'none'))
      };
    })()`);
    
    const elapsed = Date.now() - startTime;
    
    if (state.isGenerating) {
      hasStarted = true;
    }
    
    if (hasStarted) {
      if (!state.isGenerating) {
        console.log(`[Warmup] ✅ ChatGPT đã trả lời xong!`);
        return true;
      }
      console.log(`[Warmup] ⏱️ Generation status: generating (${state.generatingReason}) (${Math.round(elapsed / 1000)}s)`);
    } else {
      // If we haven't seen it start generating yet
      if (elapsed > startTimeout) {
        console.log(`[Warmup] ⚠️ Không phát hiện trạng thái generating sau ${startTimeout / 1000}s. Coi như phản hồi hoàn tất hoặc lỗi.`);
        return false;
      }
      console.log(`[Warmup] ⏱️ Generation status: waiting for start (${Math.round(elapsed / 1000)}s)`);
    }
    
    await delay(2000);
  }
  
  console.log(`[Warmup] ⚠️ Hết thời gian chờ phản hồi (${timeoutMs}ms). Tiến hành tiếp tục.`);
  return false;
}

/**
 * Automatically detects and clicks "Okay, let's go", "Next", "Skip", "Continue", "Done", etc.
 * onboarding buttons to clear ChatGPT's multi-step onboarding modals.
 */
async function dismissOnboardingModals(tabId, userId) {
  return await evalJson(tabId, userId, `(() => {
    let clickedAny = false;
    const buttons = Array.from(document.querySelectorAll('button, [role="button"], a, [class*="button"], [class*="btn"]'));
    for (const btn of buttons) {
      if (btn.offsetParent === null) continue;
      const text = (btn.innerText || btn.textContent || '').trim().toLowerCase();
      if (
        text.includes("let's go") ||
        text.includes("let’s go") ||
        text === "okay, let's go" ||
        text === "okay, let’s go" ||
        text === "okay" ||
        text === "ok" ||
        text === "got it" ||
        text === "done" ||
        text === "next" ||
        text === "skip" ||
        text === "continue" ||
        text === "get started" ||
        text === "tiếp tục" ||
        text === "bắt đầu" ||
        text === "đóng" ||
        text.includes("let's get started") ||
        text.includes("okay, let's get started") ||
        text.includes("you're all set")
      ) {
        btn.click();
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        clickedAny = true;
      }
    }
    return clickedAny;
  })()`).catch(() => false);
}

async function runWarmup() {
  const args = parseArgs();
  const accountId = args.accountId;
  
  if (!accountId) {
    console.error('❌ Thiếu đối số --accountId');
    process.exit(1);
  }
  
  let qCountArg = parseInt(args.questions || '0', 10);
  if (isNaN(qCountArg) || qCountArg <= 0) {
    qCountArg = randomInt(1, 3); // 1 to 3 questions randomly
  }
  
  console.log(`\n🔥 [Warmup] BẮT ĐẦU WARMUP TÀI KHOẢN: ${accountId}`);
  console.log(`[Warmup] 📝 Số câu hỏi tương tác dự kiến: ${qCountArg}\n`);
  
  // 1. Fetch account info from SeeLLM Tools local API
  let account;
  try {
    const res = await fetch(`${TOOLS_API_URL}/api/vault/accounts/${encodeURIComponent(accountId)}`);
    if (!res.ok) {
      throw new Error(`GET account returned status ${res.status}: ${await res.text()}`);
    }
    const data = await res.json();
    account = data.account;
  } catch (err) {
    console.error(`❌ Không tìm thấy thông tin tài khoản: ${err.message}`);
    process.exit(1);
  }
  
  const USER_ID = `seellm_warmup_${account.id}`;
  const SESSION_KEY = `warmup_${account.id}`;
  const effectiveProxy = normalizeProxyUrl(account.proxy_url || account.proxyUrl || account.proxy || null);
  
  let tabId = null;
  let preFlightResult = null;
  let questionsAsked = 0;
  let stepRecorder = null;
  
  try {
    const maxAttempts = 3;
    let runSuccess = false;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        questionsAsked = 0; // Reset question count on retry attempt
        
        // 2. Pre-flight Proxy Assert (traffic isolation security)
        if (effectiveProxy) {
          console.log(`[Warmup] 🔒 [PreFlight] Kiểm tra proxy (lượt ${attempt}/${maxAttempts}): ${effectiveProxy}`);
          try {
            let lastErr = null;
        for (let preflightAttempt = 0; preflightAttempt < 3; preflightAttempt++) {
          try {
            preFlightResult = await assertProxyApplied(effectiveProxy);
            lastErr = null;
            break;
          } catch (err) {
            lastErr = err;
            const msg = String(err?.message || err || '');
            const isTransient = msg.includes('fetch failed') || msg.includes('Không lấy được exit IP');
            if (!isTransient || preflightAttempt === 2) break;
            console.log(`[Warmup] ⚠️ [PreFlight] Thử lại ${preflightAttempt + 1}/2 sau lỗi: ${msg}`);
            await delay(2000 + preflightAttempt * 1500);
          }
        }
        if (!preFlightResult && lastErr) throw lastErr;
        console.log(`[Warmup] ✅ [PreFlight] Exit IP: ${preFlightResult.exitIp}`);
      } catch (err) {
        console.error(`[Warmup] 🛑 [PreFlight] Proxy verification FAILED: ${err.message}`);
        throw err;
      }
    }
    
    // 3. Open Camofox Tab
    console.log(`[Warmup] 🦊 Khởi động Camofox tab...`);
    const opened = await camofoxPost('/tabs', {
      userId: USER_ID,
      sessionKey: SESSION_KEY,
      url: 'about:blank',
      proxy: effectiveProxy || undefined,
      persistent: true, // Reuse profiles/cookies inside Camofox
      os: 'macos',
      screen: { width: 1440, height: 900 },
      humanize: true,
      headless: false,
    }, { timeoutMs: 35000 });
    
    tabId = opened.tabId;
    await delay(3000);
    
    // Set up step recorder for screenshots if enabled
    if (WARMUP_SCREENSHOTS) {
      const runDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'screenshots', `warmup_${account.id}`);
      await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
      await fs.mkdir(runDir, { recursive: true });
      stepRecorder = createStepRecorder(runDir, { tabId, userId: USER_ID, ignoreGlobalDisable: true });
      console.log(`[Warmup] 📸 Chụp ảnh logs đã bật! Thư mục ảnh: ${runDir}`);
    }

    
    // 4. Import cookies from database if present
    if (account.cookies && Array.isArray(account.cookies) && account.cookies.length > 0) {
      console.log(`[Warmup] 🍪 Nạp ${account.cookies.length} cookies từ database vào browser context...`);
      try {
        await fetch(`${CAMOUFOX_API}/sessions/${USER_ID}/cookies`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cookies: account.cookies })
        });
      } catch (err) {
        console.warn(`⚠️ [Warmup] Lỗi khi import cookies: ${err.message}`);
      }
    }
    
    // 5. Navigate to ChatGPT Chat interface
    console.log(`[Warmup] 🌐 Mở trang ChatGPT...`);
    await navigate(tabId, USER_ID, 'https://chatgpt.com/');
    await delay(5000);
    
    if (WARMUP_SCREENSHOTS && stepRecorder) {
      await stepRecorder.checkpoint(1, 1, 'chatgpt_initial_page');
    }
    
    // 6. Check login state
    const checkLoginState = async () => {
      const state = await getState(tabId, USER_ID);
      return state.looksLoggedIn;
    };

    let isLoggedIn = await checkLoginState();
    
    if (!isLoggedIn) {
      console.log(`[Warmup] 👤 Chưa đăng nhập hoặc cookie hết hạn! Tiến hành đăng nhập...`);
      
      const maxLoginAttempts = 15;
      let emailFilled = false;
      let emailWaitCount = 0;
      let passwordFilled = false;
      let passwordWaitCount = 0;
      let mfaFilled = false;
      
      for (let attempt = 1; attempt <= maxLoginAttempts; attempt++) {
        console.log(`[Warmup] 🔑 Loop đăng nhập - Lượt ${attempt}/${maxLoginAttempts}...`);
        
        // Take a screenshot of the login step
        if (WARMUP_SCREENSHOTS && stepRecorder) {
          await stepRecorder.checkpoint(1, 10 + attempt, `login_loop_step_${attempt}`);
        }
        
        // 1. Get current state
        const state = await getState(tabId, USER_ID);
        console.log(`[Warmup] ℹ️ Lượt ${attempt} trạng thái trang:`);
        console.log(`   - URL: ${state.href}`);
        console.log(`   - onAuthDomain: ${state.onAuthDomain}`);
        console.log(`   - looksLoggedIn: ${state.looksLoggedIn}`);
        console.log(`   - hasEmailInput: ${state.hasEmailInput}`);
        console.log(`   - hasPasswordInput: ${state.hasPasswordInput}`);
        console.log(`   - hasMfaInput: ${state.hasMfaInput}`);
        console.log(`   - hasContinueWithPassword: ${state.hasContinueWithPassword}`);
        
        if (state.looksLoggedIn) {
          console.log(`[Warmup] 👤 Đăng nhập thành công (trạng thái looksLoggedIn = true)!`);
          isLoggedIn = true;
          break;
        }
        
        if (state.hasDeactivated) {
          throw new Error('ACCOUNT_DEACTIVATED: Tài khoản đã bị khóa');
        }

        if (state.hasResetPasswordScreen) {
          throw new Error('PASSWORD_RESET_REQUIRED: Tài khoản yêu cầu đặt lại mật khẩu');
        }

        if (state.hasWrongPassword) {
          throw new Error('WRONG_PASSWORD: Mật khẩu không đúng');
        }
        
        // 1.5. Handle OpenAI/ChatGPT Error screen with self-healing click
        if (state.hasError && !state.isOnboardingScreen) {
          console.log(`[Warmup] ⚠️ Phát hiện lỗi trên trang OpenAI/ChatGPT! URL: ${state.href}`);
          // Reset tất cả flags để login loop bắt đầu lại sạch
          emailFilled = false;
          emailWaitCount = 0;
          passwordFilled = false;
          passwordWaitCount = 0;
          mfaFilled = false;

          // Navigate thẳng về chatgpt.com thay vì click "Go back" (tránh vòng lặp redirect)
          // "Go back" sau workspace selection thường đưa về login page gây loop
          console.log(`[Warmup] 🔄 Điều hướng lại về chatgpt.com để khắc phục lỗi...`);
          try {
            await navigate(tabId, USER_ID, 'https://chatgpt.com/');
          } catch (_) {
            // Fallback: click "Go back" nếu navigate thất bại
            await evalJson(tabId, USER_ID, `(() => {
              const btn = Array.from(document.querySelectorAll('button, a, [role="button"]'))
                .find(el => {
                  const t = (el.innerText || el.textContent || '').trim().toLowerCase();
                  return t.includes('go back') || t.includes('try again') || t.includes('thử lại') || t.includes('quay lại');
                });
              if (btn) { btn.click(); return true; }
              return false;
            })()`).catch(() => false);
          }
          await delay(6000);
          continue;
        }
        
        // 2. Handle Welcome Back dialog (Diane Mitchell dialog in Image 1)
        const chooseResult = await evalJson(tabId, USER_ID, `(() => {
          const body = (document.body?.innerText || '').toLowerCase();
          const hasWelcomeBack = body.includes('welcome back') || body.includes('chào mừng quay trở lại') || body.includes('choose an account') || body.includes('chọn một tài khoản');
          if (!hasWelcomeBack) return null;
          
          // Strategy 1: Look for button, [role="button"], [role="option"], or anchor elements first
          const clickables = document.querySelectorAll('button, [role="button"], [role="option"], a');
          for (const el of clickables) {
            if (el.offsetParent === null) continue;
            const text = (el.textContent || '').trim().toLowerCase();
            const emailPart = ${JSON.stringify(account.email.toLowerCase().split('@')[0])};
            if (text.includes(emailPart) || text.includes(${JSON.stringify(account.email.toLowerCase())})) {
              el.click();
              // Dispatch MouseEvents for extra security
              el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
              el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
              el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
              return 'clicked_btn: ' + text.slice(0, 60);
            }
          }
          
          // Strategy 2: Fallback to child divs with classes containing account/item/button
          const divs = document.querySelectorAll('div[class*="account"], div[class*="item"], div[class*="button"]');
          for (const el of divs) {
            if (el.offsetParent === null) continue;
            // Ensure we are clicking a leaf-like div, not the outer modal container
            if (el.querySelector('div[class*="account"], div[class*="item"]')) continue;
            const text = (el.textContent || '').trim().toLowerCase();
            const emailPart = ${JSON.stringify(account.email.toLowerCase().split('@')[0])};
            if (text.includes(emailPart) || text.includes(${JSON.stringify(account.email.toLowerCase())})) {
              el.click();
              el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
              el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
              el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
              return 'clicked_div: ' + text.slice(0, 60);
            }
          }
          return null;
        })()`);
        if (chooseResult) {
          console.log(`[Warmup] 👤 Phát hiện bảng Welcome Back -> Đã chọn tài khoản: ${chooseResult}`);
          await delay(4000);
          continue;
        }
        
        // 3. Handle Cookie Banner
        if (state.hasCookieBanner) {
          console.log(`[Warmup] 🍪 Phát hiện cookie banner -> Chấp nhận cookies...`);
          const clicked = await tryAcceptCookies(tabId, USER_ID);
          await delay(2000);
          if (clicked) {
            continue;
          }
        }
        
        // 4. Handle Workspace Selection (Image 2)
        if (state.isWorkspaceScreen) {
          console.log(`[Warmup] 🗂️ Phát hiện màn hình chọn Workspace -> Chọn Personal account...`);
          const wsResult = await selectPersonalWorkspaceOnWorkspacePage(tabId, USER_ID, { timeoutMs: 15000 });
          if (wsResult?.ok) {
            console.log(`[Warmup] ✅ Đã chọn Personal workspace: ${wsResult.text || ''}`);
            await delay(4000);
          } else {
            console.warn(`[Warmup] ⚠️ Chọn Workspace thất bại: ${wsResult?.reason}`);
            await delay(2000);
          }
          continue;
        }
        
         // 4.5. Handle Email Inbox verification screen ("Check your inbox")
        // Xảy ra khi OpenAI yêu cầu xác minh email trước khi vào màn hình mật khẩu.
        // Phân biệt với TOTP: trang này có nút "Continue with password" → click để đi thẳng vào password screen.
        if (state.hasEmailInboxScreen || state.hasContinueWithPassword) {
          console.log(`[Warmup] 📬 Phát hiện màn hình xác minh qua Email ("Check your inbox"). Chuyển sang nhập mật khẩu...`);
          const cwpResult = await clickContinueWithPassword(tabId, USER_ID);
          if (cwpResult?.ok) {
            console.log(`[Warmup] ✅ Đã click "Continue with password" (method: ${cwpResult.method}). Chờ màn hình mật khẩu...`);
            passwordFilled = false;
            passwordWaitCount = 0;
            await delay(4000);
          } else {
            console.warn(`[Warmup] ⚠️ Không tìm thấy nút "Continue with password" trên màn hình email. Thử lại...`);
            await delay(3000);
          }
          continue;
        }

        // 5. Handle Password Input
        if (state.hasPasswordInput) {
          if (passwordFilled) {
            passwordWaitCount++;
            if (passwordWaitCount < 3) {
              console.log(`[Warmup] 🔑 Password đã được điền ở lượt trước, đang chờ đăng nhập (lần đợi ${passwordWaitCount})...`);
              // Retrigger password submit click just in case the password is still in the input box
              const clicked = await evalJson(tabId, USER_ID, `(() => {
                const input = document.querySelector('input[type="password"], input[name="password"], input[id="password"]');
                if (input && !input.value.trim()) {
                  return false;
                }
                const btn = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]'))
                  .find(el => {
                    const t = (el.innerText || el.textContent || el.value || '').trim().toLowerCase();
                    return t === 'continue' || t === 'sign in' || t === 'log in' || t === 'next' || t === 'tiếp tục';
                  });
                if (btn) {
                  btn.click();
                  btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                  return true;
                }
                return false;
              })()`).catch(() => null);
              
              if (clicked === false) {
                console.log(`[Warmup] 🔑 Ô nhập password bị trống (trang đã bị reset) -> Tiến hành điền lại password ngay...`);
                passwordFilled = false;
                passwordWaitCount = 0;
              }
              await delay(3000);
              continue;
            } else {
              console.log(`[Warmup] ⚠️ Đã đợi lâu nhưng vẫn ở màn hình password -> Tiến hành điền lại password...`);
              passwordFilled = false;
              passwordWaitCount = 0;
            }
          }
          if (!passwordFilled) {
            console.log(`[Warmup] 🔑 Điền password...`);
            await fillPassword(tabId, USER_ID, account.password);
            passwordFilled = true;
            passwordWaitCount = 0;
            await delay(6000);
            continue;
          }
        }
        
        // 6. Handle Email Input
        if (state.hasEmailInput) {
          if (emailFilled) {
            emailWaitCount++;
            if (emailWaitCount < 3) {
              console.log(`[Warmup] 📧 Email đã được điền ở lượt trước, đang chờ chuyển trang (lần đợi ${emailWaitCount})...`);
              // Retrigger the continue click just in case the email is actually in the input box
              const clicked = await evalJson(tabId, USER_ID, `(() => {
                const selectors = [
                  'input[autocomplete="email"]',
                  'input[name="username"]',
                  'input[type="email"]',
                  'input[id="username"]',
                  'input[name="email"]',
                ];
                let input = null;
                for (const s of selectors) {
                  const el = document.querySelector(s);
                  if (el && el.offsetParent !== null) { input = el; break; }
                }
                
                // If there's an input box but it has no value (cleared), don't click Continue
                if (input && !input.value.trim()) {
                  return false;
                }
                
                const btn = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]'))
                  .find(el => {
                    const t = (el.innerText || el.textContent || el.value || '').trim().toLowerCase();
                    return t === 'continue' || t === 'next' || t === 'tiếp tục';
                  });
                if (btn) {
                  btn.click();
                  btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                  return true;
                }
                return false;
              })()`).catch(() => null);
              
              if (clicked === false) {
                console.log(`[Warmup] 📧 Ô nhập email bị trống (trang đã bị reset) -> Tiến hành điền lại email ngay...`);
                emailFilled = false;
                emailWaitCount = 0;
              }
              await delay(3000);
              continue;
            } else {
              console.log(`[Warmup] ⚠️ Đã đợi lâu nhưng vẫn ở màn hình email -> Tiến hành điền lại email...`);
              emailFilled = false;
              emailWaitCount = 0;
            }
          }
          if (!emailFilled) {
            console.log(`[Warmup] 📧 Điền email: ${account.email}`);
            await fillEmail(tabId, USER_ID, account.email);
            emailFilled = true;
            emailWaitCount = 0;
            await delay(5000);
            continue;
          }
        }
        
        // 7. Handle MFA Input
        if (state.hasMfaInput) {
          console.log(`[Warmup] 🛡️ Phát hiện màn hình 2FA!`);
          const totpSecret = account.two_fa_secret || account.twoFaSecret;
          if (!totpSecret) {
            throw new Error('Tài khoản yêu cầu 2FA nhưng không có Secret Key!');
          }
          const { otp } = await getFreshTOTP(totpSecret);
          console.log(`[Warmup] 🔢 Điền mã OTP: ${otp}`);
          await fillMfa(tabId, USER_ID, otp);
          mfaFilled = true;
          await delay(5000);
          continue;
        }

        // 7.5. Handle Email OTP Screen (Device Verification)
        if (state.hasEmailOtpInput) {
          console.log(`[Warmup] 📧 Phát hiện thử thách OTP gửi qua Email!`);
          let emailCreds = null;
          try {
            const res = await fetch(`${TOOLS_API_URL}/api/vault/email-pool/${encodeURIComponent(account.email)}`);
            if (res.ok) {
              const data = await res.json();
              emailCreds = data.item;
            }
          } catch (_) {}

          const refreshToken = emailCreds?.refreshToken || emailCreds?.refresh_token;
          const clientId = emailCreds?.clientId || emailCreds?.client_id;
          if (refreshToken && clientId) {
            console.log(`[Warmup] 🔄 Đang tự động lấy mã OTP từ Email...`);
            if (stepRecorder) await stepRecorder.before(4, 1, 'before_email_otp');
            const otpCode = await waitForOTPCode({
              email: account.email,
              refreshToken: refreshToken,
              clientId: clientId,
              senderDomain: 'openai.com',
              maxWaitSecs: 120
            });
            if (otpCode) {
              console.log(`[Warmup] 🔢 Nhập mã OTP từ email: ${otpCode}`);
              await fillMfa(tabId, USER_ID, otpCode);
              await delay(6000);
              if (stepRecorder) await stepRecorder.after(4, 1, 'email_otp_filled');
              continue;
            } else {
              throw new Error('EMAIL_OTP_REQUIRED: Không lấy được mã OTP từ email hoặc hết thời gian chờ!');
            }
          } else {
            throw new Error('EMAIL_OTP_REQUIRED: Yêu cầu mã OTP email nhưng thông tin email pool không đủ để lấy OTP (thiếu refresh_token/client_id)!');
          }
        }

        // 7.6. Handle Passkey Enrollment (faster login) screen
        if (state.hasPasskeyEnrollScreen) {
          console.log(`[Warmup] 🔑 Phát hiện màn hình đăng ký Passkey ("Log in faster next time"). Tiến hành bỏ qua...`);
          const dismissed = await tryDismissPasskeyEnrollment(tabId, USER_ID);
          if (dismissed) {
            console.log(`[Warmup] ✅ Đã bỏ qua màn hình Passkey thành công!`);
            await delay(3000);
            continue;
          }
        }
        
        // 8. If stuck on chatgpt.com landing/homepage but not logged in and not on auth domain
        if (!state.onAuthDomain && !state.hasEmailInput && !state.hasPasswordInput && !state.hasMfaInput && !state.hasEmailOtpInput) {
          // Guard: Nếu vừa điền email hoặc password và đang đợi transition thì không chuyển hướng lại
          if (emailFilled && emailWaitCount < 3) {
            console.log(`[Warmup] ⏳ Đang chờ chuyển trang sau khi điền email...`);
            await delay(3000);
            continue;
          }
          if (passwordFilled && passwordWaitCount < 3) {
            console.log(`[Warmup] ⏳ Đang chờ chuyển trang sau khi điền password...`);
            await delay(3000);
            continue;
          }

          console.log(`[Warmup] 🌐 Đang ở trang chủ nhưng chưa đăng nhập -> Chuyển hướng tới trang login...`);
          await dismissGooglePopupAndClickLogin(tabId, USER_ID);
          await delay(4000);
          continue;
        }
        
        // Fallback sleep
        await delay(3000);
      }
      
      if (!isLoggedIn) {
        throw new Error('Đăng nhập thất bại hoặc hết thời gian chờ!');
      }
    } else {
      console.log(`[Warmup] ✅ Session hợp lệ!`);
    }

    // 6b. Self-healing wrong/restricted workspace (e.g. Codex/SeeLLM plan instead of Personal account)
    if (isLoggedIn) {
      const isRestricted = await evalJson(tabId, USER_ID, `(() => {
        const body = (document.body?.innerText || '').toLowerCase();
        return body.includes("you don't have chatgpt access on this plan") || 
               body.includes("assigned codex access only") ||
               body.includes("back to codex");
      })()`);

      if (isRestricted) {
        console.log(`[Warmup] ⚠️ Phát hiện tài khoản đang ở Workspace bị giới hạn! Đang tự động chuyển sang Personal Workspace...`);
        
        if (WARMUP_SCREENSHOTS && stepRecorder) {
          await stepRecorder.checkpoint(2, 2, 'wrong_workspace_detected');
        }

        // STEP 1: Dismiss the blocking restricted modal dialog and its backdrop first!
        await evalJson(tabId, USER_ID, `(() => {
          // Press Escape key
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true }));
          
          // Click close "X" button if found
          const buttons = Array.from(document.querySelectorAll('button'));
          const closeBtn = buttons.find(el => {
            const label = (el.getAttribute('aria-label') || '').toLowerCase();
            const text = (el.textContent || '').trim().toLowerCase();
            return label.includes('close') || label.includes('đóng') || text === '✕' || text === '×';
          });
          if (closeBtn) {
            closeBtn.click();
            closeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          }
        })()`);
        console.log(`[Warmup] 🛡️ Đã bấm đóng/Escape để tắt hộp thoại chặn và giải phóng backdrop...`);
        await delay(2000);

        // STEP 2: Click profile button using Camofox browser-level click API (not JS dispatchEvent)
        // Radix UI menus don't respond to synthetic JS events; Camofox click simulates real user clicks.
        // There are 2 elements with data-testid="accounts-profile-button" (collapsed + expanded sidebar),
        // so we use snapshot to find the correct ref and click it to avoid strict mode violations.
        let switchResult = 'not_attempted';
        try {
          // Take snapshot to find profile button ref
          console.log(`[Warmup] 🖱️ Finding profile button via Camofox snapshot...`);
          const preSnapshot = await getSnapshot(tabId, USER_ID, { timeoutMs: 5000 });
          let profileClicked = false;
          
          if (preSnapshot?.snapshot) {
            const preLines = preSnapshot.snapshot.split('\n');
            for (const line of preLines) {
              const lower = line.toLowerCase();
              if (lower.includes('open profile menu') || lower.includes('profile menu')) {
                const refMatch = line.match(/\b(e\d+)\b/);
                if (refMatch) {
                  await clickRef(tabId, USER_ID, refMatch[1], { timeoutMs: 5000 });
                  console.log(`[Warmup] 🖱️ Clicked profile button ref=${refMatch[1]}`);
                  profileClicked = true;
                  break;
                }
              }
            }
          }
          
          if (!profileClicked) {
            // Fallback: try with specific aria-label selector 
            await camofoxPost(`/tabs/${tabId}/click`, { userId: USER_ID, selector: '[data-testid="accounts-profile-button"][aria-label*="open profile menu" i]' }, { timeoutMs: 5000 });
            console.log(`[Warmup] 🖱️ Clicked profile button via fallback selector`);
          }
          await delay(2500);
          
          // Take accessibility snapshot to find Personal workspace menu item
          const snapshot = await getSnapshot(tabId, USER_ID, { timeoutMs: 5000 });
          if (snapshot?.snapshot) {
            const snapshotText = snapshot.snapshot;
            const lines = snapshotText.split('\n');
            const personalKeywords = ['personal account', 'personal workspace', 'cá nhân', 'gabriel webb', 'personal'];
            
            // Step 2a: Look for personal workspace directly in first dropdown
            let personalRef = null;
            for (const line of lines) {
              const lower = line.toLowerCase();
              const refMatch = line.match(/\b(e\d+)\b/);
              if (!refMatch) continue;
              
              const hasPersonalKw = personalKeywords.some(k => {
                if (k === 'personal') {
                  return lower.includes('personal') && !lower.includes('personalization') && !lower.includes('personalize');
                }
                return lower.includes(k);
              });
              if (hasPersonalKw) {
                const isProfileBtn = lower.includes('open profile menu') || lower.includes('accounts-profile');
                if (!isProfileBtn) {
                  personalRef = refMatch[1];
                  console.log(`[Warmup] 🎯 Found personal workspace item ref=${personalRef} directly in first dropdown: ${line.trim().slice(0, 80)}`);
                  break;
                }
              }
            }

            // Step 2b: Expand active workspace submenu if not found in first level
            if (!personalRef) {
              console.log('[Warmup] 🖱️ "Personal" not directly in dropdown. Searching for active workspace submenu trigger...');
              let workspaceSwitcherRef = null;
              for (const line of lines) {
                const lower = line.toLowerCase();
                if (lower.includes('menuitem') && 
                    (lower.includes('seellm') || lower.includes('business') || (lower.includes('workspace') && !lower.includes('settings')))) {
                  const refMatch = line.match(/\b(e\d+)\b/);
                  if (refMatch) {
                    workspaceSwitcherRef = refMatch[1];
                    console.log(`[Warmup] 🖱️ Found active workspace trigger ref=${workspaceSwitcherRef} in line: ${line.trim().slice(0, 80)}`);
                    break;
                  }
                }
              }

              if (workspaceSwitcherRef) {
                try {
                  console.log(`[Warmup] 🖱️ Expanding workspace submenu by clicking ref=${workspaceSwitcherRef}...`);
                  await clickRef(tabId, USER_ID, workspaceSwitcherRef, { timeoutMs: 5000 });
                  await delay(2000);

                  // Take a new snapshot of the sub-menu
                  const subSnapshot = await getSnapshot(tabId, USER_ID, { timeoutMs: 5000 });
                  if (subSnapshot?.snapshot) {
                    const subLines = subSnapshot.snapshot.split('\n');
                    
                    // Pass 1: Match explicit personal keywords in the sub-menu
                    for (const line of subLines) {
                      const lower = line.toLowerCase();
                      if (lower.includes('menuitemradio')) {
                        const hasPersonalKw = personalKeywords.some(k => {
                          if (k === 'personal') {
                            return lower.includes('personal') && !lower.includes('personalization') && !lower.includes('personalize');
                          }
                          return lower.includes(k);
                        });
                        if (hasPersonalKw) {
                          const refMatch = line.match(/\b(e\d+)\b/);
                          if (refMatch) {
                            personalRef = refMatch[1];
                            console.log(`[Warmup] 🎯 Found personal workspace item ref=${personalRef} in submenu by keyword: ${line.trim().slice(0, 80)}`);
                            break;
                          }
                        }
                      }
                    }

                    // Pass 2: Fallback to the other non-checked, non-business workspace item
                    if (!personalRef) {
                      for (const line of subLines) {
                        const lower = line.toLowerCase();
                        if (lower.includes('menuitemradio') && !lower.includes('[checked]') && !lower.includes('seellm') && !lower.includes('business')) {
                          const refMatch = line.match(/\b(e\d+)\b/);
                          if (refMatch) {
                            personalRef = refMatch[1];
                            console.log(`[Warmup] 🎯 Found personal workspace item ref=${personalRef} in submenu by non-checked fallback: ${line.trim().slice(0, 80)}`);
                            break;
                          }
                        }
                      }
                    }

                    // Pass 3: DOM evaluation fallback click (since menuitemradio options lack refs in snapshot)
                    if (!personalRef) {
                      console.log('[Warmup] 🖱️ Submenu refs not found in snapshot. Attempting DOM evaluation click...');
                      const domClickResult = await evalJson(tabId, USER_ID, `(() => {
                        const radios = Array.from(document.querySelectorAll('[role="menuitemradio"]'));
                        const target = radios.find(el => {
                          const checked = el.getAttribute('aria-checked') === 'true';
                          const txt = (el.textContent || '').toLowerCase();
                          return !checked && !txt.includes('seellm') && !txt.includes('business') && !txt.includes('workspace');
                        });
                        if (target) {
                          target.click();
                          return { ok: true, text: target.textContent };
                        }
                        return { ok: false };
                      })()`, 3000);

                      if (domClickResult?.ok) {
                        console.log(`[Warmup] 🎯 Clicked personal workspace in DOM: ${domClickResult.text}`);
                        personalRef = 'dom_evaluated_click';
                      } else {
                        console.warn('[Warmup] ⚠️ DOM evaluation click did not find target.');
                      }
                    }
                  }
                } catch (e) {
                  console.warn('[Warmup] ⚠️ Submenu traversal failed:', e.message);
                }
              }
            }
            
            if (personalRef) {
              if (personalRef !== 'dom_evaluated_click') {
                await clickRef(tabId, USER_ID, personalRef, { timeoutMs: 5000 });
                console.log(`[Warmup] ✅ Clicked personal workspace via Camofox ref=${personalRef}`);
              } else {
                console.log('[Warmup] ✅ Workspace already clicked via DOM evaluation.');
              }
              switchResult = `clicked_personal_item_ref_${personalRef}`;
            } else {
              switchResult = 'personal_item_not_found_in_snapshot';
              // Close dropdown before fallback
              try {
                await camofoxPost(`/tabs/${tabId}/click`, { userId: USER_ID, selector: 'body' }, { timeoutMs: 3000 });
              } catch (_) {}
            }
          } else {
            switchResult = 'snapshot_empty';
          }
        } catch (e) {
          switchResult = `camofox_click_error: ${e.message}`;
        }

        console.log(`[Warmup] 🗂️ Kết quả chuyển Workspace: ${switchResult}`);
        await delay(5000);

        // Fallback Strategy B: If profile dropdown failed, navigate to /workspace directly and use the standard selection helper!
        if (!switchResult.startsWith('clicked_personal_item')) {
          console.log(`[Warmup] ⚠️ Chuyển bằng Dropdown thất bại. Sử dụng Fallback: Điều hướng trực tiếp sang /workspace...`);
          await navigate(tabId, USER_ID, 'https://chatgpt.com/workspace');
          await delay(6000);
          
          if (WARMUP_SCREENSHOTS && stepRecorder) {
            await stepRecorder.checkpoint(2, 3, 'forced_workspace_navigation');
          }

          const wsResult = await selectPersonalWorkspaceOnWorkspacePage(tabId, USER_ID, { timeoutMs: 20000 });
          console.log(`[Warmup] ✅ Kết quả chọn Workspace tại trang /workspace: ${JSON.stringify(wsResult)}`);
          await delay(5000);
        }

        if (WARMUP_SCREENSHOTS && stepRecorder) {
          await stepRecorder.checkpoint(2, 4, 'after_workspace_healed');
        }
      }
    }
    
    if (WARMUP_SCREENSHOTS && stepRecorder) {
      await stepRecorder.checkpoint(2, 1, 'chatgpt_logged_in_dashboard');
    }
    
    // 7. Perform conversational Q&A warmup
    console.log(`\n💬 [Warmup] Bắt đầu tương tác Q&A (${qCountArg} câu hỏi)...`);
    
    // Generate deterministic prompts per account run to avoid collisions
    const existingProviderData = account.provider_specific_data || {};
    const warmupCount = existingProviderData.warmupCount || 0;
    const seed = `seellm_warmup_${account.id}_${warmupCount}`;
    const selectedPrompts = generateWarmupPrompts(qCountArg, seed);
    
    for (let idx = 0; idx < selectedPrompts.length; idx++) {
      const promptText = selectedPrompts[idx];
      console.log(`\n[Warmup] ❓ Câu hỏi ${idx + 1}/${selectedPrompts.length}: "${promptText}"`);
      
      // Clear onboarding modals (up to 5 screens) if any overlays exist.
      // ChatGPT shows multi-step onboarding: "What brings you to ChatGPT?" → "You're all set" → etc.
      // Each step needs a delay after clicking for the next screen to render.
      for (let i = 0; i < 5; i++) {
        const dismissed = await dismissOnboardingModals(tabId, USER_ID);
        if (dismissed) {
          console.log(`[Warmup] 🛡️ Phát hiện và đóng hộp thoại giới thiệu / Onboarding Modal (Lượt ${i + 1})...`);
          await delay(3000); // increased: next modal needs time to render
        } else {
          break;
        }
      }
      
      // Wait for prompt-textarea to be visible with retry/polling loop
      let isInputVisible = false;
      let spinnerDetectedSec = 0;
      let hasReloaded = false;
      const waitStart = Date.now();
      const waitTimeout = 45000; // 45 seconds max wait
      while (Date.now() - waitStart < waitTimeout) {
        isInputVisible = await evalJson(tabId, USER_ID, `(() => {
          const ta = document.querySelector('#prompt-textarea');
          return ta && ta.offsetParent !== null;
        })()`).catch(() => false);
        
        if (isInputVisible) {
          break;
        }
        
        // Check if there is a loading spinner on the page
        const isSpinnerVisible = await evalJson(tabId, USER_ID, `(() => {
          const spinner = document.querySelector('svg.animate-spin, .loading, [class*="loading"], [class*="spinner"], .status-loading');
          if (spinner && spinner.offsetParent !== null) return true;
          const bodyText = (document.body?.innerText || '').trim().toLowerCase();
          return bodyText === 'loading...' || bodyText === 'loading';
        })()`).catch(() => false);
        
        if (isSpinnerVisible) {
          spinnerDetectedSec += 1.5;
          if (spinnerDetectedSec >= 15 && !hasReloaded) {
            console.log(`[Warmup] ⚠️ Phát hiện trang bị kẹt ở trạng thái loading spinner quá 15 giây. Tiến hành tự động reload trang...`);
            hasReloaded = true;
            spinnerDetectedSec = 0;
            try {
              await navigate(tabId, USER_ID, 'https://chatgpt.com/');
            } catch (navErr) {
              console.log(`[Warmup] ⚠️ Reload trang thất bại: ${navErr.message}`);
            }
          }
        } else {
          spinnerDetectedSec = 0;
        }
        
        // Also check/dismiss onboarding modals while waiting
        const dismissed = await dismissOnboardingModals(tabId, USER_ID);
        if (dismissed) {
          console.log(`[Warmup] 🛡️ Phát hiện và đóng hộp thoại giới thiệu trong lúc chờ hộp thoại chat...`);
        }
        
        await delay(1500);
      }
      
      if (!isInputVisible) {
        throw new Error('Không tìm thấy hộp thoại chat của ChatGPT! (Chờ 45 giây không xuất hiện)');
      }
      
      // Type message using keyboard mode to ensure ProseMirror state updates correctly
      if (WARMUP_SCREENSHOTS && stepRecorder) {
        await stepRecorder.before(3 + idx, 1, `q${idx + 1}_sending`);
      }
      await camofoxPost(`/tabs/${tabId}/type`, { userId: USER_ID, selector: '#prompt-textarea', text: promptText, mode: 'keyboard', delay: 10 });
      await delay(1000);
      
      // Send message (try clicking Send button first, fallback to pressing Enter key)
      const sent = await evalJson(tabId, USER_ID, `(() => {
        const sendBtn = document.querySelector('button[data-testid="send-button"], button[aria-label="Send prompt"], button[class*="composer-submit"]');
        if (sendBtn && sendBtn.offsetParent !== null && !sendBtn.disabled && !sendBtn.hasAttribute('disabled')) {
          sendBtn.click();
          sendBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          return true;
        }
        return false;
      })()`).catch(() => false);
      
      if (!sent) {
        console.log(`[Warmup] ⚠️ Không tìm thấy nút gửi khả dụng hoặc nút bị vô hiệu hóa, tiến hành nhấn phím Enter...`);
        await pressKey(tabId, USER_ID, 'Enter');
      }
      await delay(2000);
      
      // Wait for complete response
      await waitForGenerationComplete(tabId, USER_ID);
      
      if (WARMUP_SCREENSHOTS && stepRecorder) {
        await stepRecorder.after(3 + idx, 2, `q${idx + 1}_response_complete`);
      }
      
      questionsAsked++;
      // Sleep between questions to simulate human reading/thinking
      if (idx < selectedPrompts.length - 1) {
        const sleepMs = randomInt(4000, 8000);
        console.log(`[Warmup] 💤 Nghỉ ${Math.round(sleepMs / 1000)} giây trước câu hỏi tiếp theo...`);
        await delay(sleepMs);
      }
    }
    
    console.log(`\n🎉 [Warmup] Tương tác thành công tất cả ${questionsAsked} câu hỏi!`);
    
    // Get fresh cookies after success to keep them updated
    console.log(`[Warmup] 🍪 Thu thập cookies mới từ session...`);
    const newCookiesRes = await camofoxGet(`/tabs/${tabId}/cookies?userId=${USER_ID}`).catch(() => null);
    const newCookies = Array.isArray(newCookiesRes?.cookies) ? newCookiesRes.cookies : (Array.isArray(newCookiesRes) ? newCookiesRes : null);
    
    // Fetch session data to get accessToken, plan, etc.
    let accessToken = undefined;
    let plan = undefined;
    let workspaceId = undefined;
    let deviceId = undefined;
    let sessionData = undefined;
    try {
      console.log(`[Warmup] 🔄 Lấy thông tin session từ /api/auth/session...`);
      const sessionRes = await evalJson(tabId, USER_ID, `
        fetch('/api/auth/session')
          .then(r => r.ok ? r.json() : null)
          .catch(() => null)
      `);
      if (sessionRes && typeof sessionRes === 'object') {
        sessionData = sessionRes;
        accessToken = sessionRes.accessToken;
        plan = sessionRes.account?.planType;
        workspaceId = sessionRes.account?.id;
        deviceId = newCookies ? (newCookies.find(c => c.name === 'oai-did')?.value || '') : '';
        console.log(`[Warmup] 👤 Lấy session thành công (UserId: ${sessionData?.user?.id || 'n/a'}, Plan: ${plan || 'n/a'})`);
      } else {
        console.log(`[Warmup] ⚠️ Không lấy được session data (định dạng rỗng hoặc null)`);
      }
    } catch (sessionErr) {
      console.warn(`[Warmup] ⚠️ Lỗi khi gọi /api/auth/session: ${sessionErr.message}`);
    }

    // Save success result back to server
    await fetch(`${TOOLS_API_URL}/api/vault/accounts/${accountId}/warmup-result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'success',
        questionsAsked,
        cookies: newCookies || undefined,
        accessToken,
        plan,
        workspaceId,
        deviceId,
        sessionData
      })
    });
    
    console.log(`[Warmup] ✅ Hoàn tất cập nhật trạng thái Warmup thành công!`);
    
    runSuccess = true;
    break; // Exit retry loop on success
    } catch (err) {
      const msg = String(err.message || err || '').toLowerCase();
      
      // Classify error type for logging and wait-time decision
      const isNavigateTimeout = (
        msg.includes('page.goto') ||
        msg.includes('navigate timed out') ||
        (msg.includes('timeout') && msg.includes('navigate'))
      );
      const isRetriable = (
        isNavigateTimeout ||
        msg.includes('browser_restarted') ||
        msg.includes('session_expired') ||
        msg.includes('tab no longer exists') ||
        msg.includes('browser was restarted') ||
        msg.includes('browser session expired') ||
        msg.includes('target page, context or browser has been closed') ||
        msg.includes('context closed') ||
        msg.includes('browser closed') ||
        msg.includes('net_timeout') ||
        msg.includes('aborted due to timeout') ||
        msg.includes('không tìm thấy hộp thoại chat')
      );
      
      if (isRetriable && attempt < maxAttempts) {
        // Navigate timeouts need longer recovery: camofox destroys the session and
        // needs time to reinitialise a fresh BrowserContext with a clean proxy slot.
        const retryWaitMs = isNavigateTimeout ? 12000 : 5000;
        console.warn(`\n⚠️ [Warmup] Phát hiện lỗi ${ isNavigateTimeout ? 'navigate timeout (proxy chậm)' : 'trình duyệt/session' } ở lượt ${attempt}/${maxAttempts}: ${err.message}.`);
        console.warn(`⏳ [Warmup] Chờ ${retryWaitMs / 1000}s rồi khởi động lại tab mới...`);
        if (tabId) {
          console.log(`[Warmup] 🧹 Đóng tab cũ: ${tabId}`);
          await camofoxDelete(`/tabs/${tabId}?userId=${USER_ID}`).catch(() => {});
          tabId = null;
        }
        await delay(retryWaitMs);
        continue;
      }
      throw err;
    } finally {
      if (tabId && !runSuccess && attempt < maxAttempts) {
        console.log(`[Warmup] 🧹 Đóng tab của lượt thử thất bại...`);
        await camofoxDelete(`/tabs/${tabId}?userId=${USER_ID}`).catch(() => {});
        tabId = null;
      }
    }
  }
  } catch (err) {
    console.error(`\n❌ [Warmup] Lỗi trong quá trình chạy: ${err.message}`);
    
    if (WARMUP_SCREENSHOTS && stepRecorder) {
      await stepRecorder.error(99, 1, 'warmup_error').catch(() => {});
    }
    
    // Save failure status back to server
    try {
      await fetch(`${TOOLS_API_URL}/api/vault/accounts/${accountId}/warmup-result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'failed',
          error: err.message,
          questionsAsked
        })
      });
      console.log(`[Warmup] 🛑 Cập nhật trạng thái Warmup THẤT BẠI về database.`);
    } catch (saveErr) {
      console.error(`[Warmup] Lỗi khi cố gắng lưu trạng thái thất bại: ${saveErr.message}`);
    }
    
  } finally {
    // 8. Clean up Tab to prevent resource leak
    if (tabId) {
      console.log(`[Warmup] 🧹 Đóng tab Camofox để giải phóng tài nguyên...`);
      await camofoxDelete(`/tabs/${tabId}?userId=${USER_ID}`);
    }
    console.log(`🔥 [Warmup] KẾT THÚC CHƯƠNG TRÌNH WARMUP.\n`);
  }
}

runWarmup();
