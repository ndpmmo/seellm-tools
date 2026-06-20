const CONSUMERS_URL = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";

async function tryScopeForAccount(email, refreshToken, clientId, label, scope) {
    console.log(`\n=== [${email}] ${label} ===`);
    const body = new URLSearchParams({
        client_id: clientId,
        grant_type: 'refresh_token',
        refresh_token: refreshToken
    });
    if (scope) body.append('scope', scope);

    try {
        const r = await fetch(CONSUMERS_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body.toString()
        });
        const d = await r.json();
        if (!r.ok) {
            console.log(`❌ Token failed (${r.status}): ${d.error} — ${d.error_description}`);
            return;
        }
        const token = d.access_token;
        const isEwa = token.startsWith('EwA');
        const isJwt = token.includes('.');
        console.log(`✅ Token OK | length: ${token.length} | type: ${isEwa ? 'EwA' : isJwt ? 'JWT' : 'other'}`);
        console.log(`   Starts: ${token.substring(0, 30)}...`);

        // Test Graph
        const graphR = await fetch('https://graph.microsoft.com/v1.0/me/messages?$top=1&$select=id,subject', {
            headers: { Authorization: `Bearer ${token}` }
        });
        const graphD = await graphR.json().catch(() => ({}));
        if (graphR.ok) {
            console.log(`   📊 Graph API:          ✅ ${graphR.status} | Found: ${graphD.value?.length || 0} messages`);
        } else {
            console.log(`   📊 Graph API:          ❌ ${graphR.status} | ${graphD.error?.code} — ${graphD.error?.message}`);
        }

        // Test Outlook REST
        const outlookR = await fetch('https://outlook.office.com/api/v2.0/me/messages?$top=1&$select=Id,Subject', {
            headers: { Authorization: `Bearer ${token}` }
        });
        const outlookD = await outlookR.json().catch(() => ({}));
        if (outlookR.ok) {
            console.log(`   📧 Outlook REST v2.0: ✅ ${outlookR.status} | Found: ${outlookD.value?.length || 0} messages`);
        } else {
            console.log(`   📧 Outlook REST v2.0: ❌ ${outlookR.status} | ${outlookD.error?.code} — ${outlookD.error?.message}`);
        }
    } catch (e) {
        console.log(`❌ Error: ${e.message}`);
    }
}

const client = "9e5f94bc-e8a4-4e73-b8be-63364c29d753";

console.log("Starting Graph Scope Tests...");

const acc1_email = "omexromersinth@hotmail.com";
const acc1_rt = "M.C547_BL2.0.U.-ClYSJOEmKoPPjD4vDhmrjMJXJYeJ0KnsZmmH7bLDQlHijAvs0lasVC*PNLFsV0LMda1Fjxn19Dt6Kh2LjMeMsADNMSi!18ISvedZQoAtofZW07NVqsPpl1NfKAzUl2EizydEt*idy*yXStuhQES6S9dOJxWWg6GX0CKOYgQT7m37ZJnG1ADFHq1ikplg2p9Aii1dnvMqbI1aSBtDa71lIV7XkIJsmQlGI0N1M!Iu9*lcLNFQqgAS10PrN2tCjXG49G6KzhcdmD1apJFL33YDYzBHHwK0yOrwfTZ2*e8BNL94ZI6N!YYcD**S*yj1YmuiqIqfP9GVNcXELH*Z95tWh!!zMZpj29Z1g1OsHep6BW*rvT8fRznzxPX2dlzho0tLTY8I*6E6nymBZKq21qNXTy8HJ1M4PimoPGTDnHG59mVq";

const acc2_email = "blanchekelseyiryss9793@hotmail.com";
const acc2_rt = "M.C510_BAY.0.U.-CuQTcHRliqQRsQwYE5ynYf!M2APzZnEvJ1cZ0BPRQEP8!wJwg8U9mmcCQ9FTGdeOTbEfW0WnFQRdzVXxCq2cRF633K5pUwsJFD7aeS0H4Fzud3Mx6QCsGNdA4fZUXfAK4vNVr*aeOCKBqvCfd3OeOcM4cvPa8P7TDcp1OlJsJf5nOpOCmH11wstWxktTkTcg9aRcGxNthCNn5mQbxBbF9Ie7*wFw!7Z83ZH3rKuT!7AycJJYXGTD588iy!TN!rDL9ZiSnG139W5YHlJaVi!80BxpieVDETjYy9CLYflDkdB6j4gF698bARpXNpX6xgU23As7vfOeClKSOeOVzzWJBQl9PeO8AY!8G9Wo6HEqCVfECRddghkTFKrfPcPoAyiKxg$$";

await tryScopeForAccount(acc1_email, acc1_rt, client, "No scope", null);
await tryScopeForAccount(acc1_email, acc1_rt, client, "Mail.Read", "Mail.Read offline_access");
await tryScopeForAccount(acc1_email, acc1_rt, client, "outlook.office.com/.default", "https://outlook.office.com/.default offline_access");

await tryScopeForAccount(acc2_email, acc2_rt, client, "No scope", null);
await tryScopeForAccount(acc2_email, acc2_rt, client, "Mail.Read", "Mail.Read offline_access");
await tryScopeForAccount(acc2_email, acc2_rt, client, "outlook.office.com/.default", "https://outlook.office.com/.default offline_access");
