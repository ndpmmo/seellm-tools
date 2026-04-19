'use client';
import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useApp, Session, Screenshot } from '../AppContext';
import { Spinner, fmtDateTimeVN, ConfirmModal } from '../Views';
import {
  History, Camera, Clock, Tag, X, ChevronLeft, ChevronRight,
  Trash2, Maximize2, RefreshCw, Filter, Search, CheckSquare, Square,
  Info, ExternalLink, Calendar, AlertTriangle
} from 'lucide-react';

// --- Advanced Viewer Component ---
interface AdvancedViewerProps {
  session: Session | null;
  initialImage?: Screenshot | null;
  liveMode?: boolean;
  onClose: () => void;
  onDeleteImage?: (sessionId: string, filename: string) => Promise<void>;
}

function AdvancedViewer({ session, initialImage, liveMode, onClose, onDeleteImage }: AdvancedViewerProps) {
  const { liveShots } = useApp();
  const [currentIndex, setCurrentIndex] = useState(0);
  const filmstripRef = useRef<HTMLDivElement>(null);

  // Sync current index only when the initial clicked image changes
  useEffect(() => {
    if (session && initialImage) {
      const idx = session.images.findIndex(img => img.filename === initialImage.filename);
      if (idx !== -1) setCurrentIndex(idx);
    }
    // We only want to jump to the clicked image once per click
  }, [initialImage]);

  // Handle Live Mode Auto-Update: Only push to last if we are in live mode
  useEffect(() => {
    if (liveMode && session) {
      const latestFromLive = liveShots[session.id];
      if (latestFromLive && session.images.length > 0) {
        // Find if this new image is already in session.images (via refreshSessions in AppContext)
        const idx = session.images.findIndex(img => img.filename === latestFromLive.filename);
        if (idx !== -1) {
          setCurrentIndex(idx);
        } else {
          // If session.images is slightly behind, we can wait for next update or just stay at last
          setCurrentIndex(session.images.length - 1);
        }
      }
    }
  }, [liveShots, liveMode, session]);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight') handleNext();
      if (e.key === 'ArrowLeft') handlePrev();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [currentIndex, session]);

  // Scroll filmstrip to active item
  useEffect(() => {
    const activeItem = filmstripRef.current?.querySelector('.strip-item.active');
    if (activeItem) {
      activeItem.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }
  }, [currentIndex]);

  if (!session || session.images.length === 0) return null;

  const currentImg = session.images[currentIndex] || session.images[session.images.length - 1];

  const handleNext = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (currentIndex < session.images.length - 1) {
      setCurrentIndex(prev => prev + 1);
    }
  };

  const handlePrev = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (currentIndex > 0) {
      setCurrentIndex(prev => prev - 1);
    }
  };

  return (
    <div className="viewer-overlay">
      <div className="viewer-backdrop" onClick={onClose} />
      <div className="viewer-header">
        <div className="viewer-meta">
          <div className="viewer-title">
            {currentImg.email ? `${currentImg.email} - ${session.id.replace(/^run_/, '').substring(0, 8)}` : session.id.replace(/^run_/, '').substring(0, 40)}
          </div>
          <div className="viewer-sub">
            <Clock size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} />
            {fmtDateTimeVN(currentImg.ts || session.mtime)} • {currentImg.filename}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 15 }}>
          {liveMode && <div className="live-indicator">Đang theo dõi trực tiếp</div>}
          <button className="btn-icon" onClick={onClose} title="Đóng (Esc)">
            <X size={20} />
          </button>
        </div>
      </div>

      <div className="viewer-main">
        <div className="viewer-img-container" onClick={e => e.stopPropagation()}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img 
            key={currentImg.url} 
            src={currentImg.url} 
            alt={currentImg.filename} 
            className="viewer-img"
          />
        </div>

        <div className="viewer-controls" style={{ zIndex: 10 }}>
          <button 
            className="viewer-nav-btn" 
            onClick={handlePrev}
            disabled={currentIndex === 0}
            style={{ opacity: currentIndex === 0 ? 0 : 1, pointerEvents: currentIndex === 0 ? 'none' : 'all' }}
          >
            <ChevronLeft size={36} />
          </button>
          <button 
            className="viewer-nav-btn" 
            onClick={handleNext}
            disabled={currentIndex === session.images.length - 1}
            style={{ opacity: currentIndex === session.images.length - 1 ? 0 : 1, pointerEvents: currentIndex === session.images.length - 1 ? 'none' : 'all' }}
          >
            <ChevronRight size={36} />
          </button>
        </div>
      </div>

      <div className="viewer-footer">
        <div className="viewer-filmstrip" ref={filmstripRef} onClick={e => e.stopPropagation()}>
          {session.images.map((img, idx) => (
            <div 
              key={img.filename}
              className={`strip-item ${idx === currentIndex ? 'active' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                setCurrentIndex(idx);
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={img.url} alt={img.filename} />
              <div className="strip-label">{img.filename.replace(/^\d{2}_/, '').replace(/_/g, ' ').replace('.png', '')}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function SessionCard({
  session,
  onDeleteSession,
  onDeleteImage,
  selected,
  onToggleSelect,
  onOpenViewer,
}: {
  session: Session;
  onDeleteSession: (sessionId: string) => Promise<void>;
  onDeleteImage: (sessionId: string, filename: string) => Promise<void>;
  selected: boolean;
  onToggleSelect: (sessionId: string) => void;
  onOpenViewer: (session: Session, img: Screenshot) => void;
}) {
  const [open, setOpen] = useState(false);

  // Try to find the email attached to any of the images in the session
  const email = useMemo(() => {
    for (const img of session.images) {
      if (img.email) return img.email;
    }
    return '';
  }, [session.images]);

  const shortId = session.id.replace(/^run_/, '').substring(0, 8);
  const label = email ? `${email} - ${shortId}` : session.id.replace(/^run_/, '').substring(0, 30);

  return (
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
        <div style={{ color: 'var(--indigo-2)' }}>
          <Camera size={18} />
        </div>
        <div className="session-id">{label}</div>
        <div className="session-count" title={`Cập nhật: ${fmtDateTimeVN(session.mtime)}`}>
          <span style={{ fontWeight: 600, color: 'var(--text-2)' }}>{session.imageCount}</span> ảnh • {fmtDateTimeVN(session.createdAt || session.mtime)}
        </div>
        <button
          className="btn-icon danger btn-xs"
          onClick={(e) => {
            e.stopPropagation();
            onDeleteSession(session.id);
          }}
          title="Xóa session"
        >
          <Trash2 size={12} />
        </button>
        <div className={`session-chevron ${open ? 'open' : ''}`}>
          <ChevronRight size={14} />
        </div>
      </div>
      {open && (
        <div className="screenshot-gallery">
          {session.images.length === 0 ? (
            <div className="ss-empty">Không có ảnh nào</div>
          ) : session.images.map(img => (
            <div key={img.filename} className="ss-thumb" onClick={() => onOpenViewer(session, img)}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={img.url} alt={img.filename} loading="lazy" />
              <button
                className="btn btn-danger btn-xs"
                style={{ position: 'absolute', top: 6, right: 6, zIndex: 5, padding: '2px 4px' }}
                onClick={(e) => {
                  e.stopPropagation();
                  onDeleteImage(session.id, img.filename);
                }}
              >
                <Trash2 size={10} />
              </button>
              <div className="ss-label">{img.filename.replace(/^\d{2}_/, '').replace(/_/g, ' ').replace('.png', '')}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function ScreenshotsView() {
  const { sessions, liveShots, refreshSessions, addToast } = useApp();
  const [loading, setLoading] = useState(false);
  const [activeViewer, setActiveViewer] = useState<{ session: Session; initialImage: Screenshot; live?: boolean } | null>(null);
  const [confirmModal, setConfirmModal] = useState<{ title: string; message: string; onConfirm: () => Promise<void> } | null>(null);
  const [query, setQuery] = useState('');
  const [sortBy, setSortBy] = useState<'newest' | 'oldest' | 'most'>('newest');
  const [onlyWithImages, setOnlyWithImages] = useState(false);
  const [selectedSessions, setSelectedSessions] = useState<Set<string>>(new Set());
  const [failedLive, setFailedLive] = useState<Set<string>>(new Set());
  const [hiddenLive, setHiddenLive] = useState<Set<string>>(new Set());

  // Watch for session updates while viewer is open (to keep viewer data fresh)
  useEffect(() => {
    if (activeViewer && activeViewer.session) {
      const updated = sessions.find(s => s.id === activeViewer.session.id);
      if (updated && updated.imageCount !== activeViewer.session.imageCount) {
        setActiveViewer(prev => prev ? { ...prev, session: updated } : null);
      }
    }
  }, [sessions]);

  const refresh = async () => {
    setLoading(true);
    await refreshSessions();
    setLoading(false);
  };

  const deleteSession = async (sessionId: string) => {
    setConfirmModal({
      title: 'Xóa Session',
      message: `Bạn có chắc muốn xóa toàn bộ screenshots của session "${sessionId}"? Thao tác này không thể hoàn tác.`,
      onConfirm: async () => {
        const r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          addToast(`Xóa session thất bại: ${err.error || `HTTP ${r.status}`}`, 'error');
        } else {
          addToast('Đã xóa session screenshots', 'success');
          setSelectedSessions((prev) => {
            const next = new Set(prev);
            next.delete(sessionId);
            return next;
          });
          await refreshSessions();
        }
        setConfirmModal(null);
      }
    });
  };

  const deleteImage = async (sessionId: string, filename: string) => {
    setConfirmModal({
      title: 'Xóa Ảnh',
      message: `Bạn có chắc muốn xóa ảnh "${filename}"?`,
      onConfirm: async () => {
        const r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/images/${encodeURIComponent(filename)}`, { method: 'DELETE' });
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          addToast(`Xóa screenshot thất bại: ${err.error || `HTTP ${r.status}`}`, 'error');
        } else {
          addToast('Đã xóa screenshot', 'success');
          await refreshSessions();
        }
        setConfirmModal(null);
      }
    });
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

    setConfirmModal({
      title: 'Xóa Nhiều Session',
      message: `Bạn có chắc muốn xóa ${ids.length} session screenshots đã chọn?`,
      onConfirm: async () => {
        setLoading(true);
        let ok = 0;
        for (const id of ids) {
          try {
            const r = await fetch(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
            if (r.ok) ok += 1;
          } catch { }
        }
        setLoading(false);
        if (ok === 0) addToast('Xóa sessions thất bại', 'error');
        else if (ok < ids.length) addToast(`Đã xóa ${ok}/${ids.length} session`, 'warning');
        else addToast(`Đã xóa ${ok} session`, 'success');

        setSelectedSessions(new Set());
        await refreshSessions();
        setConfirmModal(null);
      }
    });
  };

  const handleOpenViewer = (session: Session, img: Screenshot, live = false) => {
    setActiveViewer({ session, initialImage: img, live });
  };

  return (
    <div className="content">
      {/* Live Channels Grid */}
      <div className="card">
        <div className="card-head">
          <span className="card-title" style={{ color: 'var(--rose)' }}>
            <span style={{ animation: 'blink 1s infinite', display: 'inline-block', marginRight: 8 }}>●</span>
            Bản xem trực tiếp ({activeLiveEntries.length})
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
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
              <div style={{ fontSize: 11, color: 'var(--text-3)' }}>Khởi động Worker để theo dõi đa luồng realtime</div>
            </div>
          ) : (
            <div className="live-grid">
              {activeLiveEntries.map(([sessionId, shot]) => {
                const sessionObj = sessions.find(s => s.id === sessionId);
                return (
                  <div key={sessionId} className="live-entry-container">
                    <div
                      className="live-screen clickable"
                      onClick={() => {
                        if (sessionObj) handleOpenViewer(sessionObj, shot, true);
                        else addToast('Đang khởi tạo session data...', 'info');
                      }}
                    >
                      <div className="live-badge">
                        <span className="live-dot" />LIVE
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
                );
              })}
            </div>
          )}
        </div>
      </div>


      {/* Session History */}
      <div className="card">
        <div className="card-head">
          <span className="card-title">
            <History size={16} style={{ marginRight: 4 }} />
            Lịch sử Sessions ({filteredSessions.length}/{sessions.length})
          </span>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
              <Search size={14} style={{ position: 'absolute', left: 10, color: 'var(--text-3)' }} />
              <input
                className="inp inp-sm"
                style={{ width: 220, paddingLeft: 32 }}
                placeholder="Tìm session/filename..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>

            <select className="inp inp-sm" style={{ width: 140 }} value={sortBy} onChange={(e) => {
              const v = e.target.value as any;
              setSortBy(v);
            }}>
              <option value="newest">Mới nhất</option>
              <option value="oldest">Cũ nhất</option>
              <option value="most">Nhiều ảnh nhất</option>
            </select>

            <label className="btn btn-ghost btn-sm" style={{ gap: 8, cursor: 'pointer' }}>
              <input type="checkbox" checked={onlyWithImages} onChange={(e) => setOnlyWithImages(e.target.checked)} />
              Có ảnh
            </label>

            <button className="btn btn-ghost btn-sm" onClick={toggleSelectAllFiltered} disabled={filteredSessions.length === 0}>
              {filteredSessions.length > 0 && filteredSessions.every((s) => selectedSessions.has(s.id)) ? <Square size={14} /> : <CheckSquare size={14} />}
              {filteredSessions.length > 0 && filteredSessions.every((s) => selectedSessions.has(s.id)) ? 'Bỏ chọn' : 'Chọn hết'}
            </button>

            {selectedSessions.size > 0 && (
              <button className="btn btn-danger btn-sm" onClick={deleteSelectedSessions}>
                <Trash2 size={14} /> Xóa ({selectedSessions.size})
              </button>
            )}

            <button className="btn btn-ghost btn-sm" onClick={refresh} disabled={loading} title="Làm mới">
              {loading ? <Spinner /> : <RefreshCw size={14} />}
            </button>
          </div>
        </div>
        <div className="card-body p0">
          {filteredSessions.length === 0 ? (
            <div className="empty" style={{ padding: 40 }}>
              <div className="e-ico">📂</div>
              <div className="e-txt">{sessions.length === 0 ? 'Chưa có session nào' : 'Không có session phù hợp'}</div>
              <div className="e-sub">Screenshots sẽ xuất hiện tại đây khi Worker chạy</div>
            </div>
          ) : (
            <div className="sessions-grid" style={{ padding: 12 }}>
              {filteredSessions.map(s => (
                <SessionCard
                  key={s.id}
                  session={s}
                  onDeleteSession={deleteSession}
                  onDeleteImage={deleteImage}
                  selected={selectedSessions.has(s.id)}
                  onToggleSelect={toggleSessionSelect}
                  onOpenViewer={handleOpenViewer}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {activeViewer && (
        <AdvancedViewer
          session={activeViewer.session}
          initialImage={activeViewer.initialImage}
          liveMode={activeViewer.live}
          onClose={() => setActiveViewer(null)}
          onDeleteImage={deleteImage}
        />
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
