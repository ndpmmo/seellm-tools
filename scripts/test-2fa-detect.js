import { CAMOUFOX_API, WORKER_AUTH_TOKEN } from './config.js';
import { camofoxPost, camofoxGet, camofoxDelete, navigate, evalJson } from './lib/camofox.js';
import { getFreshTOTP } from './lib/totp.js';
import {
  getState,
  fillEmail,
  fillPassword,
  fillMfa,
  tryAcceptCookies,
  dismissGooglePopupAndClickLogin,
  selectPersonalWorkspaceOnWorkspacePage
} from './lib/openai-login-flow.js';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve } from 'path';

// Tài khoản test do người dùng cung cấp
const email = "peterschloe786@hotmail.com";
const password = "0W^juD1qKhAPoyE9";
const twoFaSecret = "XIQNKMRBYUYYCTSXGQDO7QMUVABKLRKD";

const SESSION_ID = '2fa_detect_' + Date.now();
const USER_ID = 'test_2fa_detect';

const DATA_DIR = resolve('data', 'screenshots', SESSION_ID);
if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
}

async function api(path, reqBody = {}) {
    const isGet = !reqBody || Object.keys(reqBody).length === 0;
    
    let finalPath = path;
    if (isGet) {
        finalPath += (path.includes('?') ? '&' : '?') + `sessionKey=${WORKER_AUTH_TOKEN}`;
    } else {
        reqBody.sessionKey = WORKER_AUTH_TOKEN;
    }

    const res = await fetch(`${CAMOUFOX_API}${finalPath}`, {
        method: isGet ? 'GET' : 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: isGet ? undefined : JSON.stringify(reqBody)
    });
    if (!res.ok) {
        const txt = await res.text();
        throw new Error(`API Error ${res.status}: ${txt}`);
    }
    
    if (path.includes('screenshot')) {
        return res.arrayBuffer();
    }
    
    return res.json();
}

async function takeScreenshot(tabId, name) {
    try {
        const buf = await api(`/tabs/${tabId}/screenshot?userId=${USER_ID}&fullPage=true`);
        const p = resolve(DATA_DIR, `${name}.png`);
        writeFileSync(p, Buffer.from(buf));
        console.log(`📸 Chụp ảnh màn hình: ${name}.png (lưu tại data/screenshots/${SESSION_ID})`);
    } catch(e) {
        console.error("❌ Lỗi chụp ảnh:", e.message);
    }
}

async function evalCode(tabId, code) {
    try {
        const res = await api(`/tabs/${tabId}/evaluate`, { expression: code, userId: USER_ID });
        return res.result;
    } catch (e) {
        console.error("❌ Lỗi evaluate:", e.message);
        return null;
    }
}

