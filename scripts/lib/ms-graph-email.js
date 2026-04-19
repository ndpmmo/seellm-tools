/**
 * SeeLLM Tools - MS Graph Email Reader Helper v2
 * 
 * Đọc email tự động thông qua Microsoft Graph API.
 * Sử dụng OData server-side filter để lọc chính xác email mới nhất từ OpenAI.
 * An toàn khi chạy đa luồng (multi-thread safe).
 */

const GRAPH_TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const GRAPH_API_BASE = 'https://graph.microsoft.com/v1.0/me';

/**
 * Lấy Access Token từ Refresh Token
 */
export async function getAccessToken(refreshToken, clientId) {
    if (!refreshToken || !clientId) throw new Error('Refresh Token và Client ID là bắt buộc.');

    const params = new URLSearchParams({
        client_id: clientId,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        scope: 'https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/User.Read offline_access',
    });

    const res = await fetch(GRAPH_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
    });

    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error_description || `Lỗi lấy Access Token: ${res.status}`);
    }

    const data = await res.json();
    return data.access_token;
}

/**
 * Fetch danh sách email với OData filter phía server.
 * Tham số receivedAfter (ISO string) sẽ được dùng để server chỉ trả về email mới.
 */
export async function fetchMails(accessToken, { top = 10, filterUnread = false, receivedAfter = null, senderContains = null } = {}) {
    const filters = [];
    if (filterUnread) filters.push('isRead eq false');
    if (receivedAfter) filters.push(`receivedDateTime ge ${receivedAfter}`);
    if (senderContains) filters.push(`contains(from/emailAddress/address,'${senderContains}')`);

    let url = `${GRAPH_API_BASE}/messages?$top=${top}&$orderby=receivedDateTime desc&$select=id,subject,bodyPreview,body,from,toRecipients,receivedDateTime,isRead`;
    if (filters.length > 0) url += `&$filter=${filters.join(' and ')}`;

    const res = await fetch(url, {
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'Prefer': 'outlook.body-content-type="text"', // Trả body dạng text thay vì HTML → dễ parse OTP
        },
    });

    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error?.message || `Lỗi fetch mail: ${res.status}`);
    }

    const data = await res.json();
    return data.value || [];
}

/**
 * Trích xuất mã OTP 6 chữ số từ nội dung email.
 * Ưu tiên tìm trong body trước, fallback sang subject.
 */
function extractOTP(mail) {
    // Ưu tiên: body text > bodyPreview > subject
    const sources = [
        mail.body?.content || '',
        mail.bodyPreview || '',
        mail.subject || '',
    ];

    for (const text of sources) {
        // Tìm mã 6 chữ số đứng riêng biệt (không phải 1 phần của mã dài hơn)
        const match = text.match(/\b(\d{6})\b/);
        if (match) return match[1];
    }
    return null;
}

/**
 * Hàm chờ mã OTP từ OpenAI, hoạt động theo cơ chế polling nhanh (mỗi 3s).
 * 
 * ĐẶC ĐIỂM CHÍNH:
 * 1. Dùng OData server-side filter ($filter=receivedDateTime ge ...) → chỉ lấy email mới
 * 2. Lọc theo sender domain phía server → giảm dữ liệu thừa
 * 3. Verify người nhận (toRecipients) → an toàn khi nhiều luồng chạy cùng lúc
 * 4. Dùng body dạng text (không HTML) → regex match chính xác hơn
 * 5. Đánh dấu email đã đọc ngay sau khi lấy OTP → tránh dùng lại
 */
