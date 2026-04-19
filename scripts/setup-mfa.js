/**
 * setup-mfa.js
 * Luồng đầy đủ:
 * 1. Đăng nhập ChatGPT (email + password + OTP email)
 * 2. Vào Settings > Security
 * 3. Toggle "Authenticator app" → "Trouble scanning?" → lấy Secret Key
 * 4. Tạo TOTP từ Secret Key → Verify
 * 5. In Secret Key ra màn hình
 */

import { resolve } from 'path';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { createHmac } from 'crypto';
import { waitForOTPCode } from './lib/ms-graph-email.js';
import { CAMOUFOX_API, WORKER_AUTH_TOKEN } from './config.js';

// ─── Credentials ─────────────────────────────────────────────
const EMAIL        = 'darrylbridgetlagan7432@hotmail.com';
const PASSWORD     = 'fGc47RzY3lXwuoNP';  // ChatGPT password
const REFRESH_TOKEN = 'M.C507_BAY.0.U.-CrE9G5K5jngpnDATXMFdzj82!B5BgVy7HoVJK*r!oWUfNApucAbnmB5u52fX44f7neRWiakEs2OplWxJUritfnKG4oT7Gf*fMFheJiKWIuUvw6vljYpJX8E1C3AmaNebDth8p3IFLie774vYSDg3S7chc9BLV0P2Uqf6IxgQtRC2zVKKxEqDjaVDAS0zUT1jPVFzcEy67C2F*CMlupTEIwWP1zezA9tRs*c6EtYVVYkJmRshLxU42b7Wc3cN34bTeeWTxWNlrxooM*2sakAlynDunMiy3BmqRhNB39T4U30cxYSbGGmcSwB4e!Dgdo12cVaZcCLOyFNU!4oa2eDyaXTvYo1f3bxfT1Wq7tYxHHtV0*bSD44Zd7P1LYlZkKtQXg$';
const CLIENT_ID    = '9e5f94bc-e8a4-4e73-b8be-63364c29d753';
const USER_ID      = 'mfa_' + Date.now();

// ─── Screenshot dir ───────────────────────────────────────────
const SS_DIR = resolve('data', 'screenshots', 'mfa_setup_' + Date.now());
if (!existsSync(SS_DIR)) mkdirSync(SS_DIR, { recursive: true });

// ─── TOTP (RFC 6238) ──────────────────────────────────────────
function generateTOTP(secret) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = '';
    for (const c of secret.toUpperCase().replace(/=+$/, '')) {
        const v = alphabet.indexOf(c);
        if (v < 0) continue;
        bits += v.toString(2).padStart(5, '0');
    }
    const bytes = [];
    for (let i = 0; i + 8 <= bits.length; i += 8)
        bytes.push(parseInt(bits.slice(i, i + 8), 2));

    const counter = Math.floor(Date.now() / 1000 / 30);
    const cb = Buffer.alloc(8);
    cb.writeBigInt64BE(BigInt(counter));
    const hmac = createHmac('sha1', Buffer.from(bytes)).update(cb).digest();
    const off = hmac[hmac.length - 1] & 0xf;
    const code = ((hmac[off] & 0x7f) << 24 | hmac[off+1] << 16 | hmac[off+2] << 8 | hmac[off+3]) % 1_000_000;
    return code.toString().padStart(6, '0');
}

// ─── Camoufox API ─────────────────────────────────────────────
async function api(path, body = null) {
    const sep = path.includes('?') ? '&' : '?';
    const url = `${CAMOUFOX_API}${path}${sep}sessionKey=${WORKER_AUTH_TOKEN}`;
    const res = await fetch(url, {
        method: body ? 'POST' : 'GET',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify({ ...body, sessionKey: WORKER_AUTH_TOKEN }) : undefined
    });
    if (path.includes('screenshot')) return res.arrayBuffer();
    return res.json();
}

async function shot(tid, name) {
    const buf = await api(`/tabs/${tid}/screenshot?userId=${USER_ID}&fullPage=false`);
    writeFileSync(resolve(SS_DIR, `${name}.png`), Buffer.from(buf));
    console.log(`  📸 ${name}.png`);
}

async function run(tid, code) {
    const r = await api(`/tabs/${tid}/eval`, { userId: USER_ID, expression: code });
    return r?.result;
}

const wait = ms => new Promise(r => setTimeout(r, ms));

// ─── React-safe input setter ──────────────────────────────────
function reactSet(selector, value) {
    return `
    (() => {
        const el = document.querySelector('${selector}');
        if (!el) return false;
        const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        s.call(el, ${JSON.stringify(value)});
        el.dispatchEvent(new Event('input',  { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    })()`;
}

