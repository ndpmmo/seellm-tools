'use client';
import React, { useState, useMemo, useCallback } from 'react';
import { useApp, LogFile } from '../AppContext';
import { fmtBytes, fmtDateTimeVN, ConfirmModal, Spinner } from '../Views';
import { Card, CardHeader, CardTitle, CardContent, Button, Input, StatBox } from '../ui';
import {
  FileText, RefreshCw, Trash2, Download, Eye, Search, CheckSquare, Square, X,
  HardDrive, Clock, AlertTriangle, ChevronDown, ChevronRight, ArrowUpDown,
  FileCode, File, Copy, Maximize2, Minimize2, WrapText
} from 'lucide-react';

/* ─── Types ──────────────────────────────────────────────────────────────── */

type SortField = 'name' | 'size' | 'mtime';
type SortDir = 'asc' | 'desc';
type SizeFilter = 'all' | 'small' | 'medium' | 'large';

const toSizeFilter = (v: string): SizeFilter => {
  if (v === 'small' || v === 'medium' || v === 'large') return v;
  return 'all';
};

/* ─── Log Viewer Panel ───────────────────────────────────────────────────── */

function LogViewer({ filename, content, loading, onClose }: {
  filename: string; content: string; loading: boolean; onClose: () => void;
}) {
  const [searchTerm, setSearchTerm] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wordWrap, setWordWrap] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [currentMatch, setCurrentMatch] = useState(0);
  const textRef = useRef<HTMLPreElement>(null);

  const matches = useMemo(() => {
    if (!searchTerm.trim()) return [];
    const flags = caseSensitive ? 'g' : 'gi';
    try {
      const re = new RegExp(searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
      const results: number[] = [];
      let m;
      while ((m = re.exec(content)) !== null) {
        results.push(m.index);
        if (results.length > 5000) break; // safety cap
      }
      return results;
    } catch { return []; }
  }, [content, searchTerm, caseSensitive]);

  useEffect(() => {
    if (matches.length > 0 && currentMatch < matches.length && textRef.current) {
      const el = textRef.current.querySelector(`[data-match-idx="${currentMatch}"]`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [currentMatch, matches.length]);

  const highlightContent = useMemo(() => {
    if (!searchTerm.trim() || matches.length === 0) return null;
    const parts: React.ReactNode[] = [];
    let lastIdx = 0;
    const flags = caseSensitive ? 'g' : 'gi';
    try {
      const re = new RegExp(searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
      let m;
      let matchIdx = 0;
      while ((m = re.exec(content)) !== null) {
        if (m.index > lastIdx) parts.push(content.slice(lastIdx, m.index));
        const idx = matchIdx;
        parts.push(
          <mark
            key={idx}
            data-match-idx={idx}
            className={`px-0.5 rounded-sm ${idx === currentMatch ? 'bg-amber-400/40 text-amber-200 ring-1 ring-amber-400/60' : 'bg-indigo-500/30 text-indigo-200'}`}
          >
            {m[0]}
          </mark>
        );
        lastIdx = m.index + m[0].length;
        matchIdx++;
        if (matchIdx > 5000) break;
      }
      if (lastIdx < content.length) parts.push(content.slice(lastIdx));
    } catch { return null; }
    return parts;
  }, [content, searchTerm, caseSensitive, currentMatch]);

  const copyContent = () => {
    navigator.clipboard.writeText(content);
  };

  const downloadFile = () => {
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  };

  const lineCount = content.split('\n').length;

  return (
    <div className={`flex flex-col bg-[#0a0e1a] border border-white/10 rounded-xl overflow-hidden ${fullscreen ? 'fixed inset-4 z-50' : 'h-full'}`}>
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-white/5 bg-black/30">
        <FileCode size={15} className="text-indigo-400 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-semibold text-slate-200 truncate">{filename}</div>
          <div className="text-[10.5px] text-slate-500 mt-0.5">{lineCount} dòng · {fmtBytes(content.length)}</div>
        </div>

        {/* Search within content */}
        <div className="relative flex items-center">
          <Search size={12} className="absolute left-2 text-slate-500 pointer-events-none" />
          <input
            className="pl-6 pr-7 w-[160px] h-7 rounded-md bg-white/5 border border-white/10 text-[11px] text-slate-200 outline-none focus:border-indigo-500/50 placeholder:text-slate-500"
            placeholder="Tìm trong file..."
            value={searchTerm}
            onChange={e => { setSearchTerm(e.target.value); setCurrentMatch(0); }}
          />
          {searchTerm && (
            <>
              <button onClick={() => setSearchTerm('')} className="absolute right-[68px] text-slate-500 hover:text-slate-300"><X size={10} /></button>
              <div className="absolute right-2 flex items-center gap-0.5">
                <button
                  className="w-5 h-5 flex items-center justify-center text-slate-400 hover:text-white rounded hover:bg-white/10 text-[10px] disabled:opacity-30"
                  onClick={() => setCurrentMatch(m => Math.max(0, m - 1))}
                  disabled={matches.length === 0}
                  title="Trước"
                >‹</button>
                <span className="text-[9px] text-slate-500 min-w-[32px] text-center font-mono">
                  {matches.length > 0 ? `${currentMatch + 1}/${matches.length}` : '0/0'}
                </span>
                <button
                  className="w-5 h-5 flex items-center justify-center text-slate-400 hover:text-white rounded hover:bg-white/10 text-[10px] disabled:opacity-30"
                  onClick={() => setCurrentMatch(m => Math.min(matches.length - 1, m + 1))}
                  disabled={matches.length === 0}
                  title="Sau"
                >›</button>
              </div>
            </>
          )}
        </div>

        <label className="flex items-center gap-1 px-1.5 py-1 rounded border border-white/5 bg-white/5 cursor-pointer hover:bg-white/10 transition-colors text-[10px] text-slate-400 select-none" title="Phân biệt hoa/thường">
          <input type="checkbox" className="w-2.5 h-2.5 accent-indigo-500" checked={caseSensitive} onChange={e => setCaseSensitive(e.target.checked)} />
          Aa
        </label>

        <div className="w-px h-5 bg-white/10" />

        <Button variant="ghost" size="icon-sm" onClick={() => setWordWrap(w => !w)} title={wordWrap ? 'Tắt wrap' : 'Bật wrap'} className={wordWrap ? 'text-indigo-400' : ''}>
          <WrapText size={13} />
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={copyContent} title="Copy nội dung">
          <Copy size={13} />
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={downloadFile} title="Tải về">
          <Download size={13} />
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={() => setFullscreen(f => !f)} title={fullscreen ? 'Thu nhỏ' : 'Phóng to'}>
          {fullscreen ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={onClose} className="text-rose-400 hover:text-rose-300" title="Đóng">
          <X size={14} />
        </Button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto bg-[#060a14] custom-scrollbar">
        {loading ? (
          <div className="flex items-center justify-center h-full gap-2 text-slate-500">
            <Spinner /> Đang tải...
          </div>
        ) : (
          <pre ref={textRef} className={`text-[12px] leading-[1.6] text-slate-300 p-4 font-mono ${wordWrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre'}`}>
            {highlightContent || content}
          </pre>
        )}
      </div>
    </div>
  );
}

/* ─── File Row ───────────────────────────────────────────────────────────── */

function FileRow({ file, selected, onToggleSelect, onOpen, onDelete }: {
  file: LogFile; selected: boolean; onToggleSelect: () => void;
  onOpen: () => void; onDelete: () => void;
}) {
  const ext = file.filename.split('.').pop()?.toLowerCase() || '';
  const isLog = ext === 'log' || ext === 'txt';
  const isJson = ext === 'json';
  const iconColor = isJson ? 'text-amber-400' : isLog ? 'text-cyan-400' : 'text-slate-400';

  return (
    <div className={`flex items-center gap-3 px-4 py-3 hover:bg-white/[0.02] transition-colors group ${selected ? 'bg-indigo-500/5' : ''}`}>
      <input
        type="checkbox"
        className="w-4 h-4 rounded border-white/20 accent-indigo-500 cursor-pointer shrink-0"
        checked={selected}
        onChange={onToggleSelect}
      />
      <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${isJson ? 'bg-amber-500/10 border border-amber-500/20' : isLog ? 'bg-cyan-500/10 border border-cyan-500/20' : 'bg-white/5 border border-white/10'}`}>
        {isJson ? <FileCode size={15} className={iconColor} /> : <FileText size={15} className={iconColor} />}
      </div>
      <div className="flex-1 min-w-0 cursor-pointer" onClick={onOpen}>
        <div className="text-[13px] font-medium text-slate-200 truncate group-hover:text-indigo-300 transition-colors">{file.filename}</div>
        <div className="text-[10.5px] text-slate-500 mt-0.5 flex items-center gap-2">
          <Clock size={9} className="shrink-0" />
          {fmtDateTimeVN(file.createdAt || file.mtime)}
          <span className="opacity-40">·</span>
          Cập nhật: {fmtDateTimeVN(file.mtime)}
        </div>
      </div>
      <div className="flex items-center gap-3 shrink-0">
        <span className={`text-[11.5px] font-mono px-2 py-0.5 rounded-md ${file.size > 5 * 1024 * 1024 ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20' : file.size > 512 * 1024 ? 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/20' : 'text-slate-400'}`}>
          {fmtBytes(file.size)}
        </span>
        <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <Button variant="ghost" size="icon-sm" onClick={onOpen} title="Xem">
            <Eye size={12} />
          </Button>
          <Button variant="ghost" size="icon-sm" className="text-rose-400/60 hover:text-rose-400" onClick={onDelete} title="Xóa">
            <Trash2 size={12} />
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ─── Main View ──────────────────────────────────────────────────────────── */

import { useRef, useEffect } from 'react';

export function LogFilesView() {
  const { logFiles, refreshLogFiles, addToast } = useApp();
  const [loading, setLoading] = useState(false);
  const [viewFile, setViewFile] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [loadingTxt, setLoadingTxt] = useState(false);
  const [search, setSearch] = useState('');
  const [sizeFilter, setSizeFilter] = useState<SizeFilter>('all');
  const [sortField, setSortField] = useState<SortField>('mtime');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmModal, setConfirmModal] = useState<{ title: string; message: string; onConfirm: () => Promise<void> } | null>(null);

  const refresh = useCallback(async () => { setLoading(true); await refreshLogFiles(); setLoading(false); }, [refreshLogFiles]);

  const openFile = useCallback(async (filename: string) => {
    setViewFile(filename); setLoadingTxt(true); setContent('');
    try {
      const txt = await fetch(`/api/logfiles/${encodeURIComponent(filename)}`).then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      });
      setContent(txt);
    } catch (e: any) {
      addToast(`Không thể đọc file: ${e.message}`, 'error');
      setViewFile(null);
    }
    setLoadingTxt(false);
  }, [addToast]);

  const close = useCallback(() => { setViewFile(null); setContent(''); }, []);

  const filtered = useMemo(() => {
    let list = logFiles.filter(f => {
      const q = search.trim().toLowerCase();
      const matchSearch = !q || f.filename.toLowerCase().includes(q);
      const matchSize =
        sizeFilter === 'all' ? true :
          sizeFilter === 'small' ? f.size < 512 * 1024 :
            sizeFilter === 'medium' ? (f.size >= 512 * 1024 && f.size < 5 * 1024 * 1024) :
              f.size >= 5 * 1024 * 1024;
      return matchSearch && matchSize;
    });

    list.sort((a, b) => {
      const dir = sortDir === 'asc' ? 1 : -1;
      if (sortField === 'name') return dir * a.filename.localeCompare(b.filename);
      if (sortField === 'size') return dir * (a.size - b.size);
      return dir * (new Date(a.mtime).getTime() - new Date(b.mtime).getTime());
    });

    return list;
  }, [logFiles, search, sizeFilter, sortField, sortDir]);

  const totalSize = useMemo(() => logFiles.reduce((s, f) => s + f.size, 0), [logFiles]);
  const filteredSize = useMemo(() => filtered.reduce((s, f) => s + f.size, 0), [filtered]);

  const toggleSelect = (filename: string) => {
    setSelected(prev => { const next = new Set(prev); if (next.has(filename)) next.delete(filename); else next.add(filename); return next; });
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

  const deleteOne = (filename: string) => {
    setConfirmModal({
      title: 'Xóa Log File',
      message: `Bạn có chắc muốn xóa log file "${filename}"? Hành động này không thể hoàn tác.`,
      onConfirm: async () => {
        const r = await fetch(`/api/logfiles/${encodeURIComponent(filename)}`, { method: 'DELETE' });
        if (!r.ok) { const err = await r.json().catch(() => ({})); addToast(`Xóa thất bại: ${err.error || `HTTP ${r.status}`}`, 'error'); return; }
        addToast('Đã xóa log file', 'success');
        setSelected(prev => { const next = new Set(prev); next.delete(filename); return next; });
        if (viewFile === filename) close();
        await refreshLogFiles();
        setConfirmModal(null);
      }
    });
  };

  const deleteSelected = () => {
    const files = Array.from(selected);
    if (!files.length) return;
    setConfirmModal({
      title: 'Xóa Nhiều Log Files',
      message: `Bạn có chắc muốn xóa ${files.length} log file đã chọn? Hành động này không thể hoàn tác.`,
      onConfirm: async () => {
        const r = await fetch('/api/logfiles', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ files }) });
        if (!r.ok) { const err = await r.json().catch(() => ({})); addToast(`Xóa thất bại: ${err.error || `HTTP ${r.status}`}`, 'error'); return; }
        const data = await r.json().catch(() => ({}));
        addToast(`Đã xóa ${data.deleted || files.length} log file`, 'success');
        setSelected(new Set());
        if (viewFile && files.includes(viewFile)) close();
        await refreshLogFiles();
        setConfirmModal(null);
      }
    });
  };

  const handleSort = (field: SortField) => {
    if (sortField === field) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortField(field); setSortDir('desc'); }
  };

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) return <ArrowUpDown size={10} className="text-slate-600" />;
    return sortDir === 'asc'
      ? <ChevronDown size={10} className="text-indigo-400" />
      : <ChevronRight size={10} className="text-indigo-400 rotate-[-90deg]" />;
  };

  return (
    <div className="absolute inset-0 overflow-y-auto px-6 pb-10 pt-2 flex flex-col gap-5 custom-scrollbar">
      {/* Stats */}
      <div className="grid grid-cols-4 gap-4 mt-2">
        <StatBox label="Tổng files" value={logFiles.length} icon={FileText} colorClass="text-indigo-400" bgClass="bg-indigo-500/10" borderClass="border-indigo-500/50" />
        <StatBox label="Dung lượng" value={fmtBytes(totalSize)} icon={HardDrive} colorClass="text-cyan-400" bgClass="bg-cyan-500/10" borderClass="border-cyan-500/50" />
        <StatBox label="Đang xem" value={viewFile ? '1' : '0'} icon={Eye} colorClass="text-amber-400" bgClass="bg-amber-500/10" borderClass="border-amber-500/50" />
        <StatBox label="Đã chọn" value={selected.size} icon={CheckSquare} colorClass="text-rose-400" bgClass="bg-rose-500/10" borderClass="border-rose-500/50" />
      </div>

      {/* File List + Viewer split */}
      <div className="flex-1 flex gap-4 min-h-0">
        {/* File list */}
        <Card className={`flex flex-col min-h-0 ${viewFile ? 'w-[45%] shrink-0' : 'flex-1'}`}>
          <CardHeader className="flex-wrap gap-y-3">
            <CardTitle>
              <FileText size={15} className="text-indigo-400" />
              Log Files
              <span className="ml-2 px-2 py-0.5 rounded-full text-[10px] bg-white/10 text-slate-300 font-bold">{filtered.length}/{logFiles.length}</span>
              {filteredSize !== totalSize && (
                <span className="ml-1 text-[10px] text-slate-500 font-normal">({fmtBytes(filteredSize)})</span>
              )}
            </CardTitle>
            <div className="flex gap-2 items-center ml-auto flex-wrap">
              {/* Search */}
              <div className="relative flex items-center">
                <Search size={13} className="absolute left-2.5 text-slate-500 pointer-events-none" />
                <Input className="pl-7 w-[180px] h-8 text-xs bg-white/5 border-white/10" placeholder="Tìm theo tên file..." value={search} onChange={e => setSearch(e.target.value)} />
                {search && <button onClick={() => setSearch('')} className="absolute right-2 text-slate-500 hover:text-slate-300"><X size={11} /></button>}
              </div>

              {/* Size filter */}
              <select
                className="h-8 rounded-lg bg-black/40 border border-white/10 text-[12px] text-slate-300 px-2.5 pr-6 outline-none focus:border-indigo-500/50"
                value={sizeFilter}
                onChange={e => setSizeFilter(toSizeFilter(e.target.value))}
              >
                <option value="all">Mọi kích thước</option>
                <option value="small">Nhỏ (&lt; 512KB)</option>
                <option value="medium">Vừa (512KB–5MB)</option>
                <option value="large">Lớn (&gt;= 5MB)</option>
              </select>

              {/* Select all */}
              <Button variant="ghost" size="sm" onClick={toggleSelectAllFiltered} disabled={filtered.length === 0} className="border border-white/5 bg-white/5">
                {filtered.length > 0 && filtered.every(f => selected.has(f.filename))
                  ? <><Square size={13} className="mr-1.5" />Bỏ chọn</>
                  : <><CheckSquare size={13} className="mr-1.5" />Chọn hết</>
                }
              </Button>

              {/* Bulk delete */}
              {selected.size > 0 && (
                <Button variant="danger" size="sm" onClick={deleteSelected}>
                  <Trash2 size={13} /> Xóa ({selected.size})
                </Button>
              )}

              {/* Refresh */}
              <Button variant="secondary" size="icon-sm" onClick={refresh} disabled={loading} className="border-white/10 bg-white/5">
                <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
              </Button>
            </div>
          </CardHeader>

          {/* Sort header */}
          {filtered.length > 0 && (
            <div className="flex items-center gap-3 px-4 py-2 border-b border-white/5 bg-black/20 text-[10.5px] font-semibold text-slate-500 uppercase tracking-wider">
              <span className="w-4" /> {/* checkbox space */}
              <span className="w-8" /> {/* icon space */}
              <button className="flex items-center gap-1 hover:text-slate-300 transition-colors flex-1" onClick={() => handleSort('name')}>
                Tên file <SortIcon field="name" />
              </button>
              <button className="flex items-center gap-1 hover:text-slate-300 transition-colors shrink-0 w-[80px]" onClick={() => handleSort('size')}>
                Kích thước <SortIcon field="size" />
              </button>
              <button className="flex items-center gap-1 hover:text-slate-300 transition-colors shrink-0 w-[160px]" onClick={() => handleSort('mtime')}>
                Thời gian <SortIcon field="mtime" />
              </button>
              <span className="w-[60px]" /> {/* actions space */}
            </div>
          )}

          <div className="flex-1 overflow-y-auto custom-scrollbar">
            {filtered.length === 0 ? (
              <div className="py-20 flex flex-col items-center gap-3 text-center">
                <div className="text-4xl opacity-20">📂</div>
                <div className="text-slate-300 font-medium">{logFiles.length === 0 ? 'Chưa có log files' : 'Không có file phù hợp bộ lọc'}</div>
                <div className="text-[12px] text-slate-500">Logs sẽ được lưu tại <code className="bg-white/5 px-1.5 py-0.5 rounded text-indigo-400/70">data/logs/</code> mỗi khi chạy process</div>
              </div>
            ) : (
              <div className="divide-y divide-white/5">
                {filtered.map(f => (
                  <FileRow
                    key={f.filename}
                    file={f}
                    selected={selected.has(f.filename)}
                    onToggleSelect={() => toggleSelect(f.filename)}
                    onOpen={() => openFile(f.filename)}
                    onDelete={() => deleteOne(f.filename)}
                  />
                ))}
              </div>
            )}
          </div>
        </Card>

        {/* Viewer Panel */}
        {viewFile && (
          <div className="flex-1 min-w-0">
            <LogViewer
              filename={viewFile}
              content={content}
              loading={loadingTxt}
              onClose={close}
            />
          </div>
        )}
      </div>

      {/* Confirm Modal */}
      {confirmModal && <ConfirmModal title={confirmModal.title} message={confirmModal.message} onConfirm={confirmModal.onConfirm} onCancel={() => setConfirmModal(null)} />}
    </div>
  );
}
