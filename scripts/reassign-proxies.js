import fs from 'fs';
import path from 'path';

async function run() {
  const port = process.env.PORT || 4000;
  const baseUrl = `http://localhost:${port}/api`;

  console.log('🔄 Đang tải danh sách tài khoản từ Vault...');
  
  // We don't have a direct GET all accounts API endpoint that returns everything easily in one shot 
  // without pagination, but we can read from the local SQLite if we want, or just use the UI API.
  // Actually, there is `GET /api/vault/accounts`.
  const res = await fetch(`${baseUrl}/vault/accounts`);
  const data = await res.json();
  const accounts = data.items || [];

  if (accounts.length === 0) {
    console.log('❌ Không tìm thấy tài khoản nào.');
    return;
  }

  // Lọc ra các tài khoản CÓ proxy (để gỡ ra)
  const accountsWithProxy = accounts.filter(a => a.proxy_url);
  console.log(`🔍 Tìm thấy ${accountsWithProxy.length}/${accounts.length} tài khoản đang có Proxy.`);

  if (accountsWithProxy.length > 0) {
    const accountIds = accountsWithProxy.map(a => a.id);
    console.log(`🧹 Bắt đầu gỡ (Unassign) Proxy cho ${accountIds.length} tài khoản...`);
    
    // Gọi API bulk unassign
    const unassignRes = await fetch(`${baseUrl}/proxy-assign/bulk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'unassign', accountIds })
    });
    
    const unassignData = await unassignRes.json();
    if (unassignData.ok) {
      console.log(`✅ Đã gỡ thành công: ${unassignData.done}/${unassignData.total} (Lỗi: ${unassignData.failed})`);
    } else {
      console.error(`❌ Lỗi khi gỡ Proxy:`, unassignData.error);
      return;
    }
  } else {
    console.log('ℹ️ Không có tài khoản nào cần gỡ Proxy.');
  }

  console.log(`⚡ Bắt đầu chạy Auto-Assign (phân bổ lại thông minh)...`);
  const assignRes = await fetch(`${baseUrl}/proxy-assign/auto`, {
    method: 'POST'
  });
  
  const assignData = await assignRes.json();
  if (assignData.ok) {
    console.log(`🎉 Hoàn tất! Đã phân bổ lại proxy cho ${assignData.assigned}/${assignData.total} tài khoản.`);
  } else {
    console.error(`❌ Lỗi khi phân bổ Proxy:`, assignData.error);
  }
}

run().catch(console.error);
