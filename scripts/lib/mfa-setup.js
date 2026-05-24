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
        const res = await apiHelper(`/tabs/${tabId}/evaluate`, { userId, expression: code });
        return res?.result;
    };

    try {
        // ── 1. Điều hướng đến Security settings và đảm bảo settings modal được mở ──────────────────
        log('Điều hướng đến Security settings...');
        
        // Cố gắng mở settings thông qua cả hash URL và direct path URL
        await run(`window.location.href = 'https://chatgpt.com/#settings/Security'`);
        await wait(3000);

        // Hàm helper chạy trong browser để tự động mở Settings dialog nếu chưa được mở
        log('Kiểm tra và tự động kích hoạt Settings modal...');
        await run(`
            (async () => {
                const isDialogOpen = () => {
                    const dialog = document.querySelector('[role="dialog"]');
                    if (!dialog) return false;
                    const text = (dialog.innerText || '').toLowerCase();
                    return text.includes('settings') || text.includes('cài đặt') || text.includes('security') || text.includes('bảo mật');
                };

                if (isDialogOpen()) return 'already_open';

                // Thử click Profile Button để mở user menu
                const profileBtn = document.querySelector('[data-testid="profile-button"], [data-testid="user-menu-button"], [aria-label="Open user menu"], button:has([alt*="avatar"]), button:has(img[src*="avatar"])');
                if (profileBtn) {
                    profileBtn.click();
                    await new Promise(r => setTimeout(r, 1000));
                    
                    // Tìm mục Settings/Cài đặt trong menu
                    const menuItems = Array.from(document.querySelectorAll('[role="menuitem"], button, a'));
                    const settingsItem = menuItems.find(el => {
                        const t = (el.textContent || '').trim().toLowerCase();
                        return t === 'settings' || t === 'cài đặt';
                    });
                    
                    if (settingsItem) {
                        settingsItem.click();
                        await new Promise(r => setTimeout(r, 1500));
                        return 'opened_via_profile';
                    }
                }
                
                // Nếu vẫn chưa mở được, thử redirect trực tiếp sang URL path-based settings
                window.location.href = 'https://chatgpt.com/settings/security';
                await new Promise(r => setTimeout(r, 2000));
                return 'fallback_navigate';
            })()
        `);

        // Đảm bảo Security tab active (tìm cả data-testid và text chứa Security/Bảo mật)
        const activeSecTab = await run(`
            (() => {
                let sec = document.querySelector('[data-testid="security-tab"]');
                if (!sec) {
                    sec = Array.from(document.querySelectorAll('[role="tab"], button, a')).find(el => {
                        const text = (el.textContent || '').toLowerCase().trim();
                        return text === 'security' || text === 'bảo mật';
                    });
                }
                if (sec) {
                    sec.click();
                    return true;
                }
                return false;
            })()
        `);
        
        if (!activeSecTab) {
            log('⚠️  Security tab không tìm thấy qua selector/text, chờ thêm...');
            await wait(2000);
        }
        await wait(1500);

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

        // ── 3. Click toggle "Authenticator app" hoặc nút Enable/Set up ──────────────────
        log('Click toggle/enable Authenticator app...');
        const toggled = await run(`
            (() => {
                // Tìm kiếm sâu nhất (deepest element matching text) để lấy text element chính xác
                const elements = Array.from(document.querySelectorAll('*'));
                const authTextEl = elements.find(el => {
                    const text = el.textContent || '';
                    if (!/authenticator\\s+app/i.test(text) && !/authenticator/i.test(text)) return false;
                    // Đảm bảo không có child nào cũng match (để lấy node lá)
                    return !Array.from(el.children).some(child => /authenticator/i.test(child.textContent || ''));
                });

                if (authTextEl) {
                    let par = authTextEl;
                    for (let d = 0; d < 8; d++) {
                        if (!par) break;
                        
                        // Phương án A: switch/checkbox toggle
                        const sw = par.querySelector('button[role="switch"], [role="switch"], input[type="checkbox"]');
                        if (sw) { 
                            sw.click(); 
                            return 'toggled_switch'; 
                        }
                        
                        // Phương án B: Nút Enable / Set up / Turn on / Bật
                        const btn = Array.from(par.querySelectorAll('button')).find(b => {
                            const bt = b.textContent.toLowerCase().trim();
                            return bt.includes('enable') || bt.includes('set up') || bt.includes('turn on') || bt.includes('bật') || bt.includes('thiết lập');
                        });
                        if (btn) { 
                            btn.click(); 
                            return 'clicked_enable_button'; 
                        }
                        
                        par = par.parentElement;
                    }
                }
                
                // Fallback: tất cả switch trong tabpanel Security
                const panels = document.querySelectorAll('[role="tabpanel"]');
                for (const p of panels) {
                    if ((p.innerText||'').toLowerCase().includes('authenticator')) {
                        const sw = p.querySelector('button[role="switch"]');
                        if (sw) { sw.click(); return 'toggled_fallback'; }
                    }
                }
                return 'not_found';
            })()
        `);
        log(`  Toggle result: ${toggled}`);

        if (toggled === 'not_found') {
            return { success: false, secret: null, totp: null, error: 'Toggle/Button Authenticator app not found' };
        }
        await wait(4000);

        // ── 4. Click "Trouble scanning?" để hiển thị text secret ──
        log('Click "Trouble scanning?"...');
        const trouble = await run(`
            (() => {
                const el = Array.from(document.querySelectorAll('a, button, span, p'))
                    .find(e => {
                        const t = e.textContent.toLowerCase();
                        return t.includes('trouble scanning') || 
                               t.includes('can\\'t scan') || 
                               t.includes('không thể quét') || 
                               t.includes('nhập khóa') ||
                               t.includes('nhập mã');
                    });
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
                    .map(el => {
                        const raw = el.textContent.trim();
                        const cleaned = raw.replace(/\\s+/g, '');
                        return { raw, cleaned };
                    })
                    .filter(item => /^[A-Z2-7]{16,64}$/i.test(item.cleaned));
                return candidates[0]?.cleaned || null;
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
                    'input[autocomplete="one-time-code"], input[maxlength="6"], input[placeholder*="code" i], input[placeholder*="Code"], input[inputmode="numeric"], input[type="text"]'
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
                .find(b => {
                    const t = b.textContent.trim().toLowerCase();
                    return t === 'verify' || t.includes('verify') || t.includes('xác minh');
                });
            if (btn) btn.click();
        `);
        await wait(5000);

        // ── 8. Kiểm tra kết quả ───────────────────────────────────
        const confirmed = await run(`
            document.body.innerText.includes('Authenticator app enabled') ||
            document.body.innerText.includes('enabled') ||
            document.body.innerText.includes('bật') ||
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
