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
import { fileURLToPath } from 'node:url';
import { createHmac } from 'node:crypto';
import { CAMOUFOX_API, GATEWAY_URL, WORKER_AUTH_TOKEN } from './config.js';
import { waitForOTPCode } from './lib/ms-graph-email.js';
import { firstNames, lastNames } from './lib/names.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(__dirname, '..');
const IMAGES_DIR = path.join(ROOT_DIR, 'data', 'screenshots');

const OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const OAUTH_URL = 'https://auth.openai.com';
const OPENAI_AUTH = 'https://auth.openai.com';

// ============================================
// HELPERS
// ============================================
function getTOTP(secret) {
  function base32tohex(base32) {
    const base32chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = '', hex = '';
    const clean = base32.replace(/\s/g, '').toUpperCase();
    for (let i = 0; i < clean.length; i++) {
      const val = base32chars.indexOf(clean.charAt(i));
      if (val === -1) continue;
      bits += val.toString(2).padStart(5, '0');
    }
    for (let i = 0; i + 4 <= bits.length; i += 4) hex += parseInt(bits.substr(i, 4), 2).toString(16);
    return hex;
  }
  const key = base32tohex(secret);
  const epoch = Math.round(Date.now() / 1000);
  const time = Buffer.from(Math.floor(epoch / 30).toString(16).padStart(16, '0'), 'hex');
  const hmac = createHmac('sha1', Buffer.from(key, 'hex'));
  const h = hmac.update(time).digest();
  const offset = h[h.length - 1] & 0xf;
  const otp = (h.readUInt32BE(offset) & 0x7fffffff) % 1000000;
  return otp.toString().padStart(6, '0');
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

async function camofoxPost(endpoint, body, timeoutMs = 30000) {
  // Đảm bảo luôn truyền sessionKey
  const payload = { ...body, sessionKey: WORKER_AUTH_TOKEN };
  const res = await fetch(`${CAMOUFOX_API}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Camofox POST ${endpoint} failed: ${res.status}`);
  return res.json();
}

async function evalJson(tabId, userId, expression, timeoutMs = 12000) {
  try {
    const res = await camofoxPost(`/tabs/${tabId}/eval`, { userId, expression }, timeoutMs);
    return res?.result ?? null;
  } catch (e) {
    console.log(`[Eval] failed: ${e.message}`);
    return null;
  }
}

async function getCookies(tabId, userId) {
  const res = await fetch(`${CAMOUFOX_API}/tabs/${tabId}/cookies?userId=${userId}`);
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data.cookies) ? data.cookies : (Array.isArray(data) ? data : []);
}

async function saveStep(tabId, userId, runDir, label) {
  try {
    const res = await fetch(`${CAMOUFOX_API}/tabs/${tabId}/screenshot?userId=${userId}&fullPage=true`);
    if (res.ok) {
      await fs.writeFile(path.join(runDir, `${label}.png`), Buffer.from(await res.arrayBuffer()));
    }
  } catch (e) { }
}

// ============================================
// MAIN REGISTER FLOW
// ============================================

