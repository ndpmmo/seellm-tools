import { CAMOUFOX_API, WORKER_AUTH_TOKEN } from './config.js';
import fs from 'fs/promises';
import path from 'path';

async function step1_HotmailTest() {
    const DEBUG_USER = 'debug_hotmail';
    const email = "jennifergraceshanley6224244242@hotmail.com";
    console.log(`🚀 [BƯỚC 1.2] Thử nghiệm với Email: ${email}`);

    // 1. Vào trang Login gốc
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

    // 2. Bấm Sign up
    await fetch(`${CAMOUFOX_API}/tabs/${tabId}/evaluate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            userId: DEBUG_USER,
            sessionKey: WORKER_AUTH_TOKEN,
            expression: `(() => {
              const el = Array.from(document.querySelectorAll('a, button')).find(x => x.innerText.toLowerCase().includes('sign up'));
              if(el) el.click();
           })()`
        })
    });
    console.log("🖱️  Đã bấm Sign up. Đợi trang đăng ký...");
    await new Promise(r => setTimeout(r, 12000));

    // 3. Nhập email Hotmail và bấm Continue
    console.log(`📝 Điền Email: ${email}`);
    await fetch(`${CAMOUFOX_API}/tabs/${tabId}/evaluate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            userId: DEBUG_USER,
            sessionKey: WORKER_AUTH_TOKEN,
            expression: `(() => {
                const input = document.querySelector('input[name="email"]');
                if(input) {
                    input.value = "${email}";
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                }
                const btn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('Continue'));
                if(btn) btn.click();
            })()`
        })
    });

    await new Promise(r => setTimeout(r, 10000));

    // 4. Chụp ảnh kết quả xem nó sang trang Microsoft hay hiện ô Password
    const shot = await fetch(`${CAMOUFOX_API}/tabs/${tabId}/screenshot?userId=${DEBUG_USER}&sessionKey=${WORKER_AUTH_TOKEN}`);
    const shotPath = path.join(process.cwd(), 'data', 'screenshots', 'debug_hotmail_result.png');
    await fs.writeFile(shotPath, Buffer.from(await shot.arrayBuffer()));
    console.log(`📸 Screenshot: ${shotPath}`);

    // 5. Kết quả DOM
    const result = await fetch(`${CAMOUFOX_API}/tabs/${tabId}/evaluate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            userId: DEBUG_USER,
            sessionKey: WORKER_AUTH_TOKEN,
            expression: `({
                url: location.href,
                text: document.body.innerText.slice(0, 500),
                inputs: Array.from(document.querySelectorAll('input')).map(i => ({ type: i.type, name: i.name }))
            })`
        })
    }).then(r => r.json());

    console.log(JSON.stringify(result.result, null, 2));
}

step1_HotmailTest().catch(console.error);
