import { CAMOUFOX_API, WORKER_AUTH_TOKEN } from './config.js';
import fs from 'fs/promises';
import path from 'path';

async function runToOtp() {
    const email = "maxegiv229@sixoplus.com";
    const password = "PasswordAuto123!";
    const USER_ID = `manual_otp_${Date.now()}`;

    console.log(`🚀 [OTP HOLD] Bắt đầu lấy mã cho: ${email} | Pass: ${password}`);

    const tabRes = await fetch(`${CAMOUFOX_API}/tabs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: USER_ID, sessionKey: WORKER_AUTH_TOKEN, url: "https://chatgpt.com/auth/login", headless: false })
    }).then(r => r.json());

    const tabId = tabRes.tabId || tabRes.id;
    console.log(`=================================================`);
    console.log(`🔥 TAB ID CẦN GIỮ LẠI: ${tabId}`);
    console.log(`🔥 USER ID CẦN GIỮ LẠI: ${USER_ID}`);
    console.log(`=================================================`);

    await new Promise(r => setTimeout(r, 15000));

    const injectReactTyper = `
      window.typeReact = (inputSelector, text) => {
        const input = document.querySelector(inputSelector);
        if(!input) return false;
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        nativeSetter.call(input, text);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      };
    `;
    await fetch(`${CAMOUFOX_API}/tabs/${tabId}/eval`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: USER_ID, sessionKey: WORKER_AUTH_TOKEN, expression: injectReactTyper })
    });

    console.log("🖱️ Bấm Sign up...");
    await fetch(`${CAMOUFOX_API}/tabs/${tabId}/eval`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            userId: USER_ID, sessionKey: WORKER_AUTH_TOKEN,
            expression: `Array.from(document.querySelectorAll('a, button')).find(x => x.innerText.toLowerCase().includes('sign up'))?.click()`
        })
    });
    await new Promise(r => setTimeout(r, 10000));

    console.log(`📝 Điền Email...`);
    await fetch(`${CAMOUFOX_API}/tabs/${tabId}/eval`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            userId: USER_ID, sessionKey: WORKER_AUTH_TOKEN,
            expression: `(() => {
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
                return (text === 'Continue' || text === 'Tiếp tục') && !text.includes('with Google');
             });
             if (btn) btn.click();
          })()`
        })
    });

    await new Promise(r => setTimeout(r, 10000));

    console.log(`[3] Điền Password...`);
    await fetch(`${CAMOUFOX_API}/tabs/${tabId}/eval`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            userId: USER_ID, sessionKey: WORKER_AUTH_TOKEN,
            expression: `(() => {
             const typeReact = (inputSelector, text) => {
               const input = document.querySelector(inputSelector);
               if(!input) return false;
               const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
               nativeSetter.call(input, text);
               input.dispatchEvent(new Event('input', { bubbles: true }));
               return true;
             };
             const isVisible = el => el && el.getBoundingClientRect().width > 0;
             typeReact('input[name="new-password"], input[type="password"]', "${password}");
             const btn = Array.from(document.querySelectorAll('button')).find(b => 
                (b.textContent.includes('Continue') || b.textContent.includes('Tiếp tục') || b.textContent.includes('Create account') || b.textContent.includes('Next')) && isVisible(b)
             );
             if (btn) btn.click();
          })()`
        })
    });

    console.log("⏳ Chờ nhảy qua trang Verify...");
    await new Promise(r => setTimeout(r, 15000));

    const dom = await fetch(`${CAMOUFOX_API}/tabs/${tabId}/eval`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            userId: USER_ID, sessionKey: WORKER_AUTH_TOKEN,
            expression: `({ url: location.href, title: document.title, text: document.body.innerText.slice(0, 300) })`
        })
    }).then(r => r.json());

    console.log("\n--- SẴN SÀNG NHẬP OTP ---");
    console.log(JSON.stringify(dom.result, null, 2));
    console.log("✅ Đã giữ lại Tab. Hãy gửi cho tôi OTP, tôi sẽ gọi tiếp hàm thao tác Tab hiện tại!");
}

runToOtp().catch(console.error);