export async function runAutoRegister(taskInput) {
  const [email, password, refreshToken, clientId] = taskInput.split('|');
  if (!email || !password || !refreshToken || !clientId) throw new Error("Input string is invalid (expected email|pass|refresh_token|client_id)");

  console.log(`==========================================`);
  console.log(`🚀 [Auto-Register] Bắt đầu đăng ký: ${email}`);
  console.log(`==========================================`);

  const USER_ID = `register_${Date.now()}`;
  console.log(`SESSION_ID: ${USER_ID}`); // Quan trọng để frontend link ảnh chụp
  const runDir = path.join(IMAGES_DIR, USER_ID);
  await fs.mkdir(runDir, { recursive: true }).catch(() => { });

  let tabId = null;

  try {
    // 1. Khởi động - Đi từ trang login để tránh bị blank page
    console.log(`🚀 [Phase 1] Truy cập trang Login...`);
    const tabRes = await camofoxPost('/tabs', {
      userId: USER_ID,
      url: "https://chatgpt.com/auth/login",
      headless: false,
      humanize: true
    });
    tabId = tabRes.tabId;
    await new Promise(r => setTimeout(r, 8000));
    await saveStep(tabId, USER_ID, runDir, '01_login_page');

    // Click "Sign up" để sang luồng đăng ký
    console.log(`🖱️  Chuyển sang luồng Đăng ký...`);
    await evalJson(tabId, USER_ID, `(() => {
      const links = Array.from(document.querySelectorAll('a, button'));
      const signup = links.find(l => l.innerText.toLowerCase().includes('sign up'));
      if(signup) signup.click();
    })()`);
    await new Promise(r => setTimeout(r, 5000));
    await saveStep(tabId, USER_ID, runDir, '02_register_page');

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
    await saveStep(tabId, USER_ID, runDir, '02_password_load');

    // 3. Form Điền Mật khẩu (create-account/password)
    console.log(`[3] Điền Password -> ${password}`);
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
            typeReact('input[name="new-password"], input[type="password"]', "${password}");
            
            // Tìm nút Tiếp tục / Continue
            const btn = Array.from(document.querySelectorAll('button')).find(b => 
                (b.textContent.includes('Continue') || b.textContent.includes('Tiếp tục') || b.textContent.includes('Create account') || b.textContent.includes('Next')) 
                && isVisible(b)
            );
            if (btn) btn.click();
          })()
        `);
    await new Promise(r => setTimeout(r, 8000));
    await saveStep(tabId, USER_ID, runDir, '03_after_password_submit');

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
      await saveStep(tabId, USER_ID, runDir, '04_pin_verified');
    }

    // 5. Cấp User Info
    console.log(`[5] Bypass thông tin Form About...`);
    const userInfo = generateRandomUserInfo();
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

             // TH1: Form mới (Fullname + Age)
             const nameInput = document.querySelector('input[name="name"], input[placeholder="Full name"]');
             const ageInput = document.querySelector('input[name="age"], input[placeholder="Age"]');
             
             if (nameInput && ageInput) {
                 typeReact('input[name="name"], input[placeholder="Full name"]', "${userInfo.name}");
                 typeReact('input[name="age"], input[placeholder="Age"]', "${userInfo.age}");
             } else {
                 // TH2: Form cũ (First name, Last name, DOB)
                 const inps = document.querySelectorAll('input[type="text"]');
                 if(inps.length >= 2) {
                    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                    nativeSetter.call(inps[0], "${userInfo.name.split(' ')[0]}");
                    inps[0].dispatchEvent(new Event('input', {bubbles:true}));

                    nativeSetter.call(inps[1], "${userInfo.name.split(' ')[1]}");
                    inps[1].dispatchEvent(new Event('input', {bubbles:true}));
                    
                    const dob = document.querySelector('input[placeholder="DD/MM/YYYY"]');
                    if(dob) {
                      nativeSetter.call(dob, "${userInfo.birthdate.slice(8, 10)}/${userInfo.birthdate.slice(5, 7)}/${userInfo.birthdate.slice(0, 4)}");
                      dob.dispatchEvent(new Event('input', {bubbles:true}));
                    }
                 }
             }
             
             const isVisible = el => el && el.getBoundingClientRect().width > 0;
             Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Agree') || b.textContent.includes('Continue'))?.click();
          })()
        `);
    await new Promise(r => setTimeout(r, 6000));
    await saveStep(tabId, USER_ID, runDir, '05_about_completed');

    // 6. Nhẩy Bypass Phone & Nhẩy vào Workspace
    console.log(`[6] Tiến hành Bypass Screen (if Phone requested) và lấy Access Token...`);
    const pageUrl = await evalJson(tabId, USER_ID, `location.href`);
    if (pageUrl.includes('add-phone')) {
      console.log(`[6.1] Chặn Phone Add! Redirecing to Consent / Home...`);
      await camofoxPost(`/tabs/${tabId}/navigate`, { userId: USER_ID, url: 'https://chatgpt.com/' });
      await new Promise(r => setTimeout(r, 8000));
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
    await saveStep(tabId, USER_ID, runDir, '06_skip_survey');

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
    await saveStep(tabId, USER_ID, runDir, '07_inside_chat');

    await saveStep(tabId, USER_ID, runDir, '06_home_reached');

    // 7. SETUP 2FA (MFA)
    console.log(`==========================================`);
    console.log(`[7] BẬT BẢO MẬT 2FA / MFA CHO ACCOUNT NÀY...`);
    console.log(`==========================================`);

    const mfaSetup = await evalJson(tabId, USER_ID, `
          (async () => {
             try {
               const r = await fetch("https://chatgpt.com/backend-api/accounts/mfa/setup", {
                  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({})
               });
               const rjson = await r.json();
               return rjson;
             } catch(e) { return null; }
          })()
        `);

    let twoFaSecret = null;
    if (mfaSetup && mfaSetup.secret) {
      twoFaSecret = mfaSetup.secret;
      console.log(`[7.1] Sinh mã TOTP từ Secret: ${twoFaSecret}`);

      const verificationOTP = getTOTP(twoFaSecret);

      const mfaVerify = await evalJson(tabId, USER_ID, `
              (async () => {
                 try {
                   const r = await fetch("https://chatgpt.com/backend-api/accounts/mfa/verify", {
                      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ "code": "${verificationOTP}", "type": "authenticator" })
                   });
                   return r.status === 200;
                 } catch(e) { return false; }
              })()
            `);

      if (mfaVerify) {
        console.log(`[7.2] 🟢 Bật 2FA Thành Công Toàn Bước! (MFA Active)`);
      } else {
        console.log(`[7.2] 🔴 Không thể verify MFA. Tuy nhiên Account vẫn an toàn.`);
        twoFaSecret = null;
      }
    } else {
      console.log(`[7.1] 🔴 Lỗi API MFA Setup: ${JSON.stringify(mfaSetup || 'null')}`);
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
    console.log(`==========================================`);

    return {
      success: true, email, password, twoFaSecret, sessionToken, createdAt: new Date().toISOString()
    };

  } catch (error) {
    console.error(`🔴 Catch Global Lỗi 🔴: ${error.message}`);
    return { success: false, error: error.message };
  } finally {
    if (tabId) { await camofoxPost(`/tabs/${tabId}?userId=${USER_ID}`, {}, 5000).catch(() => { }); }
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
    if (res.success) {
      console.log(`\n🎉 HOÀN TẤT: ${res.email}`);
      process.exit(0);
    } else {
      console.error(`\n❌ THẤT BẠI: ${res.error}`);
      process.exit(1);
    }
  });
}
