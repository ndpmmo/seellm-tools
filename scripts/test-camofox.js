/**
 * SeeLLM Tools - Test Camofox
 * Kiểm tra Camofox server có đang chạy và hoạt động bình thường
 */
import { CAMOUFOX_API } from './config.js';

const USER_ID = `camofox_test_${Date.now()}`;
const TEST_URL = 'https://example.com';

async function testCamofox() {
  console.log(`\n🦊 SeeLLM Tools - Test Camofox`);
  console.log(`   Server: ${CAMOUFOX_API}\n`);

  let tabId;
  try {
    // 1. Health check
    process.stdout.write('1️⃣  Health check            → ');
    const healthRes = await fetch(`${CAMOUFOX_API}/health`, {
      signal: AbortSignal.timeout(3000),
    }).catch(() => null);
    
    if (!healthRes?.ok) {
      console.log('❌ Camofox không phản hồi!');
      console.log('\n💡 Gợi ý: Nhấn nút "🦊 Camofox" trong Dashboard để khởi động.\n');
      return;
    }
    console.log(`✅ Online`);

    // 2. Mở tab test
    process.stdout.write(`2️⃣  Mở tab (${TEST_URL}) → `);
    const initRes = await fetch(`${CAMOUFOX_API}/tabs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: USER_ID,
        sessionKey: 'test',
        url: TEST_URL,
      }),
    });

    if (!initRes.ok) {
      console.log(`❌ Lỗi: ${await initRes.text()}`);
      return;
    }
    const { tabId: tid } = await initRes.json();
    tabId = tid;
    console.log(`✅ TabID: ${tabId}`);

    await new Promise(r => setTimeout(r, 3000));

    // 3. Lấy snapshot
    process.stdout.write('3️⃣  Lấy nội dung trang      → ');
    const snapRes = await fetch(`${CAMOUFOX_API}/tabs/${tabId}/snapshot?userId=${USER_ID}`);
    const snapData = await snapRes.json();
    const hasContent = snapData.snapshot?.length > 10;
    console.log(hasContent ? `✅ OK (${snapData.snapshot.length} chars)` : '⚠️ Nội dung rỗng');

    // 4. Screenshot
    process.stdout.write('4️⃣  Chụp screenshot          → ');
    const ssRes = await fetch(`${CAMOUFOX_API}/tabs/${tabId}/screenshot?userId=${USER_ID}`);
    console.log(ssRes.ok ? `✅ OK (${ssRes.headers.get('content-length')} bytes)` : '⚠️ Thất bại');

    console.log('\n═══════════════════════════════════');
    console.log('✅ Camofox đang hoạt động bình thường!');
    console.log('   Bạn có thể khởi động Worker.\n');

  } catch (err) {
    console.error('\n❌ Lỗi:', err.message);
    console.log('\n💡 Kiểm tra Camofox server có đang chạy không.\n');
  } finally {
    if (tabId) {
      await fetch(`${CAMOUFOX_API}/tabs/${tabId}?userId=${USER_ID}`, { method: 'DELETE' });
    }
  }
}

testCamofox();
