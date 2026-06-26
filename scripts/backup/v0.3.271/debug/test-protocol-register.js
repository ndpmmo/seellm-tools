/**
 * Debug script for protocol-mode registration.
 * Usage: node scripts/debug/test-protocol-register.js <email> [proxyUrl]
 */

import { runProtocolRegistration, generatePassword } from '../lib/openai-protocol-register.js';
import { checkIpLocation } from '../lib/proxy-diag.js';

const email = process.argv[2];
const proxyUrl = process.argv[3] || null;

if (!email) {
  console.error('Usage: node scripts/debug/test-protocol-register.js <email> [proxyUrl]');
  process.exit(1);
}

async function mockEmailService({ email: em, timeout }) {
  console.log(`[MockEmail] Waiting for OTP for ${em}... (simulate by typing code in terminal)`);
  // In a real scenario this would poll the email inbox
  return null;
}

async function main() {
  console.log(`🚀 Protocol Registration Test`);
  console.log(`   Email: ${email}`);
  console.log(`   Proxy: ${proxyUrl || 'none'}`);

  // IP check
  const ipCheck = await checkIpLocation(proxyUrl);
  console.log(`[IP Check]`, ipCheck);
  if (!ipCheck.ok) {
    console.log('❌ IP check failed, aborting');
    process.exit(1);
  }

  // Protocol registration
  const password = generatePassword();
  const result = await runProtocolRegistration({
    email,
    password,
    proxyUrl,
    emailService: { getVerificationCode: mockEmailService },
  });

  console.log(`\n📋 Result:`);
  console.log(JSON.stringify(result, (key, value) => {
    if (key === 'cookies' && typeof value === 'object') return '<cookies>';
    return value;
  }, 2));

  if (result.success) {
    console.log('\n✅ Protocol registration succeeded!');
  } else if (result.isExistingAccount) {
    console.log('\n⚠️ Email already exists — would switch to login flow');
  } else {
    console.log(`\n❌ Protocol registration failed: ${result.error}`);
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
