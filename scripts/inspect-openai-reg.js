import { CAMOUFOX_API, WORKER_AUTH_TOKEN } from './config.js';
import fs from 'fs/promises';
import path from 'path';

async function inspectNaturalFlow() {
    const INSPECT_USER = 'inspector_v7';
    console.log(`🚀 Starting OpenAI Inspector (V7 - Natural Navigation)`);

    // 1. Vào trang Login chính thức thay vì dùng link OAuth cứng
    const tabRes = await fetch(`${CAMOUFOX_API}/tabs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            userId: INSPECT_USER,
            sessionKey: WORKER_AUTH_TOKEN,
            url: "https://chatgpt.com/auth/login",
            headless: false
        })
    }).then(r => r.json());

    const tabId = tabRes.tabId || tabRes.id;
    if (!tabId) { console.error(tabRes); return; }

    console.log(`✅ Opened chatgpt.com/auth/login. Waiting 15s...`);
    await new Promise(r => setTimeout(r, 15000));

    // 2. Chụp ảnh xem có nút Sign up không
    const shot1 = await fetch(`${CAMOUFOX_API}/tabs/${tabId}/screenshot?userId=${INSPECT_USER}&sessionKey=${WORKER_AUTH_TOKEN}`);
    if (shot1.ok) {
        await fs.writeFile(path.join(process.cwd(), 'data', 'screenshots', 'step1_login_page.png'), Buffer.from(await shot1.arrayBuffer()));
        console.log("📸 Screenshot step 1 saved.");
    }

    // 3. Tìm và Click nút "Sign up" tự động để sang trang Register
    console.log("🖱️ Searching for 'Sign up' link...");
    const clickRes = await fetch(`${CAMOUFOX_API}/tabs/${tabId}/evaluate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            userId: INSPECT_USER,
            sessionKey: WORKER_AUTH_TOKEN,
            expression: `(() => {
                const links = Array.from(document.querySelectorAll('a, button'));
                const signup = links.find(l => l.innerText.toLowerCase().includes('sign up'));
                if(signup) {
                    signup.click();
                    return "Clicked Sign up";
                }
                return "Sign up link not found";
            })()`
        })
    }).then(r => r.json());

    console.log("Result:", clickRes.result);
    await new Promise(r => setTimeout(r, 10000));

    // 4. Kiểm tra trang mới sau khi Click
    const evalFinal = await fetch(`${CAMOUFOX_API}/tabs/${tabId}/evaluate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            userId: INSPECT_USER,
            sessionKey: WORKER_AUTH_TOKEN,
            expression: `({
                url: location.href,
                inputs: Array.from(document.querySelectorAll('input')).map(i => ({ type: i.type, name: i.name, placeholder: i.placeholder })),
                buttons: Array.from(document.querySelectorAll('button')).map(b => b.innerText.trim())
            })`
        })
    }).then(r => r.json());

    console.log("\n--- FINAL DOM STATE ---");
    console.log(JSON.stringify(evalFinal.result, null, 2));

    // Screenshot cuối
    const shot2 = await fetch(`${CAMOUFOX_API}/tabs/${tabId}/screenshot?userId=${INSPECT_USER}&sessionKey=${WORKER_AUTH_TOKEN}`);
    if (shot2.ok) {
        await fs.writeFile(path.join(process.cwd(), 'data', 'screenshots', 'step2_register_page.png'), Buffer.from(await shot2.arrayBuffer()));
        console.log("📸 Screenshot step 2 saved.");
    }
}

inspectNaturalFlow().catch(console.error);