// ─── Main ─────────────────────────────────────────────────────
async function main() {
    console.log('\n=== ChatGPT MFA Setup ===\n');

    // ── Bước 1: Mở trang login ────────────────────────────────
    console.log('[1] Mở trang ChatGPT login...');
    const { tabId } = await api('/tabs', {
        userId: USER_ID,
        url: 'https://chatgpt.com/auth/login?prompt=login',
        headless: false
    });
    await wait(8000);
    await shot(tabId, '01_login_page');

    // ── Bước 2: Click nút Log in ──────────────────────────────
    console.log('[2] Click Log in...');
    await run(tabId, `
        const btn = Array.from(document.querySelectorAll('button'))
            .find(b => b.textContent.includes('Log in') || b.textContent.includes('Đăng nhập'));
        if (btn) btn.click();
    `);
    await wait(6000);
    await shot(tabId, '02_auth0');

    // ── Bước 3: Nhập email ────────────────────────────────────
    console.log('[3] Nhập email...');
    await run(tabId, reactSet('input[name="username"], input[name="email"], input[type="email"]', EMAIL));
    await wait(500);
    await run(tabId, `
        const btn = Array.from(document.querySelectorAll('button'))
            .find(b => b.textContent.includes('Continue') && !b.textContent.toLowerCase().includes('with'));
        if (btn) btn.click();
    `);
    await wait(5000);
    await shot(tabId, '03_password_step');

    // ── Bước 4: Nhập password ─────────────────────────────────
    console.log('[4] Nhập password...');
    await run(tabId, reactSet('input[name="password"], input[type="password"]', PASSWORD));
    await wait(500);
    await run(tabId, `
        const btn = Array.from(document.querySelectorAll('button'))
            .find(b => b.textContent.includes('Continue') && !b.textContent.toLowerCase().includes('with'));
        if (btn) btn.click();
    `);
    await wait(8000);
    await shot(tabId, '04_after_password');

    // ── Bước 5: Xử lý OTP email (nếu có) ─────────────────────
    const needOtp = await run(tabId, `
        document.body.innerText.toLowerCase().includes('verify') ||
        document.body.innerText.toLowerCase().includes('check your inbox') ||
        document.body.innerText.toLowerCase().includes('confirmation code')
    `);
    if (needOtp) {
        console.log('[5] Đang chờ OTP từ hộp thư...');
        const otpCode = await waitForOTPCode({
            email: EMAIL,
            refreshToken: REFRESH_TOKEN,
            clientId: CLIENT_ID,
            senderDomain: 'openai.com',
            maxWaitSecs: 90
        });
        if (!otpCode) {
            console.error('❌ Không lấy được OTP sau 90 giây!');
            await shot(tabId, '05_otp_timeout');
            process.exit(1);
        }
        console.log(`[5.1] OTP nhận được: ${otpCode}`);
        await run(tabId, reactSet('input[name="code"], input[autocomplete="one-time-code"]', otpCode));
        await wait(500);
        await run(tabId, `
            const btn = Array.from(document.querySelectorAll('button'))
                .find(b => b.textContent.includes('Continue') && !b.textContent.toLowerCase().includes('with'));
            if (btn) btn.click();
        `);
        await wait(8000);
        await shot(tabId, '05_after_otp');
    }

    // ── Bước 6: Đợi Dashboard load đầy đủ ────────────────────
    console.log('[6] Đợi dashboard...');
    await wait(6000);
    await shot(tabId, '06_dashboard');

    // ── Bước 7: Điều hướng đến Security settings ─────────────
    console.log('[7] Mở Settings > Security...');
    await run(tabId, `window.location.href = 'https://chatgpt.com/#settings/Security'`);
    await wait(5000);
    await shot(tabId, '07_security_page');

    // Kiểm tra đã vào đúng trang chưa
    const hasSecurityTab = await run(tabId, `!!document.querySelector('[data-testid="security-tab"]')`);
    if (!hasSecurityTab) {
        console.log('  ⚠️  Security tab chưa hiện, thử click vào Security trong menu...');
        // Thử click qua menu
        await run(tabId, `
            const btn = document.querySelector('button[aria-label="Profile"]') ||
                        Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Settings');
            if (btn) btn.click();
        `);
        await wait(2000);
        await run(tabId, `
            const sec = document.querySelector('[data-testid="security-tab"]');
            if (sec) sec.click();
        `);
        await wait(2000);
        await shot(tabId, '07b_security_retry');
    }

    // Ensure Security tab is clicked
    await run(tabId, `
        const sec = document.querySelector('[data-testid="security-tab"]');
        if (sec) sec.click();
    `);
    await wait(2000);

    // ── Bước 8: Cài sniffer ───────────────────────────────────
    console.log('[8] Cài network sniffer...');
    await run(tabId, `
        window._mfaLog = [];
        const _orig = window.fetch;
        window.fetch = async (...a) => {
            const url = (a[0]?.url || a[0] || '').toString();
            if (/mfa|totp|authenticator|two.factor/i.test(url)) {
                window._mfaLog.push({ url, method: a[1]?.method || 'GET', body: a[1]?.body });
            }
            return _orig(...a);
        };
    `);

    // ── Bước 9: Click toggle "Authenticator app" ──────────────
    console.log('[9] Click toggle Authenticator app...');
    const toggled = await run(tabId, `
        (() => {
            // Tìm phần nội dung Security (tabpanel đang active hoặc bất kỳ)
            const panels = document.querySelectorAll('[role="tabpanel"]');
            for (const panel of panels) {
                const text = panel.innerText || '';
                if (text.includes('Authenticator app') || text.includes('Multi-factor')) {
                    const sw = panel.querySelector('button[role="switch"]');
                    if (sw) { sw.click(); return true; }
                }
            }
            // Fallback: tìm switch đầu tiên sau text "Authenticator app"
            const allEls = Array.from(document.querySelectorAll('*'));
            const idx = allEls.findIndex(el => el.childElementCount === 0 && el.textContent.trim() === 'Authenticator app');
            if (idx >= 0) {
                for (let i = idx; i < Math.min(idx + 20, allEls.length); i++) {
                    if (allEls[i].matches('button[role="switch"]')) {
                        allEls[i].click(); return true;
                    }
                }
                // đi lên tìm parent
                let par = allEls[idx].parentElement;
                for (let d = 0; d < 6; d++) {
                    if (!par) break;
                    const sw = par.querySelector('button[role="switch"]');
                    if (sw) { sw.click(); return true; }
                    par = par.parentElement;
                }
            }
            return false;
        })()
    `);
    console.log(`  Toggle clicked: ${toggled}`);
    await wait(4000);
    await shot(tabId, '09_authenticator_modal');

    // ── Bước 10: Click "Trouble scanning?" ───────────────────
    console.log('[10] Click "Trouble scanning?"...');
    const clickedTrouble = await run(tabId, `
        (() => {
            const el = Array.from(document.querySelectorAll('a, button, span, p'))
                .find(e => e.textContent.toLowerCase().includes('trouble scanning'));
            if (el) { el.click(); return 'clicked'; }
            return 'not_found';
        })()
    `);
    console.log(`  Trouble scanning: ${clickedTrouble}`);
    await wait(2500);
    await shot(tabId, '10_secret_key_page');

    // ── Bước 11: Đọc secret key ───────────────────────────────
    console.log('[11] Đọc Secret Key...');
    // Secret là chuỗi Base32: chỉ gồm A-Z và 2-7, thường > 16 ký tự
    const secretKey = await run(tabId, `
        const candidates = Array.from(document.querySelectorAll('*'))
            .filter(el => el.childElementCount === 0)
            .map(el => el.textContent.trim())
            .filter(t => /^[A-Z2-7]{16,}$/.test(t));
        candidates[0] || null
    `);

    if (!secretKey) {
        // Dump dialog để debug
        const dialogText = await run(tabId, `document.querySelector('[role="dialog"]')?.innerText`);
        console.error('❌ Không tìm thấy Secret Key!');
        console.log('  Dialog content:\n', dialogText);
        await shot(tabId, '11_debug_no_secret');
        process.exit(1);
    }
    console.log(`\n  ✅ SECRET KEY: ${secretKey}\n`);

    // ── Bước 12: Tạo OTP từ secret key ───────────────────────
    const totp = generateTOTP(secretKey);
    console.log(`[12] TOTP: ${totp}`);

    // ── Bước 13: Điền TOTP vào input ─────────────────────────
    console.log('[13] Điền TOTP...');
    await run(tabId, reactSet(
        'input[placeholder*="code"], input[placeholder*="Code"], input[type="text"], input[inputmode="numeric"]',
        totp
    ));
    await wait(1000);
    await shot(tabId, '13_totp_filled');

    // ── Bước 14: Click Verify ─────────────────────────────────
    console.log('[14] Click Verify...');
    await run(tabId, `
        const btn = Array.from(document.querySelectorAll('button'))
            .find(b => b.textContent.trim().toLowerCase() === 'verify');
        if (btn) btn.click();
    `);
    await wait(5000);
    await shot(tabId, '14_after_verify');

    // ── Kết quả ───────────────────────────────────────────────
    const netLogs = JSON.parse(await run(tabId, 'JSON.stringify(window._mfaLog)') || '[]');
    if (netLogs.length > 0) {
        console.log('\n📡 Network requests bắt được:');
        netLogs.forEach(l => console.log('  ', l.method, l.url));
    }

    console.log('\n════════════════════════════════════');
    console.log('✅ MFA Secret Key:', secretKey);
    console.log('   Screenshots   :', SS_DIR);
    console.log('════════════════════════════════════\n');
    process.exit(0);
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
