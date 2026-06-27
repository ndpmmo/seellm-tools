/**
 * SeeLLM Tools - Lấy Session Token từ Camofox
 * 
 * Sau khi login thành công, script này lấy session cookie
 * từ Camofox và hiển thị ra để nạp vào Gateway.
 */
import { CAMOUFOX_API } from './config.js';

const USER_ID = 'seellm_worker';

async function getSessionToken() {
  try {
    console.log(`[*] Đang lấy cookies từ Camofox (User: ${USER_ID})...`);
    console.log(`[*] Camofox API: ${CAMOUFOX_API}`);

    const res = await fetch(`${CAMOUFOX_API}/sessions/${USER_ID}/cookies`);
    if (!res.ok) {
      throw new Error(
        `Không thể lấy cookie (HTTP ${res.status}). ` +
        `Hãy đảm bảo Camofox đang chạy và đã login trước đó.`
      );
    }

    const cookies = await res.json();
    console.log(`[*] Tổng số cookies: ${cookies.length}`);

    // Tìm session token của OpenAI/ChatGPT
    const sessionToken = cookies.find(c =>
      c.name?.includes('next-auth.session-token') ||
      c.name?.includes('__Secure-next-auth.session-token')
    );

    if (sessionToken) {
      console.log(`\n=========================================`);
      console.log(`✅ ĐÃ TÌM THẤY SESSION TOKEN:`);
      console.log(`-----------------------------------------`);
      console.log(sessionToken.value);
      console.log(`-----------------------------------------`);
      console.log(`\nCopy chuỗi trên và nạp vào Gateway → Codex → Session Token`);
      console.log(`Session thường có hạn 15-30 ngày.`);
      console.log(`=========================================\n`);
    } else {
      console.log('\n[!] Không tìm thấy Session Token.');
      console.log('[?] Gợi ý: Hãy chạy "auto-login-worker" trước để login thành công.');
      console.log('\n📋 Danh sách tất cả cookies hiện có:');
      cookies.forEach(c => console.log(`  - ${c.name} (domain: ${c.domain})`));
    }
  } catch (err) {
    console.error('[!] Lỗi:', err.message);
    process.exit(1);
  }
}

getSessionToken();
