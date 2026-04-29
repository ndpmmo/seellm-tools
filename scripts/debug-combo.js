import { CAMOUFOX_API, WORKER_AUTH_TOKEN } from './config.js';
import fs from 'fs/promises';
import path from 'path';

async function combo_ReactSetter() {
    const DEBUG_USER = 'debug_react';
    const email = "jennifergraceshanley6224244242@hotmail.com";
    const password = "Pass123456789!";

    console.log(`🚀 [REACT-V4] Test luồng Điền Form (Native React Setter) cho: ${email}`);

    const tabRes = await fetch(`${CAMOUFOX_API}/tabs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            userId: DEBUG_USER,
            sessionKey: WORKER_AUTH_TOKEN,
            url: "https://chatgpt.com/auth/login",
            headless: false
        })
    }).then(r => r.json());

    const tabId = tabRes.tabId || tabRes.id;
    await new Promise(r => setTimeout(r, 12000));

    // Bơm Hàm React Typer vào trình duyệt
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
        body: JSON.stringify({ userId: DEBUG_USER, sessionKey: WORKER_AUTH_TOKEN, expression: injectReactTyper })
    });

    console.log("🖱️ Bấm nút Sign up...");
    await fetch(`${CAMOUFOX_API}/tabs/${tabId}/evaluate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            userId: DEBUG_USER, sessionKey: WORKER_AUTH_TOKEN,
            expression: `Array.from(document.querySelectorAll('a, button')).find(x => x.innerText.toLowerCase().includes('sign up'))?.click()`
        })
    });
    await new Promise(r => setTimeout(r, 10000));

    console.log("📝 Điền Email...");
    await fetch(`${CAMOUFOX_API}/tabs/${tabId}/evaluate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            userId: DEBUG_USER, sessionKey: WORKER_AUTH_TOKEN,
            expression: `(() => {
             window.typeReact('input[name="email"], input[name="identifier"]', "${email}");
             const btn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('Continue') || b.innerText.includes('Tiếp tục'));
             if (btn) btn.click();
          })()`
        })
    });

    console.log("⏳ Chờ nhảy sang trang Password...");
    await new Promise(r => setTimeout(r, 8000));

    // Chụp ảnh để xem có hiện ô Password không
    const shot1 = await fetch(`${CAMOUFOX_API}/tabs/${tabId}/screenshot?userId=${DEBUG_USER}&sessionKey=${WORKER_AUTH_TOKEN}`);
    await fs.writeFile(path.join(process.cwd(), 'data', 'screenshots', 'combo_v4_step1_password_page.png'), Buffer.from(await shot1.arrayBuffer()));

    console.log("📝 Điền Password...");
    const submitRes = await fetch(`${CAMOUFOX_API}/tabs/${tabId}/evaluate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            userId: DEBUG_USER, sessionKey: WORKER_AUTH_TOKEN,
            expression: `(() => {
            const isVisible = el => el && el.getBoundingClientRect().width > 0;
            // Selector "Bóng ma" mới tìm được
            const typed = window.typeReact('input[name="new-password"], input[type="password"]', "${password}");
            
            const btn = Array.from(document.querySelectorAll('button')).find(b => 
                (b.textContent.includes('Continue') || b.textContent.includes('Tiếp tục') || b.textContent.includes('Create account') || b.textContent.includes('Next')) 
                && isVisible(b)
            );
            if (btn) btn.click();
            return { typed, url: location.href };
          })()`
        })
    }).then(r => r.json());
    console.log("Result:", submitRes.result);

    await new Promise(r => setTimeout(r, 10000));

    // Chụp lại ảnh và DOM lần cuối
    const shot2 = await fetch(`${CAMOUFOX_API}/tabs/${tabId}/screenshot?userId=${DEBUG_USER}&sessionKey=${WORKER_AUTH_TOKEN}`);
    await fs.writeFile(path.join(process.cwd(), 'data', 'screenshots', 'combo_v4_step2_final.png'), Buffer.from(await shot2.arrayBuffer()));

    const dom = await fetch(`${CAMOUFOX_API}/tabs/${tabId}/evaluate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            userId: DEBUG_USER, sessionKey: WORKER_AUTH_TOKEN,
            expression: `({ url: location.href, text: document.body.innerText.slice(0, 300) })`
        })
    }).then(r => r.json());
    console.log(JSON.stringify(dom.result, null, 2));
}

combo_ReactSetter().catch(console.error);
