'use client';
import React, { useState } from 'react';
import { useApp } from '../AppContext';
import { Spinner, fmtBytes, fmtDateTimeVN, ConfirmModal } from '../Views';

const toSizeFilter = (value: string): 'all'|'small'|'medium'|'large' => {
  if (value === 'small' || value === 'medium' || value === 'large') return value;
  return 'all';
};

export function LogFilesView() {
  const { logFiles, refreshLogFiles, addToast } = useApp();
  const [loading,   setLoading]   = useState(false);
  const [viewFile,  setViewFile]  = useState<string|null>(null);
  const [content,   setContent]   = useState('');
  const [loadingTxt, setLoadingTxt] = useState(false);
  const [search, setSearch] = useState('');
  const [sizeFilter, setSizeFilter] = useState<'all'|'small'|'medium'|'large'>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmModal, setConfirmModal] = useState<{ title: string; message: string; onConfirm: () => Promise<void> } | null>(null);

  const refresh = async () => { setLoading(true); await refreshLogFiles(); setLoading(false); };

  const openFile = async (filename: string) => {
    setViewFile(filename); setLoadingTxt(true);
    const txt = await fetch(`/api/logfiles/${encodeURIComponent(filename)}`).then(r=>r.text());
    setContent(txt); setLoadingTxt(false);
  };

  const close = () => { setViewFile(null); setContent(''); };

  const filtered = logFiles.filter((f) => {
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
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(filename)) next.delete(filename);
      else next.add(filename);
      return next;
    });
  };

  const toggleSelectAllFiltered = () => {
    const allSelected = filtered.length > 0 && filtered.every((f) => selected.has(f.filename));
    if (allSelected) {
      setSelected((prev) => {
        const next = new Set(prev);
        filtered.forEach((f) => next.delete(f.filename));
        return next;
      });
      return;
    }
    setSelected((prev) => {
      const next = new Set(prev);
      filtered.forEach((f) => next.add(f.filename));
      return next;
    });
  };

  const deleteOne = async (filename: string) => {
    setConfirmModal({
      title: 'Xóa Log File',
      message: `Bạn có chắc muốn xóa log file "${filename}"? Hành động này không thể hoàn tác.`,
      onConfirm: async () => {
        const r = await fetch(`/api/logfiles/${encodeURIComponent(filename)}`, { method: 'DELETE' });
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          addToast(`Xóa log file thất bại: ${err.error || `HTTP ${r.status}`}`, 'error');
          return;
        }
        addToast('Đã xóa log file', 'success');
        setSelected((prev) => {
          const next = new Set(prev);
          next.delete(filename);
          return next;
        });
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
        const r = await fetch('/api/logfiles', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ files }),
        });
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          addToast(`Xóa log files thất bại: ${err.error || `HTTP ${r.status}`}`, 'error');
          return;
        }
        addToast(`Đã xóa ${files.length} log file`, 'success');
        setSelected(new Set());
        await refreshLogFiles();
        setConfirmModal(null);
      }
    });
  };

  return (
    <div className="content">
      {/* File list */}
      {!viewFile && (
        <div className="card">
          <div className="card-head">
            <span className="card-title">📁 Log Files ({filtered.length}/{logFiles.length})</span>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                className="inp inp-sm"
                style={{ width: 220 }}
                placeholder="Tìm theo tên file..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <select className="inp inp-sm" style={{ width: 140 }} value={sizeFilter} onChange={(e) => setSizeFilter(toSizeFilter(e.target.value))}>
                <option value="all">Mọi kích thước</option>
                <option value="small">Nhỏ (&lt; 512KB)</option>
                <option value="medium">Vừa (512KB-5MB)</option>
                <option value="large">Lớn (&gt;= 5MB)</option>
              </select>
              <button className="btn btn-ghost btn-sm" onClick={toggleSelectAllFiltered} disabled={filtered.length === 0}>
                {filtered.length > 0 && filtered.every((f) => selected.has(f.filename)) ? 'Bỏ chọn' : 'Chọn tất cả'}
              </button>
              <button className="btn btn-danger btn-sm" onClick={deleteSelected} disabled={selected.size === 0}>
                Xóa đã chọn ({selected.size})
              </button>
              <button className="btn btn-ghost btn-sm" onClick={refresh} disabled={loading}>
                {loading ? <Spinner/> : '↻'} Làm mới
              </button>
            </div>
          </div>
          <div className="card-body">
            {filtered.length === 0 ? (
              <div className="empty">
                <div className="e-ico">📂</div>
                <div className="e-txt">{logFiles.length === 0 ? 'Chưa có log files' : 'Không có file phù hợp bộ lọc'}</div>
                <div className="e-sub">Logs sẽ được lưu tại <code>data/logs/</code> mỗi khi chạy process</div>
              </div>
            ) : (
              <div className="logfile-list">
                {filtered.map(f => (
                  <div key={f.filename} className="logfile-item">
                    <input
                      type="checkbox"
                      checked={selected.has(f.filename)}
                      onChange={() => toggleSelect(f.filename)}
                      title="Chọn để xóa nhiều file"
                    />
                    <span style={{ fontSize:16 }}>📄</span>
                    <span className="logfile-name">
                      <div>{f.filename}</div>
                      <div style={{ fontSize: 10, color: 'var(--text-4)', marginTop: 2 }}>
                        Tạo: {fmtDateTimeVN(f.createdAt || f.mtime)} | Cập nhật: {fmtDateTimeVN(f.mtime)}
                      </div>
                    </span>
                    <span className="logfile-size">{fmtBytes(f.size)}</span>
                    <button className="btn btn-ghost btn-sm" onClick={() => openFile(f.filename)}>Xem</button>
                    <a
                      href={`/data/logs/${f.filename}`}
                      download={f.filename}
                      className="btn btn-ghost btn-sm"
                      style={{ textDecoration:'none' }}
                    >⬇ Tải</a>
                    <button className="btn btn-danger btn-sm" onClick={() => deleteOne(f.filename)}>Xóa</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* File viewer */}
      {viewFile && (
        <div className="card" style={{ flex:1, display:'flex', flexDirection:'column', height:'calc(100vh - var(--topbar-h) - 40px)' }}>
          <div className="card-head">
            <span className="card-title">📄 {viewFile}</span>
            <div style={{ display:'flex', gap:8 }}>
              <a href={`/data/logs/${viewFile}`} download={viewFile} className="btn btn-ghost btn-sm" style={{ textDecoration:'none' }}>⬇ Tải xuống</a>
              <button className="btn btn-ghost btn-sm" onClick={close}>✕ Đóng</button>
            </div>
          </div>
          <div className="terminal-wrap" style={{ flex:1, borderRadius:0, border:'none' }}>
            {loadingTxt ? (
              <div style={{ display:'flex', alignItems:'center', justifyContent:'center', height:'100%', gap:10, color:'var(--text-3)' }}>
                <Spinner/> Đang tải...
              </div>
            ) : (
              <div className="term-body" style={{ height:'100%' }}>
                {content.split('\n').map((line, i) => (
                  <div key={i} className="log-line stdout">
                    <span className="log-ts" style={{ width:36, fontSize:9 }}>{i+1}</span>
                    <span className={`log-txt ${line.includes('[error]')||line.includes('❌')?'lc-err':line.includes('[system]')?'lc-info':''}`}>{line}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
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
