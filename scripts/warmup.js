/**
 * SeeLLM Tools - ChatGPT Account Warmup Module
 * Automates conversational Q&A interactions using Camofox to maintain account health.
 */

import { CAMOUFOX_API, TOOLS_API_URL } from './config.js';
import { camofoxPost, camofoxGet, camofoxDelete, navigate, pressKey, evalJson } from './lib/camofox.js';
import { normalizeProxyUrl, assertProxyApplied, probeProxyExitIp, getLocalPublicIp, isLocalRelayProxy } from './lib/proxy-diag.js';
import { getFreshTOTP } from './lib/totp.js';

// Pre-defined set of highly realistic, conversational, human-like prompts
const QUESTIONS = [
  "Can you help me brainstorm some catchy names for a startup that builds AI-powered calendar tools?",
  "Explain the difference between SQL and NoSQL databases like I am five.",
  "Write a polite email to my manager asking for feedback on my recent project performance.",
  "What are some highly-rated non-touristy restaurants or cafes in Tokyo?",
  "Can you give me 3 quick, healthy, and delicious dinner recipes that take under 20 minutes to make?",
  "How does the virtual DOM work in React, and why is it faster than standard DOM manipulation?",
  "Help me outline a 4-week training plan for running a 5K race from scratch.",
  "What are the most common coding patterns or practices in clean architecture?",
  "Can you explain the main ideas behind Stoic philosophy and how to apply them to daily work stress?",
  "Give me some creative writing prompts involving a time traveler who gets stuck in the 1920s.",
  "What's the best way to optimize CSS delivery and reduce render-blocking resources in a web app?",
  "Help me draft a concise response to a client who wants to decrease the budget of a software project.",
  "What are the key differences between REST APIs and GraphQL, and when should I choose one over the other?",
  "Can you recommend some must-read science fiction novels from the last decade?",
  "How do I implement a custom debounce function in vanilla JavaScript?",
  "What are the pros and cons of using Tailwind CSS compared to vanilla CSS?",
  "Write a humorous short story about an AI coding assistant that becomes overly dramatic.",
  "Explain how HTTPS encryption works using an easy-to-understand analogy.",
  "What are the best strategies for learning a new programming language quickly?",
  "Can you review these design principles for a modern, sleek dashboard application?",
  "What is the difference between declarative and imperative programming? Give examples in JS.",
  "Can you write a python script to parse a large JSON file and group objects by a key?",
  "Explain what Docker is and how containers differ from virtual machines.",
  "Write a cover letter for a Senior Software Engineer position at a remote-first fintech company.",
  "What are the best practices for handling authentication and session state in Next.js?",
  "Write a poem about the beauty of a quiet morning in the mountains.",
  "What are some fun weekend road trip destinations within 3 hours of San Francisco?",
  "How do modern search engines rank websites? Explain the key ranking signals.",
  "What are the core concepts of object-oriented programming with simple examples?",
  "Explain the difference between deep learning and traditional machine learning.",
  "What are some practical tips to improve my presentation skills for tech conferences?",
  "Write a SQL query to find duplicate records in a table based on email address.",
  "What is the Page Visibility API in browsers, and what is a practical use case for it?",
  "Can you write a beautiful CSS grid template for a standard 3-column blog layout?",
  "Explain how DNS resolution works step-by-step when I type a URL in the browser."
];

// Helper to get random number between min and max inclusive
function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

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
 * Polls the DOM to detect when ChatGPT has finished generating the AI response.
 * Uses multiple strategies for bulletproof detection.
 */
