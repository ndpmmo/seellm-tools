import fs from 'fs';
import path from 'path';

async function waitAndCheck() {
  const port = process.env.PORT || 4000;
  const baseUrl = `http://localhost:${port}/api`;

  while (true) {
    try {
      const res = await fetch(`${baseUrl}/vault/accounts`);
      const data = await res.json();
      const accounts = data.items || [];

      const withoutProxy = accounts.filter(a => !a.proxy_url);
      const withProxy = accounts.filter(a => a.proxy_url);

      console.log(`[${new Date().toLocaleTimeString()}] Đang gán... Đã gán: ${withProxy.length}/${accounts.length}. Chờ gán: ${withoutProxy.length}`);

      if (withoutProxy.length === 0) {
        console.log(`\n🎉 HOÀN TẤT! Tất cả tài khoản đã được gán Proxy.`);
        const distribution = {};
        for (const a of withProxy) {
          distribution[a.proxy_url] = (distribution[a.proxy_url] || 0) + 1;
        }
        console.log(`\nPhân bổ hiện tại:`);
        Object.entries(distribution).forEach(([url, count]) => {
          console.log(`  ${url}: ${count} accounts`);
        });
        break;
      }
    } catch (e) {
      console.log(`Lỗi kết nối API: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 5000));
  }
}

waitAndCheck().catch(console.error);
