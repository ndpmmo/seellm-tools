/**
 * SeeLLM Tools - Email Health Check Worker
 * 
 * Kiểm tra xem tài khoản Microsoft có thể đọc thư được không (Access Token OK?)
 */
import { getAccessToken, fetchMails } from './lib/ms-graph-email.js';

async function runCheck(input) {
    const parts = input.split('|');
    let email, password, authMethod, refreshToken, clientId;
    
    // Format received from UI: email|password|auth_method|refresh_token|client_id
    [email, password, authMethod, refreshToken, clientId] = parts;

    console.log(`[Check] 🔍 Đang kiểm tra Email: ${email} (Label: ${authMethod.toUpperCase()})`);

    try {
        // Both modes use Microsoft Graph API, so we just use the refresh token
        if (!refreshToken || !clientId) {
            throw new Error('Thiếu Refresh Token hoặc Client ID');
        }

        const token = await getAccessToken(refreshToken, clientId);
        console.log(`[Check] ✅ Lấy Access Token thành công.`);
        
        const mails = await fetchMails(token, { top: 1 });
        const message = `Kết nối Mailbox thành công. Tìm thấy ${mails.length} email.`;

        console.log(`[Check] ✅ ${message}`);

        // Cập nhật trạng thái vào Pool
        await fetch(`http://localhost:4000/api/vault/email-pool`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email,
                mail_status: 'active',
                last_checked_at: new Date().toISOString(),
                notes: `Mail OK (${new Date().toLocaleTimeString()})`
            }),
        });

        console.log(`[Check] 🟢 KẾT QUẢ: HOẠT ĐỘNG TỐT`);
    } catch (err) {
        console.log(`[Check] ❌ THẤT BẠI: ${err.message}`);

        await fetch(`http://localhost:4000/api/vault/email-pool`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email,
                mail_status: 'dead',
                last_checked_at: new Date().toISOString(),
                notes: `Lỗi: ${err.message}`
            }),
        });
    }
}

const input = process.argv[2];
if (input) {
    runCheck(input);
} else {
    console.log("Usage: node scripts/check-mail-worker.js \"email|pass|refresh|client\"");
}
