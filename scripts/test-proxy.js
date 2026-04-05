/**
 * SeeLLM Tools - Test Proxy
 * Mở tab Camofox với proxy, kiểm tra IP thực sự được dùng
 * 
 * Usage: node scripts/test-proxy.js <PROXY_URL>
 * Ví dụ: node scripts/test-proxy.js http://user:pass@1.2.3.4:8080
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAMOUFOX_API } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROXY = process.argv[2];
const USER_ID = `proxy_test_${Date.now()}`;

if (!PROXY) {
  console.log('\n🔍 SeeLLM Tools - Test Proxy\n');
  console.log('Usage: node scripts/test-proxy.js <PROXY_URL>');
  console.log('Ví dụ: node scripts/test-proxy.js http://user:pass@1.2.3.4:8080\n');
  process.exit(0);
}

async function testProxy() {
  console.log(`\n🚀 Test Proxy: ${PROXY}`);
  console.log(`   Camofox: ${CAMOUFOX_API}\n`);

  let tabId;
  try {
    // 1. Mở tab với proxy, truy cập IP checker
    const initRes = await fetch(`${CAMOUFOX_API}/tabs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: USER_ID,
        sessionKey: 'proxy_test',
        url: 'https://api.ipify.org/?format=json',
        proxy: PROXY,
      }),
    });

    if (!initRes.ok) throw new Error(`Không thể mở tab: ${await initRes.text()}`);
    const { tabId: tid } = await initRes.json();
    tabId = tid;
    console.log(`✅ Đã mở Tab: ${tabId}. Đợi load IP...`);
    await new Promise(r => setTimeout(r, 8000));

    // 2. Lấy snapshot (nội dung text)
    const snapRes = await fetch(`${CAMOUFOX_API}/tabs/${tabId}/snapshot?userId=${USER_ID}`);
    const snapData = await snapRes.json();
    console.log(`\n📋 Nội dung nhận được:`, snapData.snapshot || '(trống)');

    // 3. Chụp screenshot
    const ssRes = await fetch(`${CAMOUFOX_API}/tabs/${tabId}/screenshot?userId=${USER_ID}`);
    if (ssRes.ok) {
      const imgPath = path.join(__dirname, 'images', `proxy_test_${Date.now()}.png`);
      await fs.mkdir(path.join(__dirname, 'images'), { recursive: true });
      await fs.writeFile(imgPath, Buffer.from(await ssRes.arrayBuffer()));
      console.log(`📸 Screenshot lưu tại: ${imgPath}`);
    }

    // 4. Kiểm tra kết quả
    const snap = snapData.snapshot || '';
    const ipMatch = snap.match(/\d+\.\d+\.\d+\.\d+/);
    if (ipMatch) {
      console.log(`\n✨ IP phát hiện: ${ipMatch[0]}`);
      const proxyIp = PROXY.match(/@([\d.]+)/)?.[1];
      if (proxyIp && ipMatch[0] === proxyIp) {
        console.log(`✅ PROXY HOẠT ĐỘNG! IP khớp với proxy: ${proxyIp}\n`);
      } else {
        console.log(`⚠️  IP nhận được (${ipMatch[0]}) khác với proxy IP (${proxyIp || 'không rõ'})`);
        console.log('   Proxy có thể không hoạt động hoặc bị bypass.\n');
      }
    } else {
      console.log('❌ Không đọc được IP từ trang. Proxy có thể bị lỗi.\n');
    }

  } catch (err) {
    console.error('❌ Lỗi:', err.message);
  } finally {
    if (tabId) {
      await fetch(`${CAMOUFOX_API}/tabs/${tabId}?userId=${USER_ID}`, { method: 'DELETE' });
      console.log(`🧹 Đã đóng tab ${tabId}`);
    }
  }
}

testProxy();
