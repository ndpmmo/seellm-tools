
import { resolve } from 'path';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { CAMOUFOX_API, WORKER_AUTH_TOKEN } from './config.js';

const SESSION_ID = 'mfa_ui_' + Date.now();
const USER_ID = 'test_user'; // Dùng lại session cũ

const DATA_DIR = resolve('data', 'screenshots', SESSION_ID);
if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
}

async function api(path, reqBody = {}) {
    const isGet = !reqBody || Object.keys(reqBody).length === 0;
    let finalPath = path + (path.includes('?') ? '&' : '?') + `sessionKey=${WORKER_AUTH_TOKEN}`;

    const res = await fetch(`${CAMOUFOX_API}${finalPath}`, {
        method: isGet ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: isGet ? undefined : JSON.stringify({ ...reqBody, sessionKey: WORKER_AUTH_TOKEN })
    });

    if (path.includes('screenshot')) return res.arrayBuffer();
    return res.json();
}

async function takeScreenshot(tabId, name) {
    try {
        const buf = await api(`/tabs/${tabId}/screenshot?userId=${USER_ID}&fullPage=true`);
        writeFileSync(resolve(DATA_DIR, `${name}.png`), Buffer.from(buf));
        console.log(`📸 Screenshot: ${name}.png`);
    } catch (e) {
        console.error("Lỗi chụp ảnh:", e.message);
    }
}

async function dumpDom(tabId, name) {
    try {
        const res = await api(`/tabs/${tabId}/eval`, { userId: USER_ID, expression: 'document.body.innerHTML' });
        writeFileSync(resolve(DATA_DIR, `${name}_dom.html`), res.result || '');
        console.log(`📝 Dumped DOM: ${name}_dom.html`);
    } catch (e) {
        console.error("Lỗi Dump DOM:", e.message);
    }
}

async function evalCode(tabId, code) {
    const res = await api(`/tabs/${tabId}/eval`, { userId: USER_ID, expression: code });
    return res.result;
}

async function runMfaUI() {
    console.log(`[1] Mở Dashboard ChatGPT với Session hiện hành...`);
    const { tabId } = await api('/tabs', { userId: USER_ID, url: 'https://chatgpt.com/', headless: false });

    console.log(`Đợi 8s cho load xong...`);
    await new Promise(r => setTimeout(r, 8000));
    await takeScreenshot(tabId, '01_dashboard');

    console.log(`[2] Cài đặt Network Sniffer nội bộ trước khi click...`);
    await evalCode(tabId, `
        window._mfaLog = [];
        const originalFetch = window.fetch;
        window.fetch = async (...args) => {
            const url = args[0].toString();
            if (url.includes('mfa') || url.includes('sett') || url.includes('auth')) {
                window._mfaLog.push({ url, method: args[1]?.method || 'GET' });
            }
            return originalFetch(...args);
        };
    `);

    console.log(`[3] Phân tích và Click từng bước một cách an toàn...`);
    await evalCode(tabId, `
        async function run() {
            const clickByText = (text) => {
                const el = Array.from(document.querySelectorAll('button, div, span, a, label, h3')).find(e => 
                    e.textContent.trim().toLowerCase() === text.toLowerCase()
                );
                if (el) { el.click(); return true; }
                return false;
            };

            // Mở profile
            const profile = document.querySelector('button[id*="user-menu"], .avatar-small');
            if (profile) profile.click();
            
            await new Promise(r => setTimeout(r, 1000));
            // Settings
            clickByText('Settings') || clickByText('Cài đặt');

            await new Promise(r => setTimeout(r, 2000));
            // Security
            clickByText('Security') || clickByText('Bảo mật');

            await new Promise(r => setTimeout(r, 2000));
            // Enable
            const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Enable') || b.textContent.includes('Bật'));
            if(btn) btn.click();
        }
        run();
    `);
    
    await new Promise(r => setTimeout(r, 10000));
    await takeScreenshot(tabId, '05_final_click_result');

    console.log(`[4] Đọc logs gọi mạng xem có request nào không...`);
    const logs = await evalCode(tabId, 'window._mfaLog');
    console.log("Network Logs:", JSON.stringify(logs, null, 2));

    console.log(`Hoàn thành Script Dò đường! Xem thư mục Screenshots.`);
    process.exit(0);
}

runMfaUI().catch(console.error);
