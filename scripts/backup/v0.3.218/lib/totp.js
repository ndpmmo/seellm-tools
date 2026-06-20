/**
 * scripts/lib/totp.js
 * 
 * TOTP (Time-based One-Time Password) generator for 2FA.
 * Consolidated from auto-login, auto-connect, auto-register, and mfa-setup.
 */

import { createHmac } from 'node:crypto';

/**
 * Get remaining seconds in current TOTP window (30s cycle)
 * @returns {number} Seconds remaining (0-29)
 */
export function getSecondsRemainingInTotpWindow() {
  return 30 - (Math.floor(Date.now() / 1000) % 30);
}

/**
 * Generate TOTP code from Base32 secret
 * @param {string} secret - Base32-encoded secret key
 * @returns {string} 6-digit TOTP code
 */
export function getTOTP(secret) {
  function base32tohex(base32) {
    const base32chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = '', hex = '';
    const clean = base32.replace(/\s/g, '').toUpperCase();
    for (let i = 0; i < clean.length; i++) {
      const val = base32chars.indexOf(clean.charAt(i));
      if (val === -1) continue;
      bits += val.toString(2).padStart(5, '0');
    }
    for (let i = 0; i + 4 <= bits.length; i += 4) hex += parseInt(bits.substr(i, 4), 2).toString(16);
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

/**
 * Get fresh TOTP code, waiting for next window if current is too close to expiry
 * @param {string} secret - Base32-encoded secret key
 * @param {number} minRemainingSeconds - Minimum seconds remaining before using current code (default 10)
 * @returns {Promise<{otp: string, remaining: number}>} TOTP code and remaining seconds
 */
export async function getFreshTOTP(secret, minRemainingSeconds = 10) {
  if (!secret) throw new Error('Missing TOTP secret');
  let remaining = getSecondsRemainingInTotpWindow();
  if (remaining <= minRemainingSeconds) {
    await new Promise((r) => setTimeout(r, (remaining + 1) * 1000));
    remaining = getSecondsRemainingInTotpWindow();
  }
  return { otp: getTOTP(secret), remaining };
}
