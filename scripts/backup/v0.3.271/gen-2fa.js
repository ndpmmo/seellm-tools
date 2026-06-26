/**
 * SeeLLM Tools - Tạo Mã 2FA (TOTP)
 * Nhập secret key Base32, xuất ra mã OTP 6 số hiện tại
 * 
 * Usage: node scripts/gen-2fa.js [SECRET_KEY]
 */
import { createHmac } from 'node:crypto';

function getTOTP(secret) {
  function base32tohex(base32) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = '', hex = '';
    const clean = base32.replace(/\s/g, '').toUpperCase();
    for (let i = 0; i < clean.length; i++) {
      const val = chars.indexOf(clean.charAt(i));
      bits += val.toString(2).padStart(5, '0');
    }
    for (let i = 0; i + 4 <= bits.length; i += 4) {
      hex += parseInt(bits.substr(i, 4), 2).toString(16);
    }
    return hex;
  }
  const key = base32tohex(secret);
  const epoch = Math.round(Date.now() / 1000);
  const timeHex = Math.floor(epoch / 30).toString(16).padStart(16, '0');
  const time = Buffer.from(timeHex, 'hex');
  const hmac = createHmac('sha1', Buffer.from(key, 'hex'));
  const h = hmac.update(time).digest();
  const offset = h[h.length - 1] & 0xf;
  const otp = (h.readUInt32BE(offset) & 0x7fffffff) % 1000000;
  return otp.toString().padStart(6, '0');
}

// Lấy secret từ argument hoặc hiển thị hướng dẫn
const secret = process.argv[2];

if (!secret) {
  console.log('\n📱 SeeLLM Tools - TOTP 2FA Generator\n');
  console.log('Usage: node scripts/gen-2fa.js <SECRET_KEY>\n');
  console.log('Ví dụ: node scripts/gen-2fa.js JBSWY3DPEHPK3PXP\n');
  process.exit(0);
}

const epoch = Math.round(Date.now() / 1000);
const remaining = 30 - (epoch % 30);

console.log('\n📱 SeeLLM Tools - TOTP 2FA Generator\n');
console.log(`Secret Key: ${secret}`);
console.log('─'.repeat(40));
console.log(`✅ Mã OTP hiện tại: ${getTOTP(secret)}`);
console.log(`⏱️  Còn hiệu lực:  ${remaining} giây`);
console.log('─'.repeat(40));
console.log('\n💡 Lưu ý: Mã thay đổi sau mỗi 30 giây.\n');

// Tự động cập nhật mã mỗi giây
let lastOtp = getTOTP(secret);
const interval = setInterval(() => {
  const newOtp = getTOTP(secret);
  const ep = Math.round(Date.now() / 1000);
  const rem = 30 - (ep % 30);
  if (newOtp !== lastOtp) {
    lastOtp = newOtp;
    console.log(`🔄 Mã mới: ${newOtp} (còn ${rem}s)`);
  }
  if (rem <= 1) process.stdout.write(`\r⏱️  ${newOtp} | Còn: ${rem}s  `);
}, 1000);

// Dừng sau 60 giây
setTimeout(() => {
  clearInterval(interval);
  console.log('\n\nĐã dừng (60s). Chạy lại để xem mã mới.\n');
  process.exit(0);
}, 60000);
