'use client';
import React, { useEffect, useState } from 'react';
import { useApp } from '../AppContext';
import { Spinner, fmtBytes } from '../Views';

export function LogFilesView() {
  const { logFiles, refreshLogFiles } = useApp();
  const [loading,   setLoading]   = useState(false);
  const [viewFile,  setViewFile]  = useState<string|null>(null);
  const [content,   setContent]   = useState('');
  const [loadingTxt, setLoadingTxt] = useState(false);

  const refresh = async () => { setLoading(true); await refreshLogFiles(); setLoading(false); };

  const openFile = async (filename: string) => {
    setViewFile(filename); setLoadingTxt(true);
    const txt = await fetch(`/api/logfiles/${encodeURIComponent(filename)}`).then(r=>r.text());
    setContent(txt); setLoadingTxt(false);
  };

  const close = () => { setViewFile(null); setContent(''); };

  return (
    <div className="content">
      {/* File list */}
      {!viewFile && (
        <div className="card">
          <div className="card-head">
            <span className="card-title">📁 Log Files ({logFiles.length})</span>
            <button className="btn btn-ghost btn-sm" onClick={refresh} disabled={loading}>
              {loading ? <Spinner/> : '↻'} Làm mới
            </button>
          </div>
          <div className="card-body">
            {logFiles.length === 0 ? (
              <div className="empty">
                <div className="e-ico">📂</div>
                <div className="e-txt">Chưa có log files</div>
                <div className="e-sub">Logs sẽ được lưu tại <code>data/logs/</code> mỗi khi chạy process</div>
              </div>
            ) : (
              <div className="logfile-list">
                {logFiles.map(f => (
                  <div key={f.filename} className="logfile-item">
                    <span style={{ fontSize:16 }}>📄</span>
                    <span className="logfile-name">{f.filename}</span>
                    <span className="logfile-size">{fmtBytes(f.size)}</span>
                    <button className="btn btn-ghost btn-sm" onClick={() => openFile(f.filename)}>Xem</button>
                    <a
                      href={`/data/logs/${f.filename}`}
                      download={f.filename}
                      className="btn btn-ghost btn-sm"
                      style={{ textDecoration:'none' }}
                    >⬇ Tải</a>
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
    </div>
  );
}
