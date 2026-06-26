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
                        if (!/authenticator|two-factor|multi-factor|2fa|mfa|xác\\s+thực\\s+(hai|2)\\s+yếu\\s+tố|ứng\\s+dụng\\s+xác\\s+thực/i.test(text)) return false;
                        return !Array.from(el.children).some(child => /authenticator|two-factor|multi-factor|2fa|mfa|xác\\s+thực\\s+(hai|2)\\s+yếu\\s+tố|ứng\\s+dụng\\s+xác\\s+thực/i.test(child.textContent || ''));
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

// ── Identity Verification (Authenticator App) Bypass ──────────────────────────
async function handleAuthenticatorMFAVerification(tabId, userId, apiHelper, currentSecret, log, wait, run) {
    const isVerifyMFA = await run(`(() => {
        const isAuthPage = window.location.hostname.includes('auth.openai.com') || window.location.pathname.includes('/auth/');
        const container = isAuthPage ? document.body : (() => {
            const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
            return dialogs[dialogs.length - 1] || null;
        })();
        if (!container) return false;
        
        const text = container.innerText.toLowerCase();
        
        // Tránh trùng khớp với hộp thoại thiết lập Authenticator app/MFA setup mới
        const isMfaSetupDialog = text.includes('authenticator') && (
            text.includes('trouble scanning') || 
            text.includes('can\\'t scan') || 
            text.includes('không thể quét') || 
            text.includes('nhập khóa') ||
            text.includes('qr code') ||
            text.includes('mã qr')
        );
        if (isMfaSetupDialog) return false;
        
        const hasVerifyTitle = text.includes('verify your identity') || text.includes('xác minh danh tính');
        const hasAppPrompt = text.includes('authenticator app') || text.includes('one-time password application') || text.includes('ứng dụng xác thực');
        const hasOtpInput = !!container.querySelector('input[autocomplete="one-time-code"], input[maxlength="6"], input[inputmode="numeric"]');
        
        return hasVerifyTitle && hasAppPrompt && hasOtpInput;
    })()`);

    if (isVerifyMFA) {
        log('📬 Phát hiện yêu cầu xác minh danh tính qua Authenticator App (TOTP)!');
        if (!currentSecret) {
            throw new Error(`Cần xác minh danh tính qua Authenticator App nhưng không có currentSecret!`);
        }
        
        // Generate TOTP from current secret
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
        let bits = '';
        for (const c of currentSecret.toUpperCase().replace(/=+$/, '')) {
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
        const { createHmac } = await import('node:crypto');
        const hmac = createHmac('sha1', Buffer.from(bytes)).update(cb).digest();
        const off = hmac[hmac.length - 1] & 0xf;
        const codeNum = ((hmac[off] & 0x7f) << 24 | hmac[off+1] << 16 | hmac[off+2] << 8 | hmac[off+3]) % 1_000_000;
        const currentTotp = codeNum.toString().padStart(6, '0');

        log(`🔢 Mã TOTP sinh từ secret hiện tại: ${currentTotp}. Tiến hành điền và xác minh...`);
        
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
        })("${currentTotp}")`);

        if (fillSuccess) {
            await wait(2000);
            // Click Continue button
            await run(`(() => {
                const btn = Array.from(document.querySelectorAll('button')).find(b => {
                    const t = b.textContent.toLowerCase().trim();
                    return t.includes('continue') || t.includes('submit') || t.includes('tiếp tục');
                });
                if (btn) btn.click();
            })()`);
            log('Đợi xác minh hoàn tất...');
            await wait(6000);
            return true;
        } else {
            throw new Error(`Không tìm thấy input để điền mã TOTP xác minh!`);
        }
    }
    return false;
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

// ── Password Verification Prompt (Re-auth) Bypass ──────────────────────────────
async function handlePasswordVerificationPrompt(tabId, userId, apiHelper, password, log, wait, run) {
    if (!password) {
        log('⚠️ Không có mật khẩu để tự động xác minh lại danh tính nếu được yêu cầu.');
        return;
    }

    // Check if there is a password input on the page (usually in a dialog)
    const hasPasswordPrompt = await run(`(() => {
        const pwdInput = document.querySelector('[role="dialog"] input[type="password"], input[type="password"]');
        if (!pwdInput) return false;
        // Verify it's a re-auth password prompt, not the login screen itself
        const bodyText = (document.body.innerText || '').toLowerCase();
        return bodyText.includes('password') || bodyText.includes('confirm') || bodyText.includes('xác nhận') || bodyText.includes('mật khẩu');
    })()`);

    if (hasPasswordPrompt) {
        log('🔑 Phát hiện yêu cầu xác nhận lại mật khẩu để bật 2FA!');
        
        // Fill the password
        const typeResult = await run(`(() => {
            const pwdInput = document.querySelector('[role="dialog"] input[type="password"]') || document.querySelector('input[type="password"]');
            if (!pwdInput) return false;
            
            pwdInput.focus();
            const nativeInput = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
            if (nativeInput) nativeInput.set.call(pwdInput, ${JSON.stringify(password)});
            else pwdInput.value = ${JSON.stringify(password)};
            
            pwdInput.dispatchEvent(new Event('input', { bubbles: true }));
            pwdInput.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        })()`);
        
        if (typeResult) {
            log('Đã điền mật khẩu xác nhận. Click nút Tiếp tục/Xác nhận...');
            
            // Native click or DOM click the continue button in the dialog
            await apiHelper(`/tabs/${tabId}/click`, {
                userId,
                selector: '[role="dialog"] button[type="submit"], [role="dialog"] button:has-text("Continue"), [role="dialog"] button:has-text("Confirm"), [role="dialog"] button:has-text("Tiếp tục"), button[type="submit"]'
            }, 5000).catch(() => {});
            
            // Fallback JS click if still present after 1.5s
            await wait(1500);
            await run(`(() => {
                const pwdInput = document.querySelector('[role="dialog"] input[type="password"], input[type="password"]');
                if (pwdInput) {
                    const btn = Array.from(document.querySelectorAll('[role="dialog"] button, button'))
                        .find(b => {
                            const t = (b.textContent || b.value || '').toLowerCase().trim();
                            return t === 'continue' || t === 'confirm' || t === 'tiếp tục' || t === 'xác nhận' || t === 'next' || t === 'submit';
                        });
                    if (btn) btn.click();
                }
            })()`).catch(() => {});
            
            await wait(4000); // Chờ load trang/dialog tiếp theo
        }
    }
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

    const run = async (code, maxRetries = 5) => {
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
                    log(`⚠️ Eval failed (Attempt ${attempt}/${maxRetries}): ${msg.slice(0, 80)}. Retrying in 3s...`);
                    await wait(3000);
                    continue;
                }
                throw err;
            }
        }
    };

    const saveCheckpoint = async (slug) => {
        if (options.stepRecorder) {
            try {
                if (typeof options.stepRecorder.saveStep === 'function') {
                    await options.stepRecorder.saveStep(slug);
                } else if (typeof options.stepRecorder.checkpoint === 'function') {
                    await options.stepRecorder.checkpoint(7, 1, slug);
                }
            } catch (err) {
                log(`⚠️ Lỗi khi lưu screenshot checkpoint (${slug}): ${err.message}`);
            }
        }
    };

    try {
        // ── 0. Đóng mọi onboarding modals/overlays nếu có ──────────────────
        log('Đóng các hộp thoại giới thiệu / onboarding modals nếu có...');
        await run(`
            (() => {
                let clickedAny = false;
                const buttons = Array.from(document.querySelectorAll('button, [role="button"], a, [class*="button"], [class*="btn"]'));
                for (const btn of buttons) {
                    if (btn.offsetParent === null) continue;
                    const text = (btn.innerText || btn.textContent || '').trim().toLowerCase();
                    if (
                        text.includes("let's go") ||
                        text.includes("let’s go") ||
                        text === "okay, let's go" ||
                        text === "okay, let’s go" ||
                        text === "okay" ||
                        text === "ok" ||
                        text === "got it" ||
                        text === "done" ||
                        text === "next" ||
                        text === "tiếp tục" ||
                        text === "bắt đầu" ||
                        text === "continue" ||
                        text.includes("continue") ||
                        text.includes("let's get started") ||
                        text.includes("okay, let’s get started")
                    ) {
                        btn.click();
                        clickedAny = true;
                    }
                }
                return clickedAny;
            })()
        `);
        await wait(2000);

        // ── 1. Điều hướng đến Security settings và đảm bảo settings modal được mở ──────────────────
        log('Điều hướng đến Security settings...');
        await saveCheckpoint('mfa_navigate_start');
        
        try {
            await run(`window.location.hash = '#settings/Security'`);
            await wait(3000);
        } catch (navErr) {
            log(`⚠️ Lỗi khi JS navigate to settings: ${navErr.message}`);
        }

        // Đảm bảo settings modal được mở
        log('Chờ Settings modal mở...');
        let isOpened = false;
        for (let i = 0; i < 10; i++) {
            isOpened = await run(`
                (() => {
                    const dialog = document.querySelector('[role="dialog"]');
                    if (!dialog) return false;
                    const text = (dialog.innerText || '').toLowerCase();
                    return text.includes('settings') || text.includes('cài đặt') || text.includes('security') || text.includes('bảo mật');
                })()
            `);
            if (isOpened) break;
            
            // Tự động đóng onboarding/welcome modal nếu xuất hiện trong lúc chờ
            await run(`
                (() => {
                    let clickedAny = false;
                    const buttons = Array.from(document.querySelectorAll('button, [role="button"], a, [class*="button"], [class*="btn"]'));
                    for (const btn of buttons) {
                        if (btn.offsetParent === null) continue;
                        const text = (btn.innerText || btn.textContent || '').trim().toLowerCase();
                        if (
                            text.includes("let's go") ||
                            text.includes("let’s go") ||
                            text === "okay, let's go" ||
                            text === "okay, let’s go" ||
                            text === "okay" ||
                            text === "ok" ||
                            text === "got it" ||
                            text === "done" ||
                            text === "next" ||
                            text === "tiếp tục" ||
                            text === "bắt đầu" ||
                            text === "continue" ||
                            text.includes("continue") ||
                            text.includes("let's get started") ||
                            text.includes("okay, let’s get started")
                        ) {
                            btn.click();
                            clickedAny = true;
                        }
                    }
                    return clickedAny;
                })()
            `).catch(() => {});

            // Tự động mở sidebar nếu bị đóng/ẩn (từ lượt thứ 2 trở đi)
            if (i >= 2) {
                await run(`
                    (() => {
                        const showSidebarBtn = document.querySelector('[data-testid="show-sidebar-button"], [aria-label="Show sidebar"], [aria-label="Open sidebar"]');
                        if (showSidebarBtn && window.getComputedStyle(showSidebarBtn).display !== 'none') {
                            showSidebarBtn.click();
                            return true;
                        }
                        return false;
                    })()
                `).catch(() => {});
            }

            // Thử click profile/user menu button và settings item
            if (i === 4) {
                log('Settings modal chưa mở. Thử kích hoạt bằng click Profile/Settings menu...');
                try {
                    const profileTagged = await run(`
                        (() => {
                            const findVisibleBtn = () => {
                                const selectors = [
                                    '[data-testid="accounts-profile-button"]',
                                    '[data-testid="profile-button"]',
                                    '[data-testid="user-menu-button"]',
                                    '[aria-label="Open user menu"]',
                                    'button:has([alt*="avatar"])',
                                    'button:has(img[src*="avatar"])'
                                ];
                                for (const sel of selectors) {
                                    const elements = Array.from(document.querySelectorAll(sel));
                                    const visible = elements.find(el => el.offsetWidth > 0 && el.offsetHeight > 0);
                                    if (visible) return visible;
                                }
                                const buttons = Array.from(document.querySelectorAll('button'));
                                return buttons.find(b => (b.querySelector('img[src*="avatar"]') || (b.textContent || '').toLowerCase().includes('avatar')) && b.offsetWidth > 0 && b.offsetHeight > 0);
                            };
                            const btn = findVisibleBtn();
                            if (btn) {
                                btn.setAttribute('data-mfa-target', 'profile-btn');
                                return true;
                            }
                            return false;
                        })()
                    `);
                    if (profileTagged) {
                        log('Click Profile button bằng Camofox native click...');
                        let profileClicked = false;
                        try {
                            await apiHelper(`/tabs/${tabId}/click`, {
                                userId,
                                selector: '[data-mfa-target="profile-btn"]'
                            }, 5000);
                            profileClicked = true;
                        } catch (err) {
                            log('Native click Profile button thất bại, fallback sang JS click:', err.message);
                        }
                        if (!profileClicked) {
                            await run(`document.querySelector('[data-mfa-target="profile-btn"]')?.click()`).catch(() => {});
                        }
                        await wait(1500);

                        let settingsTagged = await run(`
                            (() => {
                                const menuItems = Array.from(document.querySelectorAll('[role="menuitem"], button, a'));
                                const settingsItem = menuItems.find(el => {
                                    const t = (el.textContent || '').trim().toLowerCase();
                                    return t === 'settings' || t === 'cài đặt' || t.includes('settings') || t.includes('cài đặt');
                                });
                                if (settingsItem) {
                                    settingsItem.setAttribute('data-mfa-target', 'settings-item');
                                    return true;
                                }
                                return false;
                            })()
                        `);
                        
                        if (!settingsTagged) {
                            log('Không tìm thấy settings menu item sau native click, fallback sang JS click Profile...');
                            await run(`document.querySelector('[data-mfa-target="profile-btn"]')?.click()`).catch(() => {});
                            await wait(1500);
                            
                            settingsTagged = await run(`
                                (() => {
                                    const menuItems = Array.from(document.querySelectorAll('[role="menuitem"], button, a'));
                                    const settingsItem = menuItems.find(el => {
                                        const t = (el.textContent || '').trim().toLowerCase();
                                        return t === 'settings' || t === 'cài đặt' || t.includes('settings') || t.includes('cài đặt');
                                    });
                                    if (settingsItem) {
                                        settingsItem.setAttribute('data-mfa-target', 'settings-item');
                                        return true;
                                    }
                                    return false;
                                })()
                            `);
                        }

                        if (settingsTagged) {
                            log('Click Settings menu item bằng Camofox native click...');
                            let settingsClicked = false;
                            try {
                                await apiHelper(`/tabs/${tabId}/click`, {
                                    userId,
                                    selector: '[data-mfa-target="settings-item"]'
                                }, 5000);
                                settingsClicked = true;
                            } catch (err) {
                                log('Native click Settings item thất bại, fallback sang JS click:', err.message);
                            }
                            if (!settingsClicked) {
                                await run(`document.querySelector('[data-mfa-target="settings-item"]')?.click()`).catch(() => {});
                            }
                        }
                    }
                } catch (clickErr) {
                    log(`⚠️ Thử click Profile/Settings menu thất bại: ${clickErr.message}`);
                }
            }
            // Thử path-based settings URL
            if (i === 7) {
                log('Vẫn chưa mở. Thử chuyển sang path-based settings URL...');
                try {
                    await run(`window.location.pathname = '/settings/security'`);
                } catch (err) {
                    log(`⚠️ Chuyển sang /settings/security qua JS thất bại: ${err.message}`);
                }
            }
            // Reload page nếu vẫn không mở được sau lần thứ 8
            if (i === 8) {
                log('⚠️ Reload page và điều hướng trực tiếp sang settings URL...');
                try {
                    await run(`window.location.href = 'https://chatgpt.com/settings/security'`);
                    await wait(6000);
                } catch (reloadErr) {
                    log(`⚠️ Điều hướng trực tiếp thất bại: ${reloadErr.message}`);
                }
            }
            await wait(1000);
        }

        if (!isOpened) {
            log('❌ KHÔNG THỂ MỞ SETTINGS MODAL SAU 10 LẦN THỬ. Abort MFA setup.');
            await saveCheckpoint('settings_modal_not_opened');
            return { success: false, secret: null, totp: null, error: 'Settings modal could not be opened after 10 attempts' };
        }

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
                    sec.setAttribute('data-mfa-target', 'security-tab-btn');
                    return true;
                }
                return false;
            })()
        `);
        
        if (activeSecTab) {
            log('Click Security tab bằng Camofox native click...');
            try {
                await apiHelper(`/tabs/${tabId}/click`, {
                    userId,
                    selector: '[data-mfa-target="security-tab-btn"]'
                }, 5000);
            } catch (err) {
                log('Native click Security tab thất bại, fallback sang JS click:', err.message);
                await run(`document.querySelector('[data-mfa-target="security-tab-btn"]')?.click()`).catch(() => {});
            }
        }
        
        if (!activeSecTab) {
            log('⚠️ Security tab không tìm thấy qua selector/text, chờ thêm...');
        }
        await wait(2000);

        // Chờ nội dung Security & Login tải xong hoàn toàn
        log('Chờ nội dung Security & Login tải xong...');
        let isSettingsLoaded = false;
        for (let w = 0; w < 12; w++) {
            isSettingsLoaded = await run(`
                (() => {
                    const dialog = document.querySelector('[role="dialog"]');
                    if (!dialog) return false;
                    const text = dialog.innerText.toLowerCase();
                    return text.includes('password') || text.includes('multi-factor') || text.includes('authenticator') || text.includes('xác thực');
                })()
            `);
            if (isSettingsLoaded) break;
            await wait(1000);
        }
        if (!isSettingsLoaded) {
            log('⚠️ Cảnh báo: Nội dung Security tab chưa tải xong hoàn toàn sau 12 giây.');
        }

        await saveCheckpoint('security_settings_loaded');

        // ── 1.5. Xử lý kịch bản 2FA ĐANG BẬT (Cần Tắt Trước Khi Tái Tạo) ──────────
        const isAlreadyEnabled = await run(`
            (() => {
                const elements = Array.from(document.querySelectorAll('*'));
                const authTextEl = elements.find(el => {
                    const text = el.textContent || '';
                    if (!/authenticator|two-factor|multi-factor|2fa|mfa|xác\\s+thực\\s+(hai|2)\\s+yếu\\s+tố|ứng\\s+dụng\\s+xác\\s+thực/i.test(text)) return false;
                    return !Array.from(el.children).some(child => /authenticator|two-factor|multi-factor|2fa|mfa|xác\\s+thực\\s+(hai|2)\\s+yếu\\s+tố|ứng\\s+dụng\\s+xác\\s+thực/i.test(child.textContent || ''));
                });
                if (authTextEl) {
                    let par = authTextEl;
                    for (let d = 0; d < 8; d++) {
                        if (!par) break;
                        const sw = par.querySelector('button[role="switch"], [role="switch"], input[type="checkbox"]');
                        if (sw) {
                            return sw.getAttribute('aria-checked') === 'true' || sw.checked === true;
                        }
                        par = par.parentElement;
                    }
                }
                return false;
            })()
        `);

        if (isAlreadyEnabled) {
            log('🛡️ Phát hiện 2FA hiện tại đang ở trạng thái BẬT (Đã kích hoạt 2FA).');
            
            // Nếu đã có currentSecret và không bắt buộc tạo lại, trả về thành công ngay lập tức
            if (!options.forceRegen && options.currentSecret) {
                log('✅ Tài khoản đã có sẵn 2FA đang hoạt động và có khóa bí mật lưu trữ. Bỏ qua việc cài đặt lại để tránh lỗi.');
                return { success: true, secret: options.currentSecret, totp: null, alreadyEnabled: true };
            }
            
            log('🛡️ Tiến hành tắt 2FA cũ trước khi thiết lập lại...');
            await saveCheckpoint('disabling_old_mfa');
            
            // Click toggle switch để tắt
            const toggledOff = await run(`
                (() => {
                    const elements = Array.from(document.querySelectorAll('*'));
                    const authTextEl = elements.find(el => {
                        const text = el.textContent || '';
                        if (!/authenticator|two-factor|multi-factor|2fa|mfa|xác\\s+thực\\s+(hai|2)\\s+yếu\\s+tố|ứng\\s+dụng\\s+xác\\s+thực/i.test(text)) return false;
                        return !Array.from(el.children).some(child => /authenticator|two-factor|multi-factor|2fa|mfa|xác\\s+thực\\s+(hai|2)\\s+yếu\\s+tố|ứng\\s+dụng\\s+xác\\s+thực/i.test(child.textContent || ''));
                    });

                    if (authTextEl) {
                        let par = authTextEl;
                        for (let d = 0; d < 8; d++) {
                            if (!par) break;
                            const sw = par.querySelector('button[role="switch"], [role="switch"], input[type="checkbox"]');
                            if (sw) { 
                                sw.setAttribute('data-mfa-target', 'toggle-off-switch');
                                return 'tagged_off_switch'; 
                            }
                            par = par.parentElement;
                        }
                    }
                    return 'not_found';
                })()
            `);
            log(`  Tắt toggle: ${toggledOff}`);
            if (toggledOff === 'tagged_off_switch') {
                log('Click tắt toggle bằng Camofox native click...');
                let offClickedOk = false;
                try {
                    await apiHelper(`/tabs/${tabId}/click`, {
                        userId,
                        selector: '[data-mfa-target="toggle-off-switch"]'
                    }, 5000);
                    await wait(1000);
                    const isToggledOff = await run(`
                        (() => {
                            const el = document.querySelector('[data-mfa-target="toggle-off-switch"]');
                            if (!el) return true; // Biến mất nghĩa là đã off
                            return el.getAttribute('aria-checked') !== 'true' && el.checked !== true;
                        })()
                    `);
                    if (isToggledOff) {
                        offClickedOk = true;
                    } else {
                        log('Native click không tắt được switch, thực hiện JS click fallback...');
                    }
                } catch (err) {
                    log('Native click tắt toggle thất bại, fallback sang JS click:', err.message);
                }
                if (!offClickedOk) {
                    await run(`document.querySelector('[data-mfa-target="toggle-off-switch"]')?.click()`).catch(() => {});
                }
            }
            await wait(4000);

            // Bổ sung xử lý thử thách xác minh khi tắt 2FA
            if (options.currentSecret) {
                await handleAuthenticatorMFAVerification(tabId, userId, apiHelper, options.currentSecret, log, wait, run);
            } else if (options.email && options.emailCreds) {
                await handleEmailOTPVerification(tabId, userId, apiHelper, options.email, options.emailCreds, log, wait, run);
            }

            // Click nút xác nhận Disable/Turn off nếu có hộp thoại hiện lên
            const clickedDisable = await run(`(() => {
                const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
                const disableBtn = buttons.find(b => {
                    const t = b.textContent.toLowerCase().trim();
                    return t === 'disable' || t.includes('turn off') || t === 'remove' || t.includes('tắt') || t.includes('vô hiệu hóa');
                });
                if (disableBtn) {
                    disableBtn.removeAttribute('disabled');
                    disableBtn.setAttribute('data-mfa-target', 'disable-btn');
                    return true;
                }
                return false;
            })()`);
            if (clickedDisable) {
                log('Click vô hiệu hóa 2FA trên hộp thoại bằng Camofox native click...');
                try {
                    await apiHelper(`/tabs/${tabId}/click`, {
                        userId,
                        selector: '[data-mfa-target="disable-btn"]'
                    }, 5000);
                } catch (err) {
                    log('Native click vô hiệu hóa thất bại, fallback sang JS click:', err.message);
                    await run(`document.querySelector('[data-mfa-target="disable-btn"]')?.click()`).catch(() => {});
                }
                log('  Đã xác nhận click vô hiệu hóa 2FA trên hộp thoại.');
                await wait(4000);
            }

            log('Đợi 5 giây để tiến trình tắt 2FA hoàn tất và trang cập nhật...');
            await wait(5000);

            // Kiểm tra lại xem 2FA đã thực sự tắt chưa
            const checkDisabled = await run(`
                (() => {
                    const elements = Array.from(document.querySelectorAll('*'));
                    const authTextEl = elements.find(el => {
                        const text = el.textContent || '';
                        if (!/authenticator|two-factor|multi-factor|2fa|mfa|xác\\s+thực\\s+(hai|2)\\s+yếu\\s+tố|ứng\\s+dụng\\s+xác\\s+thực/i.test(text)) return false;
                        return !Array.from(el.children).some(child => /authenticator|two-factor|multi-factor|2fa|mfa|xác\\s+thực\\s+(hai|2)\\s+yếu\\s+tố|ứng\\s+dụng\\s+xác\\s+thực/i.test(child.textContent || ''));
                    });
                    if (authTextEl) {
                        let par = authTextEl;
                        for (let d = 0; d < 8; d++) {
                            if (!par) break;
                            const sw = par.querySelector('button[role="switch"], [role="switch"], input[type="checkbox"]');
                            if (sw) {
                                return sw.getAttribute('aria-checked') === 'true' || sw.checked === true;
                            }
                            par = par.parentElement;
                        }
                    }
                    return false;
                })()
            `);
            if (checkDisabled) {
                throw new Error('Không thể vô hiệu hóa 2FA cũ (toggle vẫn ở trạng thái bật)');
            }
            log('✅ Đã vô hiệu hóa thành công 2FA cũ.');
            await saveCheckpoint('disabled_old_mfa_success');
        }

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
                const elements = Array.from(document.querySelectorAll('*'));
                const authTextEl = elements.find(el => {
                    const text = el.textContent || '';
                    if (!/authenticator|two-factor|multi-factor|2fa|mfa|xác\\s+thực\\s+(hai|2)\\s+yếu\\s+tố|ứng\\s+dụng\\s+xác\\s+thực/i.test(text)) return false;
                    return !Array.from(el.children).some(child => /authenticator|two-factor|multi-factor|2fa|mfa|xác\\s+thực\\s+(hai|2)\\s+yếu\\s+tố|ứng\\s+dụng\\s+xác\\s+thực/i.test(child.textContent || ''));
                });

                if (authTextEl) {
                    let par = authTextEl;
                    for (let d = 0; d < 8; d++) {
                        if (!par) break;
                        
                        const sw = par.querySelector('button[role="switch"], [role="switch"], input[type="checkbox"]');
                        if (sw) { 
                            sw.setAttribute('data-mfa-target', 'toggle-switch');
                            return 'tagged_switch'; 
                        }
                        
                        const btn = Array.from(par.querySelectorAll('button')).find(b => {
                            const bt = b.textContent.toLowerCase().trim();
                            return bt.includes('enable') || bt.includes('set up') || bt.includes('turn on') || bt.includes('bật') || bt.includes('thiết lập');
                        });
                        if (btn) { 
                            btn.setAttribute('data-mfa-target', 'enable-btn');
                            return 'tagged_enable_button'; 
                        }
                        
                        par = par.parentElement;
                    }
                }
                
                const panels = document.querySelectorAll('[role="tabpanel"]');
                for (const p of panels) {
                    if ((p.innerText||'').toLowerCase().includes('authenticator')) {
                        const sw = p.querySelector('button[role="switch"]');
                        if (sw) {
                            sw.setAttribute('data-mfa-target', 'toggle-switch-fallback');
                            return 'tagged_switch_fallback'; 
                        }
                    }
                }
                return 'not_found';
            })()
        `);
        log(`  Toggle tagged: ${toggled}`);

        if (toggled === 'not_found') {
            return { success: false, secret: null, totp: null, error: 'Toggle/Button Authenticator app not found' };
        }

        log('Click toggle/enable Authenticator app bằng Camofox native click...');
        let clickedOk = false;
        try {
            let targetSelector = '[data-mfa-target="toggle-switch"]';
            if (toggled === 'tagged_enable_button') targetSelector = '[data-mfa-target="enable-btn"]';
            if (toggled === 'tagged_switch_fallback') targetSelector = '[data-mfa-target="toggle-switch-fallback"]';
            
            await apiHelper(`/tabs/${tabId}/click`, {
                userId,
                selector: targetSelector
            }, 5000);
            
            await wait(1000);
            
            // Check xem trạng thái đã thay đổi chưa
            const isToggledOn = await run(`
                (() => {
                    const el = document.querySelector('[data-mfa-target="toggle-switch"]') || 
                               document.querySelector('[data-mfa-target="enable-btn"]') ||
                               document.querySelector('[data-mfa-target="toggle-switch-fallback"]');
                    if (!el) return false;
                    const isSwitch = el.getAttribute('role') === 'switch' || el.tagName.toLowerCase() === 'input';
                    if (isSwitch) {
                        return el.getAttribute('aria-checked') === 'true' || el.checked === true;
                    }
                    // Nếu là button, check xem dialog thiết lập đã mở chưa
                    const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
                    return dialogs.length > 1; // Thường có settings modal trước, dialog mới là dialog thứ 2
                })()
            `);
            if (isToggledOn) {
                clickedOk = true;
            } else {
                log('Native click không làm thay đổi trạng thái switch/nút, thực hiện JS click fallback...');
            }
        } catch (err) {
            log('Native click toggle/enable Authenticator app thất bại, fallback sang JS click:', err.message);
        }

        if (!clickedOk) {
            await run(`
                (() => {
                    const el = document.querySelector('[data-mfa-target="toggle-switch"]') || 
                               document.querySelector('[data-mfa-target="enable-btn"]') ||
                               document.querySelector('[data-mfa-target="toggle-switch-fallback"]');
                    if (el) el.click();
                })()
            `).catch(() => {});
        }
        await wait(4000);

        // --- Xử lý xác nhận mật khẩu (nếu có) ---
        await handlePasswordVerificationPrompt(tabId, userId, apiHelper, options.password, log, wait, run);

        if (options.email && options.emailCreds) {
            await handleEmailOTPVerification(tabId, userId, apiHelper, options.email, options.emailCreds, log, wait, run);
        }

        // Đảm bảo hộp thoại thiết lập MFA hiển thị thực tế
        log('Kiểm tra hộp thoại thiết lập MFA (QR Code)...');
        let mfaSetupScreenAppeared = false;
        for (let i = 0; i < 20; i++) {
            mfaSetupScreenAppeared = await run(`
                (() => {
                    const text = (document.body.innerText || '').toLowerCase();
                    // Text-based detection (broad set of keywords from various UI variants)
                    const hasSetupText = text.includes('trouble scanning') || 
                           text.includes("can't scan") ||
                           text.includes('cannot scan') ||
                           text.includes('không thể quét') || 
                           text.includes('nhập khóa') ||
                           text.includes('qr code') ||
                           text.includes('mã qr') ||
                           text.includes('authenticator app setup') ||
                           text.includes('scan the qr') ||
                           text.includes('scan this code') ||
                           text.includes('set up authenticator') ||
                           text.includes('use an authenticator') ||
                           text.includes('secret key') ||
                           text.includes('setup key') ||
                           text.includes('manual entry') ||
                           text.includes('enter this key') ||
                           text.includes('enter the code') ||
                           text.includes('nhập mã từ ứng dụng') ||
                           text.includes('ứng dụng xác thực');
                    if (hasSetupText) return true;

                    // DOM-based detection: look for a new dialog with a QR image or canvas
                    const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
                    for (const d of dialogs) {
                        const dText = (d.innerText || '').toLowerCase();
                        // Skip the Settings dialog itself (it has "settings" or "security" but not QR-related content)
                        if (dText.includes('settings') || dText.includes('cài đặt')) continue;
                        // Any dialog with a canvas (QR rendered via canvas) or img with qr-related alt
                        const hasQrCanvas = !!d.querySelector('canvas');
                        const hasQrImg = !!d.querySelector('img[src*="qr"], img[alt*="qr" i], img[alt*="code" i]');
                        if (hasQrCanvas || hasQrImg) return true;
                        // Any non-Settings dialog that appeared after we clicked the toggle
                        if (d.querySelectorAll('img, canvas').length > 0) return true;
                    }
                    return false;
                })()
            `);
            if (mfaSetupScreenAppeared) break;
            await wait(1000);
        }
        if (!mfaSetupScreenAppeared) {
            log('❌ Hộp thoại thiết lập MFA không hiển thị sau khi click toggle.');
            await saveCheckpoint('mfa_setup_dialog_failed');
            // Bug fix (1): Throw error if modal doesn't appear
            throw new Error('MFA setup dialog did not appear after toggle click.');
        }
        await saveCheckpoint('mfa_setup_dialog_opened');

        // ── 4. Click "Trouble scanning?" để hiển thị text secret ──
        log('Tìm và tag nút "Trouble scanning?"...');
        const troubleTagged = await run(`
            (() => {
                const KEYWORDS = ['trouble scanning', "can't scan", 'cannot scan', 'không thể quét', 'nhập khóa', 'nhập mã', 'enter setup key', 'enter key', 'use setup key', 'manual', 'enter code manually'];
                
                // 1. Find all elements containing any of the keywords in their text
                const all = Array.from(document.querySelectorAll('*'));
                const candidates = all.filter(e => {
                    const tag = e.tagName.toLowerCase();
                    if (['html', 'body', 'script', 'style', 'head', 'meta', 'link', 'iframe', 'noscript'].includes(tag)) {
                        return false;
                    }
                    const text = (e.textContent || '').toLowerCase();
                    return KEYWORDS.some(kw => text.includes(kw));
                });
                
                if (candidates.length === 0) {
                    return 'not_found';
                }
                
                // 2. Find the leaf candidate (the candidate that doesn't contain any other candidate)
                const leaf = candidates.find(c => {
                    return !candidates.some(other => other !== c && c.contains(other));
                });
                
                if (!leaf) {
                    return 'candidate_found_but_no_leaf';
                }
                
                // 3. Find closest interactive ancestor of the leaf, or default to the leaf itself
                const interactive = leaf.closest('a, button, div[role="button"], [tabindex], [onclick]');
                const el = interactive || leaf;
                
                el.setAttribute('data-mfa-target', 'trouble-btn');
                return 'tagged_' + el.tagName.toLowerCase();
            })()
        `);
        log(`  Trouble scanning tagging: ${troubleTagged}`);

        if (troubleTagged.startsWith('tagged_')) {
            log('Click "Trouble scanning?" bằng Camofox native click...');
            let troubleClickedOk = false;
            try {
                await apiHelper(`/tabs/${tabId}/click`, {
                    userId,
                    selector: '[data-mfa-target="trouble-btn"]'
                }, 5000);
                await wait(1000);
                // Check xem Secret Key container đã xuất hiện chưa
                const hasSecretKey = await run(`
                    (() => {
                        const all = Array.from(document.querySelectorAll('*'));
                        return all.some(el => {
                            const text = el.textContent || '';
                            return text.length > 10 && /^[a-z2-7=]+$/i.test(text.replace(/[\\s-]/g, ''));
                        });
                    })()
                `);
                if (hasSecretKey) {
                    troubleClickedOk = true;
                } else {
                    log('Native click không mở được Trouble scanning panel, thực hiện JS click fallback...');
                }
            } catch (err) {
                log('Native click "Trouble scanning?" thất bại, fallback sang JS click trực tiếp:', err.message);
            }
            
            if (!troubleClickedOk) {
                await run(`
                    (() => {
                        const el = document.querySelector('[data-mfa-target="trouble-btn"]');
                        if (el) {
                            try { el.focus(); } catch (e) {}
                            
                            // Trigger mouse events first
                            const events = ['mousedown', 'mouseup', 'click'];
                            for (const name of events) {
                                try {
                                    const ev = new MouseEvent(name, {
                                        bubbles: true,
                                        cancelable: true,
                                        view: window,
                                        buttons: 1
                                    });
                                    el.dispatchEvent(ev);
                                } catch (e) {}
                            }
                            
                            // Also trigger standard click just in case
                            if (typeof el.click === 'function') {
                                el.click();
                            }
                        }
                    })()
                `).catch(() => {});
            }
        } else {
            log('⚠️ Không thể tag nút "Trouble scanning?", bỏ qua click.');
        }
        await wait(2500);
        await saveCheckpoint('trouble_scanning_clicked');

        // ── 5. Đọc secret key từ DOM ──────────────────────────────
        log('Đọc Secret Key từ DOM...');
        let secret = null;
        for (let attempt = 0; attempt < 15; attempt++) {
            secret = await run(`
                (() => {
                    const elements = Array.from(document.querySelectorAll('*'))
                        .filter(el => {
                            const tag = el.tagName.toLowerCase();
                            return tag !== 'script' && tag !== 'style' && tag !== 'noscript' && tag !== 'iframe' && tag !== 'link' && tag !== 'meta' && tag !== 'head';
                        })
                        .filter(el => el.childElementCount === 0);
                    
                    const candidates = elements.map(el => {
                        const raw = el.textContent.trim();
                        const cleaned = raw.replace(/[\\s\\-]/g, '');
                        
                        let score = 0;
                        try {
                            const style = window.getComputedStyle(el);
                            const ff = (style.fontFamily || '').toLowerCase();
                            if (ff.includes('mono') || ff.includes('courier') || ff.includes('consolas') || ff.includes('code')) {
                                score += 20;
                            }
                        } catch (e) {}

                        let par = el;
                        for (let d = 0; d < 5; d++) {
                            if (!par) break;
                            const classAndId = String(par.className || '') + ' ' + String(par.id || '');
                            if (/copy|secret|key|code|authenticator/i.test(classAndId)) score += 10;
                            if (d < 2 && par.querySelector('button[aria-label*="copy" i], button[title*="copy" i]')) score += 5;
                            par = par.parentElement;
                        }
                        return { el, raw, cleaned, score };
                    });

                    let filtered = candidates.filter(item => {
                        // 1. Phải là Base32 hợp lệ và có độ dài chính xác 32 ký tự (chuẩn ChatGPT MFA)
                        // Bất kỳ chuỗi tiếng Anh viết hoa nào không có số 0,1,8,9 (VD: PARENTALCONTROLS) 
                        // đều là Base32 hợp lệ. Do đó phải giới hạn khắt khe độ dài là 32.
                        if (item.cleaned.length !== 32) return false;
                        if (!/^[A-Z2-7]{32}$/i.test(item.cleaned)) return false;
                        
                        // 2. Không chấp nhận chữ lẫn lộn hoa/thường (Mixed case)
                        const lettersOnly = item.raw.replace(/[^a-zA-Z]/g, '');
                        if (lettersOnly.length > 0) {
                            const isAllUpper = lettersOnly === lettersOnly.toUpperCase();
                            const isAllLower = lettersOnly === lettersOnly.toLowerCase();
                            if (!isAllUpper && !isAllLower) return false;
                        }

                        // 3. Nếu có khoảng trắng, nó phải được chia theo cụm đều đặn (chuẩn là 4 ký tự 1 cụm)
                        if (item.raw.includes(' ')) {
                            const words = item.raw.split(' ').filter(w => w.length > 0);
                            if (words.length > 1) {
                                const expectedLen = words[0].length;
                                if (expectedLen < 3) return false; // Thường secret key không chia cụm 1-2 ký tự
                                for (let w = 0; w < words.length - 1; w++) {
                                    if (words[w].length !== expectedLen) return false;
                                }
                                // Thưởng điểm nếu đúng format 4 ký tự mỗi cụm (VD: xxxx xxxx xxxx ...)
                                if (expectedLen === 4 && words.length === 8) {
                                    item.score += 50;
                                }
                            }
                        }

                        // 4. Entropy (tính đa dạng ký tự)
                        const uniqueChars = new Set(item.cleaned.toLowerCase()).size;
                        if (uniqueChars < 8) return false;

                        return true;
                    });

                    // Nếu chưa tìm thấy key hợp lệ 32 ký tự, trả về null để đợi DOM load thêm
                    if (filtered.length === 0) {
                        return null;
                    }

                    filtered.sort((a, b) => {
                        if (b.score !== a.score) return b.score - a.score;
                        return b.cleaned.length - a.cleaned.length;
                    });

                    return filtered[0]?.cleaned || null;
                })()
            `);

            if (secret) break;
            log(`  Chờ Secret Key xuất hiện (lần thử ${attempt + 1}/15)...`);
            await wait(1000);
        }

        if (!secret) {
            const dialogText = await run(`(() => {
                const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
                return dialogs[dialogs.length - 1]?.innerText?.slice(0, 300) || null;
            })()`);
            log('❌ Không tìm thấy Secret Key. Dialog:', dialogText);
            await saveCheckpoint('mfa_secret_not_found');
            return { success: false, secret: null, totp: null, error: `Secret key not found. Dialog: ${dialogText}` };
        }

        // Validate format key RFC 4648 Base32
        const upperSecret = secret.toUpperCase();
        if (!/^[A-Z2-7]{16,72}$/.test(upperSecret)) {
            log(`❌ Secret Key tìm thấy không hợp lệ (Base32 format): ${upperSecret}`);
            await saveCheckpoint('mfa_invalid_secret');
            return { success: false, secret: null, totp: null, error: `Invalid secret key format: ${upperSecret}` };
        }
        log(`✅ Secret Key hợp lệ: ${upperSecret}`);

        // ── 6. Tạo TOTP và điền vào input ────────────────────────
        // Check TOTP time window to avoid code expiration near the 30-second boundary (Fix #5)
        const nowSec = Math.floor(Date.now() / 1000);
        const secRemaining = 30 - (nowSec % 30);
        if (secRemaining <= 5) {
            log(`⏳ [MFA] TOTP chỉ còn ${secRemaining}s trước khi đổi mã, chờ ${secRemaining + 1}s sang chu kỳ mới...`);
            await new Promise(r => setTimeout(r, (secRemaining + 1) * 1000));
        }

        const totp = generateTOTP(upperSecret);
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

        for (let i = 0; i < 10; i++) {
            inputTagged = await run(`(() => {
                const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
                const modal = dialogs[dialogs.length - 1];
                const container = modal || document;

                for (const sel of ${JSON.stringify(otpSelectors)}) {
                    const input = container.querySelector(sel);
                    if (input && input.offsetWidth > 0 && input.offsetHeight > 0) {
                        input.setAttribute('data-mfa-target', 'otp-input');
                        return true;
                    }
                }

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

        // Focus and click
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

        const typeSelector = inputTagged ? '[data-mfa-target="otp-input"]' : 'input[autocomplete="one-time-code"], input[inputmode="numeric"]';
        try {
            await apiHelper(`/tabs/${tabId}/type`, {
                userId,
                selector: typeSelector,
                text: totp
            }, 5000); // 5s timeout to fail fast
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
        await saveCheckpoint('totp_entered');

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
                }, 5000); // 5s timeout to fail fast and fallback to JS
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
                        return t === 'verify' || t.includes('verify') || t === 'xác minh';
                    });
                if (btn) {
                    btn.removeAttribute('disabled');
                    btn.click();
                }
            `);
        }
        await wait(6000);
        await saveCheckpoint('verify_clicked');

        // ── 8. Xác minh thông minh (Thực hiện điều hướng đi chỗ khác rồi quay lại) ───────────────────────────────────
        log('Tiến hành đóng modal settings (nếu có)...');
        await run(`
            (() => {
                const closeBtn = document.querySelector('button[aria-label="Close"], button[aria-label="Đóng"], [class*="close" i]');
                if (closeBtn) {
                    closeBtn.click();
                    return true;
                }
                return false;
            })()
        `).catch(() => {});
        await wait(2000);

        log('Xác minh thông minh: Chuyển hướng trực tiếp tới Security Settings...');
        try {
            await run(`window.location.href = 'https://chatgpt.com/settings/security'`);
            await wait(6000);
        } catch (navAwayErr) {
            log(`⚠️ Lỗi khi JS navigate: ${navAwayErr.message}`);
        }
        await saveCheckpoint('navigated_to_settings');

        log('Xác minh thông minh: Kiểm tra trạng thái Security Settings...');
        
        // Chờ modal load lại
        let isReopened = false;
        for (let i = 0; i < 8; i++) {
            isReopened = await run(`
                (() => {
                    const dialog = document.querySelector('[role="dialog"]');
                    if (!dialog) return false;
                    const text = (dialog.innerText || '').toLowerCase();
                    return text.includes('settings') || text.includes('cài đặt') || text.includes('security') || text.includes('bảo mật');
                })()
            `);
            if (isReopened) break;
            
            if (i === 3) {
                try {
                    const profileTagged = await run(`
                        (() => {
                            const findVisibleBtn = () => {
                                const selectors = [
                                    '[data-testid="accounts-profile-button"]',
                                    '[data-testid="profile-button"]',
                                    '[data-testid="user-menu-button"]',
                                    '[aria-label="Open user menu"]',
                                    'button:has([alt*="avatar"])'
                                ];
                                for (const sel of selectors) {
                                    const elements = Array.from(document.querySelectorAll(sel));
                                    const visible = elements.find(el => el.offsetWidth > 0 && el.offsetHeight > 0);
                                    if (visible) return visible;
                                }
                                return null;
                            };
                            const btn = findVisibleBtn();
                            if (btn) {
                                btn.setAttribute('data-mfa-target', 'verify-profile-btn');
                                return true;
                            }
                            return false;
                        })()
                    `);
                    if (profileTagged) {
                        log('Verify double check: Click Profile button bằng Camofox native click...');
                        try {
                            await apiHelper(`/tabs/${tabId}/click`, {
                                userId,
                                selector: '[data-mfa-target="verify-profile-btn"]'
                            }, 5000);
                        } catch (err) {
                            log('Native click Profile button thất bại, fallback sang JS click:', err.message);
                            await run(`document.querySelector('[data-mfa-target="verify-profile-btn"]')?.click()`).catch(() => {});
                        }
                        await wait(1000);

                        const settingsTagged = await run(`
                            (() => {
                                const items = Array.from(document.querySelectorAll('[role="menuitem"], button, a'));
                                const settingsItem = items.find(el => {
                                    const t = (el.textContent || '').trim().toLowerCase();
                                    return t === 'settings' || t === 'cài đặt';
                                });
                                if (settingsItem) {
                                    settingsItem.setAttribute('data-mfa-target', 'verify-settings-item');
                                    return true;
                                }
                                return false;
                            })()
                        `);
                        if (settingsTagged) {
                            log('Verify double check: Click Settings menu item bằng Camofox native click...');
                            try {
                                await apiHelper(`/tabs/${tabId}/click`, {
                                    userId,
                                    selector: '[data-mfa-target="verify-settings-item"]'
                                }, 5000);
                            } catch (err) {
                                log('Native click Settings item thất bại, fallback sang JS click:', err.message);
                                await run(`document.querySelector('[data-mfa-target="verify-settings-item"]')?.click()`).catch(() => {});
                            }
                        }
                    }
                } catch (clickErr) {
                    log(`⚠️ Verify double check: click Profile/Settings menu thất bại: ${clickErr.message}`);
                }
            }
            await wait(1000);
        }

        // Click Security tab
        try {
            const secTagged = await run(`
                (() => {
                    let sec = document.querySelector('[data-testid="security-tab"]');
                    if (!sec) {
                        sec = Array.from(document.querySelectorAll('[role="tab"], button, a')).find(el => {
                            const text = (el.textContent || '').toLowerCase().trim();
                            return text === 'security' || text === 'bảo mật';
                        });
                    }
                    if (sec) {
                        sec.setAttribute('data-mfa-target', 'verify-security-tab');
                        return true;
                    }
                    return false;
                })()
            `);
            if (secTagged) {
                log('Verify double check: Click Security tab bằng Camofox native click...');
                try {
                    await apiHelper(`/tabs/${tabId}/click`, {
                        userId,
                        selector: '[data-mfa-target="verify-security-tab"]'
                    }, 5000);
                } catch (err) {
                    log('Native click Security tab thất bại, fallback sang JS click:', err.message);
                    await run(`document.querySelector('[data-mfa-target="verify-security-tab"]')?.click()`).catch(() => {});
                }
            }
        } catch (secErr) {
            log(`⚠️ Verify double check: click Security tab thất bại: ${secErr.message}`);
        }
        await wait(2000);
        await saveCheckpoint('fresh_verification_check');

        // Đọc actual toggle switch state
        const confirmed = await run(`
            (() => {
                // Đảm bảo Settings modal thực tế đang mở trên DOM
                const dialog = document.querySelector('[role="dialog"]');
                if (!dialog) return false;
                const dialogText = (dialog.innerText || '').toLowerCase();
                const isSettingsDialog = dialogText.includes('settings') || dialogText.includes('cài đặt') || dialogText.includes('security') || dialogText.includes('bảo mật');
                if (!isSettingsDialog) return false;

                const elements = Array.from(dialog.querySelectorAll('*'));
                const authTextEl = elements.find(el => {
                    const text = el.textContent || '';
                    if (!/authenticator|two-factor|multi-factor|2fa|mfa|xác\\s+thực\\s+(hai|2)\\s+yếu\\s+tố|ứng\\s+dụng\\s+xác\\s+thực/i.test(text)) return false;
                    return !Array.from(el.children).some(child => /authenticator|two-factor|multi-factor|2fa|mfa|xác\\s+thực\\s+(hai|2)\\s+yếu\\s+tố|ứng\\s+dụng\\s+xác\\s+thực/i.test(child.textContent || ''));
                });
                
                if (authTextEl) {
                    let par = authTextEl;
                    for (let d = 0; d < 8; d++) {
                        if (!par) break;
                        const sw = par.querySelector('button[role="switch"], [role="switch"], input[type="checkbox"]');
                        if (sw) {
                            return sw.getAttribute('aria-checked') === 'true' || sw.checked === true;
                        }
                        par = par.parentElement;
                    }
                }
                return false;
            })()
        `);

        if (confirmed) {
            log('🎉 XÁC MINH THÀNH CÔNG: MFA Authenticator app đã bật thực tế trên DOM!');
            return { success: true, secret: upperSecret, totp };
        }

        log('❌ XÁC MINH THẤT BẠI: Đã chạy hết các bước nhưng switch 2FA vẫn ở trạng thái tắt trên fresh DOM load!');
        return { success: false, secret: null, totp: null, error: 'MFA switch remained off after fresh page navigation check.' };

    } catch (err) {
        return { success: false, secret: null, totp: null, error: err.message };
    }
}
