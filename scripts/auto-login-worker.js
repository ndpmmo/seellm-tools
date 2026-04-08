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

/** Đợi selector xuất hiện trên trang bằng cách poll snapshot định kỳ (Smart Observer) */
async function waitForSelector(tabId, userId, selectorPatterns, timeoutMs = 25000) {
  const start = Date.now();
  console.log(`[Wait] Đợi selector: ${selectorPatterns.join(', ')}...`);
  while (Date.now() - start < timeoutMs) {
    const snap = await camofoxGet(`/tabs/${tabId}/snapshot?userId=${userId}`);
    const html = (snap.snapshot || '').toLowerCase();
    
    // [AUTO-HEALING] Quét các mã lỗi phổ biến trên màn hình để cắt ngang thay vì chờ chết
    if (html.includes('email is required') || html.includes('enter a valid email')) {
      throw new Error("Lỗi UI: Email không hợp lệ hoặc bị trống.");
    }
    if (html.includes('wrong email') || html.includes('we could not find your account')) {
      throw new Error("Lỗi UI: Account không tồn tại.");
    }
    if (html.includes('wrong password') || html.includes('incorrect password')) {
      throw new Error("Lỗi UI: Sai mật khẩu.");
    }
    if (html.includes('suspicious login behavior') || html.includes('we have detected suspicious')) {
      throw new Error("Lỗi UI: IP Proxy bị đánh dấu Suspicious.");
    }
    if (html.includes('access denied')) {
      throw new Error("Lỗi UI: Access Denied (Cloudflare Block / IP Block).");
    }

    for (const pat of selectorPatterns) {
      if (html.includes(pat.toLowerCase())) {
        console.log(`[Wait] ✅ Thấy selector khớp mẫu: ${pat}`);
        return true;
      }
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  return false;
}

async function runLoginFlow(task) {
  const account = task;
  const USER_ID = `seellm_worker_${task.id}`;
  let tabId;

  console.log(`\n===========================================`);
  if (!account.email || account.email.trim() === '') {
    console.log(`[!] Lỗi: Tài khoản ID ${task.id} không có Email. Bỏ qua.`);
    console.log(`===========================================`);
    throw new Error('Missing Email Address in record');
  }
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
    const loginUrl = account.loginUrl || account.authUrl || 'https://chatgpt.com/auth/login';
    console.log(`[1] Mở URL: ${loginUrl}`);
    const { tabId: tid } = await camofoxPost('/tabs', {
      userId: USER_ID,
      sessionKey: `codex_${task.id}`,
      url: loginUrl,
      proxy: account.proxyUrl || account.proxy || undefined,
      // --- CẤU HÌNH ẨN DANH NÂNG CAO & SẠCH TUYỆT ĐỐI ---
      persistent: false,       // KHÔNG lưu lại bất kỳ dữ liệu gì sau khi đóng (Sạch 100%)
      os: 'macos',             // Ép vân tay hệ điều hành MacOS
      screen: { width: 1440, height: 900 }, 
      humanize: true,          
      headless: false,         
      randomFonts: true,       // Ngẫu nhiên hóa danh sách Font chữ (Chống Fingerprinting)
      canvas: 'random',        // Ngẫu nhiên hóa vân tay đồ họa Canvas
    });
    tabId = tid;
    console.log(`[1] Tab mở thành công: ${tabId}`);
    
    // Chờ trang tải và Cloudflare (15 giây)
    await new Promise(r => setTimeout(r, 15000));
    await saveStep(tabId, 'khoi_dong');

    // 2. Nhận diện và Xử lý trang Email
    const emailSelectors = ['username', 'email-input', 'email', 'identifier'];
    const hasEmailField = await waitForSelector(tabId, USER_ID, emailSelectors, 30000);
    
    if (!hasEmailField) {
      // Có thể đang kẹt ở màn hình Welcome hoặc Cloudflare
      console.log(`[2] ⚠️ Không thấy ô Email ngay lập tức, thử bấm "Log in" nếu có...`);
      try {
        await camofoxPost(`/tabs/${tabId}/click`, { userId: USER_ID, selector: 'button:has-text("Log in"), a:has-text("Log in")' });
        await new Promise(r => setTimeout(r, 5000));
      } catch(e) {}
    }

    console.log(`[2] Điền email: ${account.email}`);
    const emailInputSelector = 'input[name="username"], #username, input[type="email"], #email-input, input[name="email-input"], input[name="email"]';
    await camofoxPost(`/tabs/${tabId}/type`, {
      userId: USER_ID,
      selector: emailInputSelector,
      text: account.email,
    });
    await saveStep(tabId, 'da_dien_email');

    console.log(`[3] Bấm nút Continue...`);
    // Thử click nút cụ thể thay vì Enter triệu hồi timeout
    try {
      await camofoxPost(`/tabs/${tabId}/click`, {
        userId: USER_ID,
        selector: 'button[type="submit"], button:has-text("Continue"), button:has-text("Tiếp tục")',
      });
    } catch(e) {
      await camofoxPost(`/tabs/${tabId}/press`, { userId: USER_ID, key: 'Enter' });
    }
    
    await new Promise(r => setTimeout(r, 6000));
    await saveStep(tabId, 'sau_email');

    // 3. Đợi và điền Password
    const hasPasswordField = await waitForSelector(tabId, USER_ID, ['password', 'passwd'], 25000);
    if (!hasPasswordField) {
      // OpenAI thi thoảng bắt chọn "Personal account" hoặc có màn hình trung gian
      console.log(`[4] ⚠️ Chưa thấy ô Password, thử bấm Enter lần nữa hoặc click lân cận...`);
      await camofoxPost(`/tabs/${tabId}/press`, { userId: USER_ID, key: 'Enter' });
      await new Promise(r => setTimeout(r, 5000));
    }

    console.log(`[4] Điền password...`);
    await camofoxPost(`/tabs/${tabId}/type`, {
      userId: USER_ID,
      selector: 'input[type="password"], input[name="password"], #password',
      text: account.password,
    });
    await saveStep(tabId, 'da_dien_password');

    console.log(`[5] Gửi mật khẩu...`);
    try {
      await camofoxPost(`/tabs/${tabId}/click`, {
        userId: USER_ID,
        selector: 'button[type="submit"], button:has-text("Continue"), button:has-text("Tiếp tục"), button:has-text("Log in")',
      });
    } catch(e) {
      await camofoxPost(`/tabs/${tabId}/press`, { userId: USER_ID, key: 'Enter' });
    }
    
    await new Promise(r => setTimeout(r, 10000));
    await saveStep(tabId, 'sau_password');

    // 4. Xử lý 2FA (Bổ sung poll thông minh hơn)
    let isAtMFA = false;
    for (let j = 0; j < 5; j++) {
      const snapData = await camofoxGet(`/tabs/${tabId}/snapshot?userId=${USER_ID}`);
      const snap2Url = (snapData.url || '').toLowerCase();
      const snapText = (snapData.snapshot || '').toLowerCase();
      isAtMFA = snap2Url.includes('mfa') || snap2Url.includes('verify') || 
                snapText.includes('one-time code') || snapText.includes('authenticator') ||
                snapText.includes('enter the code');
      
      if (isAtMFA) break;
      if (snap2Url.includes('localhost:1455') || snap2Url.includes('code=')) break; // Đã qua màn 2FA
      await new Promise(r => setTimeout(r, 2000));
    }

    if (isAtMFA) {
      console.log(`[${task.email}] 🛡️ Đang ở màn hình 2FA/MFA...`);
      if (!account.twoFaSecret) {
        console.log(`[${task.email}] ⚠️ Cần 2FA nhưng không có secret, chờ thủ công hoặc timeout.`);
      } else {
        const mfaSelector = 'input[autocomplete="one-time-code"], input[name="code"], input[type="text"], input[inputmode="numeric"]';
        try { await camofoxPost(`/tabs/${tabId}/click`, { userId: USER_ID, selector: mfaSelector }); } catch(e) {}

        // Sinh OTP MỚI ngay lúc này để đảm bảo còn thời hạn (TOTP hết hạn sau 30s)
        const otp = getTOTP(account.twoFaSecret);
        console.log(`[${task.email}] 🔢 Nhập OTP: ${otp} (còn ${30 - (Math.floor(Date.now()/1000) % 30)}s)`);

        await camofoxPost(`/tabs/${tabId}/type`, {
          userId: USER_ID,
          selector: mfaSelector,
          text: otp,
        });
        await camofoxPost(`/tabs/${tabId}/press`, { userId: USER_ID, key: 'Enter' });
        await new Promise(r => setTimeout(r, 6000));

        // Kiểm tra nếu vẫn còn ở màn 2FA (OTP bị từ chối, thử lại với mã mới)
        const afterMFASnap = await camofoxGet(`/tabs/${tabId}/snapshot?userId=${USER_ID}`);
        const afterMFAText = (afterMFASnap.snapshot || '').toLowerCase();
        const afterMFAUrl  = (afterMFASnap.url || '').toLowerCase();
        const stillAtMFA   = afterMFAText.includes('one-time code') || afterMFAText.includes('authenticator') ||
                             afterMFAText.includes('enter the code') || afterMFAUrl.includes('mfa');
        if (stillAtMFA) {
          // Chờ chu kỳ TOTP mới (tối đa 35s) rồi thử lại
          const secsRemaining = 30 - (Math.floor(Date.now()/1000) % 30);
          console.log(`[${task.email}] ⚠️ OTP bị từ chối, chờ ${secsRemaining}s cho chu kỳ mới...`);
          await new Promise(r => setTimeout(r, (secsRemaining + 2) * 1000));

          const otp2 = getTOTP(account.twoFaSecret);
          console.log(`[${task.email}] 🔄 Retry OTP: ${otp2}`);
          try {
            await camofoxPost(`/tabs/${tabId}/triple-click`, { userId: USER_ID, selector: mfaSelector });
          } catch(e) {
            try { await camofoxPost(`/tabs/${tabId}/click`, { userId: USER_ID, selector: mfaSelector }); } catch(_) {}
          }
          await camofoxPost(`/tabs/${tabId}/type`, { userId: USER_ID, selector: mfaSelector, text: otp2 });
          await camofoxPost(`/tabs/${tabId}/press`, { userId: USER_ID, key: 'Enter' });
          await new Promise(r => setTimeout(r, 6000));
        }
      }
      await saveStep(tabId, 'sau_2fa');
    }

    // 5. Đợi redirect về trang Consent hoặc Success
    console.log(`[${task.email}] Đang theo dõi redirect về localhost hoặc mã Code...`);
    let redirectUrl = null;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const checkSnap = await camofoxGet(`/tabs/${tabId}/snapshot?userId=${USER_ID}`);
      const curUrl = checkSnap.url || '';
      const html = (checkSnap.snapshot || '').toLowerCase();

      // Nếu thấy màn hình Consent (Uỷ quyền)
      if (curUrl.includes('consent') || html.includes('authorize') || html.includes('allow')) {
        console.log(`[${task.email}] Thấy màn hình Consent → Bấm Continue/Allow...`);
        try {
          await camofoxPost(`/tabs/${tabId}/click`, {
            userId: USER_ID,
            selector: 'button:has-text("Allow"), button:has-text("Continue"), button:has-text("Tiếp tục"), button[type="submit"]',
          });
        } catch(e) {}
      }

      if (curUrl.includes('localhost:1455') || curUrl.includes('code=')) {
        redirectUrl = curUrl;
        console.log(`[${task.email}] ✅ Tìm thấy đích: ${curUrl}`);
        break;
      }
      
      // Nếu kẹt ở màn hình login (OpenAI đôi khi quay vòng)
      if (i > 5 && (curUrl.includes('login') || html.includes('forgot password'))) {
        console.log(`[${task.email}] ⚠️ Có vẻ bị kẹt ở Login, thử Enter lần nữa...`);
        await camofoxPost(`/tabs/${tabId}/press`, { userId: USER_ID, key: 'Enter' });
      }
    }

    await saveStep(tabId, 'ket_thuc_flow');

    if (redirectUrl && redirectUrl.includes('code=')) {
      const urlObj = new URL(redirectUrl);
      const code = urlObj.searchParams.get('code');
      console.log(`[${task.email}] ✅ SUCCESS! Code: ${code?.substring(0, 20)}...`);
      await sendResultToGateway(task, 'success', 'Đã lấy được code thành công', {
        code,
        codeVerifier: account.codeVerifier,
        finalUrl: redirectUrl,
      });
    } else {
      console.log(`[${task.email}] ❌ THẤT BẠI: Không thấy Code sau 40s.`);
      await sendResultToGateway(task, 'error', 'Hết thời gian chờ hoặc không tìm thấy code trong URL redirect', {
        finalUrl: redirectUrl || 'unknown',
      });
    }
  } catch (err) {
    console.error(`[!] Lỗi xử lý ${account.email}:`, err.message);
    await sendResultToGateway(task, 'error', `Lỗi Worker: ${err.message}`, null);
  } finally {
    if (tabId) {
      try {
        await camofoxDelete(`/tabs/${tabId}?userId=${USER_ID}`);
        console.log(`[Camofox] 🧹 Đóng tab ${tabId}`);
      } catch (_) {}
    }
  }
}

