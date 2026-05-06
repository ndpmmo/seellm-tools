/**
 * cleanup-d1-stale-connections.mjs
 *
 * Scans Cloudflare D1 active codex_connections and hard-deletes / deactivates
 * those that no longer correspond to a 'ready' managed_account.
 *
 * Run: node scripts/cleanup-d1-stale-connections.mjs
 */
import { readFileSync } from "fs";
import { resolve } from "path";

const CONFIG_PATH = resolve("tools.config.json");
const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

const BASE = String(cfg.d1WorkerUrl || "").replace(/\/+$/, "");
const SECRET = cfg.d1SyncSecret;

if (!BASE || !SECRET) {
  console.error("Missing d1WorkerUrl or d1SyncSecret in tools.config.json");
  process.exit(1);
}

async function d1Req(endpoint, opts = {}) {
  const url = `${BASE}/${endpoint.replace(/^\/+/, "")}`;
  const res = await fetch(url, {
    method: opts.method || "GET",
    headers: {
      "x-sync-secret": SECRET,
      ...(opts.body ? { "Content-Type": "application/json" } : {}),
    },
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${data.error || text.slice(0, 200)}`);
  }
  return data;
}

async function main() {
  console.log("Fetching active connections from D1...");
  const connRes = await d1Req("inspect/connections?active=1&limit=500");
  const connections = connRes.items || [];
  console.log(`  → ${connections.length} active connections`);

  console.log("Fetching managed accounts from D1...");
  const acctRes = await d1Req("inspect/accounts?limit=1000");
  const accounts = acctRes.items || [];
  console.log(`  → ${accounts.length} managed accounts`);

  // Map managed accounts by id + by email (lowercased)
  const acctById = new Map();
  const acctByEmail = new Map();
  for (const a of accounts) {
    if (a.id) acctById.set(String(a.id), a);
    if (a.email) acctByEmail.set(String(a.email).toLowerCase(), a);
  }

  // Identify stale connections:
  // 1. No matching managed account at all (by id OR by email)
  // 2. Matching managed account exists but status != 'ready'
  const stale = [];
  const keep = [];
  for (const c of connections) {
    const id = String(c.id || "");
    const email = String(c.email || "").toLowerCase();

    const ma = acctById.get(id) || acctByEmail.get(email) || null;

    if (!ma) {
      stale.push({ ...c, reason: "no-managed-account" });
      continue;
    }
    if (ma.status !== "ready") {
      stale.push({ ...c, reason: `managed-status=${ma.status}` });
      continue;
    }
    keep.push(c);
  }

  console.log(`\n${keep.length} connections are VALID (linked to ready managed account)`);
  console.log(`${stale.length} connections are STALE and will be tombstoned:\n`);
  for (const s of stale) {
    console.log(`  [${s.reason}] ${s.email || s.id}`);
  }

  if (stale.length === 0) {
    console.log("\nNothing to clean up.");
    return;
  }

  // Confirm
  console.log("\n---");
  const dryRun = process.argv.includes("--dry-run");
  if (dryRun) {
    console.log("--dry-run passed: no changes made.");
    return;
  }

  // Push tombstones via /sync/push
  const now = new Date().toISOString();
  const tombstones = stale.map((c) => ({
    id: c.id,
    email: c.email,
    updated_at: now,
    deleted_at: now,
    is_active: 0,
    version: Date.now(),
  }));

  console.log(`Pushing ${tombstones.length} tombstones to D1 via /sync/push ...`);
  const pushRes = await d1Req("sync/push", {
    method: "POST",
    body: { connections: tombstones },
  });

  if (pushRes.ok || pushRes.counts) {
    console.log("  ✅ D1 accepted tombstones:", JSON.stringify(pushRes.counts || pushRes));
  } else {
    console.error("  ❌ D1 rejected push:", JSON.stringify(pushRes));
    process.exit(1);
  }

  console.log("\nCleanup complete.");
}

main().catch((e) => {
  console.error("Fatal error:", e.message);
  process.exit(1);
});
