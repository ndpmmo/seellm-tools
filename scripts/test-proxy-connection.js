// Native fetch used


const CAMOUFOX_API = 'http://localhost:3144';
const PROXY_URL = 'http://user49763:log3uBJMNV@45.32.111.6:49763';
const TEST_URL = 'https://ifconfig.co/json';

async function test() {
    console.log(`[Diagnostic] Testing Camoufox API at ${CAMOUFOX_API}...`);
    try {
        const ping = await fetch(`${CAMOUFOX_API}/health`).catch(e => ({ ok: false, error: e.message }));

        if (!ping.ok) {
            console.error(`[Diagnostic] ❌ Camoufox API is not reachable: ${ping.error || 'Unknown error'}`);
            console.log(`[Diagnostic] Tip: Make sure the Camoufox server is running on port 3144.`);
            return;
        }
        console.log(`[Diagnostic] ✅ Camoufox API is ONLINE.`);

        console.log(`[Diagnostic] [1] Creating tab with proxy: ${PROXY_URL}...`);
        const tabRes = await fetch(`${CAMOUFOX_API}/tabs`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userId: 'diag_user',
                sessionKey: 'diag_session',
                url: TEST_URL,
                proxy: PROXY_URL,
                headless: false

            })
        });

        if (!tabRes.ok) {
            const errBody = await tabRes.text();
            console.error(`[Diagnostic] ❌ Failed to create tab: ${tabRes.status} - ${errBody}`);
            return;
        }

        const tabData = await tabRes.json();
        const tabId = tabData.tabId;
        console.log(`[Diagnostic] ✅ Tab created: ${tabId}`);

        console.log(`[Diagnostic] [2] Waiting for IP check result...`);
        await new Promise(r => setTimeout(r, 10000));

        const evalRes = await fetch(`${CAMOUFOX_API}/tabs/${tabId}/eval`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userId: 'diag_user',
                expression: `document.body.innerText`
            })
        });

        if (evalRes.ok) {
            const data = await evalRes.json();
            console.log(`[Diagnostic] Result from ${TEST_URL}:`);
            console.log(data.result);
        } else {
            console.error(`[Diagnostic] ❌ Failed to eval tab: ${evalRes.status}`);
        }

        // Cleanup
        await fetch(`${CAMOUFOX_API}/tabs/${tabId}?userId=diag_user`, { method: 'DELETE' });
        console.log(`[Diagnostic] Tab closed.`);

    } catch (e) {
        console.error(`[Diagnostic] ❌ Critical Error: ${e.message}`);
    }
}

test();
