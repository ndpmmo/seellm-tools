import { CAMOUFOX_API, WORKER_AUTH_TOKEN } from './config.js';
import fs from 'fs/promises';
import path from 'path';

async function step2_SubmitPassword() {
    const DEBUG_USER = 'debug_hotmail';
    const password = "Pass123456789!";

    // Tìm Tab hiện tại
    const tabsData = await fetch(`${CAMOUFOX_API}/tabs`).then(r => r.json());
    const tabsArray = Array.isArray(tabsData) ? tabsData : (tabsData.tabs || []);

    const targetTab = tabsArray.find(t => t.userId === DEBUG_USER || t.url?.includes('auth.openai.com'));
    const tabId = targetTab?.id || targetTab?.tabId;

    if (!tabId) {
        console.error("❌ Không tìm thấy Task đang mở. Data nhận được:", JSON.stringify(tabsData));
        return;
    }

    console.log(`🚀 [BƯỚC 2] Đang thử nhập Password vào Tab: ${tabId}`);

    const res = await fetch(`${CAMOUFOX_API}/tabs/${tabId}/evaluate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            userId: DEBUG_USER,
            sessionKey: WORKER_AUTH_TOKEN,
            expression: `(() => {
                const passInput = document.querySelector('input[type="password"]') || document.querySelector('input[name="hiddenPassword"]');
                if(!passInput) return "KHÔNG TÌM THẤY Ô PASSWORD";
                
                passInput.focus();
                passInput.value = "${password}";
                passInput.dispatchEvent(new Event('input', { bubbles: true }));
                
                const btn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('Create account') || b.innerText.includes('Next') || b.innerText.includes('Continue'));
                if(btn) {
                    btn.click();
                    return "Đã điền Pass và Bấm Submit";
                }
                return "Tìm thấy Pass nhưng không thấy Nút bấm";
            })()`
        })
    }).then(r => r.json());

    console.log("Result:", res.result);
}

step2_SubmitPassword().catch(console.error);
