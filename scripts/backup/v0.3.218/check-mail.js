import { getAccessToken, fetchMails } from './lib/ms-graph-email.js';

const email = "omexromersinth@hotmail.com";
const refreshToken = "M.C547_BL2.0.U.-ClYSJOEmKoPPjD4vDhmrjMJXJYeJ0KnsZmmH7bLDQlHijAvs0lasVC*PNLFsV0LMda1Fjxn19Dt6Kh2LjMeMsADNMSi!18ISvedZQoAtofZW07NVqsPpl1NfKAzUl2EizydEt*idy*yXStuhQES6S9dOJxWWg6GX0CKOYgQT7m37ZJnG1ADFHq1ikplg2p9Aii1dnvMqbI1aSBtDa71lIV7XkIJsmQlGI0N1M!Iu9*lcLNFQqgAS10PrN2tCjXG49G6KzhcdmD1apJFL33YDYzBHHwK0yOrwfTZ2*e8BNL94ZI6N!YYcD**S*yj1YmuiqIqfP9GVNcXELH*Z95tWh!!zMZpj29Z1g1OsHep6BW*rvT8fRznzxPX2dlzho0tLTY8I*6E6nymBZKq21qNXTy8HJ1M4PimoPGTDnHG59mVq";
const clientId = "9e5f94bc-e8a4-4e73-b8be-63364c29d753";

async function test() {
    console.log("=== TEST FETCH MAIL V2 ===");
    const accessToken = await getAccessToken(refreshToken, clientId, true, email);
    console.log("✅ Token OK");

    // Test 1: Fetch ALL (no filter)
    console.log("\n--- Test 1: Fetch 5 email gần nhất (bao gồm đã đọc) ---");
    const all = await fetchMails(accessToken, { top: 5, filterUnread: false, email });
    for (const m of all) {
        console.log(`  [${m.receivedDateTime}] ${m.isRead ? '📖' : '📬'} FROM: ${m.from?.emailAddress?.address} | SUBJ: ${m.subject}`);
        const code = m.body?.content?.match(/\b(\d{6})\b/);
        if (code) console.log(`    → OTP: ${code[1]}`);
    }
}

test().catch(console.error);
