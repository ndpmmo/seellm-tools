import { CAMOUFOX_API, WORKER_AUTH_TOKEN } from './config.js';
import fs from 'fs/promises';
import path from 'path';

async function testGoogle() {
    console.log(`🚀 Testing Camoufox with Google...`);

    const tabRes = await fetch(`${CAMOUFOX_API}/tabs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            userId: 'test_google',
            sessionKey: WORKER_AUTH_TOKEN,
            url: "https://www.google.com",
            headless: false
        })
    }).then(r => r.json());

    const tabId = tabRes.tabId || tabRes.id;
    if (!tabId) { console.error(tabRes); return; }

    console.log(`✅ Waiting 8s for Google...`);
    await new Promise(r => setTimeout(r, 8000));

    const shotRes = await fetch(`${CAMOUFOX_API}/tabs/${tabId}/screenshot?userId=test_google&sessionKey=${WORKER_AUTH_TOKEN}`);
    if (shotRes.ok) {
        const buffer = await shotRes.arrayBuffer();
        const savePath = path.join(process.cwd(), 'data', 'screenshots', 'google_test.png');
        await fs.mkdir(path.dirname(savePath), { recursive: true }).catch(() => { });
        await fs.writeFile(savePath, Buffer.from(buffer));
        console.log(`✅ Google screenshot saved to: ${savePath}`);
    } else {
        console.error("❌ Google shot failed:", shotRes.status);
    }
}

testGoogle().catch(console.error);
