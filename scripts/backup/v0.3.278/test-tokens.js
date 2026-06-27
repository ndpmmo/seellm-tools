import sqlite3 from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { waitForOTPCode } from './lib/ms-graph-email.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, '../data/vault.db');
const db = new sqlite3(dbPath);

const accounts = db.prepare(`
  SELECT email, password, refresh_token, client_id, chatgpt_status 
  FROM vault_email_pool 
  WHERE (chatgpt_status = 'failed' OR chatgpt_status = 'pending')
  LIMIT 15
`).all();

console.log(`Checking ${accounts.length} accounts...`);

for (const acc of accounts) {
  if (!acc.refresh_token || !acc.client_id) {
    console.log(`[-] ${acc.email}: Missing token credentials`);
    continue;
  }
  
  try {
    console.log(`[?] Checking ${acc.email}...`);
    const otp = await waitForOTPCode({
      email: acc.email,
      refreshToken: acc.refresh_token,
      clientId: acc.client_id,
      senderDomain: 'openai.com',
      maxWaitSecs: 1 // Chỉ poll 1 giây
    }).catch(e => {
      if (e.message.includes('Token attempt failed') || e.message.includes('authenticated as the grant is expired') || e.message.includes('unauthorized or expired')) {
        throw e;
      }
      return 'timeout';
    });
    
    console.log(`[+] ${acc.email}: Token is VALID!`);
  } catch (e) {
    console.log(`[x] ${acc.email}: Token is INVALID! -> ${e.message.substring(0, 150)}`);
  }
}

db.close();
