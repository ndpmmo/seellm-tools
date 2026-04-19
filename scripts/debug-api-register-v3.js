import { CAMOUFOX_API, WORKER_AUTH_TOKEN } from './config.js';
import fs from 'fs/promises';
import path from 'path';

async function test_ApiDrivenRegister_V3() {
    const DEBUG_USER = 'debug_api_v3';
    const email = `test_v3_${Date.now()}@temp-mail.org`;
    const password = "Pass123456789!";

    console.log(`🚀 [API-V3] Bắt đầu luồng API (Kết hợp Click để lấy Session tự nhiên)`);

    // 1. Mở trang Login gốc
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
    console.log("🔗 Đã mở trang. Chờ 15s cho an toàn...");
    await new Promise(r => setTimeout(r, 15000));

    // 2. Click nút Sign up tự nhiên để lấy State thật
    console.log("🖱️ Bấm nút Sign up...");
    await fetch(`${CAMOUFOX_API}/tabs/${tabId}/eval`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            userId: DEBUG_USER, sessionKey: WORKER_AUTH_TOKEN,
            expression: `Array.from(document.querySelectorAll('a, button')).find(x => x.innerText.toLowerCase().includes('sign up'))?.click()`
        })
    });

    console.log("🔗 Đợi trình duyệt nhảy sang auth.openai.com (12s)...");
    await new Promise(r => setTimeout(r, 12000));

    // 3. Lấy URL hiện tại để chắc chắn
    const location = await fetch(`${CAMOUFOX_API}/tabs/${tabId}/eval`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            userId: DEBUG_USER, sessionKey: WORKER_AUTH_TOKEN,
            expression: `location.href`
        })
    }).then(r => r.json());

    console.log(`📍 URL hiện tại: ${location.result}`);

    if (!location.result || !location.result.includes('auth.openai.com')) {
        console.log("❌ Không tới được auth.openai.com. Dừng.");
        return;
    }

    // 4. Gọi API
    console.log(`📡 Đang POST /api/accounts/user/register với email: ${email}...`);
    const evalRes = await fetch(`${CAMOUFOX_API}/tabs/${tabId}/eval`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            userId: DEBUG_USER, sessionKey: WORKER_AUTH_TOKEN,
            expression: `(async () => {
             const payload = { "username": "${email}", "password": "${password}" };
             try {
                // OpenAI often needs the auth session cookie
                const ds = document.cookie.match(/oai-client-auth-session=([^;]+)/)?.[1];
                
                const r = await fetch("https://auth.openai.com/api/accounts/user/register", {
                   method: "POST",
                   headers: {
                       "Content-Type": "application/json",
                       "Accept": "application/json"
                   },
                   body: JSON.stringify(payload)
                });
                const text = await r.text();
                return { status: r.status, ok: r.ok, response: text, hasAuthSession: !!ds };
             } catch(e) {
                return { error: String(e) };
             }
          })()`
        })
    }).then(r => r.json());

    console.log("\n--- KẾT QUẢ CALL API (Có State hoàn hảo) ---");
    console.log(JSON.stringify(evalRes.result, null, 2));

    await fetch(`${CAMOUFOX_API}/tabs/${tabId}?userId=${DEBUG_USER}&sessionKey=${WORKER_AUTH_TOKEN}`, { method: 'DELETE' }).catch(() => { });
}

test_ApiDrivenRegister_V3().catch(console.error);
