/**
 * SeeLLM Tools - ChatGPT Account Session Checker
 * Validates if an account's cookies are still valid and updates its status.
 */

import { spawn } from 'node:child_process';
import { CAMOUFOX_API, TOOLS_API_URL } from './config.js';
import { camofoxPost, camofoxGet, camofoxDelete, navigate, evalJson } from './lib/camofox.js';
import { normalizeProxyUrl } from './lib/proxy-diag.js';
import { getState } from './lib/openai-login-flow.js';

// Wait helper
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Parse command line arguments
function parseArgs() {
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const val = process.argv[i + 1];
      if (val && !val.startsWith('--')) {
        args[key] = val;
        i++;
      } else {
        args[key] = true;
      }
    }
  }
  return args;
}

/**
 * Fast API check using python3 + curl_cffi to verify access token directly
 * @param {string} accessToken
 * @param {string|null} proxyUrl
 * @returns {Promise<{success: boolean, reason?: string}>}
 */
function fastCheckAccessToken(accessToken, proxyUrl) {
  return new Promise((resolve) => {
    if (!accessToken) {
      return resolve({ success: false, reason: 'No token' });
    }

    const env = {
      ...process.env,
      TEST_ACCESS_TOKEN: accessToken,
      TEST_PROXY_URL: proxyUrl || ''
    };

    const pythonCode = `
import os, sys
from curl_cffi import requests
try:
    token = os.environ.get("TEST_ACCESS_TOKEN", "")
    proxy = os.environ.get("TEST_PROXY_URL", "")
    headers = {
        "accept": "application/json",
        "authorization": f"Bearer {token}",
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"
    }
    proxies = {"http": proxy, "https": proxy} if proxy else None
    response = requests.get("https://chatgpt.com/backend-api/models", headers=headers, proxies=proxies, impersonate="chrome131", timeout=12)
    if response.status_code == 200:
        print("SUCCESS")
        sys.exit(0)
    else:
        print(f"FAILED: HTTP {response.status_code}")
        sys.exit(1)
except Exception as e:
    print(f"ERROR: {str(e)}")
    sys.exit(2)
`;

    const child = spawn('python3', ['-'], { env });
    
    let stdout = '';
    let stderr = '';
    
    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    
    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    child.on('close', (code) => {
      const output = stdout.trim();
      if (code === 0 && output === 'SUCCESS') {
        resolve({ success: true });
      } else {
        resolve({ success: false, reason: output || stderr.trim() || `Exit code ${code}` });
      }
    });

    child.stdin.write(pythonCode);
    child.stdin.end();
  });
}

