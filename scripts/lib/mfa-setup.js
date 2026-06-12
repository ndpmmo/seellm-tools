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
            await apiHelper(`/tabs/${tabId}/navigate`, { userId, url: 'https://chatgpt.com/#settings/Security' });
            await wait(3000);
        } catch (navErr) {
            log(`⚠️ Lỗi khi native navigate (thử fallback location.href): ${navErr.message}`);
            try {
                await run(`window.location.href = 'https://chatgpt.com/#settings/Security'`);
                await wait(4000);
            } catch (jsNavErr) {
                log(`❌ Cả native navigate và JS location.href đều lỗi: ${jsNavErr.message}`);
            }
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

            // Thử click profile/user menu button và settings item
            if (i === 4) {
                log('Settings modal chưa mở. Thử kích hoạt bằng click Profile/Settings menu...');
                await run(`
                    (async () => {
                        const profileBtn = document.querySelector('[data-testid="profile-button"], [data-testid="user-menu-button"], [aria-label="Open user menu"], button:has([alt*="avatar"]), button:has(img[src*="avatar"])');
                        if (profileBtn) {
                            profileBtn.click();
                            await new Promise(r => setTimeout(r, 1000));
                            const menuItems = Array.from(document.querySelectorAll('[role="menuitem"], button, a'));
                            const settingsItem = menuItems.find(el => {
                                const t = (el.textContent || '').trim().toLowerCase();
                                return t === 'settings' || t === 'cài đặt';
                            });
                            if (settingsItem) {
                                settingsItem.click();
                            }
                        }
                    })()
                `).catch(() => {});
            }
            // Thử path-based settings URL
            if (i === 7) {
                log('Vẫn chưa mở. Thử chuyển sang path-based settings URL...');
                try {
                    await apiHelper(`/tabs/${tabId}/navigate`, { userId, url: 'https://chatgpt.com/settings/security' });
                } catch (err) {
                    log(`⚠️ Fallback JS navigate do native navigate thất bại: ${err.message}`);
                    await run(`window.location.href = 'https://chatgpt.com/settings/security'`).catch(() => {});
                }
            }
            await wait(1000);
        }

        if (!isOpened) {
            log('⚠️ Cảnh báo: Không thể xác nhận Settings modal đã mở, vẫn tiếp tục...');
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
                    sec.click();
                    return true;
                }
                return false;
            })()
        `);
        
        if (!activeSecTab) {
            log('⚠️ Security tab không tìm thấy qua selector/text, chờ thêm...');
        }
        await wait(2000);
        await saveCheckpoint('security_settings_loaded');

        // ── 1.5. Xử lý kịch bản 2FA ĐANG BẬT (Cần Tắt Trước Khi Tái Tạo) ──────────
        const isAlreadyEnabled = await run(`
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
                        if (!/authenticator\\s+app/i.test(text) && !/authenticator/i.test(text)) return false;
                        return !Array.from(el.children).some(child => /authenticator/i.test(child.textContent || ''));
                    });

                    if (authTextEl) {
                        let par = authTextEl;
                        for (let d = 0; d < 8; d++) {
                            if (!par) break;
                            const sw = par.querySelector('button[role="switch"], [role="switch"], input[type="checkbox"]');
                            if (sw) { 
                                sw.click(); 
                                return 'toggled_off_switch'; 
                            }
                            par = par.parentElement;
                        }
                    }
                    return 'not_found';
                })()
            `);
            log(`  Tắt toggle: ${toggledOff}`);
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
                    disableBtn.click();
                    return true;
                }
                return false;
            })()`);
            if (clickedDisable) {
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
                        if (!/authenticator\\s+app/i.test(text) && !/authenticator/i.test(text)) return false;
                        return !Array.from(el.children).some(child => /authenticator/i.test(child.textContent || ''));
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
                    if (!/authenticator\\s+app/i.test(text) && !/authenticator/i.test(text)) return false;
                    return !Array.from(el.children).some(child => /authenticator/i.test(child.textContent || ''));
                });

                if (authTextEl) {
                    let par = authTextEl;
                    for (let d = 0; d < 8; d++) {
                        if (!par) break;
                        
                        const sw = par.querySelector('button[role="switch"], [role="switch"], input[type="checkbox"]');
                        if (sw) { 
                            sw.click(); 
                            return 'toggled_switch'; 
                        }
                        
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

        // Đảm bảo hộp thoại thiết lập MFA hiển thị thực tế
        log('Kiểm tra hộp thoại thiết lập MFA (QR Code)...');
        let mfaSetupScreenAppeared = false;
        for (let i = 0; i < 15; i++) {
            mfaSetupScreenAppeared = await run(`
                (() => {
                    const text = (document.body.innerText || '').toLowerCase();
                    return text.includes('trouble scanning') || 
                           text.includes('can\\'t scan') || 
                           text.includes('không thể quét') || 
                           text.includes('nhập khóa') ||
                           text.includes('qr code') ||
                           text.includes('mã qr') ||
                           text.includes('authenticator app setup');
                })()
            `);
            if (mfaSetupScreenAppeared) break;
            await wait(1000);
        }

        if (!mfaSetupScreenAppeared) {
            log('❌ Hộp thoại thiết lập MFA không hiển thị sau khi click toggle.');
            await saveCheckpoint('mfa_setup_dialog_failed');
            return { success: false, secret: null, totp: null, error: 'MFA setup dialog did not appear after toggle click.' };
        }
        await saveCheckpoint('mfa_setup_dialog_opened');

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
        await saveCheckpoint('trouble_scanning_clicked');

        // ── 5. Đọc secret key từ DOM ──────────────────────────────
        log('Đọc Secret Key từ DOM...');
        const secret = await run(`
            (() => {
                const elements = Array.from(document.querySelectorAll('*'))
                    .filter(el => el.childElementCount === 0);
                
                const candidates = elements.map(el => {
                    const raw = el.textContent.trim();
                    const cleaned = raw.replace(/\\s+/g, '');
                    
                    let score = 0;
                    let par = el;
                    for (let d = 0; d < 5; d++) {
                        if (!par) break;
                        const classAndId = String(par.className || '') + ' ' + String(par.id || '');
                        if (/copy|secret|key|code|authenticator/i.test(classAndId)) {
                            score += 10;
                        }
                        if (par.querySelector('button[aria-label*="copy" i], button[title*="copy" i]')) {
                            score += 5;
                        }
                        par = par.parentElement;
                    }
                    return { el, raw, cleaned, score };
                });

                let filtered = candidates.filter(item => /^[A-Z2-7]{16,72}$/.test(item.cleaned));
                
                if (filtered.length === 0) {
                    filtered = candidates.filter(item => /^[A-Z2-7]{16,72}$/i.test(item.cleaned));
                    const emailParam = ${JSON.stringify(options.email ? options.email.split('@')[0].replace(/[^a-zA-Z]/g, '').toLowerCase() : '')};
                    if (emailParam) {
                        filtered = filtered.filter(item => {
                            const val = item.cleaned.toLowerCase();
                            return !val.includes(emailParam) && !val.includes('smith') && !val.includes('albert');
                        });
                    }
                }

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

        log('Xác minh thông minh: Chuyển hướng ra trang chủ ChatGPT...');
        try {
            await apiHelper(`/tabs/${tabId}/navigate`, { userId, url: 'https://chatgpt.com/' });
            await wait(4000);
        } catch (navAwayErr) {
            log(`⚠️ Lỗi khi navigate away: ${navAwayErr.message}`);
        }
        await saveCheckpoint('navigated_away');

        log('Xác minh thông minh: Quay lại Security Settings...');
        try {
            await apiHelper(`/tabs/${tabId}/navigate`, { userId, url: 'https://chatgpt.com/#settings/Security' });
            await wait(4000);
        } catch (navBackErr) {
            log(`⚠️ Lỗi khi navigate quay lại: ${navBackErr.message}`);
            await run(`window.location.href = 'https://chatgpt.com/#settings/Security'`).catch(() => {});
            await wait(5000);
        }

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
                await run(`
                    (() => {
                        const profileBtn = document.querySelector('[data-testid="profile-button"], [data-testid="user-menu-button"], [aria-label="Open user menu"], button:has([alt*="avatar"])');
                        if (profileBtn) profileBtn.click();
                    })()
                `).catch(() => {});
                await wait(1000);
                await run(`
                    (() => {
                        const items = Array.from(document.querySelectorAll('[role="menuitem"], button, a'));
                        const settingsItem = items.find(el => {
                            const t = (el.textContent || '').trim().toLowerCase();
                            return t === 'settings' || t === 'cài đặt';
                        });
                        if (settingsItem) settingsItem.click();
                    })()
                `).catch(() => {});
            }
            await wait(1000);
        }

        // Click Security tab
        await run(`
            (() => {
                let sec = document.querySelector('[data-testid="security-tab"]');
                if (!sec) {
                    sec = Array.from(document.querySelectorAll('[role="tab"], button, a')).find(el => {
                        const text = (el.textContent || '').toLowerCase().trim();
                        return text === 'security' || text === 'bảo mật';
                    });
                }
                if (sec) sec.click();
            })()
        `).catch(() => {});
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
                    if (!/authenticator\\s+app/i.test(text) && !/authenticator/i.test(text)) return false;
                    return !Array.from(el.children).some(child => /authenticator/i.test(child.textContent || ''));
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
