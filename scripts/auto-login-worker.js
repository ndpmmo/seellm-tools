/**
 * SeeLLM Tools - Auto-Login Worker (Multi-thread)
 * 
 * Worker tự động poll task từ SeeLLM Gateway và thực hiện
 * Codex/OpenAI OAuth login thông qua Camofox Browser.
 * 
 * Flow:
 *  1. Poll task từ Gateway API
 *  2. Mở tab Camofox với proxy riêng
 *  3. Điều hướng đến OAuth URL
 *  4. Điền email → password → 2FA (nếu có) → Consent
 *  5. Bắt authorization code từ redirect URL
 *  6. Gửi kết quả về Gateway
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CAMOUFOX_API, GATEWAY_URL, WORKER_AUTH_TOKEN, POLL_INTERVAL_MS, MAX_THREADS } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR   = path.join(__dirname, '..');
const IMAGES_DIR = path.join(ROOT_DIR, 'data', 'screenshots');

// ============================================
// TIỆN ÍCH
// ============================================

/** Tạo mã TOTP (2FA) từ secret key Base32 */
function getTOTP(secret) {
  function base32tohex(base32) {
    const base32chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = '', hex = '';
    const clean = base32.replace(/\s/g, '').toUpperCase();
    for (let i = 0; i < clean.length; i++) {
      const val = base32chars.indexOf(clean.charAt(i));
      if (val === -1) continue;
      bits += val.toString(2).padStart(5, '0');
    }
    for (let i = 0; i + 4 <= bits.length; i += 4) {
      hex += parseInt(bits.substr(i, 4), 2).toString(16);
    }
    return hex;
  }
  const key = base32tohex(secret);
  const epoch = Math.round(Date.now() / 1000);
  const time = Buffer.from(Math.floor(epoch / 30).toString(16).padStart(16, '0'), 'hex');
  const hmac = createHmac('sha1', Buffer.from(key, 'hex'));
  const h = hmac.update(time).digest();
  const offset = h[h.length - 1] & 0xf;
  const otp = (h.readUInt32BE(offset) & 0x7fffffff) % 1000000;
  return otp.toString().padStart(6, '0');
}

// ============================================
// CAMOFOX API HELPERS
// ============================================

