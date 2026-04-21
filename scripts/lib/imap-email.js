/**
 * SeeLLM Tools - IMAP Email Reader Helper
 * 
 * Đọc email tự động thông qua giao thức IMAP (dùng cho Mật khẩu ứng dụng / Basic Auth).
 */

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

/**
 * Trích xuất mã OTP 6 chữ số từ nội dung email.
 */
function extractOTP(text) {
    const match = text.match(/\b(\d{6})\b/);
    if (match) return match[1];
    return null;
}

/**
 * Hàm chờ mã OTP qua IMAP, cơ chế polling.
 */
export async function waitForOTPCodeImap({ email, password, senderDomain = 'openai.com', maxWaitSecs = 90 }) {
    console.log(`[OTP-IMAP] ⏳ Đang kết nối IMAP cho ${email}`);

    // Dựa vào email domain để chọn host IMAP
    let host = 'imap-mail.outlook.com';
    let port = 993;
    let secure = true;

    if (email.includes('@gmail.com')) {
        host = 'imap.gmail.com';
    } else if (email.includes('@yahoo.com')) {
        host = 'imap.mail.yahoo.com';
    }

    const client = new ImapFlow({
        host,
        port,
        secure,
        auth: {
            user: email,
            pass: password
        },
        logger: false // tắt log thư viện
    });

    try {
        await client.connect();
        console.log(`[OTP-IMAP] ✅ Kết nối thành công`);

        let lock = await client.getMailboxLock('INBOX');
        const startTime = Date.now();
        let pollCount = 0;

        try {
            while (Date.now() - startTime < maxWaitSecs * 1000) {
                pollCount++;
                
                // Fetch email chưa đọc từ sender
                // Lấy các UID của thư chưa đọc
                const searchCriteria = { seen: false, from: senderDomain };
                
                // Do ImapFlow search
                let messages = [];
                for await (let message of client.fetch(searchCriteria, { source: true, envelope: true })) {
                    messages.push(message);
                }

                if (pollCount <= 3 || pollCount % 5 === 0) {
                    console.log(`[OTP-IMAP] Poll #${pollCount}: Có ${messages.length} email mới từ ${senderDomain}`);
                }

                for (const msg of messages) {
                    const parsed = await simpleParser(msg.source);
                    const subject = parsed.subject || '';
                    const text = parsed.text || '';
                    
                    const code = extractOTP(text) || extractOTP(subject);
                    if (code) {
                        console.log(`[OTP-IMAP] ✅ MÃ OTP: ${code} | Subject: "${subject}"`);
                        // Đánh dấu đã đọc
                        await client.messageFlagsAdd(msg.uid, ['\\Seen']);
                        return code;
                    }
                }

                // Chờ 3 giây rồi lấy lại
                await new Promise(r => setTimeout(r, 3000));
                // Phải nhả lock và lấy lại để refresh
                lock.release();
                lock = await client.getMailboxLock('INBOX');
            }
            
            console.log(`[OTP-IMAP] ❌ Hết giờ (${maxWaitSecs}s). Không nhận được OTP.`);
            return null;

        } finally {
            lock.release();
        }
    } catch (err) {
        console.error(`[OTP-IMAP] ❌ Lỗi IMAP: ${err.message}`);
        return null;
    } finally {
        await client.logout();
    }
}

/**
 * Kiểm tra kết nối IMAP (cho chức năng Verify/Check)
 */
export async function checkImapConnection(email, password) {
    let host = 'imap-mail.outlook.com';
    if (email.includes('@gmail.com')) host = 'imap.gmail.com';
    else if (email.includes('@yahoo.com')) host = 'imap.mail.yahoo.com';

    const client = new ImapFlow({
        host,
        port: 993,
        secure: true,
        auth: { user: email, pass: password },
        logger: false
    });

    try {
        await client.connect();
        return { ok: true };
    } catch (err) {
        return { ok: false, error: err.message };
    } finally {
        await client.logout();
    }
}
