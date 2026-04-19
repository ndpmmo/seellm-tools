import { getAccessToken, fetchMails } from './lib/ms-graph-email.js';

const email = "blanchekelseyiryss9793@hotmail.com";
const refreshToken = "M.C510_BAY.0.U.-CuQTcHRliqQRsQwYE5ynYf!M2APzZnEvJ1cZ0BPRQEP8!wJwg8U9mmcCQ9FTGdeOTbEfW0WnFQRdzVXxCq2cRF633K5pUwsJFD7aeS0H4Fzud3Mx6QCsGNdA4fZUXfAK4vNVr*aeOCKBqvCfd3OeOcM4cvPa8P7TDcp1OlJsJf5nOpOCmH11wstWxktTkTcg9aRcGxNthCNn5mQbxBbF9Ie7*wFw!7Z83ZH3rKuT!7AycJJYXGTD588iy!TN!rDL9ZiSnG139W5YHlJaVi!80BxpieVDETjYy9CLYflDkdB6j4gF698bARpXNpX6xgU23As7vfOeClKSOeOVzzWJBQl9PeO8AY!8G9Wo6HEqCVfECRddghkTFKrfPcPoAyiKxg$$";
const clientId = "9e5f94bc-e8a4-4e73-b8be-63364c29d753";

async function debugMails() {
    console.log(`[Email Debug] Đang lấy Access Token...`);
    const accToken = await getAccessToken(refreshToken, clientId);
    console.log(`[Email Debug] Fetching 5 mails (Bao gồm cả Đã đọc & Chưa đọc)...`);

    // filterUnread = false để lấy cả thư đã đọc
    const mails = await fetchMails(accToken, 5, false);

    if (!mails || mails.length === 0) {
        console.log("Không tìm thấy bức thư nào!");
        return;
    }

    mails.forEach((m, idx) => {
        console.log(`\n--- MAIL ${idx + 1} ---`);
        console.log(`Từ (From): ${m.from?.emailAddress?.address}`);
        console.log(`Tiêu đề (Subject): ${m.subject}`);
        console.log(`Ngày nhận (Received): ${m.receivedDateTime}`);
        console.log(`Đã đọc? (isRead): ${m.isRead}`);
        // In thử preview
        console.log(`Preview: ${m.bodyPreview}`);
    });
}

debugMails().catch(console.error);
