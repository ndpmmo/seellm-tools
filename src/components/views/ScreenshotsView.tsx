'use client';
import React, { useState, useEffect } from 'react';
import { useApp, Session, Screenshot } from '../AppContext';
import { Spinner } from '../Views';

function Lightbox({ img, onClose }: { img: Screenshot; onClose: () => void }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  return (
    <div className="lightbox" onClick={onClose}>
      <span className="lightbox-close">✕</span>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={img.url} alt={img.filename} onClick={e => e.stopPropagation()} />
      <div className="lightbox-filename">{img.filename}</div>
    </div>
  );
}

function SessionCard({ session }: { session: Session }) {
  const [open, setOpen] = useState(false);
  const [lightbox, setLightbox] = useState<Screenshot|null>(null);

  const dateStr = (() => {
    const m = session.id.match(/(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})/);
    if (m) return m[1].replace('T','  ').replace(/-/g,' ').replace(/(\d{4}) (\d{2}) (\d{2})/, '$1-$2-$3').replace(/(\d{2}) (\d{2}) (\d{2})$/, '$1:$2:$3');
    return session.id;
  })();

  // Parse the task/email from session id like run_<taskid>_<timestamp>
  const label = session.id.replace(/^run_/, '').substring(0, 30);

  return (
    <>
      <div className="session-card">
        <div className="session-head" onClick={() => setOpen(!open)}>
          <div style={{ fontSize:16 }}>📸</div>
          <div className="session-id">{label}</div>
          <div className="session-count">{session.imageCount} ảnh</div>
          <div className={`session-chevron ${open ? 'open' : ''}`}>▶</div>
        </div>
        {open && (
          <div className="screenshot-gallery">
            {session.images.length === 0 ? (
              <div className="ss-empty">Không có ảnh nào</div>
            ) : session.images.map(img => (
              <div key={img.filename} className="ss-thumb" onClick={() => setLightbox(img)}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={img.url} alt={img.filename} loading="lazy" />
                <div className="ss-label">{img.filename.replace(/^\d{2}_/,'').replace(/_/g,' ').replace('.png','')}</div>
              </div>
            ))}
          </div>
        )}
      </div>
      {lightbox && <Lightbox img={lightbox} onClose={() => setLightbox(null)} />}
    </>
  );
}

export function ScreenshotsView() {
  const { sessions, liveShots, refreshSessions } = useApp();
  const [loading, setLoading] = useState(false);
  const [lightbox, setLightbox] = useState<{ url:string; filename:string }|null>(null);
  
  // Local state to hide finished live sessions manually
  const [hiddenLive, setHiddenLive] = useState<Set<string>>(new Set());

  const refresh = async () => {
    setLoading(true);
    await refreshSessions();
    setLoading(false);
  };

  const activeLiveEntries = Object.entries(liveShots).filter(([id]) => !hiddenLive.has(id));

  return (
    <div className="content">
      {/* Live Channels Grid */}
      <div className="card">
        <div className="card-head">
          <span className="card-title" style={{ color:'var(--rose)' }}>
            <span style={{ animation:'blink 1s infinite', display:'inline-block' }}>●</span>&nbsp;Live Browser View ({activeLiveEntries.length})
          </span>
          <div style={{ display:'flex', gap:8 }}>
            {activeLiveEntries.length > 0 && (
              <button className="btn btn-ghost btn-xs" onClick={() => setHiddenLive(new Set(Object.keys(liveShots)))}>
                Dọn dẹp tất cả
              </button>
            )}
          </div>
        </div>
        <div className="card-body">
          {activeLiveEntries.length === 0 ? (
            <div className="live-placeholder">
              <div className="big">🦊</div>
              <div>Hiện không có luồng nào đang hoạt động</div>
              <div style={{ fontSize:11, color:'var(--text-3)' }}>Khởi động Worker để theo dõi đa luồng realtime</div>
            </div>
          ) : (
            <div className="live-grid">
              {activeLiveEntries.map(([sessionId, shot]) => (
                <div key={sessionId} className="live-entry-container">
                   <div className="live-screen clickable" onClick={() => setLightbox(shot)}>
                    <div className="live-badge">
                      <span className="live-dot"/>LIVE
                    </div>
                    <button 
                      className="live-close-btn" 
                      onClick={(e) => { e.stopPropagation(); setHiddenLive(prev => new Set([...prev, sessionId])); }}
                      title="Ẩn luồng này"
                    >✕</button>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={`${shot.url}?t=${Date.now()}`} alt="live" />
                  </div>
                  <div className="live-info">
                    <div className="live-label">{shot.email || sessionId.replace(/^run_/, '')}</div>
                    <div className="live-sub">{shot.filename}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>


      {/* Session History */}
      <div className="card">
        <div className="card-head">
          <span className="card-title">🗂️ Lịch sử Sessions ({sessions.length})</span>
          <button className="btn btn-ghost btn-sm" onClick={refresh} disabled={loading}>
            {loading ? <Spinner/> : '↻'} Làm mới
          </button>
        </div>
        <div className="card-body p0">
          {sessions.length === 0 ? (
            <div className="empty" style={{ padding:40 }}>
              <div className="e-ico">📂</div>
              <div className="e-txt">Chưa có session nào</div>
              <div className="e-sub">Screenshots sẽ xuất hiện tại đây khi Worker chạy</div>
            </div>
          ) : (
            <div className="sessions-grid" style={{ padding:12 }}>
              {sessions.map(s => <SessionCard key={s.id} session={s} />)}
            </div>
          )}
        </div>
      </div>

      {lightbox && (
        <div className="lightbox" onClick={() => setLightbox(null)}>
          <span className="lightbox-close">✕</span>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={lightbox.url} alt={lightbox.filename} onClick={e => e.stopPropagation()} />
          <div className="lightbox-filename">{lightbox.filename}</div>
        </div>
      )}
    </div>
  );
}
