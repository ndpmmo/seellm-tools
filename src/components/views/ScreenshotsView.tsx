'use client';
import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useApp, Session, Screenshot } from '../AppContext';
import { Spinner, fmtDateTimeVN, ConfirmModal } from '../Views';
import { Button, Card, CardHeader, CardTitle, CardContent, Input } from '../ui';
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
    <div className="fixed inset-0 z-50 flex flex-col bg-black/95 backdrop-blur-xl">
      <div className="absolute inset-0" onClick={onClose} />
      <div className="relative flex items-center justify-between p-4 bg-gradient-to-b from-black/80 to-transparent pointer-events-none z-10">
        <div className="flex flex-col drop-shadow-md pointer-events-auto">
          <div className="text-lg font-bold text-white tracking-wide">
            {currentImg.email ? `${currentImg.email} - ${session.id.replace(/^run_/, '').substring(0, 8)}` : session.id.replace(/^run_/, '').substring(0, 40)}
          </div>
          <div className="text-sm text-slate-300 flex items-center gap-1.5 mt-1">
            <Clock size={12} />
            {fmtDateTimeVN(currentImg.ts || session.mtime)} <span className="mx-1 opacity-50">•</span> {currentImg.filename}
          </div>
        </div>

        <div className="flex items-center gap-4 pointer-events-auto">
          {liveMode && <div className="px-3 py-1 rounded-full bg-rose-500/20 text-rose-400 border border-rose-500/30 text-xs font-bold tracking-wider animate-pulse flex items-center gap-2"><span className="w-1.5 h-1.5 bg-rose-500 rounded-full" /> Đang theo dõi trực tiếp</div>}
          <button className="w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-colors shadow-lg" onClick={onClose} title="Đóng (Esc)">
            <X size={20} />
          </button>
        </div>
      </div>

      <div className="relative flex-1 flex items-center justify-center overflow-hidden pointer-events-none">
        <div className="relative w-full h-full p-4 md:p-10 flex items-center justify-center pointer-events-auto" onClick={e => e.stopPropagation()}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img 
            key={currentImg.url} 
            src={currentImg.url} 
            alt={currentImg.filename} 
            className="max-w-full max-h-full object-contain drop-shadow-2xl rounded-sm border border-white/10 bg-black/50"
          />
        </div>

        <div className="absolute inset-y-0 left-0 flex items-center px-4 md:px-8 pointer-events-none z-10">
          <button 
            className="w-14 h-14 rounded-full bg-black/50 hover:bg-black/80 text-white flex items-center justify-center backdrop-blur-md border border-white/10 transition-all pointer-events-auto active:scale-95 disabled:opacity-0 disabled:pointer-events-none" 
            onClick={handlePrev}
            disabled={currentIndex === 0}
          >
            <ChevronLeft size={32} />
          </button>
        </div>
        <div className="absolute inset-y-0 right-0 flex items-center px-4 md:px-8 pointer-events-none z-10">
          <button 
            className="w-14 h-14 rounded-full bg-black/50 hover:bg-black/80 text-white flex items-center justify-center backdrop-blur-md border border-white/10 transition-all pointer-events-auto active:scale-95 disabled:opacity-0 disabled:pointer-events-none" 
            onClick={handleNext}
            disabled={currentIndex === session.images.length - 1}
          >
            <ChevronRight size={32} />
          </button>
        </div>
      </div>

      <div className="relative z-10 bg-gradient-to-t from-black via-black/80 to-transparent p-4 md:p-6 flex justify-center">
        <div className="flex gap-2 overflow-x-auto pb-4 px-4 snap-x hide-scrollbar scroll-smooth w-full max-w-screen-xl" ref={filmstripRef} onClick={e => e.stopPropagation()}>
          {session.images.map((img, idx) => (
            <div 
              key={img.filename}
              className={`shrink-0 relative w-24 h-16 rounded-md overflow-hidden cursor-pointer border-2 transition-all transform snap-center ${idx === currentIndex ? 'border-indigo-400 scale-110 z-10 shadow-[0_0_15px_rgba(129,140,248,0.5)]' : 'border-transparent opacity-50 hover:opacity-100'}`}
              onClick={(e) => {
                e.stopPropagation();
                setCurrentIndex(idx);
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={img.url} alt={img.filename} className="w-full h-full object-cover" />
              <div className="absolute inset-x-0 bottom-0 bg-black/70 text-[9px] text-white px-1 py-0.5 truncate text-center font-mono">{img.filename.replace(/^\d{2}_/, '').replace(/_/g, ' ').replace('.png', '')}</div>
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
    <div className="flex flex-col bg-black/20 border border-white/5 rounded-xl overflow-hidden hover:border-white/10 transition-colors">
      <div className="flex items-center gap-3 p-3.5 cursor-pointer select-none bg-white/[0.02] hover:bg-white/[0.04] transition-colors" onClick={() => setOpen(!open)}>
        <input
          type="checkbox"
          className="w-4 h-4 rounded border-white/20 bg-black/50 text-indigo-500 focus:ring-indigo-500/30 cursor-pointer"
          checked={selected}
          onChange={(e) => {
            e.stopPropagation();
            onToggleSelect(session.id);
          }}
          onClick={(e) => e.stopPropagation()}
          title="Chọn session để xóa hàng loạt"
        />
        <div className="w-8 h-8 rounded-lg bg-indigo-500/10 text-indigo-400 flex items-center justify-center shrink-0">
          <Camera size={16} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-bold text-slate-200 truncate">{label}</div>
          <div className="text-[11px] text-slate-500 flex items-center gap-1.5 mt-0.5">
            <span className="font-semibold text-slate-300">{session.imageCount}</span> ảnh <span className="opacity-50">•</span> {fmtDateTimeVN(session.createdAt || session.mtime)}
          </div>
        </div>
        <Button
          variant="danger"
          size="icon-sm"
          className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
          onClick={(e) => {
            e.stopPropagation();
            onDeleteSession(session.id);
          }}
          title="Xóa session"
        >
          <Trash2 size={13} />
        </Button>
        <div className={`text-slate-500 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}>
          <ChevronRight size={16} />
        </div>
      </div>
      {open && (
        <div className="p-3 bg-black/40 border-t border-white/5 grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 gap-2">
          {session.images.length === 0 ? (
            <div className="col-span-full py-6 text-center text-[12px] text-slate-500 italic">Không có ảnh nào</div>
          ) : session.images.map(img => (
            <div key={img.filename} className="group relative aspect-video bg-black/60 rounded-lg overflow-hidden border border-white/5 hover:border-indigo-500/50 cursor-pointer" onClick={() => onOpenViewer(session, img)}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`${img.url}`} alt="live" className="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity" />
              <button
                className="absolute top-1 right-1 w-6 h-6 rounded bg-rose-500/80 hover:bg-rose-500 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all z-10 shadow-md"
                onClick={(e) => {
                  e.stopPropagation();
                  onDeleteImage(session.id, img.filename);
                }}
              >
                <Trash2 size={11} />
              </button>
              <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 to-transparent px-2 py-1.5 text-[9px] text-slate-300 truncate font-mono">
                {img.filename.replace(/^\d{2}_/, '').replace(/_/g, ' ').replace('.png', '')}
              </div>
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
    <div className="absolute inset-0 overflow-y-auto px-6 pb-10 pt-2 flex flex-col gap-6 custom-scrollbar">
      {/* Live Channels Grid */}
      <Card>
        <CardHeader>
          <CardTitle className="text-rose-400">
            <span className="inline-block mr-2 w-2 h-2 rounded-full bg-rose-500 animate-pulse" />
            Bản xem trực tiếp ({activeLiveEntries.length})
          </CardTitle>
          <div className="flex gap-2 ml-auto">
            {activeLiveEntries.length > 0 && (
              <Button variant="ghost" size="sm" onClick={() => setHiddenLive(new Set(Object.keys(liveShots)))}>
                Dọn dẹp tất cả
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {activeLiveEntries.length === 0 ? (
            <div className="py-12 flex flex-col items-center justify-center text-center gap-3">
              <div className="text-4xl filter grayscale opacity-30">🦊</div>
              <div className="font-medium text-slate-300">Hiện không có luồng nào đang hoạt động</div>
              <div className="text-[12.5px] text-slate-500">Khởi động Worker để theo dõi đa luồng realtime</div>
            </div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
              {activeLiveEntries.map(([sessionId, shot]) => {
                const sessionObj = sessions.find(s => s.id === sessionId);
                return (
                  <div key={sessionId} className="group relative rounded-xl overflow-hidden bg-black/40 border border-white/10 hover:border-indigo-500/50 transition-colors shadow-lg">
                    <div
                      className="relative aspect-video flex items-center justify-center cursor-pointer overflow-hidden bg-black/50"
                      onClick={() => {
                        if (sessionObj) handleOpenViewer(sessionObj, shot, true);
                        else addToast('Đang khởi tạo session data...', 'info');
                      }}
                    >
                      <div className="absolute top-2 left-2 z-10 flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-rose-500/20 text-rose-400 border border-rose-500/30 text-[9px] font-bold tracking-wider backdrop-blur-md shadow-md">
                        <span className="w-1.5 h-1.5 bg-rose-500 rounded-full animate-pulse" />LIVE
                      </div>
                      <button
                        className="absolute top-2 right-2 z-10 w-6 h-6 rounded bg-black/60 hover:bg-black text-slate-300 hover:text-white flex items-center justify-center backdrop-blur-md opacity-0 group-hover:opacity-100 transition-all border border-white/10"
                        onClick={(e) => { e.stopPropagation(); setHiddenLive(prev => new Set([...prev, sessionId])); }}
                        title="Ẩn luồng này"
                      >✕</button>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={`${shot.url}`}
                        alt="live"
                        className="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity"
                        onError={() => {
                          setFailedLive((prev) => {
                            const next = new Set(prev);
                            next.add(sessionId);
                            return next;
                          });
                        }}
                      />
                    </div>
                    <div className="p-3 bg-black/20 border-t border-white/5">
                      <div className="text-[12px] font-bold text-slate-200 truncate">{shot.email || sessionId.replace(/^run_/, '')}</div>
                      <div className="text-[10px] text-slate-500 mt-1 truncate">
                        {shot.filename} <span className="mx-1 opacity-50">•</span> {fmtDateTimeVN(shot.ts || new Date().toISOString())}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>


      {/* Session History */}
      <Card className="flex flex-col flex-1 min-h-[400px]">
        <CardHeader className="flex-wrap gap-y-3">
          <CardTitle>
            <History size={16} className="text-indigo-400" />
            Lịch sử Sessions <span className="ml-2 px-2 py-0.5 rounded-full text-[10px] bg-white/10 text-slate-300 font-bold">{filteredSessions.length}/{sessions.length}</span>
          </CardTitle>
          <div className="flex gap-2 items-center ml-auto flex-wrap">
            <div className="relative flex items-center">
              <Search size={14} className="absolute left-3 text-slate-500 pointer-events-none" />
              <Input
                className="pl-8 w-[220px] bg-white/5 border-white/10 h-8 text-[12.5px]"
                placeholder="Tìm session/filename..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>

            <select className="h-8 rounded-lg bg-black/40 border border-white/10 text-[12.5px] text-slate-300 px-3 pr-8 outline-none focus:border-indigo-500/50" value={sortBy} onChange={(e) => {
              const v = e.target.value as any;
              setSortBy(v);
            }}>
              <option value="newest">Mới nhất</option>
              <option value="oldest">Cũ nhất</option>
              <option value="most">Nhiều ảnh nhất</option>
            </select>

            <label className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-white/5 bg-white/5 cursor-pointer hover:bg-white/10 transition-colors text-[12px] font-medium text-slate-300 select-none">
              <input type="checkbox" className="w-3.5 h-3.5 rounded border-white/20 bg-black/50 text-indigo-500 focus:ring-indigo-500/30 cursor-pointer" checked={onlyWithImages} onChange={(e) => setOnlyWithImages(e.target.checked)} />
              Có ảnh
            </label>

            <Button variant="ghost" size="sm" onClick={toggleSelectAllFiltered} disabled={filteredSessions.length === 0} className="border border-white/5 bg-white/5 hover:bg-white/10">
              {filteredSessions.length > 0 && filteredSessions.every((s) => selectedSessions.has(s.id)) ? <Square size={14} className="mr-1.5" /> : <CheckSquare size={14} className="mr-1.5" />}
              {filteredSessions.length > 0 && filteredSessions.every((s) => selectedSessions.has(s.id)) ? 'Bỏ chọn' : 'Chọn hết'}
            </Button>

            {selectedSessions.size > 0 && (
              <Button variant="danger" size="sm" onClick={deleteSelectedSessions}>
                <Trash2 size={14} /> Xóa ({selectedSessions.size})
              </Button>
            )}

            <Button variant="secondary" size="icon-sm" onClick={refresh} disabled={loading} title="Làm mới" className="border border-white/5 bg-white/5 hover:bg-white/10">
              <RefreshCw size={14} className={`${loading ? 'animate-spin' : ''} text-slate-300`} />
            </Button>
          </div>
        </CardHeader>
        <div className="flex-1 overflow-y-auto p-4 bg-black/10">
          {filteredSessions.length === 0 ? (
            <div className="py-20 flex flex-col items-center justify-center text-center gap-4">
              <div className="text-4xl filter grayscale opacity-20">📂</div>
              <div className="font-medium text-slate-300">{sessions.length === 0 ? 'Chưa có session nào' : 'Không có session phù hợp'}</div>
              <div className="text-[12.5px] text-slate-500">Screenshots sẽ xuất hiện tại đây khi Worker chạy</div>
            </div>
          ) : (
            <div className="flex flex-col gap-2.5">
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
      </Card>

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
