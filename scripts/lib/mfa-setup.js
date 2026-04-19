/**
 * lib/mfa-setup.js
 *
 * Module cài đặt 2FA (MFA Authenticator App) cho tài khoản ChatGPT.
 * Đã được kiểm thử thực tế: đăng nhập → Security → Toggle → Trouble scanning → Secret → TOTP → Verify
 *
 * Export:
 *   setupMFA(tabId, userId, apiHelper, options?) → Promise<{ success, secret, totp }>
 *
 * Param:
 *   tabId      - ID tab của Camoufox (đã ở trang chatgpt.com)
 *   userId     - userId dùng để eval trong Camoufox
 *   apiHelper  - async function(path, body?) trả về json/buffer (giống hàm api() trong các script khác)
 *   options    - { debug: bool, waitFn: async(ms)=>void }
 */

import { createHmac } from 'node:crypto';

// ── TOTP Generator (RFC 6238) ─────────────────────────────────────────────────
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

// ── Main export ───────────────────────────────────────────────────────────────
/**
 * @param {string} tabId
 * @param {string} userId
 * @param {Function} apiHelper  - async (path, body?) => json
 * @param {{ debug?: boolean }} [options]
 * @returns {Promise<{ success: boolean, secret: string|null, totp: string|null, error?: string }>}
 */
export async function setupMFA(tabId, userId, apiHelper, options = {}) {
    const log = (...args) => console.log('[MFA]', ...args);
    const wait = ms => new Promise(r => setTimeout(r, ms));

    const run = async (code) => {
        const res = await apiHelper(`/tabs/${tabId}/eval`, { userId, expression: code });
        return res?.result;
    };

    try {
        // ── 1. Điều hướng đến Security settings ──────────────────
        log('Điều hướng đến #settings/Security ...');
        await run(`window.location.href = 'https://chatgpt.com/#settings/Security'`);
        await wait(5000);

        // Đảm bảo Security tab active (dùng data-testid ổn định)
        const hasSecTab = await run(`!!document.querySelector('[data-testid="security-tab"]')`);
        if (!hasSecTab) {
            log('⚠️  Security tab không tìm thấy, thử lại...');
            await wait(3000);
        }
        await run(`
            const sec = document.querySelector('[data-testid="security-tab"]');
            if (sec) sec.click();
        `);
        await wait(2000);

        // ── 2. Cài network sniffer (để debug nếu cần) ─────────────
        await run(`
            window._mfaLog = [];
            const _orig = window.fetch;
            window.fetch = async (...a) => {
                const url = (a[0]?.url || a[0] || '').toString();
                if (/mfa|totp|authenticator|two.factor/i.test(url))
                    window._mfaLog.push({ url, method: a[1]?.method || 'GET' });
                return _orig(...a);
            };
        `);

        // ── 3. Click toggle "Authenticator app" ──────────────────
        log('Click toggle Authenticator app...');
        const toggled = await run(`
            (() => {
                const allEls = Array.from(document.querySelectorAll('*'));
                const idx = allEls.findIndex(el =>
                    el.childElementCount === 0 && el.textContent.trim() === 'Authenticator app'
                );
                if (idx >= 0) {
                    let par = allEls[idx].parentElement;
                    for (let d = 0; d < 8; d++) {
                        if (!par) break;
                        const sw = par.querySelector('button[role="switch"]');
                        if (sw) { sw.click(); return 'toggled'; }
                        par = par.parentElement;
                    }
                }
                // Fallback: tất cả switch trong tabpanel Security
                const panels = document.querySelectorAll('[role="tabpanel"]');
                for (const p of panels) {
                    if ((p.innerText||'').includes('Authenticator')) {
                        const sw = p.querySelector('button[role="switch"]');
                        if (sw) { sw.click(); return 'toggled_fallback'; }
                    }
                }
                return 'not_found';
            })()
        `);
        log(`  Toggle: ${toggled}`);

        if (toggled === 'not_found') {
            return { success: false, secret: null, totp: null, error: 'Toggle Authenticator app not found' };
        }
        await wait(4000);

        // ── 4. Click "Trouble scanning?" để hiển thị text secret ──
        log('Click "Trouble scanning?"...');
        const trouble = await run(`
            (() => {
                const el = Array.from(document.querySelectorAll('a, button, span, p'))
                    .find(e => e.textContent.toLowerCase().includes('trouble scanning'));
                if (el) { el.click(); return 'clicked'; }
                return 'not_found';
            })()
        `);
        log(`  Trouble scanning: ${trouble}`);
        await wait(2500);

        // ── 5. Đọc secret key từ DOM ──────────────────────────────
        log('Đọc Secret Key từ DOM...');
        const secret = await run(`
            (() => {
                const candidates = Array.from(document.querySelectorAll('*'))
                    .filter(el => el.childElementCount === 0)
                    .map(el => el.textContent.trim())
                    .filter(t => /^[A-Z2-7]{16,}$/.test(t));
                return candidates[0] || null;
            })()
        `);

        if (!secret) {
            const dialogText = await run(`document.querySelector('[role="dialog"]')?.innerText?.slice(0, 300)`);
            log('❌ Không tìm thấy Secret Key. Dialog:', dialogText);
            return { success: false, secret: null, totp: null, error: `Secret key not found. Dialog: ${dialogText}` };
        }
        log(`✅ Secret Key: ${secret}`);

        // ── 6. Tạo TOTP và điền vào input ────────────────────────
        const totp = generateTOTP(secret);
        log(`TOTP: ${totp}`);

        await run(`
            (() => {
                const input = document.querySelector(
                    'input[placeholder*="code"], input[placeholder*="Code"], input[inputmode="numeric"], input[type="text"]'
                );
                if (!input) return false;
                const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                s.call(input, ${JSON.stringify(totp)});
                input.dispatchEvent(new Event('input',  { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
                return true;
            })()
        `);
        await wait(800);

        // ── 7. Click Verify ───────────────────────────────────────
        log('Click Verify...');
        await run(`
            const btn = Array.from(document.querySelectorAll('button'))
                .find(b => b.textContent.trim().toLowerCase() === 'verify');
            if (btn) btn.click();
        `);
        await wait(5000);

        // ── 8. Kiểm tra kết quả ───────────────────────────────────
        const confirmed = await run(`
            document.body.innerText.includes('Authenticator app enabled') ||
            document.querySelector('[data-testid="security-tab"]')?.innerText?.includes('Authenticator app enabled') ||
            !!document.querySelector('[aria-label*="enabled"]')
        `);

        if (confirmed) {
            log('🎉 MFA Authenticator app enabled thành công!');
            return { success: true, secret, totp };
        }

        // Kiểm tra thêm qua screenshot nội dung trang
        const pageText = await run(`document.body.innerText.slice(0, 500)`);
        const likelySuccess = pageText?.includes('Authenticator app') && !pageText?.includes('Enter your 6-digit');
        log(likelySuccess ? '✅ Có vẻ thành công (dựa trên nội dung trang)' : '⚠️ Chưa xác nhận được kết quả');

        return { success: likelySuccess, secret, totp };

    } catch (err) {
        return { success: false, secret: null, totp: null, error: err.message };
    }
}