async function camofoxPost(endpoint, body) {
  const res = await fetch(`${CAMOUFOX_API}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Camofox ${endpoint} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function camofoxGet(endpoint) {
  const res = await fetch(`${CAMOUFOX_API}${endpoint}`);
  if (!res.ok) throw new Error(`Camofox GET ${endpoint} failed: ${res.status}`);
  return res.json();
}

async function camofoxDelete(endpoint) {
  await fetch(`${CAMOUFOX_API}${endpoint}`, { method: 'DELETE' });
}

// ============================================
// LOGIN FLOW
// ============================================

async function runLoginFlow(task) {
  const account = task;
  const USER_ID = `seellm_worker_${task.id}`;
  let tabId;

  console.log(`\n===========================================`);
  console.log(`[*] Bắt đầu xử lý: ${account.email}`);
  console.log(`===========================================`);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const runDir = path.join(IMAGES_DIR, `run_${task.id}_${timestamp}`);
  await fs.mkdir(runDir, { recursive: true });

  let stepCount = 0;
  const saveStep = async (tid, name) => {
    stepCount++;
    const filename = `${String(stepCount).padStart(2, '0')}_${name}.png`;
    try {
      const res = await fetch(
        `${CAMOUFOX_API}/tabs/${tid}/screenshot?userId=${USER_ID}&fullPage=true`
      );
      if (res.ok) {
        await fs.writeFile(path.join(runDir, filename), Buffer.from(await res.arrayBuffer()));
        console.log(`[Ảnh ${stepCount}] Lưu: ${filename}`);
      }
    } catch (_) {}
  };

  try {
    // 1. Mở tab với proxy
    const { tabId: tid } = await camofoxPost('/tabs', {
      userId: USER_ID,
      sessionKey: `codex_${task.id}`,
      url: account.loginUrl || account.authUrl || 'https://auth.openai.com/',
      proxy: account.proxyUrl || account.proxy || undefined,
    });
    tabId = tid;
    console.log(`[1] Tab mở thành công: ${tabId}`);
    await new Promise(r => setTimeout(r, 8000));
    await saveStep(tabId, 'khoi_dong');

    // 2. Điền email
    console.log(`[2] Điền email: ${account.email}`);
    await camofoxPost(`/tabs/${tabId}/type`, {
      userId: USER_ID,
      selector: 'input[name="username"], #username, input[type="email"]',
      text: account.email,
    });
    await saveStep(tabId, 'da_dien_email');

    console.log(`[3] Bấm Continue (Email)...`);
    await camofoxPost(`/tabs/${tabId}/press`, { userId: USER_ID, key: 'Enter' });
    await new Promise(r => setTimeout(r, 5000));
    await saveStep(tabId, 'sau_email');

    // 3. Điền password
    console.log(`[4] Điền password...`);
    await camofoxPost(`/tabs/${tabId}/type`, {
      userId: USER_ID,
      selector: 'input[type="password"], input[name="password"], #password',
      text: account.password,
    });
    await saveStep(tabId, 'da_dien_password');

    console.log(`[5] Bấm Continue (Password)...`);
    await camofoxPost(`/tabs/${tabId}/press`, { userId: USER_ID, key: 'Enter' });
    await new Promise(r => setTimeout(r, 8000));
    await saveStep(tabId, 'sau_password');

    // 4. Xử lý 2FA nếu cần
    const snapData = await camofoxGet(`/tabs/${tabId}/snapshot?userId=${USER_ID}`);
    const snapText = snapData.snapshot || '';
    if (snapText.includes('code') || snapText.includes('2FA') || snapText.includes('authenticator')) {
      if (!account.twoFaSecret) {
        console.log(`[${task.email}] ⚠️ Cần 2FA nhưng không có secret, bỏ qua...`);
      } else {
        const otp = getTOTP(account.twoFaSecret);
        console.log(`[${task.email}] 2FA → OTP: ${otp}`);
        await camofoxPost(`/tabs/${tabId}/type`, {
          userId: USER_ID,
          selector: 'input[autocomplete="one-time-code"], input[type="text"]',
          text: otp,
        });
        await camofoxPost(`/tabs/${tabId}/press`, { userId: USER_ID, key: 'Enter' });
        await new Promise(r => setTimeout(r, 10000));
        await saveStep(tabId, 'sau_2fa');
      }
    }

    // 5. Xử lý màn hình Consent (Bao gồm cả chọn Workspace cho tk Business)
    const consentSnap = await camofoxGet(`/tabs/${tabId}/snapshot?userId=${USER_ID}`);
    if (consentSnap.url?.includes('consent')) {
      console.log(`[${task.email}] Consent screen → Xử lý ủy quyền / chọn Workspace...`);
      
      // Nếu có yêu cầu chọn workspace theo cấu hình của tài khoản (tuỳ chọn)
      if (account.workspaceName) {
        console.log(`[${task.email}] Đang cố gắng chọn workspace: ${account.workspaceName}`);
        try {
          await camofoxPost(`/tabs/${tabId}/click`, {
            userId: USER_ID,
            selector: `text=${account.workspaceName}`,
          });
          await new Promise(r => setTimeout(r, 2000));
        } catch(e) {
          console.log(`[${task.email}] Không tìm thấy workspace: ${account.workspaceName}, dùng mặc định.`);
        }
      }

      console.log(`[${task.email}] Bấm nút Continue / Tiếp tục...`);
      await camofoxPost(`/tabs/${tabId}/click`, {
        userId: USER_ID,
        selector: 'button:has-text("Allow"), button:has-text("Continue"), button:has-text("Tiếp tục"), button[type="submit"]',
      });
      await new Promise(r => setTimeout(r, 8000));
      await saveStep(tabId, 'sau_consent');
    }

    // 6. Lấy authorization code từ URL redirect
    const finalSnap = await camofoxGet(`/tabs/${tabId}/snapshot?userId=${USER_ID}`);
    console.log(`[${task.email}] URL cuối:`, finalSnap.url);

    if (finalSnap.url?.includes('code=')) {
      const code = new URL(finalSnap.url).searchParams.get('code');
      console.log(`[${task.email}] ✅ Lấy được Code: ${code?.substring(0, 20)}...`);
      await sendResultToGateway(task.id, 'success', 'Đã lấy được code thành công', {
        code,
        codeVerifier: account.codeVerifier,
        finalUrl: finalSnap.url,
      });
      console.log(`[${task.email}] 🏁 HOÀN TẤT.`);
    } else {
      console.log(`[${task.email}] ❌ THẤT BẠI: Không thấy Code trong URL cuối.`);
      await sendResultToGateway(task.id, 'error', 'Không tìm thấy code trong URL redirect', {
        finalUrl: finalSnap.url,
      });
    }
  } catch (err) {
    console.error(`[!] Lỗi xử lý ${account.email}:`, err.message);
    await sendResultToGateway(task.id, 'error', err.message, null);
  } finally {
    if (tabId) {
      try {
        await camofoxDelete(`/tabs/${tabId}?userId=${USER_ID}`);
        console.log(`[Camofox] 🧹 Đã đóng tab ${tabId}`);
      } catch (_) {}
    }
  }
}

// ============================================
// GATEWAY COMMUNICATION
// ============================================

async function sendResultToGateway(taskId, status, message, result) {
  try {
    const res = await fetch(`${GATEWAY_URL}/api/public/worker/result`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WORKER_AUTH_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ id: taskId, status, message, result }),
    });
    if (res.ok) {
      console.log(`[Gateway] ✅ Gửi kết quả (${status}) thành công.`);
    } else {
      console.log(`[Gateway] ❌ API từ chối: HTTP ${res.status}`);
    }
  } catch (e) {
    console.error('[Gateway Error] Không thể kết nối VPS:', e.message);
  }
}

async function fetchTask() {
  try {
    const res = await fetch(`${GATEWAY_URL}/api/public/worker/task`, {
      headers: {
        Authorization: `Bearer ${WORKER_AUTH_TOKEN}`,
        Accept: 'application/json',
      },
    });
    if (res.status === 401) {
      console.log(`[!] Lỗi xác thực (401) - Kiểm tra WORKER_AUTH_TOKEN`);
      return null;
    }
    if (res.status !== 200) return null;
    const data = await res.json();
    return data.task;
  } catch (e) {
    console.error('[!] Lỗi kết nối Gateway:', e.message);
    return null;
  }
}

// ============================================
// POLLING LOOP
// ============================================
let activeThreads = 0;

async function pollTasks() {
  if (activeThreads >= MAX_THREADS) return;
  try {
    const task = await fetchTask();
    if (task?.id) {
      activeThreads++;
      console.log(`[Worker] 🚀 Luồng mới: ${task.email} (${activeThreads}/${MAX_THREADS})`);
      runLoginFlow(task)
        .then(() => {
          activeThreads--;
          console.log(`[Worker] ✅ Hoàn tất ${task.email}. Còn trống: ${MAX_THREADS - activeThreads}`);
          if (activeThreads < MAX_THREADS) setTimeout(pollTasks, 1000);
        })
        .catch(err => {
          activeThreads--;
          console.error(`[Worker] ❌ Lỗi luồng ${task.email}:`, err.message);
        });
      if (activeThreads < MAX_THREADS) setTimeout(pollTasks, 2000);
    }
  } catch (err) {
    console.error('[!] Lỗi poll tasks:', err.message);
  }
}

// ============================================
// KHỞI ĐỘNG
// ============================================
console.log(`\n================================`);
console.log(`🤖 SEELLM AUTO-LOGIN WORKER (ĐA LUỒNG)`);
console.log(`================================`);
console.log(`- GATEWAY: ${GATEWAY_URL}`);
console.log(`- CAMOFOX: ${CAMOUFOX_API}`);
console.log(`- MAX THREADS: ${MAX_THREADS}`);
console.log(`- POLL: mỗi ${POLL_INTERVAL_MS}ms`);
console.log(`================================\n`);

setInterval(pollTasks, POLL_INTERVAL_MS);
pollTasks();