async function waitForGenerationComplete(tabId, userId, timeoutMs = 150000) {
  const startTime = Date.now();
  console.log(`[Warmup] ⏳ Chờ ChatGPT phản hồi xong...`);
  
  while (Date.now() - startTime < timeoutMs) {
    const status = await evalJson(tabId, userId, `(() => {
      // 1. Check for visible "Stop generating" button
      const stopBtn = document.querySelector('button[aria-label*="Stop"], button[data-testid*="stop"], button[data-testid="stop-generating-button"]');
      if (stopBtn && stopBtn.offsetParent !== null) {
        return 'generating (stop button visible)';
      }
      
      // 2. Check for active streaming classes or selectors
      const streamingEl = document.querySelector('.result-streaming, .streaming, [class*="streaming"]');
      if (streamingEl) {
        return 'generating (streaming element active)';
      }
      
      // 3. Check send button state (it turns back to enabled/Send prompt when done)
      const sendBtn = document.querySelector('button[data-testid="send-button"], button[aria-label="Send prompt"], button[data-testid*="send"]');
      if (sendBtn) {
        const isDisabled = sendBtn.hasAttribute('disabled') || sendBtn.disabled;
        if (isDisabled) {
          return 'generating (send button disabled)';
        }
        return 'complete';
      }
      
      return 'checking';
    })()`);
    
    if (status === 'complete') {
      console.log(`[Warmup] ✅ ChatGPT đã trả lời xong!`);
      return true;
    }
    
    // Log occasionally
    console.log(`[Warmup] ⏱️ Generation status: ${status} (${Math.round((Date.now() - startTime) / 1000)}s)`);
    await delay(2000);
  }
  
  console.log(`[Warmup] ⚠️ Hết thời gian chờ phản hồi (${timeoutMs}ms). Tiến hành tiếp tục.`);
  return false;
}

