import { getAccessToken, fetchMails } from './lib/ms-graph-email.js';

const refreshToken = "M.C507_BAY.0.U.-CrE9G5K5jngpnDATXMFdzj82!B5BgVy7HoVJK*r!oWUfNApucAbnmB5u52fX44f7neRWiakEs2OplWxJUritfnKG4oT7Gf*fMFheJiKWIuUvw6vljYpJX8E1C3AmaNebDth8p3IFLie774vYSDg3S7chc9BLV0P2Uqf6IxgQtRC2zVKKxEqDjaVDAS0zUT1jPVFzcEy67C2F*CMlupTEIwWP1zezA9tRs*c6EtYVVYkJmRshLxU42b7Wc3cN34bTeeWTxWNlrxooM*2sakAlynDunMiy3BmqRhNB39T4U30cxYSbGGmcSwB4e!Dgdo12cVaZcCLOyFNU!4oa2eDyaXTvYo1f3bxfT1Wq7tYxHHtV0*bSD44Zd7P1LYlZkKtQXg$$";
const clientId = "9e5f94bc-e8a4-4e73-b8be-63364c29d753";

async function test() {
    console.log("=== TEST FETCH MAIL V2 ===");
    const accessToken = await getAccessToken(refreshToken, clientId);
    console.log("✅ Token OK");

    // Test 1: Fetch ALL (no filter)
    console.log("\n--- Test 1: Fetch 5 email gần nhất (bao gồm đã đọc) ---");
    const all = await fetchMails(accessToken, { top: 5, filterUnread: false });
    for (const m of all) {
        console.log(`  [${m.receivedDateTime}] ${m.isRead ? '📖' : '📬'} FROM: ${m.from?.emailAddress?.address} | SUBJ: ${m.subject}`);
        const code = m.body?.content?.match(/\b(\d{6})\b/);
        if (code) console.log(`    → OTP: ${code[1]}`);
    }

    // Test 2: Fetch with server-side filter (5 phút gần nhất + từ openai)
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    console.log(`\n--- Test 2: Server-side filter (sau ${fiveMinAgo}, từ openai.com) ---`);
    try {
        const filtered = await fetchMails(accessToken, {
            top: 5,
            filterUnread: false,
            receivedAfter: fiveMinAgo,
            senderContains: 'openai.com',
        });
        console.log(`  Tìm thấy ${filtered.length} email phù hợp`);
        for (const m of filtered) {
            console.log(`  [${m.receivedDateTime}] FROM: ${m.from?.emailAddress?.address} | SUBJ: ${m.subject}`);
        }
    } catch (err) {
        console.error("  ❌ Server filter lỗi:", err.message);
        console.log("  → Sẽ fallback sang client-side filter");
    }

    // Test 3: Fetch with only receivedAfter (không dùng contains filter - phòng hờ)
    console.log(`\n--- Test 3: Chỉ filter thời gian (sau ${fiveMinAgo}) ---`);
    try {
        const timeOnly = await fetchMails(accessToken, {
            top: 5,
            filterUnread: false,
            receivedAfter: fiveMinAgo,
        });
        console.log(`  Tìm thấy ${timeOnly.length} email phù hợp`);
        for (const m of timeOnly) {
            console.log(`  [${m.receivedDateTime}] FROM: ${m.from?.emailAddress?.address} | SUBJ: ${m.subject}`);
        }
    } catch (err) {
        console.error("  ❌ Time filter lỗi:", err.message);
    }
}

test().catch(console.error);
