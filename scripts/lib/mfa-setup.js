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
import { waitForOTPCode } from './ms-graph-email.js';

// ── Identity Verification (Email OTP) Bypass ──────────────────────────────────
async function handleEmailOTPVerification(tabId, userId, apiHelper, email, emailCreds, log, wait, run) {
    const isVerifyIdentity = await run(`(() => {
        const isAuthPage = window.location.hostname.includes('auth.openai.com') || window.location.pathname.includes('/auth/');
        const container = isAuthPage ? document.body : (() => {
            const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
            return dialogs[dialogs.length - 1] || null;
        })();
        if (!container) return false;
        
        const text = container.innerText.toLowerCase();
        
        // Tránh trùng khớp với hộp thoại thiết lập Authenticator app/MFA setup
        const isMfaSetupDialog = text.includes('authenticator') || 
                                 text.includes('trouble scanning') || 
                                 text.includes('can\\'t scan') || 
                                 text.includes('không thể quét') || 
                                 text.includes('nhập khóa') ||
                                 text.includes('qr code') ||
                                 text.includes('mã qr');
        if (isMfaSetupDialog) return false;
        
        // Kiểm tra các cụm từ đặc trưng chỉ xuất hiện khi có thử thách xác minh danh tính
        const hasVerifyTitle = text.includes('verify your identity') || text.includes('xác minh danh tính');
        const hasInboxMsg = text.includes('check your inbox') || text.includes('hộp thư đến') || text.includes('we sent a code') || text.includes('sent a code');
        const hasEmailKeywords = text.includes('email') || text.includes('inbox') || text.includes('hộp thư') || text.includes('@');
        
        const hasOtpPrompt = text.includes('nhập mã xác minh') || 
                             /enter the (verification )?code/i.test(text) || 
                             /enter the 6-digit/i.test(text) ||
                             (text.includes('verification code') && (text.includes('sent to') || text.includes('đã gửi')));
                             
        // Có ô nhập code hoặc nút tiếp tục/gửi mã trong bối cảnh xác minh danh tính
        const hasOtpInput = !!container.querySelector('input[autocomplete="one-time-code"], input[maxlength="6"], input[inputmode="numeric"]');
        
        return (hasVerifyTitle || hasInboxMsg || (hasOtpPrompt && hasEmailKeywords)) && 
               (hasOtpInput || text.includes('continue') || text.includes('tiếp tục') || text.includes('send code') || text.includes('gửi mã'));
    })()`);

    if (isVerifyIdentity) {
        log('📬 Phát hiện yêu cầu xác minh danh tính qua email!');
        if (!emailCreds || (!emailCreds.refreshToken && !emailCreds.refresh_token)) {
            throw new Error(`Cần xác minh danh tính qua email nhưng không tìm thấy refresh token trong email pool!`);
        }
        
        // Kiểm tra xem đã có ô nhập mã chưa. Nếu chưa có, có thể cần click Continue để kích hoạt gửi mail.
        const hasCodeInput = await run(`!!document.querySelector('input[autocomplete="one-time-code"], input[maxlength="6"], input[inputmode="numeric"]')`);
        if (!hasCodeInput) {
            log('Chưa thấy ô nhập OTP. Đang tìm nút Tiếp tục/Gửi mã...');
            const clickResult = await run(`(() => {
                const buttons = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]'));
                const targetBtn = buttons.find(b => {
                    const t = (b.textContent || b.value || '').toLowerCase().trim();
                    return t === 'continue' || t === 'send code' || t.includes('email code') || t === 'tiếp tục' || t.includes('gửi mã');
                }) || buttons.find(b => {
                    const t = (b.textContent || b.value || '').toLowerCase().trim();
                    return t.includes('continue') || t.includes('tiếp tục');
                });
                
                if (targetBtn) {
                    targetBtn.click();
                    return true;
                }
                return false;
            })()`);
            if (clickResult) {
                log('Đã click nút gửi mã xác minh. Chờ 5 giây để trang gửi email và hiển thị ô nhập...');
                await wait(5000);
            } else {
                log('⚠️ Không tìm thấy nút gửi mã xác minh danh tính.');
            }
        }
        
        // Trừ 5 phút để tránh lệch múi giờ/đồng hồ giữa local và Microsoft Exchange Server
        const otpCheckStartTime = new Date(Date.now() - 5 * 60 * 1000);
        log('Đang truy vấn hộp thư để lấy mã OTP...');
        const otpCode = await waitForOTPCode({
            email: email,
            refreshToken: emailCreds.refreshToken || emailCreds.refresh_token,
            clientId: emailCreds.clientId || emailCreds.client_id,
            senderDomain: 'openai.com',
            maxWaitSecs: 120,
            minTime: otpCheckStartTime
        });

        if (!otpCode) {
            throw new Error(`Không lấy được mã OTP xác minh email từ hộp thư!`);
        }

        log(`🔢 Lấy được mã OTP: ${otpCode}. Tiến hành điền và xác minh...`);
        const fillSuccess = await run(`((code) => {
            const input = document.querySelector('input[autocomplete="one-time-code"], input[maxlength="6"], input[inputmode="numeric"]');
            if (input) {
                const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                nativeSetter.call(input, code);
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
                return true;
            }
            return false;
        })("${otpCode}")`);

        if (fillSuccess) {
            await wait(2000);
            // Click Continue button if not auto-submitted
            await run(`(() => {
                const btn = Array.from(document.querySelectorAll('button')).find(b => {
                    const t = b.textContent.toLowerCase().trim();
                    return t.includes('continue') || t.includes('submit') || t.includes('tiếp tục');
                });
                if (btn) btn.click();
            })()`);
            log('Đợi xác minh hoàn tất và kích hoạt lại tab Security...');
            await wait(6000);

            // Click Security tab to switch back from General tab!
            await run(`(() => {
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
            })()`);
            await wait(3000);

            // Re-trigger the switch toggle!
            log('Kích hoạt lại toggle 2FA sau khi xác minh xong...');
            const reToggled = await run(`
                (() => {
                    const elements = Array.from(document.querySelectorAll('*'));
                    const authTextEl = elements.find(el => {
                        const text = el.textContent || '';
                        if (!/authenticator\\s+app/i.test(text) && !/authenticator/i.test(text)) return false;
                        return !Array.from(el.children).some(child => /authenticator/i.test(child.textContent || ''));
                    });

                    if (authTextEl) {
                        let par = authTextEl;
                        for (let d = 0; d < 8; d++) {
                            if (!par) break;
                            const sw = par.querySelector('button[role="switch"], [role="switch"], input[type="checkbox"]');
                            if (sw) { sw.click(); return 're_toggled_switch'; }
                            const btn = Array.from(par.querySelectorAll('button')).find(b => {
                                const bt = b.textContent.toLowerCase().trim();
                                return bt.includes('enable') || bt.includes('set up') || bt.includes('turn on') || bt.includes('bật') || bt.includes('thiết lập');
                            });
                            if (btn) { btn.click(); return 're_clicked_enable_button'; }
                            par = par.parentElement;
                        }
                    }
                    return 'not_found';
                })()
            `);
            log(`Re-toggle result: ${reToggled}`);
            await wait(4000);
        } else {
            throw new Error(`Không tìm thấy input để điền mã OTP!`);
        }
    }
}

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

    const run = async (code, maxRetries = 3) => {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const res = await apiHelper(`/tabs/${tabId}/evaluate`, { userId, expression: code });
                return res?.result;
            } catch (err) {
                const msg = err.message || String(err);
                const isTransient = msg.includes('context was destroyed') || 
                                    msg.includes('navigation') || 
                                    msg.includes('destroyed') || 
                                    msg.includes('500');
                if (isTransient && attempt < maxRetries) {
                    log(`⚠️ Eval failed (Attempt ${attempt}/${maxRetries}): ${msg.slice(0, 80)}. Retrying in 1.5s...`);
                    await wait(1500);
                    continue;
                }
                throw err;
            }
        }
    };

    try {
        // ── 1. Điều hướng đến Security settings và đảm bảo settings modal được mở ──────────────────
        log('Điều hướng đến Security settings...');
        
        // Cố gắng mở settings thông qua cả hash URL và direct path URL
        try {
            await run(`window.location.href = 'https://chatgpt.com/#settings/Security'`);
        } catch (navErr) {
            log(`⚠️ Lỗi khi đổi location.href (có thể do redirect ngay lập tức): ${navErr.message}`);
        }
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

        if (options.email && options.emailCreds) {
            await handleEmailOTPVerification(tabId, userId, apiHelper, options.email, options.emailCreds, log, wait, run);
        }

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

        if (options.email && options.emailCreds) {
            await handleEmailOTPVerification(tabId, userId, apiHelper, options.email, options.emailCreds, log, wait, run);
        }

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
                const elements = Array.from(document.querySelectorAll('*'))
                    .filter(el => el.childElementCount === 0);
                
                const candidates = elements.map(el => {
                    const raw = el.textContent.trim();
                    const cleaned = raw.replace(/\\s+/g, '');
                    
                    // Điểm ưu tiên dựa trên các class, ID hoặc text cha liên quan đến copy/secret/key
                    let score = 0;
                    let par = el;
                    for (let d = 0; d < 5; d++) {
                        if (!par) break;
                        const classAndId = String(par.className || '') + ' ' + String(par.id || '');
                        if (/copy|secret|key|code|authenticator/i.test(classAndId)) {
                            score += 10;
                        }
                        // Thêm điểm nếu có nút copy hoặc icon copy ở gần
                        if (par.querySelector('button[aria-label*="copy" i], button[title*="copy" i]')) {
                            score += 5;
                        }
                        par = par.parentElement;
                    }
                    return { el, raw, cleaned, score };
                });

                // Bộ lọc 1: Ưu tiên regex cực kỳ nghiêm ngặt: Chỉ chữ HOA và số 2-7 (đúng chuẩn RFC 4648 Base32)
                let filtered = candidates.filter(item => /^[A-Z2-7]{16,72}$/.test(item.cleaned));
                
                // Bộ lọc 2: Nếu không tìm thấy, fallback sang case-insensitive để an toàn
                if (filtered.length === 0) {
                    filtered = candidates.filter(item => /^[A-Z2-7]{16,72}$/i.test(item.cleaned));
                    
                    // Lọc bỏ tên người dùng nếu có email
                    const emailParam = ${JSON.stringify(options.email ? options.email.split('@')[0].replace(/[^a-zA-Z]/g, '').toLowerCase() : '')};
                    if (emailParam) {
                        filtered = filtered.filter(item => {
                            const val = item.cleaned.toLowerCase();
                            return !val.includes(emailParam) && !val.includes('smith') && !val.includes('albert');
                        });
                    }
                }

                // Loại trừ các cụm từ tĩnh phổ biến trong UI khảo sát/welcome của OpenAI có độ dài khớp regex
                const excludes = [
                    'funandentertainment', 
                    'termsofservice', 
                    'privacypolicy', 
                    'aboutyou', 
                    'whatwilluse', 
                    'chatgptplus',
                    'personaluse',
                    'educationuse',
                    'workuse'
                ];
                filtered = filtered.filter(item => !excludes.includes(item.cleaned.toLowerCase()));

                // Sắp xếp các ứng viên theo điểm ưu tiên giảm dần
                filtered.sort((a, b) => b.score - a.score);

                return filtered[0]?.cleaned || null;
            })()
        `);

        if (!secret) {
            const dialogText = await run(`(() => {
                const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
                return dialogs[dialogs.length - 1]?.innerText?.slice(0, 300) || null;
            })()`);
            log('❌ Không tìm thấy Secret Key. Dialog:', dialogText);
            return { success: false, secret: null, totp: null, error: `Secret key not found. Dialog: ${dialogText}` };
        }
        log(`✅ Secret Key: ${secret}`);

        // ── 6. Tạo TOTP và điền vào input ────────────────────────
        const totp = generateTOTP(secret);
        log(`TOTP: ${totp}`);

        log('Chờ OTP input field hiển thị...');
        let inputTagged = false;
        const otpSelectors = [
            'input[autocomplete="one-time-code"]',
            'input[inputmode="numeric"]',
            'input[maxlength="6"]',
            'input[placeholder*="code" i]',
            'input[placeholder*="Code"]',
            'input[type="text"]'
        ];

        // Chờ tối đa 10 giây cho input hiển thị
        for (let i = 0; i < 10; i++) {
            inputTagged = await run(`(() => {
                const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
                const modal = dialogs[dialogs.length - 1];
                const container = modal || document;

                // Thử các selector định hướng trước
                for (const sel of ${JSON.stringify(otpSelectors)}) {
                    const input = container.querySelector(sel);
                    if (input && input.offsetWidth > 0 && input.offsetHeight > 0) {
                        input.setAttribute('data-mfa-target', 'otp-input');
                        return true;
                    }
                }

                // Fallback: tìm input text/number bất kỳ trong modal
                if (modal) {
                    const inputs = Array.from(modal.querySelectorAll('input'));
                    const textInput = inputs.find(inp => {
                        const type = inp.getAttribute('type') || 'text';
                        return (type === 'text' || type === 'number') && inp.offsetWidth > 0 && inp.offsetHeight > 0;
                    });
                    if (textInput) {
                        textInput.setAttribute('data-mfa-target', 'otp-input');
                        return true;
                    }
                }
                return false;
            })()`);

            if (inputTagged) {
                log('✅ Đã tìm thấy và tag OTP input field.');
                break;
            }
            await wait(1000);
        }

        if (!inputTagged) {
            log('⚠️ Cảnh báo: Không tìm thấy OTP input field bằng JS, tiếp tục thử selector mặc định...');
        }

        // Click để focus vào input
        await run(`
            (() => {
                const input = document.querySelector('[data-mfa-target="otp-input"]') ||
                              document.querySelector('input[autocomplete="one-time-code"], input[inputmode="numeric"], input[maxlength="6"]');
                if (input) {
                    input.focus();
                    input.click();
                    return true;
                }
                return false;
            })()
        `);
        await wait(500);

        // Sử dụng native type của Camofox để mô phỏng gõ phím thật (giúp React nhận diện trạng thái)
        const typeSelector = inputTagged ? '[data-mfa-target="otp-input"]' : 'input[autocomplete="one-time-code"], input[inputmode="numeric"]';
        try {
            await apiHelper(`/tabs/${tabId}/type`, {
                userId,
                selector: typeSelector,
                text: totp
            });
            log('Đã gõ TOTP bằng Camofox native keyboard.');
        } catch (typeErr) {
            log('Native type lỗi, fallback sang JS injection:', typeErr.message);
            await run(`
                (() => {
                    const input = document.querySelector('[data-mfa-target="otp-input"]') ||
                                  document.querySelector('input[autocomplete="one-time-code"], input[inputmode="numeric"], input[maxlength="6"]');
                    if (!input) return false;
                    const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                    s.call(input, ${JSON.stringify(totp)});
                    input.dispatchEvent(new Event('input',  { bubbles: true }));
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                    return true;
                })()
            `);
        }
        await wait(1000);

        // ── 7. Click Verify ───────────────────────────────────────
        log('Tìm và tag nút Verify...');
        const btnTagged = await run(`(() => {
            const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
            const modal = dialogs[dialogs.length - 1];
            const container = modal || document;
            const buttons = Array.from(container.querySelectorAll('button, [role="button"], input[type="submit"]'));
            const verifyBtn = buttons.find(b => {
                const t = (b.textContent || b.value || '').trim().toLowerCase();
                return t === 'verify' || t.includes('verify') || t === 'xác minh' || t.includes('xác minh');
            });
            if (verifyBtn) {
                verifyBtn.removeAttribute('disabled');
                verifyBtn.setAttribute('data-mfa-target', 'verify-btn');
                return true;
            }
            return false;
        })()`);

        if (btnTagged) {
            log('Click Verify bằng Camofox native click...');
            try {
                await apiHelper(`/tabs/${tabId}/click`, {
                    userId,
                    selector: '[data-mfa-target="verify-btn"]'
                });
            } catch (clickErr) {
                log('Native click nút Verify lỗi, fallback sang JS click:', clickErr.message);
                await run(`(() => {
                    const btn = document.querySelector('[data-mfa-target="verify-btn"]');
                    if (btn) btn.click();
                })()`);
            }
        } else {
            log('⚠️ Không tìm thấy nút Verify cụ thể, thử click bằng text fallback...');
            await run(`
                const btn = Array.from(document.querySelectorAll('button'))
                    .find(b => {
                        const t = b.textContent.trim().toLowerCase();
                        return t === 'verify' || t.includes('verify') || t.includes('xác minh');
                    });
                if (btn) {
                    btn.removeAttribute('disabled');
                    btn.click();
                }
            `);
        }
        await wait(5000);

        // ── 8. Kiểm tra kết quả ───────────────────────────────────
        const confirmed = await run(`
            (() => {
                // 1. Kiểm tra switch trạng thái của Authenticator app
                const elements = Array.from(document.querySelectorAll('*'));
                const authTextEl = elements.find(el => {
                    const text = el.textContent || '';
                    if (!/authenticator\\s+app/i.test(text) && !/authenticator/i.test(text)) return false;
                    return !Array.from(el.children).some(child => /authenticator/i.test(child.textContent || ''));
                });
                
                if (authTextEl) {
                    let par = authTextEl;
                    for (let d = 0; d < 8; d++) {
                        if (!par) break;
                        const sw = par.querySelector('button[role="switch"], [role="switch"], input[type="checkbox"]');
                        if (sw) {
                            const isChecked = sw.getAttribute('aria-checked') === 'true' || sw.checked === true;
                            if (isChecked) return true;
                        }
                        par = par.parentElement;
                    }
                }
                
                // 2. Kiểm tra các text thành công phổ biến khác
                const bodyText = document.body.innerText.toLowerCase();
                return bodyText.includes('authenticator app enabled') || 
                       bodyText.includes('authenticator app is enabled') ||
                       bodyText.includes('xác thực hai yếu tố đã được bật') ||
                       bodyText.includes('enabled') ||
                       bodyText.includes('đã bật');
            })()
        `);

        if (confirmed) {
            log('🎉 MFA Authenticator app enabled thành công!');
            return { success: true, secret, totp };
        }

        // Kiểm tra thêm qua screenshot nội dung trang
        const fullBodyText = await run(`document.body.innerText`);
        const likelySuccess = fullBodyText?.includes('Authenticator app') && !fullBodyText?.includes('Enter your 6-digit');
        log(likelySuccess ? '✅ Có vẻ thành công (dựa trên nội dung trang)' : '⚠️ Chưa xác nhận được kết quả');

        return { success: likelySuccess, secret, totp };

    } catch (err) {
        return { success: false, secret: null, totp: null, error: err.message };
    }
}
