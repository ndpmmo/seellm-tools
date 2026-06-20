import { runAutoRegister } from './auto-register-worker.js';

const randomSuffix = Math.random().toString(36).slice(-6);
const email = `test_register_${randomSuffix}@outlook.com`;
const chatgptPassword = "T00ls" + Math.random().toString(36).slice(-8) + "12A!";
const refreshToken = "mock_refresh_token_for_validation";
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
