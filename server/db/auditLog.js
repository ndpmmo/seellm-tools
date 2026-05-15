/**
 * Audit Log Module — Ghi nhận mọi thao tác trên hệ thống để giám sát.
 *
 * Mỗi log entry: ai làm gì, trên đối tượng nào, khi nào, chi tiết gì.
 * Dùng chung vault.db (better-sqlite3) — không cần DB riêng.
 */
import { vault } from './vault.js';
import { v4 as uuidv4 } from 'uuid';
import dayjs from 'dayjs';

/* ─── Schema ─────────────────────────────────────────────────────────────── */

function initAuditSchema() {
  vault.db.exec(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id            TEXT PRIMARY KEY,
      action        TEXT NOT NULL,       -- create|update|delete|start|stop|test|sync|deploy|revoke|verify|navigate|launch|close|clone|import|export|bulk_delete|bulk_verify|config_change|connect|login|register
      entity        TEXT NOT NULL,       -- account|proxy|api_key|email_pool|profile|process|config|cookie|gateway
      entity_id     TEXT,                -- ID của đối tượng
      entity_label  TEXT,                -- tên/email/label hiển thị
      details       TEXT,                -- JSON chi tiết (before/after snapshot, metadata)
      severity      TEXT DEFAULT 'info', -- info|success|warning|error
      source        TEXT DEFAULT 'ui',   -- ui|worker|sync|system
      created_at    TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs(entity);
    CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action);
    CREATE INDEX IF NOT EXISTS idx_audit_severity ON audit_logs(severity);
    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_audit_entity_id ON audit_logs(entity_id);
  `);
}

initAuditSchema();

/* ─── Insert Statement (prepared for performance) ────────────────────────── */

const insertStmt = vault.db.prepare(`
  INSERT INTO audit_logs (id, action, entity, entity_id, entity_label, details, severity, source, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

/* ─── Public API ──────────────────────────────────────────────────────────── */

/**
 * Ghi một audit log entry.
 *
 * @param {object} entry
 * @param {string} entry.action    — Loại hành động
 * @param {string} entry.entity    — Đối tượng bị tác động
 * @param {string} [entry.entityId] — ID đối tượng
 * @param {string} [entry.entityLabel] — Tên hiển thị
 * @param {object} [entry.details] — Chi tiết bổ sung (sẽ JSON.stringify)
 * @param {string} [entry.severity='info'] — Mức độ
 * @param {string} [entry.source='ui'] — Nguồn thao tác
 * @returns {{ id: string, createdAt: string }}
 */
export function auditLog({ action, entity, entityId, entityLabel, details, severity = 'info', source = 'ui' }) {
  const id = `log_${uuidv4().replace(/-/g, '').slice(0, 10)}`;
  const createdAt = dayjs().toISOString();
  const detailsJson = details ? JSON.stringify(details) : null;

  insertStmt.run(id, action, entity, entityId || null, entityLabel || null, detailsJson, severity, source, createdAt);

  return { id, createdAt };
}

/**
 * Lấy audit logs với filter + pagination.
 *
 * @param {object} opts
 * @param {string} [opts.entity]    — Filter theo entity
 * @param {string} [opts.action]    — Filter theo action
 * @param {string} [opts.severity]  — Filter theo severity
 * @param {string} [opts.source]    — Filter theo source
 * @param {string} [opts.search]    — Tìm trong entity_label / entity_id
 * @param {string} [opts.from]      — Từ ngày (ISO)
 * @param {string} [opts.to]        — Đến ngày (ISO)
 * @param {number} [opts.limit=100] — Số dòng tối đa
 * @param {number} [opts.offset=0]  — Offset cho pagination
 * @returns {{ items: Array, total: number }}
 */
export function getAuditLogs(opts = {}) {
  const { entity, action, severity, source, search, from, to, limit = 100, offset = 0 } = opts;

  const clauses = [];
  const params = [];

  if (entity) { clauses.push('entity = ?'); params.push(entity); }
  if (action) { clauses.push('action = ?'); params.push(action); }
  if (severity) { clauses.push('severity = ?'); params.push(severity); }
  if (source) { clauses.push('source = ?'); params.push(source); }
  if (from) { clauses.push("created_at >= ?"); params.push(from); }
  if (to) { clauses.push("created_at <= ?"); params.push(to); }
  if (search) {
    clauses.push('(entity_label LIKE ? OR entity_id LIKE ? OR details LIKE ?)');
    const q = `%${search}%`;
    params.push(q, q, q);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const total = vault.db.prepare(`SELECT COUNT(*) as c FROM audit_logs ${where}`).get(...params).c;
  const items = vault.db.prepare(
    `SELECT * FROM audit_logs ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);

  return { items, total };
}

/**
 * Thống kê tổng quan cho dashboard.
 */
export function getAuditStats() {
  const total = vault.db.prepare('SELECT COUNT(*) as c FROM audit_logs').get().c;
  const last24h = vault.db.prepare(
    "SELECT COUNT(*) as c FROM audit_logs WHERE created_at >= ?"
  ).get(dayjs().subtract(24, 'hour').toISOString()).c;

  const byEntity = vault.db.prepare(
    'SELECT entity, COUNT(*) as c FROM audit_logs GROUP BY entity ORDER BY c DESC'
  ).all();

  const byAction = vault.db.prepare(
    'SELECT action, COUNT(*) as c FROM audit_logs GROUP BY action ORDER BY c DESC'
  ).all();

  const bySeverity = vault.db.prepare(
    'SELECT severity, COUNT(*) as c FROM audit_logs GROUP BY severity'
  ).all();

  const recentErrors = vault.db.prepare(
    "SELECT * FROM audit_logs WHERE severity = 'error' ORDER BY created_at DESC LIMIT 10"
  ).all();

  return { total, last24h, byEntity, byAction, bySeverity, recentErrors };
}

/**
 * Xóa audit logs cũ hơn X ngày.
 * @param {number} olderThanDays — Số ngày
 * @returns {number} — Số dòng đã xóa
 */
export function purgeAuditLogs(olderThanDays = 30) {
  const cutoff = dayjs().subtract(olderThanDays, 'day').toISOString();
  const result = vault.db.prepare('DELETE FROM audit_logs WHERE created_at < ?').run(cutoff);
  return result.changes;
}

/**
 * Xóa toàn bộ audit logs.
 * @returns {number}
 */
export function clearAuditLogs() {
  const result = vault.db.prepare('DELETE FROM audit_logs').run();
  return result.changes;
}