async function runDetect() {
    console.log(`===========================================================`);
    console.log(`🛡️ BẮT ĐẦU CHẠY THỬ NGHIỆM PHÁT HIỆN 2FA CHO TÀI KHOẢN TEST`);
    console.log(`Tài khoản: ${email}`);
    console.log(`===========================================================`);

    console.log(`[1] Khởi tạo tab Camofox mới...`);
    const { tabId } = await api('/tabs', { 
        userId: USER_ID, 
        url: 'https://chatgpt.com/', 
        headless: false,
        os: 'macos',
        screen: { width: 1440, height: 900 }
    });
    
    console.log(`[2] Đợi tải trang chủ ChatGPT...`);
    await new Promise(r => setTimeout(r, 6000));
    await takeScreenshot(tabId, '01_homepage_loaded');

    let state = await getState(tabId, USER_ID);
    let isLoggedIn = state.looksLoggedIn;

    if (!isLoggedIn) {
        console.log(`[3] Chưa đăng nhập. Tiến hành điều hướng đến trang login...`);
        await dismissGooglePopupAndClickLogin(tabId, USER_ID);
        await new Promise(r => setTimeout(r, 5000));
        
        const maxLoginAttempts = 12;
        let emailFilled = false;
        let passwordFilled = false;

        for (let attempt = 1; attempt <= maxLoginAttempts; attempt++) {
            console.log(`[Login] Vòng lặp đăng nhập - Lượt ${attempt}/${maxLoginAttempts}...`);
            await new Promise(r => setTimeout(r, 1000));
            
            const currState = await getState(tabId, USER_ID);
            
            if (currState.looksLoggedIn) {
                console.log(`[Login] ✅ Đăng nhập thành công!`);
                isLoggedIn = true;
                break;
            }

            // Welcome Back chọn tài khoản
            const chooseResult = await evalCode(tabId, `(() => {
              const body = (document.body?.innerText || '').toLowerCase();
              const hasWelcomeBack = body.includes('welcome back') || body.includes('chào mừng quay trở lại') || body.includes('choose an account') || body.includes('chọn một tài khoản');
              if (!hasWelcomeBack) return null;

              const clickables = document.querySelectorAll('button, [role="button"], [role="option"], a');
              for (const el of clickables) {
                if (el.offsetParent === null) continue;
                const text = (el.textContent || '').trim().toLowerCase();
                if (text.includes(${JSON.stringify(email.split('@')[0])}) || text.includes(${JSON.stringify(email)})) {
                  el.click();
                  return 'clicked_btn: ' + text.slice(0, 60);
                }
              }
              return null;
            })()`);
            if (chooseResult) {
                console.log(`[Login] 👤 Đã click chọn tài khoản Welcome Back: ${chooseResult}`);
                await new Promise(r => setTimeout(r, 4000));
                continue;
            }

            // Cookie banner
            if (currState.hasCookieBanner) {
                console.log(`[Login] 🍪 Chấp nhận cookies...`);
                await tryAcceptCookies(tabId, USER_ID);
                await new Promise(r => setTimeout(r, 2000));
                continue;
            }

            // Điền email
            if (currState.hasEmailInput && !emailFilled) {
                console.log(`[Login] 📧 Điền email: ${email}`);
                await fillEmail(tabId, USER_ID, email);
                emailFilled = true;
                await new Promise(r => setTimeout(r, 5000));
                continue;
            }

            // Điền mật khẩu
            if (currState.hasPasswordInput && !passwordFilled) {
                console.log(`[Login] 🔑 Điền password...`);
                await fillPassword(tabId, USER_ID, password);
                passwordFilled = true;
                await new Promise(r => setTimeout(r, 5000));
                continue;
            }

            // Thử thách 2FA (Authenticator App)
            if (currState.hasMfaInput) {
                console.log(`[Login] 🛡️ Phát hiện màn hình yêu cầu mã 2FA Authenticator App!`);
                console.log(`[Login] 🔄 Đang tự động tạo mã TOTP từ Secret Key: ${twoFaSecret}`);
                const { otp } = await getFreshTOTP(twoFaSecret);
                console.log(`[Login] 🔢 Mã TOTP được tạo: ${otp}. Tiến hành điền và đăng nhập...`);
                await fillMfa(tabId, USER_ID, otp);
                await new Promise(r => setTimeout(r, 6000));
                continue;
            }
        }
    } else {
        console.log(`[3] ✅ Session cookie vẫn còn hợp lệ! Đã đăng nhập.`);
    }

    if (!isLoggedIn) {
        console.error(`❌ Đăng nhập thất bại hoặc hết hạn chờ.`);
        await takeScreenshot(tabId, 'error_login_failed');
        await camofoxDelete(`/tabs/${tabId}?userId=${USER_ID}`);
        process.exit(1);
    }

    await new Promise(r => setTimeout(r, 3000));

    // Đóng onboarding modals nếu có
    await evalCode(tabId, `
        (() => {
            const buttons = Array.from(document.querySelectorAll('button, [role="button"], a'));
            for (const btn of buttons) {
                if (btn.offsetParent === null) continue;
                const text = (btn.innerText || btn.textContent || '').trim().toLowerCase();
                if (
                    text === "okay, let's go" ||
                    text === "okay, let’s go" ||
                    text === "got it" ||
                    text === "done" ||
                    text === "next" ||
                    text === "continue"
                ) {
                    btn.click();
                }
            }
        })()
    `);

    // 🌐 [4] Điều hướng vào Security Settings
    console.log(`[4] ⚙️ Điều hướng tới Security Settings...`);
    try {
        await evalCode(tabId, `window.location.href = 'https://chatgpt.com/#settings/Security'`);
    } catch (_) {}
    await new Promise(r => setTimeout(r, 6000));

    // Kiểm tra xem Settings modal đã hiển thị chưa. Nếu chưa, thử click profile menu.
    await evalCode(tabId, `
        (async () => {
            const dialog = document.querySelector('[role="dialog"]');
            if (dialog) return;

            const profileBtn = document.querySelector('[data-testid="profile-button"], [data-testid="user-menu-button"], [aria-label="Open user menu"]');
            if (profileBtn) {
                profileBtn.click();
                await new Promise(r => setTimeout(r, 1000));
                const menuItems = Array.from(document.querySelectorAll('[role="menuitem"], button'));
                const settingsItem = menuItems.find(el => {
                    const t = (el.textContent || '').trim().toLowerCase();
                    return t === 'settings' || t === 'cài đặt';
                });
                if (settingsItem) {
                    settingsItem.click();
                }
            }
        })()
    `);
    await new Promise(r => setTimeout(r, 3000));

    // Kích hoạt tab Security
    await evalCode(tabId, `
        (() => {
            let sec = document.querySelector('[data-testid="security-tab"]');
            if (!sec) {
                sec = Array.from(document.querySelectorAll('[role="tab"], button, a')).find(el => {
                    const text = (el.textContent || '').toLowerCase().trim();
                    return text === 'security' || text === 'bảo mật';
                });
            }
            if (sec) sec.click();
        })()
    `);
    await new Promise(r => setTimeout(r, 2000));

    await takeScreenshot(tabId, '02_security_settings_loaded');

    // 🔍 [5] Phân tích DOM để nhận diện trạng thái 2FA hiện tại
    console.log(`[5] 🔍 Đang phân tích DOM của phần tử Authenticator App trong mục Security...`);
    
    const analysis = await evalCode(tabId, `
        (() => {
            const results = {};
            const elements = Array.from(document.querySelectorAll('*'));
            const authTextEl = elements.find(el => {
                const text = el.textContent || '';
                if (!/authenticator\\s+app/i.test(text) && !/authenticator/i.test(text)) return false;
                return !Array.from(el.children).some(child => /authenticator/i.test(child.textContent || ''));
            });

            if (!authTextEl) {
                return { success: false, reason: "Không tìm thấy bất kỳ nhãn nào chứa chữ 'Authenticator' trên giao diện!" };
            }

            results.authTextEl_tag = authTextEl.tagName;
            results.authTextEl_text = authTextEl.textContent;

            // Tìm switch hoặc checkbox
            let par = authTextEl;
            let foundSwitch = null;
            let pathTrace = [];

            for (let d = 0; d < 8; d++) {
                if (!par) break;
                pathTrace.push(par.tagName + (par.className ? '.' + par.className.split(' ').join('.') : ''));
                
                const sw = par.querySelector('button[role="switch"], [role="switch"], input[type="checkbox"]');
                if (sw) {
                    foundSwitch = sw;
                    break;
                }
                par = par.parentElement;
            }

            if (!foundSwitch) {
                return { 
                    success: false, 
                    reason: "Tìm thấy chữ 'Authenticator' nhưng không tìm thấy switch/checkbox nào quanh đó!",
                    pathTrace
                };
            }

            results.switch_tag = foundSwitch.tagName;
            results.switch_role = foundSwitch.getAttribute('role');
            results.switch_type = foundSwitch.getAttribute('type');
            results.switch_aria_checked = foundSwitch.getAttribute('aria-checked');
            results.switch_checked_property = foundSwitch.checked;
            results.switch_outerHTML = foundSwitch.outerHTML;

            // Kiểm tra trạng thái kích hoạt 2FA
            const is2FaEnabled = (results.switch_aria_checked === 'true' || results.switch_checked_property === true);
            results.is2FaEnabled = is2FaEnabled;

            return { success: true, results };
        })()
    `);

    console.log(`\n📊 KẾT QUẢ PHÂN TÍCH DOM:`);
    console.log(JSON.stringify(analysis, null, 2));

    if (analysis && analysis.success) {
        const is2FaOn = analysis.results.is2FaEnabled;
        console.log(`\n===========================================================`);
        console.log(`🛡️ KẾT LUẬN NHẬN DIỆN TRẠNG THÁI 2FA:`);
        if (is2FaOn) {
            console.log(`✅ [TRẠNG THÁI]: 2FA ĐANG BẬT (Đã có 2FA thành công!)`);
            console.log(`   --> Có thể dùng thuộc tính 'aria-checked="true"' trên switch để nhận diện.`);
        } else {
            console.log(`❌ [TRẠNG THÁI]: 2FA ĐANG TẮT (Chưa cài đặt 2FA)`);
        }
        console.log(`===========================================================`);
    } else {
        console.error(`\n❌ Nhận dạng thất bại: ${analysis?.reason || 'Lỗi không xác định'}`);
    }

    // 🧹 [6] Đóng tab Camofox
    console.log(`\n[6] 🧹 Đóng tab Camofox...`);
    await camofoxDelete(`/tabs/${tabId}?userId=${USER_ID}`);
    console.log(`🏁 Hoàn tất chương trình thử nghiệm.`);
}

runDetect().catch(console.error);
