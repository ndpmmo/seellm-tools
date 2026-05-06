import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';

console.log('🚀 Bắt đầu quá trình cài đặt VNC Dependencies...');

try {
  // 1. Tìm đường dẫn brew
  let brewPath = '';
  try {
    brewPath = execSync('which brew').toString().trim();
  } catch (e) {
    // Thử các đường dẫn mặc định nếu which brew thất bại
    const paths = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'];
    for (const p of paths) {
      if (fs.existsSync(p)) {
        brewPath = p;
        break;
      }
    }
  }

  if (!brewPath) {
    console.error('❌ Không tìm thấy Homebrew (brew) trên máy của bạn.');
    console.log('💡 Vui lòng cài đặt Homebrew tại https://brew.sh trước.');
    process.exit(1);
  }

  console.log(`📦 Sử dụng Homebrew tại: ${brewPath}`);
  console.log('⏳ Đang cài đặt x11vnc via brew và websockify via pip3...');

  // 2. Chạy lệnh cài đặt x11vnc
  console.log('--- Bước 1: Cài đặt x11vnc ---');
  try {
    execSync(`${brewPath} install x11vnc`, { stdio: 'inherit' });
  } catch (e) {
    console.warn('⚠️ Cảnh báo: x11vnc có thể đã được cài đặt hoặc gặp lỗi nhỏ.');
  }

  // 3. Chạy lệnh cài đặt websockify via pip3
  console.log('\n--- Bước 2: Cài đặt websockify ---');
  try {
    console.log('Đang thử cài đặt websockify qua pip3...');
    // Thêm --break-system-packages để vượt qua rào cản bảo vệ Python mặc định trên macOS
    execSync('pip3 install websockify --break-system-packages', { stdio: 'inherit' });
    console.log('✅ websockify đã được cài đặt.');
  } catch (e) {
    console.error('❌ Thất bại khi cài đặt websockify qua pip3.');
    console.log('💡 Vui lòng chạy thủ công: pip3 install websockify');
    process.exit(1);
  }

  console.log('\n✅ CÀI ĐẶT TẤT CẢ THÀNH CÔNG!');
  console.log('💡 Bây giờ bạn có thể quay lại tab Multi Profile và Launch trình duyệt.');
  process.exit(0);

} catch (err) {
  console.error('❌ Lỗi không xác định:', err.message);
  process.exit(1);
}
