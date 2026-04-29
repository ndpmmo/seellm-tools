
import { resolve } from 'path';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { createHmac } from 'crypto';
import { CAMOUFOX_API, WORKER_AUTH_TOKEN } from './config.js';

const SESSION_ID = 'mfa_test_' + Date.now();
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

function getTOTP(secret) {
    const base32tohex = (base32) => {
        const base32chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
        let bits = '', hex = '';
        const clean = base32.replace(/\s/g, '').toUpperCase();
        for (let i = 0; i < clean.length; i++) {
            const val = base32chars.indexOf(clean.charAt(i));
            if (val === -1) continue;
            bits += val.toString(2).padStart(5, '0');
        }
        for (let i = 0; i + 4 <= bits.length; i += 4) hex += parseInt(bits.substr(i, 4), 2).toString(16);
        return hex;
    };
    const key = base32tohex(secret);
    const epoch = Math.round(Date.now() / 1000);
    const time = Buffer.from(Math.floor(epoch / 30).toString(16).padStart(16, '0'), 'hex');
    const hmac = createHmac('sha1', Buffer.from(key, 'hex'));
    const h = hmac.update(time).digest();
    const offset = h[h.length - 1] & 0xf;
    const otp = (h.readUInt32BE(offset) & 0x7fffffff) % 1000000;
    return otp.toString().padStart(6, '0');
}

async function runMfaTest() {
    console.log(`[1] Mở Dashboard ChatGPT với Session hiện có (USER_ID: ${USER_ID})...`);
    const { tabId } = await api('/tabs', { userId: USER_ID, url: 'https://chatgpt.com/', headless: false });
    
    await new Promise(r => setTimeout(r, 10000));

    console.log(`[2] Cài đặt Sniffer để bắt Endpoint MFA...`);
    await api(`/tabs/${tabId}/evaluate`, {
        userId: USER_ID,
        expression: `
            (() => {
                window._mfaLog = [];
                const originalFetch = window.fetch;
                window.fetch = async (...args) => {
                    const url = args[0].toString();
                    if (url.includes('mfa') || url.includes('sett') || url.includes('auth')) {
                        window._mfaLog.push({
                            url,
                            method: args[1]?.method || 'GET',
                            body: args[1]?.body
                        });
                    }
                    return originalFetch(...args);
                };
                console.log('Sniffer Active');
            })()
        `
    });

    console.log(`Bây giờ hãy thực hiện thao tác Settings -> Security -> Enable MFA trên trình duyệt Camoufox.`);
    console.log(`Đang chờ 60 giây để bạn thao tác...`);
    
    // Tăng thời gian chờ để subagent hoặc user thao tác
    for(let i=0; i<12; i++) {
        await new Promise(r => setTimeout(r, 5000));
        const check = await api(`/tabs/${tabId}/evaluate`, {
            userId: USER_ID,
            expression: `window._mfaLog`
        });
        if (check.result && check.result.length > 0) {
            console.log("!!! PHÁT HIỆN REQUEST MỚI !!!");
            console.log(JSON.stringify(check.result, null, 2));
        }
    }

    console.log("Kết thúc phiên sniffing.");
    process.exit(0);
}

runMfaTest().catch(console.error);
