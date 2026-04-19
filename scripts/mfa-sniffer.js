
import { resolve } from 'path';
import { writeFileSync, mkdirSync, existsSync, appendFileSync } from 'fs';
import { CAMOUFOX_API, WORKER_AUTH_TOKEN } from './config.js';

const USER_ID = 'test_user';
const SESSION_ID = 'sniffer_' + Date.now();
const LOG_FILE = resolve('data', 'mfa_sniffer_log.json');

async function api(path, reqBody = {}) {
    try {
        const isGet = !reqBody || Object.keys(reqBody).length === 0;
        let finalPath = path + (path.includes('?') ? '&' : '?') + `sessionKey=${WORKER_AUTH_TOKEN}`;

        const res = await fetch(`${CAMOUFOX_API}${finalPath}`, {
            method: isGet ? 'GET' : 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: isGet ? undefined : JSON.stringify({ ...reqBody, sessionKey: WORKER_AUTH_TOKEN })
        });
        return res.json();
    } catch (e) {
        console.error(`API Error (${path}):`, e.message);
        return { error: e.message };
    }
}

async function startSniffing() {
    console.log("🚀 Khởi động Sniffer...");
    const { tabId } = await api('/tabs', { userId: USER_ID, url: 'https://chatgpt.com/', headless: false });
    if (!tabId) {
        console.error("Không thể tạo tab.");
        process.exit(1);
    }
    console.log(`Tab ID: ${tabId}`);

    await new Promise(r => setTimeout(r, 12000));

    await api(`/tabs/${tabId}/eval`, {
        userId: USER_ID,
        expression: `
            window._mfaLog = [];
            const originalFetch = window.fetch;
            window.fetch = async (...args) => {
                const url = args[0].toString();
                if (url.includes('mfa') || url.includes('setup') || url.includes('verify')) {
                    const entry = { ts: new Date().toISOString(), url, method: args[1]?.method || 'GET' };
                    window._mfaLog.push(entry);
                }
                return originalFetch(...args);
            };
            console.log('Sniffer ready');
        `
    });

    console.log("Hệ thống đang nghe... Hãy thực hiện thao tác trên Dashboard Camoufox (Settings -> Security -> Enable MFA)");

    // Chạy trong 2 phút
    for (let i = 0; i < 24; i++) {
        await new Promise(r => setTimeout(r, 5000));
        const res = await api(`/tabs/${tabId}/eval`, {
            userId: USER_ID,
            expression: `window._mfaLog`
        });

        if (res.result && res.result.length > 0) {
            console.log(`Bắt được ${res.result.length} requests!`);
            writeFileSync(LOG_FILE, JSON.stringify(res.result, null, 2));
            // Nếu đã bắt được, ta có thể dừng hoặc chạy tiếp
        } else {
            console.log(`[${i}] Đang chờ...`);
        }
    }

    console.log("Kết thúc. Kiểm tra file:", LOG_FILE);
    process.exit(0);
}

startSniffing();
