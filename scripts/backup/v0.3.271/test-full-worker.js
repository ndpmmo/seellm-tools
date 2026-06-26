import { CAMOUFOX_API, WORKER_AUTH_TOKEN } from './config.js';
import fs from 'fs/promises';
import path from 'path';

async function testFull() {
    const email = "jennifergraceshanley6224244242@hotmail.com";
    const password = "Pass123456789!";
    const USER_ID = `test_full_${Date.now()}`;
    const runDir = path.join(process.cwd(), 'data', 'screenshots', USER_ID);
    await fs.mkdir(runDir, { recursive: true }).catch(() => { });

    console.log(`🚀 [FULL TEST] Bắt đầu luồng đăng ký: ${email}`);

    // 1. Mở trang Login
    const tabRes = await fetch(`${CAMOUFOX_API}/tabs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: USER_ID, sessionKey: WORKER_AUTH_TOKEN, url: "https://chatgpt.com/auth/login", headless: false })
    }).then(r => r.json());
    const tabId = tabRes.tabId || tabRes.id;
    await new Promise(r => setTimeout(r, 15000));

    // Tiêm React Type Handler
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
    await fetch(`${CAMOUFOX_API}/tabs/${tabId}/evaluate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: USER_ID, sessionKey: WORKER_AUTH_TOKEN, expression: injectReactTyper })
    });

    console.log("🖱️ Bấm Sign up...");
    await fetch(`${CAMOUFOX_API}/tabs/${tabId}/evaluate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            userId: USER_ID, sessionKey: WORKER_AUTH_TOKEN,
            expression: `Array.from(document.querySelectorAll('a, button')).find(x => x.innerText.toLowerCase().includes('sign up'))?.click()`
        })
    });
    await new Promise(r => setTimeout(r, 12000));

    // Điền Email
    console.log(`📝 Điền Email: ${email}`);
    await fetch(`${CAMOUFOX_API}/tabs/${tabId}/evaluate`, {
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
             // Tránh "Continue with Google" hoặc các nút Login SSO
             const btn = Array.from(document.querySelectorAll('button')).find(b => {
                const text = b.innerText.trim();
                return (text === 'Continue' || text === 'Tiếp tục') && !text.includes('with Google');
             });
             if (btn) btn.click();
          })()`
        })
    });

    console.log("⏳ Chờ OpenAI chuyển qua trang Password...");
    await new Promise(r => setTimeout(r, 12000));

    const shot1 = await fetch(`${CAMOUFOX_API}/tabs/${tabId}/screenshot?userId=${USER_ID}&sessionKey=${WORKER_AUTH_TOKEN}`);
    await fs.writeFile(path.join(runDir, '02_password_load.png'), Buffer.from(await shot1.arrayBuffer()));

    // Điền Password
    console.log(`[3] Điền Password: ${password}`);
    await fetch(`${CAMOUFOX_API}/tabs/${tabId}/evaluate`, {
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

    console.log("⏳ Chờ OpenAI tạo tài khoản và chuyển trang...");
    await new Promise(r => setTimeout(r, 15000));

    const shot2 = await fetch(`${CAMOUFOX_API}/tabs/${tabId}/screenshot?userId=${USER_ID}&sessionKey=${WORKER_AUTH_TOKEN}`);
    await fs.writeFile(path.join(runDir, '03_after_password.png'), Buffer.from(await shot2.arrayBuffer()));

    // Lấy DOM cuối cùng
    const dom = await fetch(`${CAMOUFOX_API}/tabs/${tabId}/evaluate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            userId: USER_ID, sessionKey: WORKER_AUTH_TOKEN,
            expression: `({ url: location.href, title: document.title, text: document.body.innerText.slice(0, 300) })`
        })
    }).then(r => r.json());

    console.log("\n--- KẾT QUẢ CUỐI (VERIFY EMAIL?) ---");
    console.log(JSON.stringify(dom.result, null, 2));
    console.log(`📸 Ảnh lưu tại: data/screenshots/${USER_ID}/`);
}

testFull().catch(console.error);