// ============================================
// COMMUNICATION
// ============================================

async function sendResultToGateway(task, status, message, result) {
  const taskId = task.id;
  const source = task.source || 'd1';

  // LUÔN báo về Tools để cập nhật UI Local.
  // Gửi kèm result (code + codeVerifier) nếu có, để Tools exchange token và lưu vào D1.
  try {
    // Nếu result có codeVerifier thì luôn gửi, bất kể source — Tools sẽ tự exchange.
    const toolsResult = (result && result.codeVerifier) ? result : 
                        (source === 'tools' ? result : null);
    const toolsRes = await fetch(`http://localhost:4000/api/vault/accounts/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: taskId, status, message, result: toolsResult }),
      signal: AbortSignal.timeout(10000),
    });
    const toolsBody = await toolsRes.text();
    console.log(`[Tools] ✅ Đã báo cáo (HTTP ${toolsRes.status}): ${toolsBody.substring(0, 100)}`);
  } catch (e) {
    console.log(`[Tools] ⚠️ Không gửi được result: ${e.message}`);
  }

  if (source === 'gateway') {
    // Chỉ báo cáo có kèm result về Gateway nếu task lấy từ Gateway
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
  } else {
    // Nếu task đến từ D1 Cloud trực tiếp (source='d1'), cập nhật status cho D1
    // Nếu source='tools': Tools đã tự push 'ready' lên D1 qua SyncManager → KHÔNG PATCH thêm
    if (source !== 'tools') {
      try {
        const configRes = await fetch('http://localhost:4000/api/config', { signal: AbortSignal.timeout(2000) });
        const cfg = await configRes.json();
        if (cfg.d1WorkerUrl && cfg.d1SyncSecret) {
          // Dùng 'ready' thay vì 'success' để Gateway hiển thị đúng
          const d1Status = status === 'success' ? 'ready' : status;
          await fetch(`${cfg.d1WorkerUrl}/accounts/${taskId}`, {
            method: 'PATCH',
            headers: { 'x-sync-secret': cfg.d1SyncSecret, 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: d1Status, last_error: message, updated_at: new Date().toISOString() }),
            signal: AbortSignal.timeout(4000),
          });
          console.log(`[D1 Cloud] ✅ Cập nhật status → ${d1Status}`);
        }
      } catch (e) {
        console.log(`[D1 Cloud] ⚠️ Không cập nhật được D1: ${e.message}`);
      }
    } else {
      console.log(`[D1 Cloud] ℹ️ Source=tools → Tools đã push 'ready', bỏ qua PATCH D1.`);
    }
  }
}

async function fetchTask() {
  // 1. Ưu tiên: Hỏi Gateway (OmniRoute Task API)
  try {
    const res = await fetch(`${GATEWAY_URL}/api/public/worker/task`, {
      headers: {
        Authorization: `Bearer ${WORKER_AUTH_TOKEN}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(3000)
    });
    if (res.status === 401) {
      console.log(`[!] Lỗi xác thực Gateway (401) - Kiểm tra Token`);
      return null;
    }
    if (res.status === 200) {
      const data = await res.json();
      if (data.task) {
        console.log(`[Gateway] ✅ Tìm thấy task: ${data.task.email}`);
        data.task.source = 'gateway';
        return data.task;
      }
      console.log(`[Gateway] Không có task pending`);
    }
  } catch (e) {
    console.log(`[Gateway] Không kết nối được: ${e.message}`);
  }

  // 2. Hỏi Tools Server (có PKCE baked-in, đảm bảo codeVerifier hợp lệ)
  try {
    const res = await fetch(`http://localhost:4000/api/vault/accounts/task`, {
      signal: AbortSignal.timeout(3000)
    });
    if (res.ok) {
      const data = await res.json();
      if (data.task) {
        console.log(`[Tools] ✅ Tìm thấy task: ${data.task.email} (codeVerifier: ${data.task.codeVerifier ? 'CÓ' : 'KHÔNG'})`);
        data.task.source = 'tools';
        return data.task;
      }
      console.log(`[Tools] Không có task pending`);
    } else {
      console.log(`[Tools] Lỗi HTTP ${res.status}: ${await res.text()}`);
    }
  } catch (e) {
    console.log(`[Tools] Không kết nối được: ${e.message}`);
  }

  // 3. Dự phòng cuối: Hỏi thẳng Cloud D1 qua Tools (để lấy PKCE từ Tools)
  // Chỉ dùng direct D1 nếu Tools server KHÔNG online (không có codeVerifier thì token exchange LUÔN thất bại)
  try {
    const configRes = await fetch(`http://localhost:4000/api/config`, {
      signal: AbortSignal.timeout(2000)
    });
    const cfg = await configRes.json();
    if (!cfg.d1WorkerUrl || !cfg.d1SyncSecret) {
      return null;
    }
    const d1Res = await fetch(`${cfg.d1WorkerUrl}/inspect/accounts?limit=200`, {
      headers: { 'x-sync-secret': cfg.d1SyncSecret },
      signal: AbortSignal.timeout(4000)
    });
    if (!d1Res.ok) return null;

    const d1Data = await d1Res.json();
    const allItems = (d1Data.items || []).filter(a => !a.deleted_at);
    console.log(`[D1 Cloud] Tổng accounts: ${allItems.length}, tìm pending...`);
    const pending = allItems.find(a => (a.status === 'pending' || a.status === 'relogin'));
    if (pending) {
      // Nếu D1 có loginUrl với codeVerifier embedded thì dùng, ngược lại bỏ qua
      if (!pending.codeVerifier && !pending.loginUrl?.includes('code_challenge=')) {
        console.log(`[D1 Cloud] ⚠️ Task ${pending.email} không có codeVerifier → BỎ QUA (sẽ thất bại exchange token)`);
        return null;
      }
      console.log(`[D1 Cloud] ☁️ Tìm thấy task: ${pending.email} (${pending.status})`);
      pending.source = 'd1';
      return pending;
    }
    console.log(`[D1 Cloud] Không có account nào đang pending`);
  } catch (e) {
    console.log(`[D1 Cloud] Lỗi: ${e.message}`);
  }

  return null;
}

