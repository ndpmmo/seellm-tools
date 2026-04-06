import express from 'express';
import { vault } from '../db/vault.js';

const router = express.Router();

// --- ACCOUNTS ---
router.get('/accounts', (req, res) => {
  try { res.json({ ok: true, items: vault.getAccounts() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/accounts', (req, res) => {
  try {
    const id = vault.upsertAccount(req.body);
    res.json({ ok: true, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/accounts/:id', (req, res) => {
  try {
    vault.deleteAccount(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- PROXIES ---
router.get('/proxies', (req, res) => {
  try { res.json({ ok: true, items: vault.getProxies() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/proxies', (req, res) => {
  try {
    const id = vault.upsertProxy(req.body);
    res.json({ ok: true, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/proxies/:id', (req, res) => {
  try {
    vault.deleteProxy(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- API KEYS ---
router.get('/api-keys', (req, res) => {
  try { res.json({ ok: true, items: vault.getApiKeys() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api-keys', (req, res) => {
  try {
    const id = vault.upsertApiKey(req.body);
    res.json({ ok: true, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/api-keys/:id', (req, res) => {
  try {
    vault.deleteApiKey(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
