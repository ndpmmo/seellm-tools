import { CAMOUFOX_API, WORKER_AUTH_TOKEN } from './config.js';
import fs from 'fs/promises';
import path from 'path';

async function test_ApiDrivenRegister_V2() {
    const DEBUG_USER = 'debug_api_v2';
    const email = `test_v2_${Date.now()}@temp-mail.org`;
    const password = "Pass123456789!";

    console.log(`🚀 [API-V2] Bắt đầu luồng API (Có khởi tạo Session)`);

    // 1. Vào thẳng endpoint tạo Session của NextAuth
    // Nó sẽ tự Redirect sang trang auth.openai.com với đầy đủ State/Nonce hợp lệ
    const startUrl = "https://chatgpt.com/api/auth/signin/auth0?prompt=login&screen_hint=signup";
    const tabRes = await fetch(`${CAMOUFOX_API}/tabs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            userId: DEBUG_USER,
            sessionKey: WORKER_AUTH_TOKEN,
            url: startUrl,
            headless: false
        })
    }).then(r => r.json());

    const tabId = tabRes.tabId || tabRes.id;
    console.log("🔗 Đang lấy Session và Redirect sang Auth. Chờ 15s...");
    await new Promise(r => setTimeout(r, 15000));

    // 2. Kiểm tra xem đã hạ cánh ở auth.openai.com chưa
    const location = await fetch(`${CAMOUFOX_API}/tabs/${tabId}/evaluate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            userId: DEBUG_USER, sessionKey: WORKER_AUTH_TOKEN,
            expression: `location.href`
        })
    }).then(r => r.json());

    console.log(`📍 URL hiện tại: ${location.result}`);

    if (!location.result || !location.result.includes('auth.openai.com')) {
        console.log("❌ Không redirect được sang auth.openai.com. Dừng.");
        return;
    }

    // 3. Thực hiện Fetch đâm thẳng vào API đăng ký
    console.log(`📡 Đang POST /api/accounts/user/register với email: ${email}...`);
    const evalRes = await fetch(`${CAMOUFOX_API}/tabs/${tabId}/evaluate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            userId: DEBUG_USER, sessionKey: WORKER_AUTH_TOKEN,
            expression: `(async () => {
             const payload = { "username": "${email}", "password": "${password}" };
             try {
                const r = await fetch("https://auth.openai.com/api/accounts/user/register", {
                   method: "POST",
                   headers: {
                       "Content-Type": "application/json",
                       "Accept": "application/json",
                       "oai-device-id": document.cookie.match(/oai-did=([a-zA-Z0-9-]+)/)?.[1] || "c4b4d1b8-6ed5-4dc9-9831-2f3b90f1d533"
                   },
                   body: JSON.stringify(payload)
                });
                const text = await r.text();
                return { status: r.status, ok: r.ok, response: text };
             } catch(e) {
                return { error: String(e) };
             }
          })()`
        })
    }).then(r => r.json());

    console.log("\n--- KẾT QUẢ CALL API (Có Session) ---");
    console.log(JSON.stringify(evalRes.result, null, 2));

    await fetch(`${CAMOUFOX_API}/tabs/${tabId}?userId=${DEBUG_USER}&sessionKey=${WORKER_AUTH_TOKEN}`, { method: 'DELETE' }).catch(() => { });
}

test_ApiDrivenRegister_V2().catch(console.error);
