'use client';
import React from 'react';
import { useApp } from './AppContext';
import { AlertTriangle, CheckCircle, XCircle, Info, AlertCircle } from 'lucide-react';

export function ConfirmModal({ title, message, onConfirm, onCancel, isLoading }: {
  title: string; message: string;
  onConfirm: () => void; onCancel: () => void; isLoading?: boolean;
}) {
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onCancel}>
      <div className="relative bg-[#111827] border border-white/10 rounded-2xl shadow-2xl w-[420px] max-w-[90vw] overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-6 py-5 border-b border-white/5">
          <div className="w-9 h-9 rounded-lg bg-rose-500/10 border border-rose-500/20 flex items-center justify-center shrink-0">
            <AlertTriangle size={18} className="text-rose-400" />
          </div>
          <h3 className="text-[15px] font-bold text-slate-100">{title}</h3>
        </div>
        <div className="px-6 py-5 text-[13.5px] text-slate-300 leading-relaxed">{message}</div>
        <div className="flex gap-3 justify-end px-6 pb-5">
          <button className="px-4 py-2 text-[13px] font-medium rounded-lg bg-white/5 border border-white/10 text-slate-300 hover:bg-white/10 transition-colors" onClick={onCancel} disabled={isLoading}>
            Hủy bỏ
          </button>
          <button className="px-4 py-2 text-[13px] font-semibold rounded-lg bg-rose-500/15 border border-rose-500/30 text-rose-400 hover:bg-rose-500/25 transition-colors flex items-center gap-2 disabled:opacity-50" onClick={onConfirm} disabled={isLoading}>
            {isLoading && <span className="w-3.5 h-3.5 border-2 border-rose-400/30 border-t-rose-400 rounded-full animate-spin" />}
            Xác nhận xóa
          </button>
        </div>
      </div>
    </div>
  );
}

const TOAST_STYLE: Record<string, { icon: React.ElementType; cls: string }> = {
  success: { icon: CheckCircle, cls: 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300' },
  error: { icon: XCircle, cls: 'bg-rose-500/15 border-rose-500/30 text-rose-300' },
  warning: { icon: AlertCircle, cls: 'bg-amber-500/15 border-amber-500/30 text-amber-300' },
  info: { icon: Info, cls: 'bg-indigo-500/15 border-indigo-500/30 text-indigo-300' },
};

export function ToastContainer() {
  const { toasts } = useApp();
  return (
    <div className="fixed bottom-5 right-5 z-[200] flex flex-col gap-2 pointer-events-none">
      {toasts.map(t => {
        const s = TOAST_STYLE[t.type] || TOAST_STYLE.info;
        const Icon = s.icon;
        return (
          <div key={t.id} className={`flex items-center gap-2.5 px-4 py-3 rounded-xl border backdrop-blur-md shadow-xl text-[13px] font-medium ${s.cls} animate-in slide-in-from-right-8 fade-in duration-200`}>
            <Icon size={15} className="shrink-0" />
            {t.message}
          </div>
        );
      })}
    </div>
  );
}

export function Badge({ status }: { status: string }) {
  const map: Record<string, string> = {
    running: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
    stopped: 'bg-slate-500/15 text-slate-400 border-slate-500/30',
    error: 'bg-rose-500/15 text-rose-400 border-rose-500/30',
    ready: 'bg-cyan-500/15 text-cyan-400 border-cyan-500/30',
    pending: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
  };
  const labels: Record<string, string> = { running: 'Running', stopped: 'Stopped', error: 'Error', ready: 'Ready', pending: 'Pending' };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-bold border uppercase tracking-wide ${map[status] || 'bg-white/5 text-slate-400 border-white/10'}`}>
      {labels[status] || status}
    </span>
  );
}

export function Spinner() {
  return <span className="inline-block w-4 h-4 border-2 border-white/20 border-t-white rounded-full animate-spin" />;
}

export function fmtTime(iso: string) {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

export function fmtDateTimeVN(iso?: string | null) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return new Intl.DateTimeFormat('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZoneName: 'short',
  }).format(d);
}

export function relTime(iso: string) {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s trước`;
  if (s < 3600) return `${Math.floor(s / 60)}m trước`;
  return `${Math.floor(s / 3600)}h trước`;
}

export function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
