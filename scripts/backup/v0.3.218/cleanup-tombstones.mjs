#!/usr/bin/env node
/**
 * cleanup-tombstones.mjs
 *
 * Hard-delete soft-deleted (tombstoned) records from Tools' local vault.db.
 * Tombstones accumulate over time because vault.deleteAccount/deleteProxy
 * use soft-delete + push to D1. Once D1 has been synced and there's no need
 * to track historic deletions, tombstones can be safely purged locally.
 *
 * Usage:
 *   node scripts/cleanup-tombstones.mjs
 */

import path from "node:path";
import fs from "node:fs";
import Database from "better-sqlite3";

const DB_PATH = path.resolve("data/vault.db");

if (!fs.existsSync(DB_PATH)) {
  console.error(`[cleanup-tombstones] vault.db not found: ${DB_PATH}`);
  process.exit(1);
}

const TABLES = ["vault_accounts", "vault_proxies", "vault_api_keys"];

const db = new Database(DB_PATH);
console.log(`[cleanup-tombstones] DB: ${DB_PATH}`);

const summary = {};
for (const table of TABLES) {
  try {
    const before = db
      .prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE deleted_at IS NOT NULL`)
      .get();
    const result = db
      .prepare(`DELETE FROM ${table} WHERE deleted_at IS NOT NULL`)
      .run();
    summary[table] = { tombstonesFound: before?.c || 0, deleted: result.changes };
    console.log(
      `  - ${table}: tombstones=${before?.c || 0}, deleted=${result.changes}`
    );
  } catch (e) {
    summary[table] = { error: e.message };
    console.warn(`  - ${table}: SKIPPED (${e.message})`);
  }
}

db.close();

console.log("\n[cleanup-tombstones] Summary:");
console.log(JSON.stringify(summary, null, 2));
console.log("\nDone. Restart Tools server if it was running.");
