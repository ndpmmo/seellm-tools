/**
 * SeeLLM Tools - Email Health Check Worker
 * 
 * Kiểm tra xem tài khoản Microsoft có thể đọc thư được không (Access Token OK?)
 * 
 * Input format: email|password|auth_method|refresh_token|client_id
 * - auth_method: 'graph' (default) or 'imap'
 * - refresh_token & client_id are required for Microsoft Graph API
 */
import { getAccessToken, fetchMails } from './lib/ms-graph-email.js';

// Server URL — use WORKER_BASE_URL env var if set, otherwise derive from PORT
const BASE_URL = process.env.WORKER_BASE_URL || `http://localhost:${process.env.PORT || 4000}`;

async function runCheck(input) {
    const parts = input.split('|');
    
    // Support both formats:
    // 5-part: email|password|auth_method|refresh_token|client_id  (preferred)
    // 4-part: email|password|refresh_token|client_id              (legacy, auth_method defaults to 'graph')
    let email, password, authMethod, refreshToken, clientId;
    
    if (parts.length >= 5) {
        [email, password, authMethod, refreshToken, clientId] = parts;
    } else if (parts.length === 4) {
        [email, password, refreshToken, clientId] = parts;
        authMethod = 'graph';
    } else if (parts.length === 3) {
        // email|refresh_token|client_id
        [email, refreshToken, clientId] = parts;
        authMethod = 'graph';
        password = '';
    } else {
        throw new Error(`Invalid input format: expected 3-5 pipe-separated parts, got ${parts.length}`);
    }

    console.log(`[Check] 🔍 Đang kiểm tra Email: ${email} (Auth: ${authMethod.toUpperCase()})`);

    try {
        // Both modes use Microsoft Graph API, so we just use the refresh token
        if (!refreshToken || refreshToken === 'undefined' || refreshToken === 'null') {
            throw new Error('Thiếu Refresh Token — không thể kiểm tra mail');
        }
        if (!clientId || clientId === 'undefined' || clientId === 'null') {
            throw new Error('Thiếu Client ID — không thể kiểm tra mail');
        }

        // Try with scope first, fallback without scope if error
        let token;
        try {
            token = await getAccessToken(refreshToken, clientId, true);
            console.log(`[Check] ✅ Lấy Access Token thành công (với scope).`);
        } catch (scopeErr) {
            if (scopeErr.message.includes('unauthorized') || scopeErr.message.includes('scope')) {
                console.log(`[Check] ⚠️ Scope không được phép, thử lại không scope...`);
                token = await getAccessToken(refreshToken, clientId, false);
                console.log(`[Check] ✅ Lấy Access Token thành công (không scope).`);
            } else {
                throw scopeErr;
            }
        }
        
        const mails = await fetchMails(token, { top: 1 });
        const message = `Kết nối Mailbox thành công. Tìm thấy ${mails.length} email.`;

        console.log(`[Check] ✅ ${message}`);

        // Cập nhật trạng thái vào Pool
        const updateRes = await fetch(`${BASE_URL}/api/vault/email-pool`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email,
                mail_status: 'active',
                last_checked_at: new Date().toISOString(),
                notes: `Mail OK (${new Date().toLocaleTimeString()})`
            }),
        });
        
        if (!updateRes.ok) {
            console.log(`[Check] ⚠️ Không thể cập nhật trạng thái pool: HTTP ${updateRes.status}`);
        }

        console.log(`[Check] 🟢 KẾT QUẢ: HOẠT ĐỘNG TỐT`);
    } catch (err) {
        console.log(`[Check] ❌ THẤT BẠI: ${err.message}`);

        try {
            await fetch(`${BASE_URL}/api/vault/email-pool`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    email,
                    mail_status: 'dead',
                    last_checked_at: new Date().toISOString(),
                    notes: `Lỗi: ${err.message}`
                }),
            });
        } catch (updateErr) {
            console.log(`[Check] ⚠️ Không thể cập nhật trạng thái dead: ${updateErr.message}`);
        }
    }
}

const input = process.argv[2];
if (input) {
    await runCheck(input);
} else {
    console.log('Usage: node scripts/check-mail-worker.js "email|password|auth_method|refresh_token|client_id"');
}
