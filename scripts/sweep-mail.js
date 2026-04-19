import { getAccessToken, fetchMails, markMailAsRead } from './lib/ms-graph-email.js';

const refreshToken = process.argv[2] || "M.C507_BAY.0.U.-CrE9G5K5jngpnDATXMFdzj82!B5BgVy7HoVJK*r!oWUfNApucAbnmB5u52fX44f7neRWiakEs2OplWxJUritfnKG4oT7Gf*fMFheJiKWIuUvw6vljYpJX8E1C3AmaNebDth8p3IFLie774vYSDg3S7chc9BLV0P2Uqf6IxgQtRC2zVKKxEqDjaVDAS0zUT1jPVFzcEy67C2F*CMlupTEIwWP1zezA9tRs*c6EtYVVYkJmRshLxU42b7Wc3cN34bTeeWTxWNlrxooM*2sakAlynDunMiy3BmqRhNB39T4U30cxYSbGGmcSwB4e!Dgdo12cVaZcCLOyFNU!4oa2eDyaXTvYo1f3bxfT1Wq7tYxHHtV0*bSD44Zd7P1LYlZkKtQXg$$";
const clientId = "9e5f94bc-e8a4-4e73-b8be-63364c29d753";

async function sweepEmails() {
    console.log(`[Sweep] Đang lấy Access Token...`);
    const accToken = await getAccessToken(refreshToken, clientId);

    const mails = await fetchMails(accToken, { top: 50, filterUnread: true });
    console.log(`[Sweep] Tìm thấy ${mails.length} email chưa đọc.`);

    for (const m of mails) {
        console.log(`[Sweep] Đánh dấu đã đọc: ${m.subject} (${m.receivedDateTime})`);
        await markMailAsRead(m.id, accToken);
    }

    console.log("[Sweep] ✅ Đã dọn dẹp sạch sẽ!");
}

sweepEmails().catch(console.error);
