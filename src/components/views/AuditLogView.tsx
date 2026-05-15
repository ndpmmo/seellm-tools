'use client';
import React, { useCallback, useEffect, useState, useRef } from 'react';
import { useApp } from '../AppContext';
import { fmtDateTimeVN, ConfirmModal } from '../Views';
import { Card, CardHeader, CardTitle, CardContent, Button, Input, StatBox } from '../ui';
import {
  Shield, Search, RefreshCw, Trash2, Filter, ChevronLeft, ChevronRight,
  X, Eye, Activity, AlertTriangle, CheckCircle2, XCircle, Info, Clock
} from 'lucide-react';

/* ─── Types ──────────────────────────────────────────────────────────────── */
interface AuditEntry {
  id: string;
  action: string;
  entity: string;
  entity_id: string | null;
  entity_label: string | null;
  details: string | null;
  severity: string;
  source: string;
  created_at: string;
}

interface AuditStats {
  total: number;
  last24h: number;
  byEntity: { entity: string; c: number }[];
  byAction: { action: string; c: number }[];
  bySeverity: { severity: string; c: number }[];
  recentErrors: AuditEntry[];
}

/* ─── Constants ──────────────────────────────────────────────────────────── */
const ACTION_LABELS: Record<string, string> = {
  create: 'Tạo mới', update: 'Cập nhật', delete: 'Xóa',
  start: 'Khởi động', stop: 'Dừng', test: 'Kiểm tra',
  sync: 'Đồng bộ', deploy: 'Deploy', revoke: 'Thu hồi',
  verify: 'Xác minh', navigate: 'Điều hướng', launch: 'Mở',
  close: 'Đóng', clone: 'Nhân bản', import: 'Nhập',
  export: 'Xuất', bulk_delete: 'Xóa hàng loạt', bulk_verify: 'Xác minh H/L',
  config_change: 'Đổi cấu hình', connect: 'Kết nối', login: 'Đăng nhập',
  register: 'Đăng ký',
};

const ENTITY_LABELS: Record<string, string> = {
  account: 'Tài khoản', proxy: 'Proxy', api_key: 'API Key',
  email_pool: 'Email Pool', profile: 'Profile', process: 'Tiến trình',
  config: 'Cấu hình', cookie: 'Cookie', gateway: 'Gateway',
};

