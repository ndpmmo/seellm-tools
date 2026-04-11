'use client';
import React from 'react';
import { useApp } from './AppContext';

export function ToastContainer() {
  const { toasts } = useApp();
  return (
    <div className="toast-wrap">
      {toasts.map(t => (
        <div key={t.id} className={`toast ${t.type}`}>
          <span>{t.type==='success'?'✓':t.type==='error'?'✗':t.type==='warning'?'⚠':'ℹ'}</span>
          {t.message}
        </div>
      ))}
    </div>
  );
}

export function Badge({ status }: { status: string }) {
  const labels: Record<string,string> = { running:'Running', stopped:'Stopped', error:'Error', ready:'Ready', pending:'Pending' };
  return <span className={`badge ${status}`}>{labels[status] || status}</span>;
}

export function Spinner() { return <span className="spin" />; }

export function fmtTime(iso: string) {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
}

export function fmtDateTimeVN(iso?: string | null) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return new Intl.DateTimeFormat('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZoneName: 'short',
  }).format(d);
}

export function relTime(iso: string) {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60)   return `${s}s trước`;
  if (s < 3600) return `${Math.floor(s/60)}m trước`;
  return `${Math.floor(s/3600)}h trước`;
}

export function fmtBytes(n: number) {
  if (n < 1024)       return `${n} B`;
  if (n < 1024*1024)  return `${(n/1024).toFixed(1)} KB`;
  return `${(n/1024/1024).toFixed(2)} MB`;
}
