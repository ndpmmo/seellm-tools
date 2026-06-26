/**
 * SeeLLM Tools - Ping Servers
 * Kiểm tra trạng thái kết nối đến Camofox và Gateway
 */
import { CAMOUFOX_API, GATEWAY_URL, WORKER_AUTH_TOKEN } from './config.js';

const TIMEOUT_MS = 5000;

async function pingUrl(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return { ok: true, status: res.status };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, error: e.message };
  }
}

async function checkAll() {
  console.log('\n🔍 SeeLLM Tools - Kiểm tra kết nối\n');
  console.log('─'.repeat(50));

  // Ping Camofox
  process.stdout.write('🦊 Camofox Browser Server   → ');
  const cf = await pingUrl(`${CAMOUFOX_API}/health`);
  if (cf.ok) {
    console.log(`✅ Online (HTTP ${cf.status})  [${CAMOUFOX_API}]`);
  } else {
    console.log(`❌ Offline - ${cf.error}  [${CAMOUFOX_API}]`);
  }

  // Ping Gateway (worker endpoint)
  process.stdout.write('🌐 SeeLLM Gateway           → ');
  const gw = await pingUrl(`${GATEWAY_URL}/api/public/worker/task`, {
    headers: { Authorization: `Bearer ${WORKER_AUTH_TOKEN}`, Accept: 'application/json' },
  });
  if (gw.ok) {
    const label = gw.status === 200 ? '✅ Online, có task đang chờ' :
                  gw.status === 204 ? '✅ Online, không có task' :
                  gw.status === 401 ? '⚠️  Online nhưng Auth thất bại (kiểm tra token)' :
                  `✅ Online (HTTP ${gw.status})`;
    console.log(`${label}  [${GATEWAY_URL}]`);
  } else {
    console.log(`❌ Offline - ${gw.error}  [${GATEWAY_URL}]`);
  }

  console.log('─'.repeat(50));

  // Summary
  const allOk = cf.ok && gw.ok;
  if (allOk) {
    console.log('\n✨ Tất cả kết nối OK! Bạn có thể khởi động Worker.\n');
  } else {
    console.log('\n⚠️  Có kết nối lỗi. Vui lòng kiểm tra lại:\n');
    if (!cf.ok) console.log('  • Khởi động Camofox: nhấn nút "🦊 Camofox" trong Dashboard');
    if (!gw.ok) console.log('  • Kiểm tra Gateway URL và Auth Token trong tab Cài đặt');
    console.log('');
  }
}

checkAll();
