/**
 * SeeLLM Tools - ChatGPT Account Warmup Module
 * Automates conversational Q&A interactions using Camofox to maintain account health.
 */

import { CAMOUFOX_API, TOOLS_API_URL, WARMUP_SCREENSHOTS } from './config.js';
import { camofoxPost, camofoxGet, camofoxDelete, navigate, pressKey, evalJson } from './lib/camofox.js';
import { normalizeProxyUrl, assertProxyApplied, probeProxyExitIp, getLocalPublicIp, isLocalRelayProxy } from './lib/proxy-diag.js';
import { getFreshTOTP } from './lib/totp.js';
import { generateWarmupPrompts } from './lib/warmup-prompts.js';
import { createStepRecorder } from './lib/screenshot.js';
import {
  getState,
  fillEmail,
  fillPassword,
  fillMfa,
  tryAcceptCookies,
  dismissGooglePopupAndClickLogin,
  selectPersonalWorkspaceOnWorkspacePage
} from './lib/openai-login-flow.js';
import fs from 'node:fs/promises';
import path from 'node:path';



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
  
  while (Date.now() - startTime < timeoutMs) {
    const status = await evalJson(tabId, userId, `(() => {
      // 1. Check for visible "Stop generating" button
      const stopBtn = document.querySelector('button[aria-label*="Stop"], button[data-testid*="stop"], button[data-testid="stop-generating-button"], button[class*="composer-submit"] svg[use*="stop"]');
      if (stopBtn && stopBtn.offsetParent !== null) {
        return 'generating (stop button visible)';
      }
      
      // 2. Check for active streaming classes or selectors
      const streamingEl = document.querySelector('.result-streaming, .streaming, [class*="streaming"]');
      if (streamingEl) {
        return 'generating (streaming element active)';
      }
      
      // 3. Check submit/voice button state
      const submitBtn = document.querySelector('button[class*="composer-submit"], button[aria-label="Start Voice"], button[aria-label="Send prompt"], button[data-testid="send-button"]');
      if (submitBtn && submitBtn.offsetParent !== null) {
        // If it's a stop button or disabled
        const ariaLabel = (submitBtn.getAttribute('aria-label') || '').toLowerCase();
        const className = (submitBtn.className || '').toLowerCase();
        const hasStopSvg = !!submitBtn.querySelector('svg[use*="stop"]') || !!submitBtn.querySelector('svg rect'); // stop icon has rect
        
        if (ariaLabel.includes('stop') || className.includes('stop') || hasStopSvg) {
          return 'generating (composer-submit stop active)';
        }
        
        // If it's idle/voice or send is enabled (meaning ready for next prompt)
        const isDisabled = submitBtn.hasAttribute('disabled') || submitBtn.disabled;
        if (isDisabled && !ariaLabel.includes('voice')) {
          return 'generating (submit button disabled)';
        }
        return 'complete';
      }
      
      return 'checking';
    })()`);
    
    if (status === 'complete') {
      console.log(`[Warmup] ✅ ChatGPT đã trả lời xong!`);
      return true;
    }
    
    // Log occasionally
    console.log(`[Warmup] ⏱️ Generation status: ${status} (${Math.round((Date.now() - startTime) / 1000)}s)`);
    await delay(2000);
  }
  
  console.log(`[Warmup] ⚠️ Hết thời gian chờ phản hồi (${timeoutMs}ms). Tiến hành tiếp tục.`);
  return false;
}

