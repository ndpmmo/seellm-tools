'use client';
import React, { useState, useEffect } from 'react';
import { useApp, Session, Screenshot } from '../AppContext';
import { Spinner, fmtDateTimeVN } from '../Views';

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

function SessionCard({
  session,
  onDeleteSession,
  onDeleteImage,
  selected,
  onToggleSelect,
}: {
  session: Session;
  onDeleteSession: (sessionId: string) => Promise<void>;
  onDeleteImage: (sessionId: string, filename: string) => Promise<void>;
  selected: boolean;
  onToggleSelect: (sessionId: string) => void;
}) {
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
          <input
            type="checkbox"
            checked={selected}
            onChange={(e) => {
              e.stopPropagation();
              onToggleSelect(session.id);
            }}
            onClick={(e) => e.stopPropagation()}
            title="Chọn session để xóa hàng loạt"
          />
          <div style={{ fontSize:16 }}>📸</div>
          <div className="session-id">{label}</div>
          <div className="session-count" title={`Tạo: ${fmtDateTimeVN(session.createdAt || session.mtime)} | Cập nhật: ${fmtDateTimeVN(session.mtime)}`}>
            {session.imageCount} ảnh | {fmtDateTimeVN(session.createdAt || session.mtime)}
          </div>
          <button
            className="btn btn-danger btn-xs"
            onClick={(e) => {
              e.stopPropagation();
              onDeleteSession(session.id);
            }}
          >
            Xóa session
          </button>
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
                <button
                  className="btn btn-danger btn-xs"
                  style={{ position: 'absolute', top: 6, right: 6, zIndex: 5 }}
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeleteImage(session.id, img.filename);
                  }}
                >
                  Xóa
                </button>
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
  const { sessions, liveShots, refreshSessions, addToast } = useApp();
  const [loading, setLoading] = useState(false);
  const [lightbox, setLightbox] = useState<{ url:string; filename:string }|null>(null);
  const [query, setQuery] = useState('');
  const [sortBy, setSortBy] = useState<'newest'|'oldest'|'most'>('newest');
  const [onlyWithImages, setOnlyWithImages] = useState(false);
  const [selectedSessions, setSelectedSessions] = useState<Set<string>>(new Set());
  const [failedLive, setFailedLive] = useState<Set<string>>(new Set());
  
  // Local state to hide finished live sessions manually
  const [hiddenLive, setHiddenLive] = useState<Set<string>>(new Set());

  const refresh = async () => {
    setLoading(true);
    await refreshSessions();
    setLoading(false);
  };

  const deleteSession = async (sessionId: string) => {
    if (!confirm(`Xóa toàn bộ screenshots của session "${sessionId}"?`)) return;
    const r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      addToast(`Xóa session thất bại: ${err.error || `HTTP ${r.status}`}`, 'error');
      return;
    }
    addToast('Đã xóa session screenshots', 'success');
    setSelectedSessions((prev) => {
      const next = new Set(prev);
      next.delete(sessionId);
      return next;
    });
    await refreshSessions();
  };

  const deleteImage = async (sessionId: string, filename: string) => {
    if (!confirm(`Xóa ảnh "${filename}"?`)) return;
    const r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/images/${encodeURIComponent(filename)}`, { method: 'DELETE' });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      addToast(`Xóa screenshot thất bại: ${err.error || `HTTP ${r.status}`}`, 'error');
      return;
    }
    addToast('Đã xóa screenshot', 'success');
    await refreshSessions();
  };

  const activeLiveEntries = Object.entries(liveShots).filter(([id]) => !hiddenLive.has(id) && !failedLive.has(id));

  const filteredSessions = sessions
    .map((s) => {
      const q = query.trim().toLowerCase();
      if (!q) return s;
      const sessionMatch = s.id.toLowerCase().includes(q);
      if (sessionMatch) return s;
      const matchedImages = s.images.filter((img) => img.filename.toLowerCase().includes(q));
      return { ...s, images: matchedImages, imageCount: matchedImages.length };
    })
    .filter((s) => {
      if (onlyWithImages && s.imageCount <= 0) return false;
      if (!query.trim()) return true;
      return s.id.toLowerCase().includes(query.trim().toLowerCase()) || s.imageCount > 0;
    })
    .sort((a, b) => {
      if (sortBy === 'most') return b.imageCount - a.imageCount;
      const ta = new Date(a.mtime).getTime();
      const tb = new Date(b.mtime).getTime();
      return sortBy === 'oldest' ? ta - tb : tb - ta;
    });

  const toggleSessionSelect = (sessionId: string) => {
    setSelectedSessions((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  };

  const toggleSelectAllFiltered = () => {
    const allSelected = filteredSessions.length > 0 && filteredSessions.every((s) => selectedSessions.has(s.id));
    setSelectedSessions((prev) => {
      const next = new Set(prev);
      if (allSelected) {
        filteredSessions.forEach((s) => next.delete(s.id));
      } else {
        filteredSessions.forEach((s) => next.add(s.id));
      }
      return next;
    });
  };

  const deleteSelectedSessions = async () => {
    const ids = Array.from(selectedSessions);
    if (!ids.length) return;
    if (!confirm(`Xóa ${ids.length} session screenshots đã chọn?`)) return;

    let ok = 0;
    for (const id of ids) {
      try {
        const r = await fetch(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
        if (r.ok) ok += 1;
      } catch {}
    }

    if (ok === 0) addToast('Xóa sessions thất bại', 'error');
    else if (ok < ids.length) addToast(`Đã xóa ${ok}/${ids.length} session`, 'warning');
    else addToast(`Đã xóa ${ok} session`, 'success');

    setSelectedSessions(new Set());
    await refreshSessions();
  };

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
                    <img
                      src={`${shot.url}?t=${Date.now()}`}
                      alt="live"
                      onError={() => {
                        setFailedLive((prev) => {
                          const next = new Set(prev);
                          next.add(sessionId);
                          return next;
                        });
                        setHiddenLive((prev) => {
                          const next = new Set(prev);
                          next.add(sessionId);
                          return next;
                        });
                      }}
                    />
                  </div>
                  <div className="live-info">
                    <div className="live-label">{shot.email || sessionId.replace(/^run_/, '')}</div>
                    <div className="live-sub">
                      {shot.filename} • {fmtDateTimeVN(shot.ts || new Date().toISOString())}
                    </div>
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
          <span className="card-title">🗂️ Lịch sử Sessions ({filteredSessions.length}/{sessions.length})</span>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              className="inp inp-sm"
              style={{ width: 220 }}
              placeholder="Tìm theo session/filename..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <select className="inp inp-sm" style={{ width: 150 }} value={sortBy} onChange={(e) => {
              const v = e.target.value;
              if (v === 'oldest' || v === 'most') setSortBy(v);
              else setSortBy('newest');
            }}>
              <option value="newest">Mới nhất</option>
              <option value="oldest">Cũ nhất</option>
              <option value="most">Nhiều ảnh nhất</option>
            </select>
            <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 12, color: 'var(--text-2)' }}>
              <input type="checkbox" checked={onlyWithImages} onChange={(e) => setOnlyWithImages(e.target.checked)} />
              Chỉ session có ảnh
            </label>
            <button className="btn btn-ghost btn-sm" onClick={toggleSelectAllFiltered} disabled={filteredSessions.length === 0}>
              {filteredSessions.length > 0 && filteredSessions.every((s) => selectedSessions.has(s.id)) ? 'Bỏ chọn' : 'Chọn tất cả'}
            </button>
            <button className="btn btn-danger btn-sm" onClick={deleteSelectedSessions} disabled={selectedSessions.size === 0}>
              Xóa đã chọn ({selectedSessions.size})
            </button>
            <button className="btn btn-ghost btn-sm" onClick={refresh} disabled={loading}>
              {loading ? <Spinner/> : '↻'} Làm mới
            </button>
          </div>
        </div>
        <div className="card-body p0">
          {filteredSessions.length === 0 ? (
            <div className="empty" style={{ padding:40 }}>
              <div className="e-ico">📂</div>
              <div className="e-txt">{sessions.length === 0 ? 'Chưa có session nào' : 'Không có session phù hợp bộ lọc'}</div>
              <div className="e-sub">Screenshots sẽ xuất hiện tại đây khi Worker chạy</div>
            </div>
          ) : (
            <div className="sessions-grid" style={{ padding:12 }}>
              {filteredSessions.map(s => (
                <SessionCard
                  key={s.id}
                  session={s}
                  onDeleteSession={deleteSession}
                  onDeleteImage={deleteImage}
                  selected={selectedSessions.has(s.id)}
                  onToggleSelect={toggleSessionSelect}
                />
              ))}
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