const SEVERITY_CONFIG: Record<string, { icon: React.ElementType; cls: string; bg: string }> = {
  info: { icon: Info, cls: 'text-blue-400', bg: 'bg-blue-500/10 border-blue-500/20' },
  success: { icon: CheckCircle2, cls: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/20' },
  warning: { icon: AlertTriangle, cls: 'text-amber-400', bg: 'bg-amber-500/10 border-amber-500/20' },
  error: { icon: XCircle, cls: 'text-rose-400', bg: 'bg-rose-500/10 border-rose-500/20' },
};

const SOURCE_LABELS: Record<string, string> = {
  ui: 'Giao diện', worker: 'Worker', sync: 'Đồng bộ', system: 'Hệ thống',
};

const PAGE_SIZE = 50;

/* ─── Detail Modal ───────────────────────────────────────────────────────── */
function DetailModal({ entry, onClose }: { entry: AuditEntry; onClose: () => void }) {
  const sev = SEVERITY_CONFIG[entry.severity] || SEVERITY_CONFIG.info;
  const SevIcon = sev.icon;
  let detailsObj: any = null;
  if (entry.details) {
    try { detailsObj = JSON.parse(entry.details); } catch { detailsObj = null; }
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="relative bg-[#111827] border border-white/10 rounded-2xl shadow-2xl w-[560px] max-w-[90vw] max-h-[80vh] overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-6 py-4 border-b border-white/5">
          <div className={`w-8 h-8 rounded-lg ${sev.bg} border flex items-center justify-center shrink-0`}>
            <SevIcon size={16} className={sev.cls} />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-[14px] font-bold text-slate-100">
              {ACTION_LABELS[entry.action] || entry.action} — {ENTITY_LABELS[entry.entity] || entry.entity}
            </h3>
            <p className="text-[11px] text-slate-400 mt-0.5">{fmtDateTimeVN(entry.created_at)}</p>
          </div>
          <button className="text-slate-400 hover:text-slate-200 transition-colors" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <div className="px-6 py-4 overflow-y-auto max-h-[60vh] space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-white/5 rounded-lg p-3 border border-white/5">
              <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">Hành động</div>
              <div className="text-[13px] text-slate-200 font-medium">{ACTION_LABELS[entry.action] || entry.action}</div>
            </div>
            <div className="bg-white/5 rounded-lg p-3 border border-white/5">
              <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">Đối tượng</div>
              <div className="text-[13px] text-slate-200 font-medium">{ENTITY_LABELS[entry.entity] || entry.entity}</div>
            </div>
            <div className="bg-white/5 rounded-lg p-3 border border-white/5">
              <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">Nhãn</div>
              <div className="text-[13px] text-slate-200 font-medium truncate">{entry.entity_label || '-'}</div>
            </div>
            <div className="bg-white/5 rounded-lg p-3 border border-white/5">
              <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">Nguồn</div>
              <div className="text-[13px] text-slate-200 font-medium">{SOURCE_LABELS[entry.source] || entry.source}</div>
            </div>
          </div>

          {entry.entity_id && (
            <div className="bg-white/5 rounded-lg p-3 border border-white/5">
              <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">Entity ID</div>
              <div className="text-[12px] text-slate-300 font-mono">{entry.entity_id}</div>
            </div>
          )}

          {detailsObj && (
            <div className="bg-white/5 rounded-lg p-3 border border-white/5">
              <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-2">Chi tiết</div>
              <pre className="text-[12px] text-slate-300 font-mono whitespace-pre-wrap break-words leading-relaxed">
                {JSON.stringify(detailsObj, null, 2)}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ─── Main View ──────────────────────────────────────────────────────────── */
export function AuditLogView() {
  const { addToast } = useApp();
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<AuditStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState('');
  const [filterEntity, setFilterEntity] = useState('');
  const [filterAction, setFilterAction] = useState('');
  const [filterSeverity, setFilterSeverity] = useState('');
  const [detailEntry, setDetailEntry] = useState<AuditEntry | null>(null);
  const [confirmModal, setConfirmModal] = useState<{ title: string; message: string; onConfirm: () => Promise<void> } | null>(null);
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchLogs = useCallback(async (p = page) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String(p * PAGE_SIZE),
      });
      if (search) params.set('search', search);
      if (filterEntity) params.set('entity', filterEntity);
      if (filterAction) params.set('action', filterAction);
      if (filterSeverity) params.set('severity', filterSeverity);

      const res = await fetch(`/api/audit-logs?${params}`);
      const data = await res.json();
      if (data.ok) {
        setEntries(data.items);
        setTotal(data.total);
      }
    } catch (e) {
      console.error('Failed to fetch audit logs:', e);
    }
    setLoading(false);
  }, [page, search, filterEntity, filterAction, filterSeverity]);

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch('/api/audit-logs/stats');
      const data = await res.json();
      if (data.ok) setStats(data);
    } catch (e) {
      console.error('Failed to fetch audit stats:', e);
    }
  }, []);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  // Debounced search
  const handleSearch = (val: string) => {
    setSearch(val);
    setPage(0);
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => fetchLogs(0), 300);
  };

  const handleFilterChange = (setter: (v: string) => void, val: string) => {
    setter(val);
    setPage(0);
  };

  const refresh = async () => {
    setLoading(true);
    await Promise.all([fetchLogs(), fetchStats()]);
    setLoading(false);
  };

  const totalPages = Math.ceil(total / PAGE_SIZE);

  const purgeLogs = async (olderThanDays: number) => {
    const r = await fetch('/api/audit-logs', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ olderThanDays }),
    });
    const data = await r.json();
    if (data.ok) {
      addToast(`Đã xóa ${data.deleted} log cũ hơn ${olderThanDays} ngày`, 'success');
      await refresh();
    } else {
      addToast('Xóa thất bại', 'error');
    }
    setConfirmModal(null);
  };

  const clearAllLogs = async () => {
    const r = await fetch('/api/audit-logs', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clearAll: true }),
    });
    const data = await r.json();
    if (data.ok) {
      addToast(`Đã xóa toàn bộ ${data.deleted} log`, 'success');
      await refresh();
    } else {
      addToast('Xóa thất bại', 'error');
    }
    setConfirmModal(null);
  };

  const hasActiveFilter = search || filterEntity || filterAction || filterSeverity;
  const clearFilters = () => {
    setSearch('');
    setFilterEntity('');
    setFilterAction('');
    setFilterSeverity('');
    setPage(0);
  };

  return (
    <div className="absolute inset-0 overflow-y-auto px-6 pb-10 pt-2 flex flex-col gap-5 custom-scrollbar">
      {/* Stats Row */}
      <div className="grid grid-cols-4 gap-4 mt-2">
        <StatBox label="Tổng logs" value={stats?.total || 0} icon={Shield} colorClass="text-indigo-400" bgClass="bg-indigo-500/10" borderClass="border-indigo-500/50" />
        <StatBox label="24h qua" value={stats?.last24h || 0} icon={Activity} colorClass="text-emerald-400" bgClass="bg-emerald-500/10" borderClass="border-emerald-500/50" />
        <StatBox label="Lỗi gần đây" value={stats?.recentErrors?.length || 0} icon={AlertTriangle} colorClass="text-rose-400" bgClass="bg-rose-500/10" borderClass="border-rose-500/50" />
        <StatBox label="Loại đối tượng" value={stats?.byEntity?.length || 0} icon={Filter} colorClass="text-cyan-400" bgClass="bg-cyan-500/10" borderClass="border-cyan-500/50" />
      </div>

      {/* Recent Errors Quick View */}
      {stats?.recentErrors && stats.recentErrors.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>
              <AlertTriangle size={15} className="text-rose-400" />
              Lỗi gần đây
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="divide-y divide-white/5">
              {stats.recentErrors.map(e => (
                <div
                  key={e.id}
                  className="flex items-center gap-3 px-4 py-2.5 hover:bg-white/[0.02] transition-colors cursor-pointer"
                  onClick={() => setDetailEntry(e)}
                >
                  <XCircle size={14} className="text-rose-400 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <span className="text-[12px] text-slate-200 font-medium">{e.entity_label || e.entity_id || e.entity}</span>
                    <span className="text-[11px] text-slate-500 ml-2">{ACTION_LABELS[e.action] || e.action}</span>
                  </div>
                  <span className="text-[10.5px] text-slate-500 shrink-0">{fmtDateTimeVN(e.created_at)}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Main Log Table */}
      <Card className="flex-1 flex flex-col min-h-0">
        <CardHeader className="flex-wrap gap-y-3">
          <CardTitle>
            <Shield size={15} className="text-indigo-400" />
            Audit Logs
            <span className="ml-2 px-2 py-0.5 rounded-full text-[10px] bg-white/10 text-slate-300 font-bold">{total}</span>
          </CardTitle>
          <div className="flex gap-2 items-center ml-auto flex-wrap">
            {/* Search */}
            <div className="relative flex items-center">
              <Search size={13} className="absolute left-2.5 text-slate-500 pointer-events-none" />
              <Input
                className="pl-7 w-[200px] h-8 text-xs bg-white/5 border-white/10"
                placeholder="Tìm kiếm..."
                value={search}
                onChange={e => handleSearch(e.target.value)}
              />
              {search && (
                <button onClick={() => handleSearch('')} className="absolute right-2 text-slate-500 hover:text-slate-300">
                  <X size={11} />
                </button>
              )}
            </div>

            {/* Entity Filter */}
            <select
              className="h-8 rounded-lg bg-black/40 border border-white/10 text-[12px] text-slate-300 px-2.5 pr-6 outline-none focus:border-indigo-500/50"
              value={filterEntity}
              onChange={e => handleFilterChange(setFilterEntity, e.target.value)}
            >
              <option value="">Đối tượng</option>
              {Object.entries(ENTITY_LABELS).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>

            {/* Action Filter */}
            <select
              className="h-8 rounded-lg bg-black/40 border border-white/10 text-[12px] text-slate-300 px-2.5 pr-6 outline-none focus:border-indigo-500/50"
              value={filterAction}
              onChange={e => handleFilterChange(setFilterAction, e.target.value)}
            >
              <option value="">Hành động</option>
              {Object.entries(ACTION_LABELS).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>

            {/* Severity Filter */}
            <select
              className="h-8 rounded-lg bg-black/40 border border-white/10 text-[12px] text-slate-300 px-2.5 pr-6 outline-none focus:border-indigo-500/50"
              value={filterSeverity}
              onChange={e => handleFilterChange(setFilterSeverity, e.target.value)}
            >
              <option value="">Mức độ</option>
              <option value="info">Info</option>
              <option value="success">Success</option>
              <option value="warning">Warning</option>
              <option value="error">Error</option>
            </select>

            {hasActiveFilter && (
              <Button variant="ghost" size="sm" onClick={clearFilters} className="text-[11px]">
                <X size={12} /> Xóa lọc
              </Button>
            )}

            <Button variant="danger" size="sm" onClick={() => setConfirmModal({
              title: 'Xóa Logs Cũ',
              message: 'Xóa tất cả audit logs cũ hơn 30 ngày? Hành động này không thể hoàn tác.',
              onConfirm: () => purgeLogs(30),
            })}>
              <Trash2 size={13} /> Dọn dẹp
            </Button>

            <Button variant="secondary" size="icon-sm" onClick={refresh} disabled={loading} className="border-white/10 bg-white/5">
              <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
            </Button>
          </div>
        </CardHeader>

        {/* Table */}
        <div className="flex-1 overflow-y-auto">
          {entries.length === 0 ? (
            <div className="py-20 flex flex-col items-center gap-3 text-center">
              <div className="text-4xl opacity-20">🛡️</div>
              <div className="text-slate-300 font-medium">{total === 0 ? 'Chưa có audit logs' : 'Không có log phù hợp bộ lọc'}</div>
              <div className="text-[12px] text-slate-500">Mọi thao tác trên hệ thống sẽ được ghi nhận tại đây</div>
            </div>
          ) : (
            <div className="divide-y divide-white/5">
              {entries.map(e => {
                const sev = SEVERITY_CONFIG[e.severity] || SEVERITY_CONFIG.info;
                const SevIcon = sev.icon;
                return (
                  <div
                    key={e.id}
                    className="flex items-center gap-3 px-5 py-3 hover:bg-white/[0.02] transition-colors group cursor-pointer"
                    onClick={() => setDetailEntry(e)}
                  >
                    {/* Severity Icon */}
                    <div className={`w-7 h-7 rounded-lg ${sev.bg} border flex items-center justify-center shrink-0`}>
                      <SevIcon size={13} className={sev.cls} />
                    </div>

                    {/* Content */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-[12.5px] font-semibold text-slate-200">
                          {ACTION_LABELS[e.action] || e.action}
                        </span>
                        <span className="text-[11px] text-slate-500">→</span>
                        <span className="text-[12px] text-slate-400">
                          {ENTITY_LABELS[e.entity] || e.entity}
                        </span>
                        {e.entity_label && (
                          <>
                            <span className="text-[11px] text-slate-600">·</span>
                            <span className="text-[12px] text-slate-300 truncate max-w-[200px]">{e.entity_label}</span>
                          </>
                        )}
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className={`text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border ${sev.bg} ${sev.cls}`}>
                          {e.severity}
                        </span>
                        <span className="text-[10px] text-slate-500">{SOURCE_LABELS[e.source] || e.source}</span>
                      </div>
                    </div>

                    {/* Time */}
                    <div className="flex items-center gap-2 shrink-0">
                      <Clock size={11} className="text-slate-600" />
                      <span className="text-[11px] text-slate-500">{fmtDateTimeVN(e.created_at)}</span>
                    </div>

                    {/* View button */}
                    <div className="opacity-0 group-hover:opacity-100 transition-opacity">
                      <Button variant="ghost" size="icon-sm" className="text-slate-400 hover:text-slate-200">
                        <Eye size={13} />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between px-5 py-3 border-t border-white/5">
            <span className="text-[11px] text-slate-500">
              Trang {page + 1}/{totalPages} · {total} entries
            </span>
            <div className="flex gap-1.5">
              <Button variant="ghost" size="sm" disabled={page === 0} onClick={() => setPage(p => p - 1)}>
                <ChevronLeft size={14} />
              </Button>
              <Button variant="ghost" size="sm" disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)}>
                <ChevronRight size={14} />
              </Button>
            </div>
          </div>
        )}
      </Card>

      {/* Detail Modal */}
      {detailEntry && <DetailModal entry={detailEntry} onClose={() => setDetailEntry(null)} />}

      {/* Confirm Modal */}
      {confirmModal && (
        <ConfirmModal
          title={confirmModal.title}
          message={confirmModal.message}
          onConfirm={confirmModal.onConfirm}
          onCancel={() => setConfirmModal(null)}
        />
      )}
    </div>
  );
}