/**
 * Automatically detects and clicks "Okay, let's go", "Next", "Done", etc. onboarding buttons.
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
        text === "tiếp tục" ||
        text === "bắt đầu" ||
        text.includes("let's get started") ||
        text.includes("okay, let’s get started")
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
    // 2. Pre-flight Proxy Assert (traffic isolation security)
    if (effectiveProxy) {
      console.log(`[Warmup] 🔒 [PreFlight] Kiểm tra proxy: ${effectiveProxy}`);
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
      url: 'https://example.com/',
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
      const runDir = path.join(process.cwd(), 'data', 'screenshots', `warmup_${account.id}`);
      await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
      await fs.mkdir(runDir, { recursive: true });
      stepRecorder = createStepRecorder(runDir, { tabId, userId: USER_ID });
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
        
        if (state.looksLoggedIn) {
          console.log(`[Warmup] 👤 Đăng nhập thành công (trạng thái looksLoggedIn = true)!`);
          isLoggedIn = true;
          break;
        }
        
        if (state.hasDeactivated) {
          throw new Error('ACCOUNT_DEACTIVATED: Tài khoản đã bị khóa');
        }
        
        // 1.5. Handle OpenAI/ChatGPT Error screen with self-healing click
        if (state.hasError) {
          console.log(`[Warmup] ⚠️ Phát hiện lỗi trên trang OpenAI/ChatGPT!`);
          const errorHealed = await evalJson(tabId, USER_ID, `(() => {
            const btn = Array.from(document.querySelectorAll('button, a, [role=\"button\"]'))
              .find(el => {
                const t = (el.innerText || el.textContent || '').trim().toLowerCase();
                return t.includes('go back') || t.includes('try again') || t.includes('thử lại') || t.includes('quay lại');
              });
            if (btn) {
              btn.click();
              btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
              return true;
            }
            return false;
          })()`).catch(() => false);
          
          if (errorHealed) {
            console.log(`[Warmup] 🔄 Đã bấm nút "Go back / Try again" để tự khắc phục lỗi...`);
            await delay(5000);
            continue;
          } else {
            throw new Error(`OPENAI_ERROR_PAGE: Phát hiện màn hình báo lỗi của OpenAI (${state.href})`);
          }
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
        
        // 5. Handle Password Input
        if (state.hasPasswordInput) {
          if (passwordFilled) {
            passwordWaitCount++;
            if (passwordWaitCount < 3) {
              console.log(`[Warmup] 🔑 Password đã được điền ở lượt trước, đang chờ đăng nhập (lần đợi ${passwordWaitCount})...`);
              // Retrigger password submit click just in case
              await evalJson(tabId, USER_ID, `(() => {
                const btn = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]'))
                  .find(el => {
                    const t = (el.innerText || el.textContent || el.value || '').trim().toLowerCase();
                    return t === 'continue' || t === 'sign in' || t === 'log in' || t === 'next' || t === 'tiếp tục';
                  });
                if (btn) {
                  btn.click();
                  btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                }
              })()`).catch(() => {});
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
              // Retrigger the continue click just in case
              await evalJson(tabId, USER_ID, `(() => {
                const btn = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]'))
                  .find(el => {
                    const t = (el.innerText || el.textContent || el.value || '').trim().toLowerCase();
                    return t === 'continue' || t === 'next' || t === 'tiếp tục';
                  });
                if (btn) {
                  btn.click();
                  btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                }
              })()`).catch(() => {});
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
        
        // 8. If stuck on chatgpt.com landing/homepage but not logged in and not on auth domain
        if (!state.onAuthDomain) {
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
    
    if (WARMUP_SCREENSHOTS && stepRecorder) {
      await stepRecorder.checkpoint(2, 1, 'chatgpt_logged_in_dashboard');
    }
    
    // 7. Perform conversational Q&A warmup
    console.log(`\n💬 [Warmup] Bắt đầu tương tác Q&A (${qCountArg} câu hỏi)...`);
    
    // Generate random conversational prompts dynamically using dynamic combinations
    const selectedPrompts = generateWarmupPrompts(qCountArg);
    
    for (let idx = 0; idx < selectedPrompts.length; idx++) {
      const promptText = selectedPrompts[idx];
      console.log(`\n[Warmup] ❓ Câu hỏi ${idx + 1}/${selectedPrompts.length}: "${promptText}"`);
      
      // Clear onboarding modals (up to 3 screens) if any overlays exist
      for (let i = 0; i < 3; i++) {
        const dismissed = await dismissOnboardingModals(tabId, USER_ID);
        if (dismissed) {
          console.log(`[Warmup] 🛡️ Phát hiện và đóng hộp thoại giới thiệu / Onboarding Modal (Lượt ${i + 1})...`);
          await delay(2000);
        } else {
          break;
        }
      }
      
      // Wait for prompt-textarea to be visible
      const isInputVisible = await evalJson(tabId, USER_ID, `(() => {
        const ta = document.querySelector('#prompt-textarea');
        return ta && ta.offsetParent !== null;
      })()`);
      
      if (!isInputVisible) {
        throw new Error('Không tìm thấy hộp thoại chat của ChatGPT!');
      }
      
      // Type message
      if (WARMUP_SCREENSHOTS && stepRecorder) {
        await stepRecorder.before(3 + idx, 1, `q${idx + 1}_sending`);
      }
      await camofoxPost(`/tabs/${tabId}/type`, { userId: USER_ID, selector: '#prompt-textarea', text: promptText });
      await delay(1000);
      
      // Send message
      await pressKey(tabId, USER_ID, 'Enter');
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
    
    // Save success result back to server
    await fetch(`${TOOLS_API_URL}/api/vault/accounts/${accountId}/warmup-result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'success',
        questionsAsked,
        cookies: newCookies || undefined
      })
    });
    
    console.log(`[Warmup] ✅ Hoàn tất cập nhật trạng thái Warmup thành công!`);
    
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
