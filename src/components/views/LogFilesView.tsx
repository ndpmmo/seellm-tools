'use client';
import React, { useState } from 'react';
import { useApp } from '../AppContext';
import { fmtBytes, fmtDateTimeVN, ConfirmModal } from '../Views';
import { Card, CardHeader, CardTitle, CardContent, Button, Input } from '../ui';
import { FileText, RefreshCw, Trash2, Download, Eye, Search, CheckSquare, Square, X } from 'lucide-react';

const toSizeFilter = (value: string): 'all' | 'small' | 'medium' | 'large' => {
  if (value === 'small' || value === 'medium' || value === 'large') return value;
  return 'all';
};

export function LogFilesView() {
  const { logFiles, refreshLogFiles, addToast } = useApp();
  const [loading, setLoading] = useState(false);
  const [viewFile, setViewFile] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [loadingTxt, setLoadingTxt] = useState(false);
  const [search, setSearch] = useState('');
  const [sizeFilter, setSizeFilter] = useState<'all' | 'small' | 'medium' | 'large'>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmModal, setConfirmModal] = useState<{ title: string; message: string; onConfirm: () => Promise<void> } | null>(null);

  const refresh = async () => { setLoading(true); await refreshLogFiles(); setLoading(false); };

  const openFile = async (filename: string) => {
    setViewFile(filename); setLoadingTxt(true);
    const txt = await fetch(`/api/logfiles/${encodeURIComponent(filename)}`).then(r => r.text());
    setContent(txt); setLoadingTxt(false);
  };

  const close = () => { setViewFile(null); setContent(''); };

  const filtered = logFiles.filter(f => {
    const q = search.trim().toLowerCase();
    const matchSearch = !q || f.filename.toLowerCase().includes(q);
    const matchSize =
      sizeFilter === 'all' ? true :
        sizeFilter === 'small' ? f.size < 512 * 1024 :
          sizeFilter === 'medium' ? (f.size >= 512 * 1024 && f.size < 5 * 1024 * 1024) :
            f.size >= 5 * 1024 * 1024;
    return matchSearch && matchSize;
  });

  const toggleSelect = (filename: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(filename)) next.delete(filename); else next.add(filename);
      return next;
    });
  };

  const toggleSelectAllFiltered = () => {
    const allSelected = filtered.length > 0 && filtered.every(f => selected.has(f.filename));
    setSelected(prev => {
      const next = new Set(prev);
      if (allSelected) filtered.forEach(f => next.delete(f.filename));
      else filtered.forEach(f => next.add(f.filename));
      return next;
    });
  };

  const deleteOne = async (filename: string) => {
    setConfirmModal({
      title: 'Xóa Log File',
      message: `Bạn có chắc muốn xóa log file "${filename}"? Hành động này không thể hoàn tác.`,
      onConfirm: async () => {
        const r = await fetch(`/api/logfiles/${encodeURIComponent(filename)}`, { method: 'DELETE' });
        if (!r.ok) { const err = await r.json().catch(() => ({})); addToast(`Xóa thất bại: ${err.error || `HTTP ${r.status}`}`, 'error'); return; }
        addToast('Đã xóa log file', 'success');
        setSelected(prev => { const next = new Set(prev); next.delete(filename); return next; });
        await refreshLogFiles();
        setConfirmModal(null);
      }
    });
  };

  const deleteSelected = async () => {
    const files = Array.from(selected);
    if (!files.length) return;
    setConfirmModal({
      title: 'Xóa Nhiều Log Files',
      message: `Bạn có chắc muốn xóa ${files.length} log file đã chọn? Hành động này không thể hoàn tác.`,
      onConfirm: async () => {
        const r = await fetch('/api/logfiles', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ files }) });
        if (!r.ok) { const err = await r.json().catch(() => ({})); addToast(`Xóa thất bại: ${err.error || `HTTP ${r.status}`}`, 'error'); return; }
        addToast(`Đã xóa ${files.length} log file`, 'success');
        setSelected(new Set());
        await refreshLogFiles();
        setConfirmModal(null);
      }
    });
  };

  return (
    <div className="absolute inset-0 px-6 pb-10 pt-2 flex flex-col gap-5 overflow-hidden">
      {/* File list */}
      {!viewFile && (
        <Card className="flex-1 flex flex-col min-h-0">
          <CardHeader className="flex-wrap gap-y-3">
            <CardTitle>
              <FileText size={15} className="text-indigo-400" />
              Log Files
              <span className="ml-2 px-2 py-0.5 rounded-full text-[10px] bg-white/10 text-slate-300 font-bold">{filtered.length}/{logFiles.length}</span>
            </CardTitle>
            <div className="flex gap-2 items-center ml-auto flex-wrap">
              <div className="relative flex items-center">
                <Search size={13} className="absolute left-2.5 text-slate-500 pointer-events-none" />
                <Input className="pl-7 w-[200px] h-8 text-xs bg-white/5 border-white/10" placeholder="Tìm theo tên file..." value={search} onChange={e => setSearch(e.target.value)} />
                {search && <button onClick={() => setSearch('')} className="absolute right-2 text-slate-500 hover:text-slate-300"><X size={11} /></button>}
              </div>
              <select
                className="h-8 rounded-lg bg-black/40 border border-white/10 text-[12px] text-slate-300 px-3 pr-7 outline-none focus:border-indigo-500/50"
                value={sizeFilter}
                onChange={e => setSizeFilter(toSizeFilter(e.target.value))}
              >
                <option value="all">Mọi kích thước</option>
                <option value="small">Nhỏ (&lt; 512KB)</option>
                <option value="medium">Vừa (512KB–5MB)</option>
                <option value="large">Lớn (&gt;= 5MB)</option>
              </select>
              <Button variant="ghost" size="sm" onClick={toggleSelectAllFiltered} disabled={filtered.length === 0} className="border border-white/5 bg-white/5">
                {filtered.length > 0 && filtered.every(f => selected.has(f.filename))
                  ? <><Square size={13} className="mr-1.5" />Bỏ chọn</>
                  : <><CheckSquare size={13} className="mr-1.5" />Chọn tất cả</>
                }
              </Button>
              {selected.size > 0 && (
                <Button variant="danger" size="sm" onClick={deleteSelected}>
                  <Trash2 size={13} /> Xóa đã chọn ({selected.size})
                </Button>
              )}
              <Button variant="secondary" size="icon-sm" onClick={refresh} disabled={loading} className="border-white/10 bg-white/5">
                <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
              </Button>
            </div>
          </CardHeader>
          <div className="flex-1 overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="py-20 flex flex-col items-center gap-3 text-center">
                <div className="text-4xl opacity-20">📂</div>
                <div className="text-slate-300 font-medium">{logFiles.length === 0 ? 'Chưa có log files' : 'Không có file phù hợp bộ lọc'}</div>
                <div className="text-[12px] text-slate-500">Logs sẽ được lưu tại <code className="bg-white/5 px-1 rounded">data/logs/</code> mỗi khi chạy process</div>
              </div>
            ) : (
              <div className="divide-y divide-white/5">
                {filtered.map(f => (
                  <div key={f.filename} className="flex items-center gap-3 px-5 py-3.5 hover:bg-white/[0.02] transition-colors group">
                    <input
                      type="checkbox"
                      className="w-4 h-4 rounded border-white/20 accent-indigo-500 cursor-pointer shrink-0"
                      checked={selected.has(f.filename)}
                      onChange={() => toggleSelect(f.filename)}
                    />
                    <span className="text-base shrink-0">📄</span>
                    <div className="flex-1 min-w-0">
                      <div className="text-[13px] font-medium text-slate-200 truncate">{f.filename}</div>
                      <div className="text-[10.5px] text-slate-500 mt-0.5">
                        Tạo: {fmtDateTimeVN(f.createdAt || f.mtime)} &nbsp;·&nbsp; Cập nhật: {fmtDateTimeVN(f.mtime)}
                      </div>
                    </div>
                    <span className="text-[11.5px] text-slate-400 shrink-0 font-mono">{fmtBytes(f.size)}</span>
                    <div className="flex gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      <Button variant="ghost" size="sm" onClick={() => openFile(f.filename)}>
                        <Eye size={13} /> Xem
                      </Button>
                      <a href={`/data/logs/${f.filename}`} download={f.filename} className="inline-flex items-center gap-1 px-2.5 py-1 text-[12px] rounded-md bg-white/5 border border-white/10 hover:bg-white/10 text-slate-300 transition-colors font-medium">
                        <Download size={13} /> Tải
                      </a>
                      <Button variant="danger" size="sm" onClick={() => deleteOne(f.filename)}>
                        <Trash2 size={13} />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Card>
      )}

      {/* File viewer */}
      {viewFile && (
        <Card className="flex flex-col flex-1" style={{ height: 'calc(100vh - 88px)' }}>
          <CardHeader>
            <CardTitle>
              <FileText size={14} className="text-indigo-400" />
              {viewFile}
            </CardTitle>
            <div className="flex gap-2 ml-auto">
              <a href={`/data/logs/${viewFile}`} download={viewFile} className="inline-flex items-center gap-1.5 px-3 py-1 text-[12px] rounded-md bg-white/5 border border-white/10 hover:bg-white/10 text-slate-300 transition-colors">
                <Download size={13} /> Tải xuống
              </a>
              <Button variant="ghost" size="sm" onClick={close}>
                <X size={13} /> Đóng
              </Button>
            </div>
          </CardHeader>
          <div className="flex-1 overflow-y-auto bg-[#050810] p-4 font-mono text-[11.5px] leading-relaxed">
            {loadingTxt ? (
              <div className="flex items-center justify-center h-full gap-3 text-slate-500">
                <span className="w-4 h-4 border-2 border-white/10 border-t-indigo-500 rounded-full animate-spin" />
                Đang tải...
              </div>
            ) : (
              content.split('\n').map((line, i) => (
                <div key={i} className="flex gap-3 hover:bg-white/5 px-1 -mx-1 rounded">
                  <span className="text-slate-600 shrink-0 select-none w-8 text-right">{i + 1}</span>
                  <span className={`flex-1 ${line.includes('[error]') || line.includes('❌') ? 'text-rose-400' : line.includes('[system]') ? 'text-indigo-300' : 'text-slate-300'}`}>{line || '\u00a0'}</span>
                </div>
              ))
            )}
          </div>
        </Card>
      )}

      {confirmModal && (
        <ConfirmModal
          title={confirmModal.title}
          message={confirmModal.message}
          onConfirm={confirmModal.onConfirm}
          onCancel={() => setConfirmModal(null)}
          isLoading={loading}
        />
      )}
    </div>
  );
}
