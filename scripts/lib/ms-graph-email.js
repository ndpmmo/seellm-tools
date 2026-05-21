/**
 * SeeLLM Tools - MS Graph Email Reader Helper v3
 *
 * KEY INSIGHT (tested 2026-05-21):
 * Token type is determined by the CLIENT ID + what consent was granted, NOT by scope requested.
 * Different client IDs return different token types even with the same no-scope request.
 * Must detect AFTER receiving the token:
 *   - EwA* (encrypted, no dots) → Outlook REST API only ✅  /  Graph API → IDX14100 ❌
 *   - EwBY* (opaque, no dots)   → Graph API ✅              /  Outlook REST → 401 ❌
 *   - eyJ* (JWT, has dots)      → Graph API ✅
 */

const GRAPH_TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const GRAPH_TOKEN_URL_CONSUMERS = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token';
const GRAPH_API_BASE = 'https://graph.microsoft.com/v1.0/me';
const OUTLOOK_API_BASE = 'https://outlook.office.com/api/v2.0/me';

// Personal Microsoft account domains — use no-scope token flow for Graph API access.
// Alternatively, use outlook.office.com/.default scope for Outlook REST API.
const PERSONAL_MS_DOMAINS = ['outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'passport.com'];

function isPersonalMsAccount(email) {
    const domain = (email || '').split('@')[1]?.toLowerCase();
    return domain && PERSONAL_MS_DOMAINS.some(d => domain === d || domain.endsWith('.' + d));
}

/**
 * Detect if an MS access token requires Outlook REST API (true) or Graph API (false).
 * EwA* = encrypted → Outlook REST only. EwBY* / JWT = opaque/JWT → Graph API.
 */
function isEwAToken(token) {
    if (!token) return false;
    return token.startsWith('EwA') && !token.startsWith('EwBY');
}

/**
 * Lấy Access Token từ Refresh Token.
 * Returns { token, useOutlookApi } — useOutlookApi is detected from token prefix, NOT guessed.
 *
 * Strategy:
 * 1. Try no-scope first — works for most client IDs
 * 2. Fallback with scope if no-scope fails
 */
export async function getAccessToken(refreshToken, clientId, withScope = true, email = null) {
    if (!refreshToken || !clientId) throw new Error('Refresh Token và Client ID là bắt buộc.');

    const isPersonal = email ? isPersonalMsAccount(email) : false;
    const tokenUrl = isPersonal ? GRAPH_TOKEN_URL_CONSUMERS : GRAPH_TOKEN_URL;

    // Step 1: Try no-scope first — works for most client IDs
    const noScopeParams = new URLSearchParams({
        client_id: clientId,
        grant_type: 'refresh_token',
        refresh_token: refreshToken
    });
    let res = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: noScopeParams.toString(),
    });
    if (res.ok) {
        const data = await res.json();
        const token = data.access_token;
        const useOutlookApi = isEwAToken(token);
        console.log(`[Graph] Token OK (no-scope): ${useOutlookApi ? 'EwA→Outlook REST' : 'EwBY/JWT→Graph'}`);
        return { token, useOutlookApi };
    }

    // Step 2: Fallback with scope
    const err = await res.json().catch(() => ({}));
    console.log(`[Graph] No-scope failed: ${err.error_description?.substring(0, 80)}`);

    const scopeParams = new URLSearchParams({
        client_id: clientId,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        scope: isPersonal
            ? 'https://outlook.office.com/.default offline_access'
            : 'Mail.Read offline_access'
    });
    res = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: scopeParams.toString(),
    });
    if (!res.ok) {
        const err2 = await res.json().catch(() => ({}));
        throw new Error(err2.error_description || `Lỗi lấy Access Token: ${res.status}`);
    }
    const data2 = await res.json();
    const token2 = data2.access_token;
    const useOutlookApi2 = isEwAToken(token2);
    console.log(`[Graph] Token OK (fallback scope): ${useOutlookApi2 ? 'EwA→Outlook REST' : 'EwBY/JWT→Graph'}`);
    return { token: token2, useOutlookApi: useOutlookApi2 };
}

/**
 * Fetch danh sách email với OData filter phía server.
 * Tự động dùng Outlook REST API (EwA token) hoặc Graph API (EwBY/JWT token).
 * 
 * tokenArg có thể là:
 * - string (legacy): dùng Graph API, không biết account type
 * - { token, useOutlookApi } (mới): routing đúng API
 */