// ============================================
// POLLING LOOP
// ============================================
let activeThreads = 0;
const processingIds = new Set(); // Chặn duplicate tasks

async function pollTasks() {
  if (activeThreads >= MAX_THREADS) return;
  try {
    const task = await fetchTask();
    if (!task?.id) return;

    // Chặn cùng 1 account bị xử lý 2 lần
    if (processingIds.has(task.id)) {
      console.log(`[Worker] ⏭️ Bỏ qua ${task.email} - đang được xử lý rồi`);
      return;
    }

    processingIds.add(task.id);
    activeThreads++;
    console.log(`[Worker] 🚀 Luồng mới: ${task.email} (${activeThreads}/${MAX_THREADS})`);

    runLoginFlow(task)
      .then(() => {
        activeThreads = Math.max(0, activeThreads - 1);
        processingIds.delete(task.id);
        console.log(`[Worker] ✅ Hoàn tất ${task.email}. Còn trống: ${MAX_THREADS - activeThreads}`);
        if (activeThreads < MAX_THREADS) setTimeout(pollTasks, 1000);
      })
      .catch(err => {
        activeThreads = Math.max(0, activeThreads - 1);
        processingIds.delete(task.id);
        console.error(`[Worker] ❌ Lỗi luồng ${task.email}:`, err.message);
      });

    if (activeThreads < MAX_THREADS) setTimeout(pollTasks, 2000);
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
