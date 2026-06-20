import { CAMOUFOX_API, WORKER_AUTH_TOKEN } from './config.js';
import fs from 'fs/promises';
import path from 'path';

async function test_ApiDrivenRegister() {
    const DEBUG_USER = 'debug_api';
    const email = `test.api.${Date.now()}@temp-mail.org`;
    const password = "Pass123456789!";

    console.log(`🚀 [API-DRIVEN] Bắt đầu luồng đăng ký qua API với Email: ${email}`);

    // 1. Mở trang chủ để lấy Cookie và dập Cloudflare
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
    await new Promise(r => setTimeout(r, 15000));

    // 2. Ép nhảy sang auth.openai.com để cùng Domain (CORS Bypass)
    await fetch(`${CAMOUFOX_API}/tabs/${tabId}/evaluate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            userId: DEBUG_USER, sessionKey: WORKER_AUTH_TOKEN,
            expression: `window.location.href = "https://auth.openai.com/en/login";`
        })
    });
    console.log("🔗 Đã chuyển sang auth.openai.com. Chờ 10s...");
    await new Promise(r => setTimeout(r, 10000));

    // 3. Thực hiện FETCH trần (Naked POST) lên API Register
    console.log("📡 Đang gửi POST Request tới /api/accounts/user/register...");
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
                       "Accept": "application/json"
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

    console.log("\n--- KẾT QUẢ API REGISTER ---");
    console.log(JSON.stringify(evalRes.result, null, 2));

    // Cleanup
    await fetch(`${CAMOUFOX_API}/tabs/${tabId}?userId=${DEBUG_USER}&sessionKey=${WORKER_AUTH_TOKEN}`, { method: 'DELETE' }).catch(() => { });
}

test_ApiDrivenRegister().catch(console.error);
