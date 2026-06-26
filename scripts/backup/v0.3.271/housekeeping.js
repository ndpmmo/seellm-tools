/**
 * seellm-tools - Smart Housekeeping Service
 *
 * Automates the cleanup of local Camofox browser profile directories.
 * Identifies and purges:
 * - Orphaned profiles (no matching account in the database)
 * - Dead accounts (status is "dead" or deactivated)
 * - Deleted accounts
 *
 * Usage:
 *   node scripts/housekeeping.js
 */

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(__dirname, "..");
const DB_PATH = path.join(ROOT_DIR, "data", "vault.db");

// Helper to compute SHA256
function getSha256(str) {
  return crypto.createHash("sha256").update(str).digest("hex");
}

// Helper to calculate directory size recursively
async function getDirSize(dirPath) {
  let size = 0;
  try {
    const files = await fs.readdir(dirPath, { withFileTypes: true });
    for (const file of files) {
      const filePath = path.join(dirPath, file.name);
      if (file.isDirectory()) {
        size += await getDirSize(filePath);
      } else if (file.isFile()) {
        const stats = await fs.stat(filePath);
        size += stats.size;
      }
    }
  } catch (e) {
    // Ignore locked files/temp read issues
  }
  return size;
}

// Format bytes
function formatBytes(bytes) {
  if (!bytes || bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function run() {
  console.log("🧹 [Housekeeping] Starting smart profile cleanup service...");

  // 1. Resolve Profile directory
  const homeDir = process.env.HOME || process.env.USERPROFILE || os.homedir() || "";
  const profilesDir = process.env.CAMOFOX_PROFILE_DIR || path.join(homeDir, ".camofox", "profiles");

  let subdirs = [];
  try {
    subdirs = await fs.readdir(profilesDir);
  } catch (e) {
    console.log(`ℹ️ [Housekeeping] Profile directory not found or empty: ${profilesDir}`);
    return;
  }

  // 2. Load accounts from SQLite database
  let accounts = [];
  try {
    if (await fs.stat(DB_PATH).catch(() => false)) {
      const db = new Database(DB_PATH);
      accounts = db.prepare("SELECT id, email, status, is_active, deleted_at FROM vault_accounts").all();
      db.close();
      console.log(`📊 [Housekeeping] Loaded ${accounts.length} accounts from local database.`);
    } else {
      console.warn("⚠️ [Housekeeping] vault.db not found at data/vault.db, proceeding in safe-only mode (orphaned check disabled).");
    }
  } catch (err) {
    console.error("❌ [Housekeeping] Failed to load accounts from database:", err.message);
    return;
  }

  // 3. Pre-calculate variations and map them to their expected hashes
  const hashMap = new Map();
  for (const acc of accounts) {
    const email = acc.email || "";
    const id = acc.id || "";
    const status = acc.status || "";
    const isActive = acc.is_active !== 0;
    const deletedAt = acc.deleted_at || null;

    const variations = [
      `seellm_connect_${id}`,
      `register_${email}`,
      `warmup_${id}`,
      `seellm_${id}`,
      `seellm_${email}`,
      id,
      email,
    ];

    for (const val of variations) {
      if (val) {
        hashMap.set(getSha256(val), { email, id, status, isActive, deletedAt });
      }
    }
  }

  let cleanedCount = 0;
  let totalRecoveredBytes = 0;

  console.log("🔍 [Housekeeping] Analyzing local profiles...");

  for (const dirName of subdirs) {
    // Only check valid sha256 directory names
    if (!/^[a-f0-9]{64}$/i.test(dirName)) {
      continue;
    }

    const fullPath = path.join(profilesDir, dirName);
    let sizeBytes = 0;

    try {
      const stat = await fs.stat(fullPath);
      if (!stat.isDirectory()) continue;
      sizeBytes = await getDirSize(fullPath);
    } catch (e) {
      continue;
    }

    const matched = hashMap.get(dirName);
    let shouldDelete = false;
    let reason = "";

    if (!matched) {
      // Orphaned profile directory (not registered in database)
      shouldDelete = true;
      reason = "Orphaned (No linked database account)";
    } else if (matched.deletedAt) {
      // Linked account was deleted
      shouldDelete = true;
      reason = `Account deleted (Email: ${matched.email})`;
    } else if (matched.status === "dead" || !matched.isActive) {
      // Account is dead or deactivated
      shouldDelete = true;
      reason = `Account is dead/inactive (Email: ${matched.email})`;
    }

    if (shouldDelete) {
      try {
        console.log(`🗑️ [Housekeeping] Pruning profile folder: ${dirName.substring(0, 10)}... | Size: ${formatBytes(sizeBytes)} | Reason: ${reason}`);
        await fs.rm(fullPath, { recursive: true, force: true });
        cleanedCount++;
        totalRecoveredBytes += sizeBytes;
      } catch (err) {
        console.error(`❌ [Housekeeping] Failed to prune ${fullPath}:`, err.message);
      }
    }
  }

  console.log(`✅ [Housekeeping] Cleanup complete! Purged ${cleanedCount} folders. Recovered ${formatBytes(totalRecoveredBytes)}.`);
}

run().catch((err) => {
  console.error("❌ [Housekeeping] Fatal error in housekeeping execution:", err);
});
