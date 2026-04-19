
import { CAMOUFOX_API, WORKER_AUTH_TOKEN } from './config.js';

const USER_ID = 'test_user';

async function api(path, reqBody = {}) {
    const isGet = !reqBody || Object.keys(reqBody).length === 0;
    let finalPath = path + (path.includes('?') ? '&' : '?') + `sessionKey=${WORKER_AUTH_TOKEN}`;
    const res = await fetch(`${CAMOUFOX_API}${finalPath}`, {
        method: isGet ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: isGet ? undefined : JSON.stringify({ ...reqBody, sessionKey: WORKER_AUTH_TOKEN })
    });
    return res.json();
}

async function runDir() {
    const res = await api('/tabs');
    const tabs = res.tabs || res;
    const tab = Array.isArray(tabs) ? tabs.find(t => t.url && t.url.includes('chatgpt')) : null;
    if (!tab) return console.log("No tab");

    // Sniffer
    console.log("Installing sniffer...");
    await api(`/tabs/${tab.id}/eval`, {
        userId: USER_ID,
        expression: `
            window._mfaLog = window._mfaLog || [];
            if (!window._snifferActive) {
                const originalFetch = window.fetch;
                window.fetch = async (...args) => {
                    const url = args[0].toString();
                    if (url.includes('mfa') || url.includes('setup') || url.includes('verify')) {
                        window._mfaLog.push({ url, method: args[1]?.method || 'GET' });
                    }
                    return originalFetch(...args);
                };
                window._snifferActive = true;
            }
        `
    });

    console.log("Clicking trigger...");
    await api(`/tabs/${tab.id}/eval`, {
        userId: USER_ID,
        expression: `
            async function doMfa() {
                // Ensure profile menu is open
                const profile = document.querySelector('button[id*="user-menu"]');
                if (profile) profile.click();
                
                await new Promise(r => setTimeout(r, 1000));
                const settingsBtn = Array.from(document.querySelectorAll('div, button')).find(e => e.textContent === 'Settings');
                if (settingsBtn) settingsBtn.click();
                
                await new Promise(r => setTimeout(r, 1500));
                const secBtn = Array.from(document.querySelectorAll('button')).find(e => e.textContent === 'Security');
                if (secBtn) secBtn.click();
                
                await new Promise(r => setTimeout(r, 1000));
                const enableBtn = Array.from(document.querySelectorAll('button')).find(e => e.textContent.includes('Enable'));
                if (enableBtn) enableBtn.click();
                
                console.log("Done clicks");
            }
            doMfa();
        `
    });

    for (let i = 0; i < 5; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const check = await api(`/tabs/${tab.id}/eval`, { userId: USER_ID, expression: 'window._mfaLog' });
        console.log("Logs:", check.result);
    }
}
runDir();
