import express from 'express';
import { vault } from '../db/vault.js';
import { SyncManager } from '../services/syncManager.js';

const router = express.Router();

// --- ACCOUNTS ---
router.get('/accounts', (req, res) => {
  try { res.json({ ok: true, items: vault.getAccounts() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/accounts', async (req, res) => {
  try {
    const record = vault.upsertAccount(req.body);
    SyncManager.pushVault('account', record); // background sync
    res.json({ ok: true, id: record.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/accounts/:id', async (req, res) => {
  try {
    const record = vault.deleteAccount(req.params.id);
    SyncManager.pushVault('account', record);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- PROXIES ---
router.get('/proxies', (req, res) => {
  try { res.json({ ok: true, items: vault.getProxies() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/proxies', async (req, res) => {
  try {
    const record = vault.upsertProxy(req.body);
    SyncManager.pushVault('proxy', record);
    res.json({ ok: true, id: record.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/proxies/:id', async (req, res) => {
  try {
    const record = vault.deleteProxy(req.params.id);
    SyncManager.pushVault('proxy', record);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- API KEYS ---
router.get('/api-keys', (req, res) => {
  try { res.json({ ok: true, items: vault.getApiKeys() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api-keys', async (req, res) => {
  try {
    const record = vault.upsertApiKey(req.body);
    SyncManager.pushVault('key', record);
    res.json({ ok: true, id: record.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/api-keys/:id', async (req, res) => {
  try {
    const record = vault.deleteApiKey(req.params.id);
    SyncManager.pushVault('key', record);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