export async function fetchMails(tokenArg, { top = 10, filterUnread = false, receivedAfter = null, senderContains = null, email = null } = {}) {
    // Support both legacy string token and new object format
    let accessToken, useOutlookApi;
    if (typeof tokenArg === 'string') {
        accessToken = tokenArg;
        // Legacy: detect from email parameter
        useOutlookApi = email ? false : false; // Legacy callers use Graph API
    } else {
        accessToken = tokenArg.token;
        useOutlookApi = tokenArg.useOutlookApi;
    }

    const isPersonal = useOutlookApi;
    const apiBase = isPersonal ? OUTLOOK_API_BASE : GRAPH_API_BASE;

    const filters = [];
    if (filterUnread) filters.push(isPersonal ? 'IsRead eq false' : 'isRead eq false');
    if (receivedAfter) filters.push(isPersonal ? `ReceivedDateTime ge ${receivedAfter}` : `receivedDateTime ge ${receivedAfter}`);
    if (senderContains) filters.push(isPersonal
        ? `contains(From/EmailAddress/Address,'${senderContains}')`
        : `contains(from/emailAddress/address,'${senderContains}')`
    );

    const selectFields = isPersonal
        ? 'Id,Subject,BodyPreview,Body,From,ToRecipients,ReceivedDateTime,IsRead'
        : 'id,subject,bodyPreview,body,from,toRecipients,receivedDateTime,isRead';

    const orderBy = isPersonal ? 'ReceivedDateTime desc' : 'receivedDateTime desc';
    let url = `${apiBase}/messages?$top=${top}&$orderby=${orderBy}&$select=${selectFields}`;
    if (filters.length > 0) url += `&$filter=${filters.join(' and ')}`;

    const res = await fetch(url, {
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'Prefer': 'outlook.body-content-type="text"',
        },
    });

    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error?.message || `Lỗi fetch mail: ${res.status}`);
    }

    const data = await res.json();
    const messages = data.value || [];

    // Normalize Outlook REST API format to match Graph API format
    if (isPersonal) {
        return messages.map(m => ({
            id: m.Id,
            subject: m.Subject,
            bodyPreview: m.BodyPreview || m.Body?.Content?.substring(0, 255),
            body: m.Body ? { content: m.Body.Content, contentType: m.Body.ContentType } : undefined,
            from: m.From ? { emailAddress: { name: m.From.EmailAddress?.Name, address: m.From.EmailAddress?.Address } } : undefined,
            toRecipients: (m.ToRecipients || []).map(r => ({ emailAddress: { name: r.EmailAddress?.Name, address: r.EmailAddress?.Address } })),
            receivedDateTime: m.ReceivedDateTime,
            isRead: m.IsRead,
        }));
    }
    return messages;
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
        // Pattern 1: Tìm OTP gần từ khóa verification (ưu tiên cao nhất)
        let match = text.match(/(?:code|verification|verify|your code is)[:\s]*(\d{6})/i);
        if (match && match[1]) return match[1];

        // Pattern 2: Tìm OTP có từ khóa phía sau
        match = text.match(/(\d{6})\s*(?:is your|verification|code)/i);
        if (match && match[1]) return match[1];

        // Pattern 3: Tìm bất kỳ số 6 chữ số đứng riêng (word boundary)
        match = text.match(/\b(\d{6})\b/);
        if (match && match[1]) {
            // Double-check: không phải phần của số dài hơn
            const before = text[match.index - 1] || ' ';
            const after = text[match.index + match[0].length] || ' ';
            if (!/\d/.test(before) && !/\d/.test(after)) {
                return match[1];
            }
        }
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

    let tokenEntry = null;
    try {
        tokenEntry = await getAccessToken(refreshToken, clientId, true, email);
        console.log(`[OTP] ✅ Access Token OK (${tokenEntry.useOutlookApi ? 'Outlook REST' : 'Graph API'})`);
    } catch (err) {
        console.error(`[OTP] ❌ Lỗi lấy Access Token: ${err.message}`);
        return null;
    }

    let pollCount = 0;
    while (Date.now() - startTime < maxWaitSecs * 1000) {
        pollCount++;
        try {
            // Fetch email từ server với filter: nhận sau filterAfter + từ sender openai
            const mails = await fetchMails(tokenEntry, {
                top: 5,
                filterUnread: true,
                receivedAfter: filterAfter,
                senderContains: senderDomain,
                email,
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
                    await markMailAsRead(m.id, tokenEntry, email).catch(() => { });
                    return code;
                } else {
                    console.log(`[OTP] ⚠️ Email match nhưng không tìm thấy mã 6 số: "${subject}"`);
                }
            }

            // Nếu không tìm thấy mail chưa đọc, thử tìm cả mail đã đọc (phòng hờ auto-read)
            if (mails.length === 0 && pollCount % 3 === 0) {
                const allMails = await fetchMails(tokenEntry, {
                    top: 3,
                    filterUnread: false,
                    receivedAfter: filterAfter,
                    senderContains: senderDomain,
                    email,
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
 * tokenArg có thể là string (legacy) hoặc { token, useOutlookApi }
 */
export async function markMailAsRead(messageId, tokenArg, email = null) {
    let accessToken, useOutlookApi;
    if (typeof tokenArg === 'string') {
        accessToken = tokenArg;
        useOutlookApi = email ? isPersonalMsAccount(email) : false;
    } else {
        accessToken = tokenArg.token;
        useOutlookApi = tokenArg.useOutlookApi;
    }

    const isPersonal = useOutlookApi;
    const apiBase = isPersonal ? OUTLOOK_API_BASE : GRAPH_API_BASE;
    const body = isPersonal ? { IsRead: true } : { isRead: true };
    const url = `${apiBase}/messages/${messageId}`;
    await fetch(url, {
        method: 'PATCH',
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body)
    });
}
