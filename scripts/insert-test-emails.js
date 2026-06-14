import sqlite3 from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, '../data/vault.db');
const db = new sqlite3(dbPath);

const newEmails = [
  {
    email: 'nicolewalker4ydlnu7e@hotmail.com',
    password: 'Trieu@123',
    refresh_token: 'M.C544_SN1.0.U.MsaArtifacts.-CuoJ85UKd*z6oS!sqk7GaQVfoxZasAkxKD8Mboc1p77bI1Yn37*YKDhuuMfFsvkToa*vn5J4L*6iX5Lb699KRIpsI4kzgGBq7419SNk3*OcspqJQ7VFRC9WzkELbRId*u9rCJX4E38Huaa6TFNjKlzRCRjN1OZWyVwfBxF0pz63RMAO8!9MfTJrN3I3lcAkm4FGU9tkkFQbtG49X8*fS5Z9mB0TBTZp92ND5TIJ4SaNBZjufQAV8nRbD8NyDIw!7zGbdQlkAwTlrqvJrly1SA8USDR7NsGtN2*1Gk5U7lYsP9WkinSbzIfVxb8DjV0L19SOo9i5EzvNfk57Sbef1P8dX*QgtF*E8nZpRlXvJm9PYAefzYAtirUWlhidz1sAv*Q$$',
    client_id: '9e5f94bc-e8a4-4e73-b8be-63364c29d753'
  },
  {
    email: 'karennelsoncjrsipvi@hotmail.com',
    password: 'MAxXXo@123',
    refresh_token: 'M.C539_BAY.0.U.MsaArtifacts.-Ch9VYYKrd2lu0jyiYaJZjv6KfN0V3aNh0LoLQtBc5MToiwRwiWfmi1PGKmpg*HZAApZHe5VanRhARcKLrJe41D8JeoSmwOURmenX1zrHGjJuTYfwlH!fGy2a!dHdeSMtep8wgale9Ud7JJ3!3N3XSvOM8wewFn8pt6cjCffw5OEmgzY0YP6FuK*FCrRnmgfuuj0t9pJ58!b9LCyn4D6F0LaVQL*WnMkQ6RfiIDu3YpGiksh*ODoHm64B0Qi86GrJIuJEaZCrUOiGM*JOelT9FSsYstsUmelL33kWD9qqRNCje9W*e0f5DgR6exo8Vaq85rNz4Kzc4BEcqGmKTwAwr3E!vtcMWQxT7rq6zpvHxBAgyN4Hc!CsVf9sFOXqg3qPNQ$$',
    client_id: '9e5f94bc-e8a4-4e73-b8be-63364c29d753'
  },
  {
    email: 'matthewthompsonordcjlc8@hotmail.com',
    password: 'Trieu@123',
    refresh_token: 'M.C549_SN1.0.U.MsaArtifacts.-CgZ*ubbs5foqbQF*mqg0RCy4OYzm!uoDHAZnKRf3j*JogH*13toJZT6JeEfMhOsKLIMzmxBDrBWSBXRdP30ejLqapwH7xy*XvP!3S*dq2X!In0YHHvJt2CZlh5fcMAYMCxBJTN4wS3!2Gc43oPKNuij!0mvqnyPVDoPkU2qUcaVTlKnMOFb1OcVhDZwcAJVIwmwHh0!VER8rNxedU4cJUEHUoRwfS41w6ahq*!qI7hwh4aQYKlNUxeTBqnwDTq2oLPZXgADgRLUgYPyl23GwFGmm3By59ThiXNBVq!yeRAP1XfvZiizvlEDX*qqXVn0gNp2iVOsMWn3Uu8oON8qhj*qpUsqGLBUw7UPKJ1UUpjkEzsQ3GXkLdJ1ufRBB9v5vKS0v9rbE8Bg0y8yJVh9FjAU$',
    client_id: '9e5f94bc-e8a4-4e73-b8be-63364c29d753'
  }
];

const now = new Date().toISOString();

for (const item of newEmails) {
  const existing = db.prepare('SELECT email FROM vault_email_pool WHERE email = ?').get(item.email);
  if (existing) {
    db.prepare(`
      UPDATE vault_email_pool 
      SET password = ?, refresh_token = ?, client_id = ?, chatgpt_status = 'failed', notes = 'User provided fresh test email', updated_at = ?
      WHERE email = ?
    `).run(item.password, item.refresh_token, item.client_id, now, item.email);
    console.log(`Updated existing account: ${item.email}`);
  } else {
    db.prepare(`
      INSERT INTO vault_email_pool (email, password, refresh_token, client_id, chatgpt_status, notes, updated_at, created_at)
      VALUES (?, ?, ?, ?, 'failed', 'User provided fresh test email', ?, ?)
    `).run(item.email, item.password, item.refresh_token, item.client_id, now, now);
    console.log(`Inserted new account: ${item.email}`);
  }
}

db.close();
