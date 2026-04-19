import { runAutoRegister } from './auto-register-worker.js';

const email = "darrylbridgetlagan7432@hotmail.com";
// Sinh mật khẩu 15 ký tự đảm bảo qua ải OpenAI
const chatgptPassword = "T00ls" + Math.random().toString(36).slice(-8) + "12A!";
const refreshToken = "M.C507_BAY.0.U.-CrE9G5K5jngpnDATXMFdzj82!B5BgVy7HoVJK*r!oWUfNApucAbnmB5u52fX44f7neRWiakEs2OplWxJUritfnKG4oT7Gf*fMFheJiKWIuUvw6vljYpJX8E1C3AmaNebDth8p3IFLie774vYSDg3S7chc9BLV0P2Uqf6IxgQtRC2zVKKxEqDjaVDAS0zUT1jPVFzcEy67C2F*CMlupTEIwWP1zezA9tRs*c6EtYVVYkJmRshLxU42b7Wc3cN34bTeeWTxWNlrxooM*2sakAlynDunMiy3BmqRhNB39T4U30cxYSbGGmcSwB4e!Dgdo12cVaZcCLOyFNU!4oa2eDyaXTvYo1f3bxfT1Wq7tYxHHtV0*bSD44Zd7P1LYlZkKtQXg$$";
const clientId = "9e5f94bc-e8a4-4e73-b8be-63364c29d753";

const inputStr = `${email}|${chatgptPassword}|${refreshToken}|${clientId}`;

console.log(`[Test] Đang khởi chạy workflow cho: ${email}`);

runAutoRegister(inputStr).then(res => {
    console.log("FINAL RESULT:", JSON.stringify(res, null, 2));
    process.exit(res.success ? 0 : 1);
}).catch(e => {
    console.error(e);
    process.exit(1);
});
