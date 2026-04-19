
import { CAMOUFOX_API, WORKER_AUTH_TOKEN } from './config.js';
import { resolve } from 'path';
import { writeFileSync, mkdirSync } from 'fs';

const USER_ID = 'test_user';

async function api(path, reqBody = {}) {
    const isGet = !reqBody || Object.keys(reqBody).length === 0;
    const res = await fetch(`${CAMOUFOX_API}${path}?sessionKey=${WORKER_AUTH_TOKEN}`, {
        method: isGet ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: isGet ? undefined : JSON.stringify({ ...reqBody, sessionKey: WORKER_AUTH_TOKEN })
    });
    if (path.includes('screenshot')) return res.arrayBuffer();
    return res.json();
}

async function run() {
    console.log("Opening new tab...");
    const { tabId: tid } = await api('/tabs', { userId: USER_ID, url: 'https://chatgpt.com/', headless: false });

    console.log("Waiting for load...");
    await new Promise(r => setTimeout(r, 10000));

    console.log("Clicking profile menu...");
    await api(`/tabs/${tid}/eval`, {
        userId: USER_ID,
        expression: `
        const btn = document.querySelector('button[aria-label="Profile"]');
        if (btn) btn.click();
        else {
            const allBtn = Array.from(document.querySelectorAll('button'));
            const p = allBtn.find(b => b.textContent.includes('Jacqueline'));
            if(p) p.click();
        }
        `
    });
    await new Promise(r => setTimeout(r, 2000));

    console.log("Clicking Settings...");
    await api(`/tabs/${tid}/eval`, {
        userId: USER_ID,
        expression: `
        const items = Array.from(document.querySelectorAll('[role="menuitem"]'));
        const s = items.find(i => i.textContent.includes('Settings') || i.textContent.includes('Cài đặt'));
        if(s) s.click();
        `
    });
    await new Promise(r => setTimeout(r, 3000));

    console.log("Dumping Settings DOM...");
    const dom = await api(`/tabs/${tid}/eval`, {
        userId: USER_ID,
        expression: "document.querySelector('div[role=\"dialog\"]')?.innerHTML"
    });
    if (dom.result) {
        writeFileSync(resolve('data', 'screenshots', 'settings_modal.html'), dom.result);
        console.log("Dumped to settings_modal.html");
    }

    console.log("Clicking Security tab directly using id...");
    await api(`/tabs/${tid}/eval`, {
        userId: USER_ID,
        expression: `
        const sec = document.querySelector('[data-testid="security-tab"]');
        if (sec) {
            sec.dispatchEvent(new MouseEvent('mousedown', {bubbles:true}));
            sec.dispatchEvent(new MouseEvent('mouseup', {bubbles:true}));
            sec.click();
        }
        `
    });
    await new Promise(r => setTimeout(r, 2000));

    console.log("Dumping Security DOM...");
    const secDom = await api(`/tabs/${tid}/eval`, {
        userId: USER_ID,
        expression: "document.querySelector('div[role=\"dialog\"]')?.innerHTML"
    });
    if (secDom.result) {
        writeFileSync(resolve('data', 'screenshots', 'security_modal.html'), secDom.result);
    }

    console.log("Taking screenshot...");
    const buf = await api(`/tabs/${tid}/screenshot?userId=${USER_ID}&fullPage=true`);
    writeFileSync(resolve('data', 'screenshots', `security_tab_sniff.png`), Buffer.from(buf));
    console.log("Done: security_tab_sniff.png");
}
run();
