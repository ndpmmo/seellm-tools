
import { CAMOUFOX_API, WORKER_AUTH_TOKEN } from './config.js';

const USER_ID = 'test_user';

async function api(path, reqBody = {}) {
    const isGet = !reqBody || Object.keys(reqBody).length === 0;
    const finalPath = path + (path.includes('?') ? '&' : '?') + `sessionKey=${WORKER_AUTH_TOKEN}`;
    const res = await fetch(`${CAMOUFOX_API}${finalPath}`, {
        method: isGet ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: isGet ? undefined : JSON.stringify({ ...reqBody, sessionKey: WORKER_AUTH_TOKEN })
    });
    return res.json();
}

async function triggerUI() {
    console.log("Đang tìm Tab đang mở...");
    const res = await api('/tabs');
    const tabs = res.tabs || res;
    
    // Tìm tab của ChatGPT
    const myTab = tabs.find(t => t.url && t.url.includes('chatgpt.com'));
    
    if (!myTab) {
        console.error("Không tìm thấy tab ChatGPT nào đang mở.");
        return;
    }
    
    const tabId = myTab.id;
    const userId = myTab.userId || USER_ID;
    console.log(`Đang thao tác trên Tab: ${tabId}`);

    const script = `
        async function run() {
            const clickByText = (text) => {
                const el = Array.from(document.querySelectorAll('button, div, span, a')).find(e => 
                    e.textContent.trim() === text || e.textContent.includes(text)
                );
                if (el) {
                    el.click();
                    return true;
                }
                return false;
            };

            console.log('Clicking Profile...');
            // Click profile icon (thường là ở góc dưới bên trái hoặc có tên người dùng)
            const profile = document.querySelector('button[id*="user-menu"], .avatar-small, img[alt*="User"]');
            if(profile) profile.click();
            else clickByText('Jacqueline'); // Tên sample lúc nãy

            await new Promise(r => setTimeout(r, 1000));
            console.log('Clicking Settings...');
            clickByText('Settings');
            clickByText('Cài đặt');

            await new Promise(r => setTimeout(r, 1000));
            console.log('Clicking Security...');
            clickByText('Security');
            clickByText('Bảo mật');

            await new Promise(r => setTimeout(r, 1000));
            console.log('Clicking Enable MFA...');
            const enableBtn = Array.from(document.querySelectorAll('button')).find(b => 
                b.textContent.includes('Enable') || b.textContent.includes('Bật')
            );
            if(enableBtn) enableBtn.click();
        }
        run();
    `;

    await api(`/tabs/${tabId}/eval`, { userId: USER_ID, expression: script });
    console.log("Đã gửi lệnh thao tác UI. Hãy kiểm tra cửa sổ Sniffer.");
}

triggerUI();
