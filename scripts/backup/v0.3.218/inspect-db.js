import Database from 'better-sqlite3';
import path from 'path';

const DB_PATH = path.resolve('data/vault.db');
console.log('Reading DB:', DB_PATH);
const db = new Database(DB_PATH);

const accounts = db.prepare('SELECT id, provider, label, email, status, proxy_url, two_fa_secret FROM vault_accounts').all();
console.log('Total accounts found:', accounts.length);
console.dir(accounts, { depth: null });
