/**
 * SeeLLM Tools - ChatGPT Account 2FA Regeneration Module
 * Disables existing 2FA and configures a fresh 2FA using Camoufox.
 */

import { CAMOUFOX_API, TOOLS_API_URL, WARMUP_SCREENSHOTS } from './config.js';
import { camofoxPost, camofoxGet, camofoxDelete, navigate, pressKey, evalJson } from './lib/camofox.js';
import { normalizeProxyUrl, assertProxyApplied } from './lib/proxy-diag.js';
import { getFreshTOTP } from './lib/totp.js';
import { createStepRecorder } from './lib/screenshot.js';
import { waitForOTPCode } from './lib/ms-graph-email.js';
import { setupMFA } from './lib/mfa-setup.js';
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
import { createHmac } from 'node:crypto';

// Helper to generate TOTP code locally inside the script
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
        text === "continue" ||
        text.includes("continue") ||
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

async function run2faRegen() {
  const args = parseArgs();
  const accountId = args.accountId;

  if (!accountId) {
    console.error('❌ Thiếu đối số --accountId');
    process.exit(1);
  }

  console.log(`\n🛡️ [2FA Regen] BẮT ĐẦU TÁO TẠO 2FA CHO TÀI KHOẢN: ${accountId}\n`);

  // 1. Fetch account info from local API
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

  // 2. Fetch email credentials from local email pool for MS Graph OTP bypass
  let emailCreds = null;
  try {
    const res = await fetch(`${TOOLS_API_URL}/api/vault/email-pool/${encodeURIComponent(account.email)}`);
    if (res.ok) {
      const data = await res.json();
      emailCreds = data.item;
      console.log(`[2FA Regen] ✅ Đã tải thông tin email pool cho ${account.email}`);
    }
  } catch (err) {
    console.warn(`[2FA Regen] ⚠️ Không tìm thấy email credentials trong pool: ${err.message}`);
  }

  const USER_ID = `seellm_2fa_${account.id}`;
  const SESSION_KEY = `2fa_${account.id}`;
  const effectiveProxy = normalizeProxyUrl(account.proxy_url || account.proxyUrl || account.proxy || null);

  let tabId = null;
  let preFlightResult = null;
  let stepRecorder = null;

  try {
    // 3. Pre-flight Proxy Assert (traffic isolation security)
    if (effectiveProxy) {
      console.log(`[2FA Regen] 🔒 [PreFlight] Kiểm tra proxy: ${effectiveProxy}`);
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
            console.log(`[2FA Regen] ⚠️ [PreFlight] Thử lại ${preflightAttempt + 1}/2 sau lỗi: ${msg}`);
            await delay(2000 + preflightAttempt * 1500);
          }
        }
        if (!preFlightResult && lastErr) throw lastErr;
        console.log(`[2FA Regen] ✅ [PreFlight] Exit IP: ${preFlightResult.exitIp}`);
      } catch (err) {
        console.error(`[2FA Regen] 🛑 [PreFlight] Proxy verification FAILED: ${err.message}`);
        throw err;
      }
    }

    // 4. Open Camofox Tab
    console.log(`[2FA Regen] 🦊 Khởi động Camofox tab...`);
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
      blockResources: true,
    }, { timeoutMs: 35000 });

    tabId = opened.tabId;
    await delay(1000);

    // Set fixed viewport to avoid narrow/mobile layout on headful macOS
    console.log(`[2FA Regen] 🌐 Thiết lập viewport size 1440x900...`);
    await camofoxPost(`/tabs/${tabId}/viewport`, {
      userId: USER_ID,
      width: 1440,
      height: 900
    }).catch(err => {
      console.warn(`⚠️ [2FA Regen] Không thể thiết lập viewport: ${err.message}`);
    });

    await delay(2000);

    // Set up step recorder
    if (WARMUP_SCREENSHOTS) {
      const runDir = path.join(process.cwd(), 'data', 'screenshots', `2fa_regen_${account.id}`);
      await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
      await fs.mkdir(runDir, { recursive: true });
      stepRecorder = createStepRecorder(runDir, { tabId, userId: USER_ID });
      console.log(`[2FA Regen] 📸 Chụp ảnh logs đã bật! Thư mục ảnh: ${runDir}`);
    }

    // 5. Import cookies from database if present
    if (account.cookies && Array.isArray(account.cookies) && account.cookies.length > 0) {
      console.log(`[2FA Regen] 🍪 Nạp ${account.cookies.length} cookies từ database...`);
      try {
        await fetch(`${CAMOUFOX_API}/sessions/${USER_ID}/cookies`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cookies: account.cookies })
        });
      } catch (err) {
        console.warn(`⚠️ [2FA Regen] Lỗi khi import cookies: ${err.message}`);
      }
    }

    // 6. Navigate to ChatGPT
    console.log(`[2FA Regen] 🌐 Mở trang ChatGPT...`);
    await navigate(tabId, USER_ID, 'https://chatgpt.com/', { timeoutMs: 30000, waitUntil: 'commit' });
    await delay(5000);

    if (WARMUP_SCREENSHOTS && stepRecorder) {
      await stepRecorder.checkpoint(1, 1, 'chatgpt_initial_page');
    }

    // 7. Check login state
    const checkLoginState = async () => {
      const state = await getState(tabId, USER_ID);
      return state.looksLoggedIn;
    };

    let isLoggedIn = await checkLoginState();

    if (!isLoggedIn) {
      console.log(`[2FA Regen] 👤 Chưa đăng nhập hoặc cookie hết hạn! Tiến hành đăng nhập...`);

      const maxLoginAttempts = 40;
      let emailFilled = false;
      let emailWaitCount = 0;
      let emailFillAttempts = 0;
      let passwordFilled = false;
      let passwordWaitCount = 0;
      let mfaFilled = false;

      for (let attempt = 1; attempt <= maxLoginAttempts; attempt++) {
        console.log(`[2FA Regen] 🔑 Loop đăng nhập - Lượt ${attempt}/${maxLoginAttempts}...`);

        if (WARMUP_SCREENSHOTS && stepRecorder) {
          await stepRecorder.checkpoint(1, 10 + attempt, `login_loop_step_${attempt}`);
        }

        const state = await getState(tabId, USER_ID);

        if (state.looksLoggedIn) {
          console.log(`[2FA Regen] 👤 Đăng nhập thành công!`);
          isLoggedIn = true;
          break;
        }

        if (state.hasDeactivated) {
          throw new Error('ACCOUNT_DEACTIVATED: Tài khoản đã bị khóa');
        }

        if (state.hasError && !state.isOnboardingScreen) {
          console.log(`[2FA Regen] ⚠️ Phát hiện lỗi trên trang OpenAI/ChatGPT! URL: ${state.href}`);
          // Reset tất cả flags để login loop bắt đầu lại sạch
          emailFilled = false;
          emailWaitCount = 0;
          passwordFilled = false;
          passwordWaitCount = 0;
          mfaFilled = false;

          // Navigate thẳng về chatgpt.com thay vì click "Go back"
          console.log(`[2FA Regen] 🔄 Điều hướng lại về chatgpt.com để khắc phục lỗi...`);
          try {
            await navigate(tabId, USER_ID, 'https://chatgpt.com/');
          } catch (_) {
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

        // Welcome back dialog
        const chooseResult = await evalJson(tabId, USER_ID, `(() => {
          const body = (document.body?.innerText || '').toLowerCase();
          const hasWelcomeBack = body.includes('welcome back') || body.includes('chào mừng quay trở lại') || body.includes('choose an account') || body.includes('chọn một tài khoản');
          if (!hasWelcomeBack) return null;

          const clickables = document.querySelectorAll('button, [role="button"], [role="option"], a');
          for (const el of clickables) {
            if (el.offsetParent === null) continue;
            const text = (el.textContent || '').trim().toLowerCase();
            const emailPart = ${JSON.stringify(account.email.toLowerCase().split('@')[0])};
            if (text.includes(emailPart) || text.includes(${JSON.stringify(account.email.toLowerCase())})) {
              el.click();
              el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
              el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
              el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
              return 'clicked_btn: ' + text.slice(0, 60);
            }
          }
          return null;
        })()`);
        if (chooseResult) {
          console.log(`[2FA Regen] 👤 Đã chọn tài khoản Welcome Back: ${chooseResult}`);
          await delay(4000);
          continue;
        }

        // Cookie banner
        if (state.hasCookieBanner) {
          console.log(`[2FA Regen] 🍪 Cookie banner -> Chấp nhận cookies...`);
          await tryAcceptCookies(tabId, USER_ID);
          await delay(2000);
          continue;
        }

        // Onboarding screen: "How old are you?"
        if (state.isOnboardingScreen) {
          console.log(`[2FA Regen] 🎂 Phát hiện màn hình Onboarding ("How old are you?") -> Tiến hành điền thông tin...`);
          
          // Generate a name from the email, completely stripping numbers to avoid validation error
          const namePart = account.email.split('@')[0].replace(/[0-9]/g, '').trim();
          let fullName = namePart.split(/[^a-zA-Z]/).filter(Boolean).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
          if (!fullName) {
            fullName = 'Albert Knutson';
          } else if (!fullName.includes(' ')) {
            // Append a realistic last name to satisfy "First and Last Name" validation
            fullName = fullName + ' Smith';
          }
          const ageNum = Math.floor(Math.random() * 11) + 25; // Random age between 25 and 35
          const age = String(ageNum);
          const currentYear = new Date().getFullYear();
          const year = currentYear - ageNum;
          const monthNum = Math.floor(Math.random() * 12) + 1;
          const dayNum = Math.floor(Math.random() * 28) + 1;
          const birthdate = `${year}-${String(monthNum).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`;
          
          console.log(`[2FA Regen] ✍️ Điền Full Name: "${fullName}" | Age: ${age} | Bday: ${birthdate}`);
          
          const onboardResult = await evalJson(tabId, USER_ID, `(() => {
            const isVisible = (el) => {
              if (!el) return false;
              const s = window.getComputedStyle(el);
              const r = el.getBoundingClientRect();
              return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0' && r.width > 0 && r.height > 0;
            };

            const inputs = Array.from(document.querySelectorAll('input, select')).filter(el => {
              if (el.tagName === 'INPUT') {
                if (el.type === 'hidden' || el.type === 'checkbox' || el.type === 'radio' || el.type === 'submit') {
                  return false;
                }
              }
              return true;
            });

            const isNameInput = (el) => {
              const placeholder = (el.placeholder || '').toLowerCase();
              const id = (el.id || '').toLowerCase();
              const name = (el.name || '').toLowerCase();
              return placeholder.includes('name') || id.includes('name') || name.includes('name');
            };

            let nameInputs = inputs.filter(isNameInput);
            let bdayInputs = inputs.filter(el => !isNameInput(el));

            if (nameInputs.length === 0 && inputs.length > 0) {
              nameInputs = [inputs[0]];
              bdayInputs = inputs.slice(1);
            }

            const getAllInputsDump = () => {
              return Array.from(document.querySelectorAll('input, select')).map(el => {
                const s = window.getComputedStyle(el);
                const r = el.getBoundingClientRect();
                return {
                  tagName: el.tagName,
                  type: el.type,
                  name: el.name,
                  id: el.id,
                  placeholder: el.placeholder,
                  visible: isVisible(el),
                  styleDisplay: el.style.display,
                  computedDisplay: s.display,
                  computedVisibility: s.visibility,
                  computedOpacity: s.opacity,
                  rectWidth: r.width,
                  rectHeight: r.height
                };
              });
            };

            if (nameInputs.length === 0) {
              return { ok: false, reason: 'name-input-not-found', allInputs: getAllInputsDump() };
            }

            const setValue = (el, val) => {
              if (!el) return;
              el.focus();
              if (el.tagName === 'SELECT') {
                el.value = val;
                el.dispatchEvent(new Event('change', { bubbles: true }));
                return;
              }
              const nativeInput = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
              if (nativeInput) nativeInput.set.call(el, val);
              else el.value = val;
              
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }));
              el.dispatchEvent(new KeyboardEvent('keypress', { bubbles: true }));
              el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
              el.blur();
            };

            // Điền tên
            nameInputs.forEach(nameInput => {
              if (nameInputs.length >= 2) {
                const placeholder = (nameInput.placeholder || '').toLowerCase();
                const name = (nameInput.name || '').toLowerCase();
                const isFirst = placeholder.includes('first') || name.includes('first');
                const parts = ${JSON.stringify(fullName)}.split(' ');
                if (isFirst) {
                  setValue(nameInput, parts[0] || '');
                } else {
                  setValue(nameInput, parts.slice(1).join(' ') || parts[0]);
                }
              } else {
                setValue(nameInput, ${JSON.stringify(fullName)});
              }
            });

            // Điền ngày sinh / tuổi
            if (bdayInputs.length >= 3) {
              // Giao diện segmented MM / DD / YYYY
              const monthEl = bdayInputs.find(el => (el.placeholder || '').toLowerCase().includes('m') || (el.name || '').toLowerCase().includes('month') || (el.ariaLabel || '').toLowerCase().includes('month')) || bdayInputs[0];
              const dayEl = bdayInputs.find(el => (el.placeholder || '').toLowerCase().includes('d') || (el.name || '').toLowerCase().includes('day') || (el.ariaLabel || '').toLowerCase().includes('day')) || bdayInputs[1];
              const yearEl = bdayInputs.find(el => (el.placeholder || '').toLowerCase().includes('y') || (el.name || '').toLowerCase().includes('year') || (el.ariaLabel || '').toLowerCase().includes('year')) || bdayInputs[2];
              
              setValue(monthEl, ${JSON.stringify(String(monthNum).padStart(2, '0'))});
              setValue(dayEl, ${JSON.stringify(String(dayNum).padStart(2, '0'))});
              setValue(yearEl, ${JSON.stringify(String(year))});
            } else if (bdayInputs.length > 0) {
              // Chỉ có 1 ô nhập bday (dạng Date hoặc Age)
              const bdayEl = bdayInputs[0];
              if (bdayEl.type === 'number' || (bdayEl.placeholder || '').toLowerCase().includes('age') || (bdayEl.name || '').toLowerCase().includes('age')) {
                setValue(bdayEl, ${JSON.stringify(age)});
              } else if (bdayEl.type === 'date') {
                setValue(bdayEl, ${JSON.stringify(birthdate)});
              } else {
                // Type text hoặc loại khác
                const placeholder = bdayEl.placeholder || '';
                let dobStr = placeholder.startsWith('MM')
                  ? ${JSON.stringify(String(monthNum).padStart(2, '0') + '/' + String(dayNum).padStart(2, '0') + '/' + String(year))}
                  : ${JSON.stringify(String(dayNum).padStart(2, '0') + '/' + String(monthNum).padStart(2, '0') + '/' + String(year))};
                setValue(bdayEl, dobStr);
              }
            } else {
              // Fallback trường hợp đặc biệt: không tìm thấy input nào khác name, thử tìm input ẩn thực tế
              const hiddenBday = document.querySelector('input[type="hidden"][name*="birth" i], input[type="hidden"][name*="dob" i], input[type="hidden"][name="birthday"]');
              if (hiddenBday) {
                setValue(hiddenBday, ${JSON.stringify(birthdate)});
              } else {
                return { ok: false, reason: 'bday-input-not-found-yet', hasInputs: nameInputs.length > 0 + '/false', allInputs: getAllInputsDump() };
              }
            }

            const btn = Array.from(document.querySelectorAll('button')).find(el => {
              const text = (el.innerText || el.textContent || '').toLowerCase();
              return text.includes('finish') || text.includes('create') || text.includes('hoàn tất') || text.includes('finish creating');
            });

            if (btn) {
              btn.click();
              btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
              return { ok: true, clicked: true };
            }

            return { ok: true, clicked: false, reason: 'button-not-found' };
          })()`);
          
          console.log(`[2FA Regen] 🎂 Kết quả onboarding:`, onboardResult);
          await delay(6000);
          continue;
        }

        // Workspace selection
        if (state.isWorkspaceScreen) {
          console.log(`[2FA Regen] 🗂️ Màn hình Workspace -> Chọn Personal account...`);
          const wsResult = await selectPersonalWorkspaceOnWorkspacePage(tabId, USER_ID, { timeoutMs: 15000 });
          if (wsResult?.ok) {
            console.log(`[2FA Regen] ✅ Đã chọn Personal workspace: ${wsResult.text || ''}`);
            await delay(4000);
          }
          continue;
        }

        // Email OTP Input Screen: "Check your inbox" + ô nhập code + nút "Continue with password"
        // Màn hình này cần lấy OTP từ email và điền vào ô code, KHÔNG click "Continue with password"
        if (state.hasEmailOtpInput) {
          console.log(`[2FA Regen] 📧 Phát hiện màn hình "Check your inbox" có ô nhập code OTP!`);
          const refreshToken = emailCreds?.refreshToken || emailCreds?.refresh_token;
          const clientId = emailCreds?.clientId || emailCreds?.client_id;
          if (refreshToken && clientId) {
            console.log(`[2FA Regen] 🔄 Đang tự động lấy mã OTP từ Email (email-verification screen)...`);
            const otpCode = await waitForOTPCode({
              email: account.email,
              refreshToken: refreshToken,
              clientId: clientId,
              senderDomain: 'openai.com',
              maxWaitSecs: 120
            });
            if (otpCode) {
              console.log(`[2FA Regen] 🔢 Nhập mã OTP từ email: ${otpCode}`);
              await fillMfa(tabId, USER_ID, otpCode);
              await delay(6000);
              continue;
            } else {
              throw new Error('Không lấy được mã OTP từ email hoặc hết thời gian chờ (email-verification screen)!');
            }
          } else {
            // Không có email pool -> fallback: click "Continue with password" để dùng mật khẩu
            console.log(`[2FA Regen] ⚠️ Không có email pool credentials -> Fallback: click "Continue with password"...`);
            await evalJson(tabId, USER_ID, `(() => {
              const btn = Array.from(document.querySelectorAll('button, [role="button"], a'))
                .find(el => {
                  if (el.offsetParent === null) return false;
                  const t = (el.innerText || el.textContent || '').trim().toLowerCase();
                  return t.includes('continue with password') || t.includes('enter your password') || t.includes('use password');
                });
              if (btn) { btn.click(); return true; }
              return false;
            })()`).catch(() => {});
            passwordFilled = false;
            await delay(4000);
            continue;
          }
        }

        // Email inbox screen (NO code input): bypass via "Continue with password"
        if (state.hasEmailInboxScreen) {
          console.log(`[2FA Regen] 📬 Màn hình hộp thư đến (không có ô code) -> Click "Continue with password"...`);
          await evalJson(tabId, USER_ID, `(() => {
            const btn = Array.from(document.querySelectorAll('button, [role="button"], a'))
              .find(el => {
                if (el.offsetParent === null) return false;
                const t = (el.innerText || el.textContent || '').trim().toLowerCase();
                return t.includes('continue with password') || t.includes('enter your password') || t.includes('use password');
              });
            if (btn) { btn.click(); return true; }
            return false;
          })()`).catch(() => {});
          passwordFilled = false;
          await delay(4000);
          continue;
        }

        // Password input
        if (state.hasPasswordInput) {
          if (passwordFilled) {
            passwordWaitCount++;
            if (passwordWaitCount < 3) {
              console.log(`[2FA Regen] 🔑 Password đã được điền, đang chờ (lần ${passwordWaitCount})...`);
              await evalJson(tabId, USER_ID, `(() => {
                const btn = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]'))
                  .find(el => {
                    const t = (el.innerText || el.textContent || el.value || '').trim().toLowerCase();
                    return t === 'continue' || t === 'sign in' || t === 'log in' || t === 'next' || t === 'tiếp tục';
                  });
                if (btn) btn.click();
              })()`).catch(() => {});
              await delay(3000);
              continue;
            } else {
              passwordFilled = false;
              passwordWaitCount = 0;
            }
          }
          if (!passwordFilled) {
            console.log(`[2FA Regen] 🔑 Điền password...`);
            await fillPassword(tabId, USER_ID, account.password);
            passwordFilled = true;
            passwordWaitCount = 0;
            await delay(6000);
            continue;
          }
        }

        // Email input
        if (state.hasEmailInput) {
          if (emailFilled) {
            // Check if the input actually has the email value inside it
            if (!state.emailValue || state.emailValue.trim() === '') {
              console.log(`[2FA Regen] ⚠️ Email input trống rỗng dù đã set emailFilled. Đặt lại emailFilled = false để điền lại...`);
              emailFilled = false;
              emailWaitCount = 0;
            } else {
              emailWaitCount++;
              if (emailWaitCount < 3) {
                console.log(`[2FA Regen] 📧 Email đã được điền ("${state.emailValue}"), đang chờ (lần ${emailWaitCount})...`);
                await evalJson(tabId, USER_ID, `(() => {
                  const btn = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]'))
                    .find(el => {
                      const t = (el.innerText || el.textContent || el.value || '').trim().toLowerCase();
                      return t === 'continue' || t === 'next' || t === 'tiếp tục';
                    });
                  if (btn) btn.click();
                })()`).catch(() => {});
                await delay(3000);
                continue;
              } else {
                emailFilled = false;
                emailWaitCount = 0;
              }
            }
          }
          if (!emailFilled) {
            emailFillAttempts++;
            if (emailFillAttempts > 3) {
              throw new Error('LOGIN_REJECTED: Nhập email thất bại nhiều lần (quá giới hạn 3 lần thử). Có thể do Proxy reputation block, Cloudflare hoặc trang web bị lỗi tải.');
            }
            console.log(`[2FA Regen] 📧 Điền email (lần thử ${emailFillAttempts}/3): ${account.email}`);
            const fillRes = await fillEmail(tabId, USER_ID, account.email);
            if (fillRes && fillRes.ok) {
              emailFilled = true;
              emailWaitCount = 0;
            } else {
              console.log(`[2FA Regen] ⚠️ Điền email thất bại: ${JSON.stringify(fillRes)}`);
              emailFilled = false;
            }
            await delay(5000);
            continue;
          }
        }

        // MFA / OTP challenge (can be email OTP or authenticator TOTP)
        if (state.hasMfaInput) {
          console.log(`[2FA Regen] 🛡️ Phát hiện màn hình MFA/2FA challenge!`);

          // 1. Kiểm tra xem đây có phải là màn hình yêu cầu OTP từ Email hay không
          const isEmailOtpScreen = await evalJson(tabId, USER_ID, `(() => {
            const b = (document.body?.innerText || '').toLowerCase();
            const hasEmailWords = b.includes('email') || b.includes('verification code') || b.includes('mã xác minh') || 
                                  b.includes('sent a code') || b.includes('temporary verification code') || 
                                  b.includes('vérification') || b.includes('código de verificación') ||
                                  b.includes('we\\'ve sent') || b.includes('sent to') || b.includes('check your inbox') || b.includes('hộp thư');
            const hasAuthWords = b.includes('authenticator') || b.includes('ứng dụng xác thực') || b.includes('auth app');
            if (hasAuthWords) {
              if (b.includes('sent to your email') || b.includes('send code to email') || b.includes('email verification')) {
                return true;
              }
              return false;
            }
            return hasEmailWords;
          })()`);

          if (isEmailOtpScreen) {
            console.log(`[2FA Regen] 📧 Phát hiện thử thách OTP gửi qua Email!`);
            const refreshToken = emailCreds?.refreshToken || emailCreds?.refresh_token;
            const clientId = emailCreds?.clientId || emailCreds?.client_id;
            if (refreshToken && clientId) {
              console.log(`[2FA Regen] 🔄 Đang tự động lấy mã OTP từ Email...`);
              const otpCode = await waitForOTPCode({
                email: account.email,
                refreshToken: refreshToken,
                clientId: clientId,
                senderDomain: 'openai.com',
                maxWaitSecs: 120
              });
              if (otpCode) {
                console.log(`[2FA Regen] 🔢 Nhập mã OTP từ email: ${otpCode}`);
                await fillMfa(tabId, USER_ID, otpCode);
                await delay(6000);
                continue;
              } else {
                throw new Error('Không lấy được mã OTP từ email hoặc hết thời gian chờ!');
              }
            } else {
              throw new Error('Yêu cầu mã OTP email nhưng thông tin email pool không đủ để lấy OTP (thiếu refresh_token/client_id)!');
            }
          } else {
            // Đây là Authenticator App challenge
            console.log(`[2FA Regen] 🔒 Phát hiện thử thách 2FA Authenticator App!`);
            const totpSecret = account.two_fa_secret || account.twoFaSecret;
            if (!totpSecret) {
              throw new Error('Tài khoản yêu cầu 2FA Authenticator nhưng không có Secret Key!');
            }
            const { otp } = await getFreshTOTP(totpSecret);
            console.log(`[2FA Regen] 🔢 Điền mã OTP sinh từ secret hiện tại: ${otp}`);
            await fillMfa(tabId, USER_ID, otp);
            mfaFilled = true;
            await delay(6000);
            continue;
          }
        }

        // Stuck on chatgpt homepage but not logged in
        if (!state.onAuthDomain) {
          console.log(`[2FA Regen] 🌐 Đang ở trang chủ nhưng chưa đăng nhập -> Chuyển hướng tới trang login...`);
          await dismissGooglePopupAndClickLogin(tabId, USER_ID);
          await delay(4000);
          continue;
        }

        await delay(3000);
      }

      if (!isLoggedIn) {
        throw new Error('Đăng nhập thất bại hoặc hết thời gian chờ!');
      }

      // Clear any onboarding modals ("Okay, let's go", etc.) that overlay the screen
      for (let i = 0; i < 3; i++) {
        const dismissed = await dismissOnboardingModals(tabId, USER_ID);
        if (dismissed) {
          console.log(`[2FA Regen] 🛡️ Phát hiện và đóng hộp thoại giới thiệu / Onboarding Modal (Lượt ${i + 1})...`);
          await delay(2000);
        } else {
          break;
        }
      }
    } else {
      console.log(`[2FA Regen] ✅ Session hợp lệ!`);
    }

    if (WARMUP_SCREENSHOTS && stepRecorder) {
      await stepRecorder.checkpoint(2, 1, 'chatgpt_logged_in_dashboard');
    }

    // ── 8. Navigation to Security Settings & 2FA Setup using setupMFA ──
    console.log(`[2FA Regen] 🛡️ Tiến hành thiết lập/bật 2FA mới sử dụng thư viện mfa-setup...`);
    const apiHelper = async (path, body) => {
      return await camofoxPost(path, body);
    };

    const mfaResult = await setupMFA(tabId, USER_ID, apiHelper, {
      email: account.email,
      emailCreds: emailCreds,
      password: account.password,
      currentSecret: account.two_fa_secret || account.twoFaSecret,
      stepRecorder: stepRecorder
    });

    if (!mfaResult.success) {
      throw new Error(`Cài đặt 2FA bằng thư viện mfa-setup thất bại: ${mfaResult.error || 'Unknown error'}`);
    }

    const newSecret = mfaResult.secret;
    console.log(`[2FA Regen] 🎉 Kích hoạt 2FA thành công! Secret Key: ${newSecret}`);

    if (WARMUP_SCREENSHOTS && stepRecorder) {
      await stepRecorder.checkpoint(3, 5, 'enable_mfa_finished_success');
    }

    // Capture new cookies
    const newCookiesRes = await camofoxGet(`/tabs/${tabId}/cookies?userId=${USER_ID}`).catch(() => null);
    const newCookies = Array.isArray(newCookiesRes?.cookies) ? newCookiesRes.cookies : (Array.isArray(newCookiesRes) ? newCookiesRes : null);

    // Post success back to API
    console.log(`[2FA Regen] 💾 Đang gửi kết quả về local API...`);
    const saveRes = await fetch(`${TOOLS_API_URL}/api/vault/accounts/${accountId}/regenerate-2fa-result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'success',
        secret: newSecret,
        cookies: newCookies || undefined
      })
    });

    if (!saveRes.ok) {
      throw new Error(`Lưu kết quả thất bại: ${await saveRes.text()}`);
    }

    console.log(`[2FA Regen] ✅ HOÀN TẤT TÁI TẠO 2FA THÀNH CÔNG!`);

  } catch (err) {
    console.error(`\n❌ [2FA Regen] Lỗi trong quá trình chạy: ${err.message}`);

    if (WARMUP_SCREENSHOTS && stepRecorder) {
      await stepRecorder.error(99, 1, '2fa_regen_error').catch(() => {});
    }

    // Post failure back to API
    try {
      await fetch(`${TOOLS_API_URL}/api/vault/accounts/${accountId}/regenerate-2fa-result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'failed',
          error: err.message
        })
      });
      console.log(`[2FA Regen] 🛑 Đã cập nhật trạng thái lỗi về local API.`);
    } catch (saveErr) {
      console.error(`[2FA Regen] Lỗi khi lưu trạng thái thất bại: ${saveErr.message}`);
    }

  } finally {
    // Clean up Tab to prevent resource leak
    if (tabId) {
      console.log(`[2FA Regen] 🧹 Đóng tab Camofox...`);
      await camofoxDelete(`/tabs/${tabId}?userId=${USER_ID}`);
    }
    console.log(`🛡️ [2FA Regen] KẾT THÚC CHƯƠNG TRÌNH TÁI TẠO 2FA.\n`);
  }
}

run2faRegen().then(() => {
  process.exit(0);
}).catch(err => {
  console.error(err);
  process.exit(1);
});