export async function waitForOTPCode({ email, refreshToken, clientId, senderDomain = 'openai.com', maxWaitSecs = 90 }) {
    console.log(`[OTP] ⏳ Polling cho ${email} | sender: *${senderDomain} | timeout: ${maxWaitSecs}s`);

    // Ghi nhận thời điểm TRƯỚC khi gọi hàm này (sẽ được gọi từ worker)
    // Lùi 5 phút để chắc chắn bắt được email đã gửi trước khi function này được invoke.
    // Việc lọc đúng mã sẽ do "mark as read" + "recipient check" đảm nhiệm.
    const filterAfter = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const startTime = Date.now();

    let accessToken = null;
    try {
        accessToken = await getAccessToken(refreshToken, clientId);
        console.log(`[OTP] ✅ Access Token OK`);
    } catch (err) {
        console.error(`[OTP] ❌ Lỗi lấy Access Token: ${err.message}`);
        return null;
    }

    let pollCount = 0;
    while (Date.now() - startTime < maxWaitSecs * 1000) {
        pollCount++;
        try {
            // Fetch email từ server với filter: nhận sau filterAfter + từ sender openai
            const mails = await fetchMails(accessToken, {
                top: 5,
                filterUnread: true,
                receivedAfter: filterAfter,
                senderContains: senderDomain,
            });

            if (pollCount <= 3 || pollCount % 5 === 0) {
                console.log(`[OTP] Poll #${pollCount}: ${mails.length} email từ *${senderDomain} (sau ${filterAfter})`);
            }

            for (const m of mails) {
                const sender = m.from?.emailAddress?.address || '';
                const subject = m.subject || '';
                const received = m.receivedDateTime || '';

                // MULTI-THREAD SAFE: Kiểm tra người nhận có khớp email đang đăng ký không
                const recipients = (m.toRecipients || []).map(r => (r.emailAddress?.address || '').toLowerCase());
                if (recipients.length > 0 && !recipients.includes(email.toLowerCase())) {
                    console.log(`[OTP] ⚠️ Skip: thư gửi cho ${recipients.join(',')} (không phải ${email})`);
                    continue;
                }

                // Trích xuất mã OTP
                const code = extractOTP(m);
                if (code) {
                    console.log(`[OTP] ✅ MÃ OTP: ${code} | Subject: "${subject}" | From: ${sender} | Recv: ${received}`);
                    // Đánh dấu đã đọc ngay lập tức → tránh lần chạy sau nhặt lại
                    await markMailAsRead(m.id, accessToken).catch(() => { });
                    return code;
                } else {
                    console.log(`[OTP] ⚠️ Email match nhưng không tìm thấy mã 6 số: "${subject}"`);
                }
            }

            // Nếu không tìm thấy mail chưa đọc, thử tìm cả mail đã đọc (phòng hờ auto-read)
            if (mails.length === 0 && pollCount % 3 === 0) {
                const allMails = await fetchMails(accessToken, {
                    top: 3,
                    filterUnread: false,
                    receivedAfter: filterAfter,
                    senderContains: senderDomain,
                });
                for (const m of allMails) {
                    const recipients = (m.toRecipients || []).map(r => (r.emailAddress?.address || '').toLowerCase());
                    if (recipients.length > 0 && !recipients.includes(email.toLowerCase())) continue;

                    const code = extractOTP(m);
                    if (code) {
                        console.log(`[OTP] ✅ MÃ OTP (từ mail đã đọc): ${code} | Subject: "${m.subject}"`);
                        return code;
                    }
                }
            }
        } catch (err) {
            console.error(`[OTP] Poll #${pollCount} lỗi: ${err.message}`);
        }

        // Chờ 3 giây rồi poll lại
        await new Promise(r => setTimeout(r, 3000));
    }

    console.log(`[OTP] ❌ Hết giờ (${maxWaitSecs}s) sau ${pollCount} lần poll. Không nhận được OTP.`);
    return null;
}

/**
 * Đánh dấu email là đã đọc (critical: ngăn OTP bị dùng lại)
 */
export async function markMailAsRead(messageId, accessToken) {
    const url = `${GRAPH_API_BASE}/messages/${messageId}`;
    await fetch(url, {
        method: 'PATCH',
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ isRead: true })
    });
}
