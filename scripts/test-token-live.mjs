/**
 * Live test: Which scope + endpoint works for personal MS accounts (hotmail/outlook.com)?
 * 
 * Usage: node scripts/test-token-live.mjs [email] [refreshToken] [clientId]
 * Or edit the defaults below.
 */

const email = process.argv[2] || "blanchekelseyiryss9793@hotmail.com";
const refreshToken = process.argv[3] || "M.C510_BAY.0.U.-CuQTcHRliqQRsQwYE5ynYf!M2APzZnEvJ1cZ0BPRQEP8!wJwg8U9mmcCQ9FTGdeOTbEfW0WnFQRdzVXxCq2cRF633K5pUwsJFD7aeS0H4Fzud3Mx6QCsGNdA4fZUXfAK4vNVr*aeOCKBqvCfd3OeOcM4cvPa8P7TDcp1OlJsJf5nOpOCmH11wstWxktTkTcg9aRcGxNthCNn5mQbxBbF9Ie7*wFw!7Z83ZH3rKuT!7AycJJYXGTD588iy!TN!rDL9ZiSnG139W5YHlJaVi!80BxpieVDETjYy9CLYflDkdB6j4gF698bARpXNpX6xgU23As7vfOeClKSOeOVzzWJBQl9PeO8AY!8G9Wo6HEqCVfECRddghkTFKrfPcPoAyiKxg$$";
const clientId = process.argv[4] || "9e5f94bc-e8a4-4e73-b8be-63364c29d753";

const CONSUMERS_URL = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";
const COMMON_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";

async function tryScope(label, url, scope) {
    console.log(`\n=== ${label} ===`);
    const body = new URLSearchParams({ client_id: clientId, grant_type: 'refresh_token', refresh_token: refreshToken });
    if (scope) body.append('scope', scope);

    try {
        const r = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body.toString()
        });
        const d = await r.json();
        if (!r.ok) {
            console.log(`❌ Token failed (${r.status}): ${d.error} — ${d.error_description?.substring(0, 150)}`);
            return null;
        }
        const token = d.access_token;
        const isEwa = token.startsWith('EwA');
        const isJwt = token.includes('.');
        console.log(`✅ Token OK | length: ${token.length} | type: ${isEwa ? 'EwA (encrypted)' : isJwt ? 'JWT' : 'other'}`);
        console.log(`   Starts: ${token.substring(0, 30)}...`);

        // Test against Outlook REST API
        const outlookR = await fetch('https://outlook.office.com/api/v2.0/me/messages?$top=1&$select=Id,Subject', {
            headers: { Authorization: `Bearer ${token}` }
        });
        const outlookD = await outlookR.json().catch(() => ({}));
        if (outlookR.ok) {
            console.log(`   📧 Outlook REST v2.0: ✅ ${outlookR.status} | Found: ${outlookD.value?.length || 0} messages`);
        } else {
            console.log(`   📧 Outlook REST v2.0: ❌ ${outlookR.status} | ${outlookD.error?.code} — ${outlookD.error?.message?.substring(0, 100)}`);
        }

        // Test against Graph API
        const graphR = await fetch('https://graph.microsoft.com/v1.0/me/messages?$top=1&$select=id,subject', {
            headers: { Authorization: `Bearer ${token}` }
        });
        const graphD = await graphR.json().catch(() => ({}));
        if (graphR.ok) {
            console.log(`   📊 Graph API:          ✅ ${graphR.status} | Found: ${graphD.value?.length || 0} messages`);
        } else {
            console.log(`   📊 Graph API:          ❌ ${graphR.status} | ${graphD.error?.code} — ${graphD.error?.message?.substring(0, 100)}`);
        }

        return token;
    } catch (e) {
        console.log(`❌ Network error: ${e.message}`);
        return null;
    }
}

console.log(`\n🔍 Testing MS token strategies for: ${email}`);
console.log(`   ClientID: ${clientId}`);

await tryScope('1: consumers + IMAP scope (current approach)', CONSUMERS_URL, 'https://outlook.office.com/IMAP.AccessAsUser.All offline_access');
await tryScope('2: consumers + no scope', CONSUMERS_URL, null);
await tryScope('3: common + no scope', COMMON_URL, null);
await tryScope('4: consumers + https://outlook.office.com/.default', CONSUMERS_URL, 'https://outlook.office.com/.default offline_access');

console.log('\n✅ Test complete!');