async function runCheck() {
  const args = parseArgs();
  const accountId = args.accountId;

  if (!accountId) {
    console.error('❌ Thiếu tham số --accountId');
    process.exit(1);
  }

  const USER_ID = `check_session_${accountId}`;
  let tabId = null;

  try {
    console.log(`[CheckSession] 🔍 Đang tải thông tin tài khoản ${accountId} từ database...`);
    const accRes = await fetch(`${TOOLS_API_URL}/api/vault/accounts/${accountId}`);
    if (!accRes.ok) {
      throw new Error(`Không thể lấy thông tin tài khoản từ backend (Status: ${accRes.status})`);
    }
    const data = await accRes.json();
    const account = data.account;

    if (!account) {
      throw new Error('Không tìm thấy tài khoản trong database');
    }

    console.log(`[CheckSession] 🔒 Chuẩn bị proxy cho kiểm tra: ${account.proxy_url || 'Không cấu hình proxy'}`);
    let proxyConfig = null;
    if (account.proxy_url) {
      proxyConfig = normalizeProxyUrl(account.proxy_url);
    }

    // ⚡ Fast API check path using access_token + curl_cffi
    if (account.access_token && account.access_token.length > 20) {
      console.log(`[CheckSession] ⚡ Phát hiện Access Token trong DB. Đang kiểm tra trực tiếp qua API (curl_cffi)...`);
      const apiCheck = await fastCheckAccessToken(account.access_token, proxyConfig);
      if (apiCheck.success) {
        console.log(`[CheckSession] ✅ Access Token vẫn hoạt động! Cập nhật DB trạng thái ready (Bỏ qua Camofox)...`);
        await fetch(`${TOOLS_API_URL}/api/vault/accounts/${accountId}/warmup-result`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            status: 'success',
            questionsAsked: 0,
            accountStatus: 'ready',
            notes: 'Fast API check passed',
            accessToken: account.access_token,
            plan: account.plan || undefined,
            workspaceId: account.workspace_id || undefined,
            deviceId: account.device_id || undefined
          })
        });
        console.log(`[CheckSession] 🎉 Hoàn tất kiểm tra session qua API thành công!`);
        return;
      } else {
        console.log(`[CheckSession] ⚠️ API check không thành công: ${apiCheck.reason}. Chuyển sang kiểm tra bằng Camofox...`);
      }
    }

    if (!account.cookies || (typeof account.cookies === 'string' && account.cookies.length < 10)) {
      throw new Error('Tài khoản chưa có cookies hoặc cookies trống');
    }

    // Parse cookies if string
    let parsedCookies = account.cookies;
    if (typeof account.cookies === 'string') {
      try {
        parsedCookies = JSON.parse(account.cookies);
      } catch (_) {
        throw new Error('Định dạng cookies không hợp lệ');
      }
    }

    if (!Array.isArray(parsedCookies) || parsedCookies.length === 0) {
      throw new Error('Cookies rỗng hoặc không đúng cấu trúc mảng');
    }

    // 1. Launch a Camofox tab with the account proxy
    console.log(`[CheckSession] 🦊 Khởi động Camofox tab...`);
    const launchData = {
      userId: USER_ID,
      url: 'about:blank',
      proxy: proxyConfig || undefined
    };

    const tabRes = await camofoxPost('/tabs', launchData);
    if (!tabRes || !tabRes.tabId) {
      throw new Error(`Khởi động tab thất bại: ${JSON.stringify(tabRes)}`);
    }
    tabId = tabRes.tabId;
    console.log(`[CheckSession] ✴️ Đã tạo tab: ${tabId}`);

    // 2. Inject cookies into the browser session
    console.log(`[CheckSession] 🍪 Nạp ${parsedCookies.length} cookies vào browser...`);
    await fetch(`${CAMOUFOX_API}/sessions/${USER_ID}/cookies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookies: parsedCookies })
    });

    // 3. Navigate to ChatGPT
    console.log(`[CheckSession] 🌐 Mở trang ChatGPT...`);
    await navigate(tabId, USER_ID, 'https://chatgpt.com/', 25000);
    await delay(3000);

    // 4. Check state
    console.log(`[CheckSession] 👤 Đang kiểm tra trạng thái đăng nhập...`);
    const state = await getState(tabId, USER_ID);
    console.log(`[CheckSession] Trạng thái: looksLoggedIn=${state.looksLoggedIn}, onAuthDomain=${state.onAuthDomain}, hasDeactivated=${state.hasDeactivated}`);

    if (state.hasDeactivated) {
      throw new Error('ACCOUNT_DEACTIVATED: Tài khoản đã bị vô hiệu hóa hoặc xóa');
    }

    if (!state.looksLoggedIn) {
      // Cookies dead
      console.log(`[CheckSession] ❌ Cookies đã hết hạn hoặc không hợp lệ.`);
      await fetch(`${TOOLS_API_URL}/api/vault/accounts/${accountId}/warmup-result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'failed',
          questionsAsked: 0,
          accountStatus: 'relogin',
          notes: 'Session expired (cookie dead)',
          error: 'Session expired (cookie dead)'
        })
      });
      console.log(`[CheckSession] 🛑 Đã cập nhật trạng thái Re-login về database.`);
      return;
    }

    // 5. Fetch session data if looksLoggedIn
    let sessionData = null;
    let accessToken = undefined;
    let plan = undefined;
    let workspaceId = undefined;
    let deviceId = undefined;

    try {
      console.log(`[CheckSession] 🔄 Lấy thông tin session từ /api/auth/session...`);
      const sessionRes = await evalJson(tabId, USER_ID, `
        fetch('/api/auth/session')
          .then(r => r.ok ? r.json() : null)
          .catch(() => null)
      `);
      if (sessionRes && typeof sessionRes === 'object') {
        sessionData = sessionRes;
        accessToken = sessionRes.accessToken;
        plan = sessionRes.account?.planType;
        workspaceId = sessionRes.account?.id;
      }
    } catch (sessionErr) {
      console.warn(`[CheckSession] ⚠️ Lỗi khi gọi /api/auth/session: ${sessionErr.message}`);
    }

    // Extract fresh cookies
    console.log(`[CheckSession] 🍪 Thu thập cookies mới từ session...`);
    const newCookiesRes = await camofoxGet(`/tabs/${tabId}/cookies?userId=${USER_ID}`).catch(() => null);
    const newCookies = Array.isArray(newCookiesRes?.cookies) ? newCookiesRes.cookies : (Array.isArray(newCookiesRes) ? newCookiesRes : null);
    
    if (newCookies) {
      deviceId = newCookies.find(c => c.name === 'oai-did')?.value || '';
    }

    console.log(`[CheckSession] ✅ Tài khoản LIVE! Cập nhật DB...`);
    await fetch(`${TOOLS_API_URL}/api/vault/accounts/${accountId}/warmup-result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'success',
        questionsAsked: 0,
        cookies: newCookies || undefined,
        accountStatus: 'ready',
        notes: '',
        accessToken,
        plan,
        workspaceId,
        deviceId,
        sessionData
      })
    });
    console.log(`[CheckSession] 🎉 Hoàn tất kiểm tra session thành công!`);

  } catch (err) {
    console.error(`\n❌ [CheckSession] Lỗi: ${err.message}`);
    const isDeactivated = err.message.includes('ACCOUNT_DEACTIVATED');
    
    try {
      await fetch(`${TOOLS_API_URL}/api/vault/accounts/${accountId}/warmup-result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'failed',
          questionsAsked: 0,
          accountStatus: isDeactivated ? 'dead' : 'error',
          notes: err.message,
          error: err.message
        })
      });
      console.log(`[CheckSession] 🛑 Đã cập nhật trạng thái lỗi/dead về database.`);
    } catch (saveErr) {
      console.error(`[CheckSession] Lỗi khi lưu trạng thái: ${saveErr.message}`);
    }
  } finally {
    if (tabId) {
      console.log(`[CheckSession] 🧹 Đóng tab Camofox...`);
      await camofoxDelete(`/tabs/${tabId}?userId=${USER_ID}`);
    }
    console.log(`[CheckSession] KẾT THÚC CHƯƠNG TRÌNH KIỂM TRA SESSION.`);
  }
}

runCheck().then(() => {
  process.exit(0);
}).catch(err => {
  console.error(err);
  process.exit(1);
});
