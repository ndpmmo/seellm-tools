import fs from 'fs';
import { vault } from './server/db/vault.js';
import { SyncManager } from './server/services/syncManager.js';
import dayjs from 'dayjs';

async function run() {
    console.log("Loading D1 Data...");
    const d1Raw = JSON.parse(fs.readFileSync('/tmp/d1_data.json', 'utf8'));
    const d1Accounts = d1Raw.data?.vaultAccounts || [];
    const d1Managed = d1Raw.data?.managedAccounts || [];

    console.log("Loading Local Vault...");
    const localAccounts = vault.db.prepare('SELECT * FROM vault_accounts WHERE deleted_at IS NULL ORDER BY updated_at DESC').all();
    const localDeleted = vault.db.prepare('SELECT * FROM vault_accounts WHERE deleted_at IS NOT NULL').all();

    console.log(`Local Alive: ${localAccounts.length}, Local Deleted: ${localDeleted.length}, D1 Vault: ${d1Accounts.length}, D1 Managed: ${d1Managed.length}`);

    let actionsProcessed = 0;

    // 1. Force Push ALL ALIVE local accounts to D1
    console.log("\n--- Phase 1: Force Pushing Local Alive Accounts ---");
    for (const acc of localAccounts) {
        if (!acc.email) continue;
        process.stdout.write(`Pushing ALIVE ${acc.email}... `);
        await SyncManager.pushVault('account', acc, true); // force=true
        console.log(`OK`);
        actionsProcessed++;
    }

    // 2. Soft-delete any account in D1 that is NOT ALIVE locally (either deleted locally, or doesn't exist locally)
    console.log("\n--- Phase 2: Cleaning up Junk/Deleted Accounts in D1 ---");
    const localSet = new Set(localAccounts.map(a => a.id));

    // Collect all unique IDs from D1
    const d1Set = new Set([
        ...d1Accounts.map(a => a.id),
        ...d1Managed.map(a => a.id)
    ]);

    for (const id of d1Set) {
        if (!localSet.has(id)) {
            // Find what email it was
            const d1Acc = d1Accounts.find(a => a.id === id) || d1Managed.find(a => a.id === id);
            const email = d1Acc?.email || id;

            // Look up if we have it locally in the deleted stash
            let recordToPush = localDeleted.find(a => a.id === id);
            if (!recordToPush) {
                recordToPush = {
                    ...d1Acc,
                    status: 'idle',
                    deleted_at: dayjs().toISOString()
                };
            } else {
                if (!recordToPush.deleted_at) {
                    recordToPush.deleted_at = dayjs().toISOString();
                }
            }

            process.stdout.write(`Soft-deleting JUNK/Deleted ${email}... `);
            await SyncManager.pushVault('account', recordToPush, true);
            console.log(`OK`);
            actionsProcessed++;
        }
    }

    console.log(`\n✅ Done! Processed ${actionsProcessed} actions.`);
    process.exit(0);
}

run().catch(console.error);
