import { exec } from 'child_process';
import { resolve } from 'path';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { waitForOTPCode } from './lib/ms-graph-email.js';
import { CAMOUFOX_API, WORKER_AUTH_TOKEN } from './config.js';
import { firstNames, lastNames } from './lib/names.js';

const email = "darrylbridgetlagan7432@hotmail.com";
const password = "T00lskuvy0zzx12A!";
const refreshToken = "M.C507_BAY.0.U.-CrE9G5K5jngpnDATXMFdzj82!B5BgVy7HoVJK*r!oWUfNApucAbnmB5u52fX44f7neRWiakEs2OplWxJUritfnKG4oT7Gf*fMFheJiKWIuUvw6vljYpJX8E1C3AmaNebDth8p3IFLie774vYSDg3S7chc9BLV0P2Uqf6IxgQtRC2zVKKxEqDjaVDAS0zUT1jPVFzcEy67C2F*CMlupTEIwWP1zezA9tRs*c6EtYVVYkJmRshLxU42b7Wc3cN34bTeeWTxWNlrxooM*2sakAlynDunMiy3BmqRhNB39T4U30cxYSbGGmcSwB4e!Dgdo12cVaZcCLOyFNU!4oa2eDyaXTvYo1f3bxfT1Wq7tYxHHtV0*bSD44Zd7P1LYlZkKtQXg$$";
const clientId = "9e5f94bc-e8a4-4e73-b8be-63364c29d753";

const SESSION_ID = 'login_test_' + Date.now();
const USER_ID = 'test_user';

const DATA_DIR = resolve('data', 'screenshots', SESSION_ID);
if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
}

async function api(path, reqBody = {}) {
    const isGet = !reqBody || Object.keys(reqBody).length === 0;
    
    // Attach sessionKey
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
    
    // Return buffer for screenshot, json for eval
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
        console.log(`📸 Screenshot: ${name}.png`);
    } catch(e) {
        console.error("Lỗi chụp ảnh:", e.message);
    }
}

async function evalCode(tabId, code) {
    try {
        const res = await api(`/tabs/${tabId}/eval`, { expression: code, userId: USER_ID });
        return res.result;
    } catch (e) {
        console.error("Lỗi eval:", e.message);
        return null;
    }
}