async function runWarmup() {
  const args = parseArgs();
  const accountId = args.accountId;
  
  if (!accountId) {
    console.error('❌ Thiếu đối số --accountId');
    process.exit(1);
  }
  
  let qCountArg = parseInt(args.questions || '0', 10);
  if (isNaN(qCountArg) || qCountArg <= 0) {
    qCountArg = randomInt(1, 3); // 1 to 3 questions randomly
  }
  
  console.log(`\n🔥 [Warmup] BẮT ĐẦU WARMUP TÀI KHOẢN: ${accountId}`);
  console.log(`[Warmup] 📝 Số câu hỏi tương tác dự kiến: ${qCountArg}\n`);
  
  // 1. Fetch account info from SeeLLM Tools local API
  let account;
  try {
    const res = await fetch(`${TOOLS_API_URL}/api/vault/accounts/${encodeURIComponent(accountId)}`);
    if (!res.ok) {
      throw new Error(`GET account returned status ${res.status}: ${await res.text()}`);
    }
    const data = await res.json();
    account = data.account;
  } catch (err) {
    console.error(`❌ Không tìm thấy thông tin tài khoản: ${err.message}`);
    process.exit(1);
  }
  
  const USER_ID = `seellm_warmup_${account.id}`;
  const SESSION_KEY = `warmup_${account.id}`;
  const effectiveProxy = normalizeProxyUrl(account.proxy_url || account.proxyUrl || account.proxy || null);
  
  let tabId = null;
  let preFlightResult = null;
  let questionsAsked = 0;
  
  try {
    // 2. Pre-flight Proxy Assert (traffic isolation security)
    if (effectiveProxy) {
      console.log(`[Warmup] 🔒 [PreFlight] Kiểm tra proxy: ${effectiveProxy}`);
      try {
        let lastErr = null;
        for (let preflightAttempt = 0; preflightAttempt < 3; preflightAttempt++) {
          try {
            preFlightResult = await assertProxyApplied(effectiveProxy);
            lastErr = null;
            break;
          } catch (err) {
            lastErr = err;
            const msg = String(err?.message || err || '');
            const isTransient = msg.includes('fetch failed') || msg.includes('Không lấy được exit IP');
            if (!isTransient || preflightAttempt === 2) break;
            console.log(`[Warmup] ⚠️ [PreFlight] Thử lại ${preflightAttempt + 1}/2 sau lỗi: ${msg}`);
            await delay(2000 + preflightAttempt * 1500);
          }
        }
        if (!preFlightResult && lastErr) throw lastErr;
        console.log(`[Warmup] ✅ [PreFlight] Exit IP: ${preFlightResult.exitIp}`);
      } catch (err) {
        console.error(`[Warmup] 🛑 [PreFlight] Proxy verification FAILED: ${err.message}`);
        throw err;
      }
    }
    
    // 3. Open Camofox Tab
    console.log(`[Warmup] 🦊 Khởi động Camofox tab...`);
    const opened = await camofoxPost('/tabs', {
      userId: USER_ID,
      sessionKey: SESSION_KEY,
      url: 'about:blank',
      proxy: effectiveProxy || undefined,
      persistent: true, // Reuse profiles/cookies inside Camofox
      os: 'macos',
      screen: { width: 1440, height: 900 },
      humanize: true,
      headless: false,
    }, { timeoutMs: 35000 });
    
    tabId = opened.tabId;
    await delay(3000);
    
    // 4. Import cookies from database if present
    if (account.cookies && Array.isArray(account.cookies) && account.cookies.length > 0) {
      console.log(`[Warmup] 🍪 Nạp ${account.cookies.length} cookies từ database vào browser context...`);
      try {
        await fetch(`${CAMOUFOX_API}/sessions/${USER_ID}/cookies`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cookies: account.cookies })
        });
      } catch (err) {
        console.warn(`⚠️ [Warmup] Lỗi khi import cookies: ${err.message}`);
      }
    }
    
    // 5. Navigate to ChatGPT Chat interface
    console.log(`[Warmup] 🌐 Mở trang ChatGPT...`);
    await navigate(tabId, USER_ID, 'https://chatgpt.com/');
    await delay(5000);
    
    // 6. Check login state
    let isLoggedIn = await evalJson(tabId, USER_ID, `!!document.querySelector('#prompt-textarea')`);
    
    if (!isLoggedIn) {
      console.log(`[Warmup] 👤 Chưa đăng nhập hoặc cookie hết hạn! Tiến hành đăng nhập...`);
      await navigate(tabId, USER_ID, 'https://chatgpt.com/auth/login');
      await delay(5000);
      
      // 6.1 Accept cookies
      await evalJson(tabId, USER_ID, `(() => {
        const btns = document.querySelectorAll('button');
        for (const b of btns) {
          const t = b.textContent?.toLowerCase() || '';
          if (t.includes('accept all') || t.includes('đồng ý') || t.includes('accept cookies')) {
            b.click();
            return 'clicked_accept';
          }
        }
        return 'no_cookie_banner';
      })()`);
      await delay(1500);
      
      // 6.2 Click main log in button if presented
      await evalJson(tabId, USER_ID, `(() => {
        const btns = document.querySelectorAll('button, a');
        for (const b of btns) {
          const t = b.textContent?.toLowerCase() || '';
          if (t === 'log in' || t === 'đăng nhập') {
            b.click();
            return 'clicked_login';
          }
        }
        return 'already_on_login_form';
      })()`);
      await delay(4000);
      
      // 6.3 Fill Email
      console.log(`[Warmup] 📧 Điền email: ${account.email}`);
      const emailInputSelector = 'input[name="username"], #username, input[type="email"]';
      await camofoxPost(`/tabs/${tabId}/type`, { userId: USER_ID, selector: emailInputSelector, text: account.email });
      await pressKey(tabId, USER_ID, 'Enter');
      await delay(3000);
      
      // 6.4 Fill Password
      console.log(`[Warmup] 🔑 Điền password...`);
      const pwdSelector = 'input[type="password"], input[name="password"], #password';
      await camofoxPost(`/tabs/${tabId}/type`, { userId: USER_ID, selector: pwdSelector, text: account.password });
      await pressKey(tabId, USER_ID, 'Enter');
      await delay(5000);
      
      // 6.5 Handle 2FA if needed
      const isAtMFA = await evalJson(tabId, USER_ID, `(() => {
        const url = location.href.toLowerCase();
        const txt = document.body?.innerText?.toLowerCase() || '';
        return url.includes('mfa') || url.includes('/verify') || txt.includes('one-time code') || txt.includes('authenticator');
      })()`);
      
      if (isAtMFA) {
        console.log(`[Warmup] 🛡️ Phát hiện màn hình 2FA!`);
        const totpSecret = account.two_fa_secret || account.twoFaSecret;
        if (!totpSecret) {
          throw new Error('Tài khoản yêu cầu 2FA nhưng không có Secret Key!');
        }
        const { otp } = await getFreshTOTP(totpSecret);
        console.log(`[Warmup] 🔢 Tạo mã OTP: ${otp}`);
        const mfaSelector = 'input[autocomplete="one-time-code"], input[name="code"], input[type="text"]';
        await camofoxPost(`/tabs/${tabId}/type`, { userId: USER_ID, selector: mfaSelector, text: otp });
        await pressKey(tabId, USER_ID, 'Enter');
        await delay(5000);
      }
      
      // 6.6 Verify redirect back
      for (let waitSec = 0; waitSec < 10; waitSec++) {
        isLoggedIn = await evalJson(tabId, USER_ID, `!!document.querySelector('#prompt-textarea')`);
        if (isLoggedIn) break;
        await delay(2000);
      }
      
      if (!isLoggedIn) {
        const snapText = await evalJson(tabId, USER_ID, `document.body?.innerText?.toLowerCase() || ''`);
        if (snapText.includes('phone') || snapText.includes('sđt') || snapText.includes('số điện thoại')) {
          throw new Error('NEED_PHONE: Tài khoản yêu cầu xác minh số điện thoại');
        }
        if (snapText.includes('deactivated') || snapText.includes('vô hiệu hóa') || snapText.includes('bị khóa')) {
          throw new Error('ACCOUNT_DEACTIVATED: Tài khoản đã bị khóa');
        }
        throw new Error('Đăng nhập thất bại hoặc cookie hết hạn!');
      }
      
      console.log(`[Warmup] 👤 Đăng nhập thành công!`);
    } else {
      console.log(`[Warmup] ✅ Session hợp lệ!`);
    }
    
    // 7. Perform conversational Q&A warmup
    console.log(`\n💬 [Warmup] Bắt đầu tương tác Q&A (${qCountArg} câu hỏi)...`);
    
    // Shuffle prompts
    const shuffled = [...QUESTIONS].sort(() => 0.5 - Math.random());
    const selectedPrompts = shuffled.slice(0, qCountArg);
    
    for (let idx = 0; idx < selectedPrompts.length; idx++) {
      const promptText = selectedPrompts[idx];
      console.log(`\n[Warmup] ❓ Câu hỏi ${idx + 1}/${selectedPrompts.length}: "${promptText}"`);
      
      // Wait for prompt-textarea to be visible
      const isInputVisible = await evalJson(tabId, USER_ID, `(() => {
        const ta = document.querySelector('#prompt-textarea');
        return ta && ta.offsetParent !== null;
      })()`);
      
      if (!isInputVisible) {
        throw new Error('Không tìm thấy hộp thoại chat của ChatGPT!');
      }
      
      // Type message
      await camofoxPost(`/tabs/${tabId}/type`, { userId: USER_ID, selector: '#prompt-textarea', text: promptText });
      await delay(1000);
      
      // Send message
      await pressKey(tabId, USER_ID, 'Enter');
      await delay(2000);
      
      // Wait for complete response
      await waitForGenerationComplete(tabId, USER_ID);
      
      questionsAsked++;
      // Sleep between questions to simulate human reading/thinking
      if (idx < selectedPrompts.length - 1) {
        const sleepMs = randomInt(4000, 8000);
        console.log(`[Warmup] 💤 Nghỉ ${Math.round(sleepMs / 1000)} giây trước câu hỏi tiếp theo...`);
        await delay(sleepMs);
      }
    }
    
    console.log(`\n🎉 [Warmup] Tương tác thành công tất cả ${questionsAsked} câu hỏi!`);
    
    // Get fresh cookies after success to keep them updated
    console.log(`[Warmup] 🍪 Thu thập cookies mới từ session...`);
    const newCookiesRes = await camofoxGet(`/tabs/${tabId}/cookies?userId=${USER_ID}`).catch(() => null);
    const newCookies = Array.isArray(newCookiesRes?.cookies) ? newCookiesRes.cookies : (Array.isArray(newCookiesRes) ? newCookiesRes : null);
    
    // Save success result back to server
    await fetch(`${TOOLS_API_URL}/api/vault/accounts/${accountId}/warmup-result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'success',
        questionsAsked,
        cookies: newCookies || undefined
      })
    });
    
    console.log(`[Warmup] ✅ Hoàn tất cập nhật trạng thái Warmup thành công!`);
    
  } catch (err) {
    console.error(`\n❌ [Warmup] Lỗi trong quá trình chạy: ${err.message}`);
    
    // Save failure status back to server
    try {
      await fetch(`${TOOLS_API_URL}/api/vault/accounts/${accountId}/warmup-result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'failed',
          error: err.message,
          questionsAsked
        })
      });
      console.log(`[Warmup] 🛑 Cập nhật trạng thái Warmup THẤT BẠI về database.`);
    } catch (saveErr) {
      console.error(`[Warmup] Lỗi khi cố gắng lưu trạng thái thất bại: ${saveErr.message}`);
    }
    
  } finally {
    // 8. Clean up Tab to prevent resource leak
    if (tabId) {
      console.log(`[Warmup] 🧹 Đóng tab Camofox để giải phóng tài nguyên...`);
      await camofoxDelete(`/tabs/${tabId}?userId=${USER_ID}`);
    }
    console.log(`🔥 [Warmup] KẾT THÚC CHƯƠNG TRÌNH WARMUP.\n`);
  }
}

runWarmup();
