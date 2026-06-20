/**
 * Audit Log API Router — Đọc/xóa audit logs + thống kê.
 */
import express from 'express';
import { getAuditLogs, getAuditStats, purgeAuditLogs, purgeAuditLogsToday, clearAuditLogs } from '../db/auditLog.js';

const router = express.Router();
router.use(express.json({ limit: '50mb' }));

// SSE emitter — set from server.js
let emitSSE = null;
export function setAuditSSEEmitter(emitter) {
  emitSSE = emitter;
}

/**
 * Broadcast audit event realtime qua SSE.
 * Gọi từ các route khác khi có thao tác cần log.
 */
export function broadcastAudit(entry) {
  if (emitSSE) {
    emitSSE('audit:new', entry);
  }
}

/* ─── Routes ─────────────────────────────────────────────────────────────── */

/** GET /api/audit-logs — List logs với filter + pagination */
router.get('/', (req, res) => {
  try {
    const opts = {
      entity: req.query.entity || undefined,
      action: req.query.action || undefined,
      severity: req.query.severity || undefined,
      source: req.query.source || undefined,
      search: req.query.search || undefined,
      from: req.query.from || undefined,
      to: req.query.to || undefined,
      limit: Math.min(parseInt(req.query.limit) || 100, 500),
      offset: parseInt(req.query.offset) || 0,
    };
    const result = getAuditLogs(opts);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** GET /api/audit-logs/stats — Thống kê tổng quan */
router.get('/stats', (req, res) => {
  try {
    const stats = getAuditStats();
    res.json({ ok: true, ...stats });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** DELETE /api/audit-logs — Purge logs cũ hơn X ngày, xóa hôm nay, hoặc xóa tất cả */
router.delete('/', (req, res) => {
  try {
    const { olderThanDays, clearAll, today } = req.body || req.query;
    let deleted;
    if (clearAll === 'true' || clearAll === true) {
      deleted = clearAuditLogs();
    } else if (today === 'true' || today === true) {
      deleted = purgeAuditLogsToday();
    } else {
      deleted = purgeAuditLogs(parseInt(olderThanDays) || 30);
    }
    res.json({ ok: true, deleted });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