async function runLogin() {
    console.log(`[1] Tạo tab mới...`);
    const { tabId } = await api('/tabs', { userId: USER_ID, url: 'https://chatgpt.com/auth/login?prompt=login', headless: false });
    
    console.log(`[2] Đợi tải...`);
    await new Promise(r => setTimeout(r, 8000));
    await takeScreenshot(tabId, '01_login_page_loaded');

    console.log(`[3] Click "Log in"...`);
    await evalCode(tabId, `
        const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Log in') || b.textContent.includes('Đăng nhập'));
        if (btn) btn.click();
    `);

    await new Promise(r => setTimeout(r, 6000));
    await takeScreenshot(tabId, '02_auth0_loaded');

    console.log(`[4] Điền Email...`);
    await evalCode(tabId, `
        (() => {
            const input = document.querySelector('input[name="username"], input[name="email"], input[type="email"]');
            if(input) {
                const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                nativeSetter.call(input, "${email}");
                input.dispatchEvent(new Event('input', { bubbles: true }));
                
                const btn = Array.from(document.querySelectorAll('button')).find(b => 
                    b.textContent.includes('Continue') && !b.textContent.toLowerCase().includes('with')
                );
                if (btn) btn.click();
            }
        })();
    `);

    await new Promise(r => setTimeout(r, 5000));
    await takeScreenshot(tabId, '03_password_step');

    console.log(`[5] Điền Password...`);
    await evalCode(tabId, `
        (() => {
            const input = document.querySelector('input[name="password"], input[type="password"]');
            if(input) {
                const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                nativeSetter.call(input, "${password}");
                input.dispatchEvent(new Event('input', { bubbles: true }));
                
                const btn = Array.from(document.querySelectorAll('button')).find(b => 
                    b.textContent.includes('Continue') && !b.textContent.toLowerCase().includes('with')
                );
                if (btn) btn.click();
            }
        })();
    `);

    await new Promise(r => setTimeout(r, 8000));
    await takeScreenshot(tabId, '04_after_login');

    const isVerifyEmailUrl = await evalCode(tabId, `location.href.includes('email-verification')`);
    if (isVerifyEmailUrl || await evalCode(tabId, `document.body.innerText.toLowerCase().includes('verify')`)) {
        console.log(`[6] Yêu cầu OTP...`);
        const otpCode = await waitForOTPCode({ email, refreshToken, clientId, senderDomain: 'openai.com', maxWaitSecs: 90 });
        if (otpCode) {
            console.log(`[6.1] Nhập OTP: ${otpCode}`);
            await evalCode(tabId, `
                (() => {
                    const input = document.querySelector('input[name="code"], input[autocomplete="one-time-code"]');
                    if(input) {
                        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                        nativeSetter.call(input, "${otpCode}");
                        input.dispatchEvent(new Event('input', { bubbles: true }));
                        
                        const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Continue') && !b.textContent.toLowerCase().includes('with'));
                        if (btn) btn.click();
                    }
                })();
            `);
            await new Promise(r => setTimeout(r, 6000));
            await takeScreenshot(tabId, '05_after_otp');
            
            console.log(`[6.2] Điền About You (Full name, Age)...`);
            const age = Math.floor(Math.random() * (40 - 18 + 1)) + 18;
            const nameToFill = `${firstNames[Math.floor(Math.random() * firstNames.length)]} ${lastNames[Math.floor(Math.random() * lastNames.length)]}`;
            
            await evalCode(tabId, `
                (() => {
                    const typeReact = (inputSelector, text) => {
                       const input = document.querySelector(inputSelector);
                       if(!input) return false;
                       const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                       nativeSetter.call(input, text);
                       input.dispatchEvent(new Event('input', { bubbles: true }));
                       return true;
                    };
                    
                    typeReact('input[name="name"], input[placeholder="Full name"]', "${nameToFill}");
                    typeReact('input[name="age"], input[placeholder="Age"]', "${age}");
                    
                    const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Finish creating account') || b.textContent.includes('Agree'));
                    if (btn) btn.click();
                })();
            `);
            
            await new Promise(r => setTimeout(r, 8000));
            await takeScreenshot(tabId, '06_after_about_you');
            
            console.log(`[6.3] Bỏ qua form "What describes your usage" (nếu có)...`);
            await evalCode(tabId, `
                (() => {
                    // Cố gắng tìm nút có chữ Skip hoặc Bỏ qua (thường là button hoặc a)
                    const skipElements = Array.from(document.querySelectorAll('button, a, div[role="button"]'));
                    const skipBtn = skipElements.find(b => {
                        const txt = b.textContent.toLowerCase();
                        return txt === 'skip' || txt === 'bỏ qua';
                    });
                    
                    if (skipBtn) {
                        skipBtn.click();
                    } else {
                        // Tìm tùy chọn cá nhân
                        const personalUse = skipElements.find(e => {
                            const txt = e.textContent.toLowerCase();
                            return txt.includes('personal') || txt.includes('cá nhân') || txt.includes('other') || txt.includes('khác');
                        });
                        
                        if (personalUse) {
                            personalUse.click();
                            setTimeout(() => {
                                const nextBtn = skipElements.find(b => {
                                    const txt = b.textContent.toLowerCase();
                                    return txt.includes('next') || txt.includes('tiếp theo') || txt.includes('continue');
                                });
                                if (nextBtn) nextBtn.click();
                            }, 500);
                        }
                    }
                })();
            `);
            
            await new Promise(r => setTimeout(r, 6000));
            await takeScreenshot(tabId, '07_final_dashboard');
        }
    }

    console.log(`[7] Dump DOM để phân tích`);
    const domHtml = await evalCode(tabId, `document.body.innerHTML`);
    writeFileSync(resolve(DATA_DIR, 'dom.html'), domHtml || '');
    console.log("Xong!");
    process.exit(0);
}

runLogin().catch(console.error);
