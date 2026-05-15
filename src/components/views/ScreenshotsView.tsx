'use client';
import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useApp, Session, Screenshot } from '../AppContext';
import { Spinner, fmtDateTimeVN, fmtBytes, relTime, ConfirmModal } from '../Views';
import { Button, Card, CardHeader, CardTitle, CardContent, Input, StatBox } from '../ui';
import {
  History, Camera, Clock, Tag, X, ChevronLeft, ChevronRight,
  Trash2, Maximize2, RefreshCw, Filter, Search, CheckSquare, Square,
  Info, ExternalLink, Calendar, AlertTriangle, LayoutGrid, List,
  Image, Download, Eye, ZoomIn, ZoomOut, RotateCw, Copy
} from 'lucide-react';

/* ─── Types ──────────────────────────────────────────────────────────────── */

type ViewMode = 'grid' | 'list';
type SortMode = 'newest' | 'oldest' | 'most';

/* ─── Advanced Viewer ────────────────────────────────────────────────────── */

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
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [showInfo, setShowInfo] = useState(false);
  const filmstripRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (session && initialImage) {
      const idx = session.images.findIndex(img => img.filename === initialImage.filename);
      if (idx !== -1) setCurrentIndex(idx);
    }
  }, [initialImage]);

  useEffect(() => {
    if (liveMode && session) {
      const latestFromLive = liveShots[session.id];
      if (latestFromLive && session.images.length > 0) {
        const idx = session.images.findIndex(img => img.filename === latestFromLive.filename);
        if (idx !== -1) setCurrentIndex(idx);
        else setCurrentIndex(session.images.length - 1);
      }
    }
  }, [liveShots, liveMode, session]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight') handleNext();
      else if (e.key === 'ArrowLeft') handlePrev();
      else if (e.key === '+' || e.key === '=') setZoom(z => Math.min(z + 0.25, 4));
      else if (e.key === '-') setZoom(z => Math.max(z - 0.25, 0.25));
      else if (e.key === '0') { setZoom(1); setRotation(0); }
      else if (e.key === 'r') setRotation(r => (r + 90) % 360);
      else if (e.key === 'i') setShowInfo(s => !s);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [currentIndex, session, zoom]);

  useEffect(() => {
    const activeItem = filmstripRef.current?.querySelector('.strip-item.active');
    if (activeItem) activeItem.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  }, [currentIndex]);

  if (!session || session.images.length === 0) return null;

  const currentImg = session.images[currentIndex] || session.images[session.images.length - 1];

  const handleNext = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (currentIndex < session.images.length - 1) setCurrentIndex(prev => prev + 1);
  };
  const handlePrev = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (currentIndex > 0) setCurrentIndex(prev => prev - 1);
  };

  const handleWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      setZoom(z => Math.max(0.25, Math.min(4, z - e.deltaY * 0.002)));
    }
  };

  const copyImageUrl = () => {
    navigator.clipboard.writeText(window.location.origin + currentImg.url);
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/95 backdrop-blur-xl" onWheel={handleWheel}>
      <div className="absolute inset-0" onClick={onClose} />

      {/* Top Bar */}
      <div className="relative flex items-center justify-between px-4 py-3 bg-gradient-to-b from-black/80 to-transparent pointer-events-none z-10">
        <div className="flex flex-col drop-shadow-md pointer-events-auto min-w-0">
          <div className="text-[15px] font-bold text-white tracking-wide truncate">
            {currentImg.email ? `${currentImg.email}` : session.id.replace(/^run_/, '').substring(0, 40)}
          </div>
          <div className="text-[11.5px] text-slate-400 flex items-center gap-2 mt-0.5">
            <Clock size={11} />
            {fmtDateTimeVN(currentImg.ts || session.mtime)}
            <span className="opacity-40">|</span>
            <span className="font-mono truncate">{currentImg.filename}</span>
            <span className="opacity-40">|</span>
            <span>{currentIndex + 1}/{session.images.length}</span>
          </div>
        </div>

        <div className="flex items-center gap-2 pointer-events-auto">
          {liveMode && (
            <div className="px-2.5 py-1 rounded-full bg-rose-500/20 text-rose-400 border border-rose-500/30 text-[10px] font-bold tracking-wider animate-pulse flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 bg-rose-500 rounded-full" /> LIVE
            </div>
          )}

          {/* Zoom controls */}
          <div className="flex items-center gap-1 bg-white/5 rounded-lg border border-white/10 px-1">
            <button className="w-7 h-7 flex items-center justify-center text-slate-300 hover:text-white transition-colors" onClick={() => setZoom(z => Math.max(0.25, z - 0.25))} title="Thu nhỏ (-)">
              <ZoomOut size={14} />
            </button>
            <button className="text-[11px] text-slate-300 font-mono min-w-[40px] text-center" onClick={() => { setZoom(1); setRotation(0); }} title="Reset (0)">
              {Math.round(zoom * 100)}%
            </button>
            <button className="w-7 h-7 flex items-center justify-center text-slate-300 hover:text-white transition-colors" onClick={() => setZoom(z => Math.min(4, z + 0.25))} title="Phóng to (+)">
              <ZoomIn size={14} />
            </button>
          </div>

          <button className="w-8 h-8 rounded-lg bg-white/5 hover:bg-white/10 text-slate-300 flex items-center justify-center transition-colors border border-white/10" onClick={() => setRotation(r => (r + 90) % 360)} title="Xoay (R)">
            <RotateCw size={14} />
          </button>
          <button className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors border ${showInfo ? 'bg-indigo-500/20 text-indigo-400 border-indigo-500/30' : 'bg-white/5 hover:bg-white/10 text-slate-300 border-white/10'}`} onClick={() => setShowInfo(s => !s)} title="Thông tin (I)">
            <Info size={14} />
          </button>
          <button className="w-8 h-8 rounded-lg bg-white/5 hover:bg-white/10 text-slate-300 flex items-center justify-center transition-colors border border-white/10" onClick={copyImageUrl} title="Copy URL">
            <Copy size={14} />
          </button>
          <button className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-colors shadow-lg" onClick={onClose} title="Đóng (Esc)">
            <X size={18} />
          </button>
        </div>
      </div>

      {/* Image Area */}
      <div className="relative flex-1 flex items-center justify-center overflow-hidden pointer-events-none" onClick={onClose}>
        <div className="relative w-full h-full flex items-center justify-center pointer-events-auto" onClick={e => e.stopPropagation()}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            key={currentImg.url}
            src={currentImg.url}
            alt={currentImg.filename}
            className="max-w-full max-h-full object-contain drop-shadow-2xl rounded-sm border border-white/10 bg-black/50 transition-transform duration-150"
            style={{ transform: `scale(${zoom}) rotate(${rotation}deg)` }}
          />
        </div>

        {/* Nav arrows */}
        <div className="absolute inset-y-0 left-0 flex items-center px-4 md:px-8 pointer-events-none z-10">
          <button className="w-12 h-12 rounded-full bg-black/50 hover:bg-black/80 text-white flex items-center justify-center backdrop-blur-md border border-white/10 transition-all pointer-events-auto active:scale-95 disabled:opacity-0 disabled:pointer-events-none" onClick={handlePrev} disabled={currentIndex === 0}>
            <ChevronLeft size={28} />
          </button>
        </div>
        <div className="absolute inset-y-0 right-0 flex items-center px-4 md:px-8 pointer-events-none z-10">
          <button className="w-12 h-12 rounded-full bg-black/50 hover:bg-black/80 text-white flex items-center justify-center backdrop-blur-md border border-white/10 transition-all pointer-events-auto active:scale-95 disabled:opacity-0 disabled:pointer-events-none" onClick={handleNext} disabled={currentIndex === session.images.length - 1}>
            <ChevronRight size={28} />
          </button>
        </div>

        {/* Info Panel */}
        {showInfo && (
          <div className="absolute top-0 right-0 w-[280px] h-full bg-black/80 backdrop-blur-xl border-l border-white/10 p-5 overflow-y-auto pointer-events-auto z-20">
            <h4 className="text-[13px] font-bold text-slate-200 mb-3">Thông tin ảnh</h4>
            <div className="space-y-2.5 text-[12px]">
              <div><span className="text-slate-500">File:</span> <span className="text-slate-300 font-mono">{currentImg.filename}</span></div>
              <div><span className="text-slate-500">Session:</span> <span className="text-slate-300">{session.id}</span></div>
              {currentImg.email && <div><span className="text-slate-500">Email:</span> <span className="text-slate-300">{currentImg.email}</span></div>}
              {currentImg.ts && <div><span className="text-slate-500">Thời gian:</span> <span className="text-slate-300">{fmtDateTimeVN(currentImg.ts)}</span></div>}
              <div><span className="text-slate-500">Vị trí:</span> <span className="text-slate-300">{currentIndex + 1} / {session.images.length}</span></div>
              <div><span className="text-slate-500">URL:</span> <span className="text-indigo-400 font-mono text-[10px] break-all">{currentImg.url}</span></div>
            </div>
            {onDeleteImage && (
              <Button variant="danger" size="sm" className="w-full mt-4" onClick={() => onDeleteImage(session.id, currentImg.filename)}>
                <Trash2 size={13} /> Xóa ảnh này
              </Button>
            )}
          </div>
        )}
      </div>

      {/* Filmstrip */}
      <div className="relative z-10 bg-gradient-to-t from-black via-black/80 to-transparent p-3 md:p-4 flex justify-center">
        <div className="flex gap-1.5 overflow-x-auto pb-3 px-4 snap-x hide-scrollbar scroll-smooth w-full max-w-screen-xl" ref={filmstripRef} onClick={e => e.stopPropagation()}>
          {session.images.map((img, idx) => (
            <div
              key={img.filename}
              className={`strip-item shrink-0 relative w-20 h-14 rounded-md overflow-hidden cursor-pointer border-2 transition-all transform snap-center ${idx === currentIndex ? 'active border-indigo-400 scale-110 z-10 shadow-[0_0_12px_rgba(129,140,248,0.4)]' : 'border-transparent opacity-40 hover:opacity-80'}`}
              onClick={(e) => { e.stopPropagation(); setCurrentIndex(idx); }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={img.url} alt={img.filename} className="w-full h-full object-cover" />
              <div className="absolute inset-x-0 bottom-0 bg-black/70 text-[8px] text-white px-1 py-0.5 truncate text-center font-mono">{img.filename.replace(/^\d{2}_/, '').replace(/_/g, ' ').replace('.png', '')}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ─── Session Card (Grid mode) ───────────────────────────────────────────── */

function SessionGridCard({ session, selected, onToggleSelect, onOpen, onDelete }: {
  session: Session; selected: boolean; onToggleSelect: () => void;
  onOpen: (img: Screenshot) => void; onDelete: () => void;
}) {
  const email = useMemo(() => session.images.find(i => i.email)?.email || '', [session.images]);
  const label = email || session.id.replace(/^run_/, '').substring(0, 20);
  const latestImg = session.images[session.images.length - 1];

  return (
    <div className={`group flex flex-col bg-black/20 border rounded-xl overflow-hidden transition-all hover:-translate-y-0.5 ${selected ? 'border-indigo-500/40 ring-1 ring-indigo-500/20' : 'border-white/5 hover:border-white/10'}`}>
      {/* Thumbnail */}
      <div className="relative aspect-video bg-black/40 cursor-pointer overflow-hidden" onClick={() => latestImg && onOpen(latestImg)}>
        {latestImg ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={latestImg.url} alt="" className="w-full h-full object-cover opacity-70 group-hover:opacity-100 transition-opacity" />
            <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent" />
          </>
        ) : (
          <div className="w-full h-full flex items-center justify-center text-slate-600">
            <Camera size={24} />
          </div>
        )}

        {/* Checkbox */}
        <input
          type="checkbox"
          className="absolute top-2 left-2 w-4 h-4 rounded border-white/30 accent-indigo-500 cursor-pointer z-10"
          checked={selected}
          onChange={onToggleSelect}
          onClick={e => e.stopPropagation()}
        />

        {/* Image count badge */}
        <div className="absolute top-2 right-2 px-1.5 py-0.5 rounded-md bg-black/60 text-[10px] text-slate-300 font-bold backdrop-blur-sm border border-white/10">
          {session.imageCount} ảnh
        </div>
      </div>

      {/* Info */}
      <div className="p-3 flex-1 flex flex-col gap-1">
        <div className="text-[12.5px] font-semibold text-slate-200 truncate">{label}</div>
        <div className="text-[10.5px] text-slate-500">{fmtDateTimeVN(session.createdAt || session.mtime)}</div>
        <div className="flex items-center gap-1.5 mt-auto pt-1.5">
          <Button variant="ghost" size="sm" className="flex-1 text-[11px]" onClick={() => latestImg && onOpen(latestImg)}>
            <Eye size={12} /> Xem
          </Button>
          <Button variant="ghost" size="icon-sm" className="text-rose-400/60 hover:text-rose-400" onClick={onDelete}>
            <Trash2 size={12} />
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ─── Session Row (List mode) ────────────────────────────────────────────── */

function SessionListRow({ session, selected, onToggleSelect, onOpen, onDelete }: {
  session: Session; selected: boolean; onToggleSelect: () => void;
  onOpen: (img: Screenshot) => void; onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const email = useMemo(() => session.images.find(i => i.email)?.email || '', [session.images]);
  const label = email || session.id.replace(/^run_/, '').substring(0, 30);
  const latestImg = session.images[session.images.length - 1];

  return (
    <div className={`flex flex-col border-b border-white/5 transition-colors ${selected ? 'bg-indigo-500/5' : 'hover:bg-white/[0.02]'}`}>
      <div className="flex items-center gap-3 px-4 py-3 cursor-pointer select-none" onClick={() => setOpen(!open)}>
        <input type="checkbox" className="w-4 h-4 rounded border-white/20 accent-indigo-500 cursor-pointer shrink-0" checked={selected} onChange={onToggleSelect} onClick={e => e.stopPropagation()} />

        {/* Thumbnail */}
        {latestImg ? (
          <div className="w-16 h-10 rounded-md overflow-hidden shrink-0 border border-white/5" onClick={e => { e.stopPropagation(); onOpen(latestImg); }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={latestImg.url} alt="" className="w-full h-full object-cover" />
          </div>
        ) : (
          <div className="w-16 h-10 rounded-md bg-white/5 flex items-center justify-center shrink-0 text-slate-600"><Camera size={16} /></div>
        )}

        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-semibold text-slate-200 truncate">{label}</div>
          <div className="text-[11px] text-slate-500 flex items-center gap-2 mt-0.5">
            <span className="font-semibold text-slate-300">{session.imageCount}</span> ảnh
            <span className="opacity-40">·</span>
            {fmtDateTimeVN(session.createdAt || session.mtime)}
          </div>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <Button variant="ghost" size="icon-sm" className="text-rose-400/60 hover:text-rose-400 opacity-0 group-hover:opacity-100" onClick={e => { e.stopPropagation(); onDelete(); }}>
            <Trash2 size={13} />
          </Button>
          <ChevronRight size={14} className={`text-slate-500 transition-transform ${open ? 'rotate-90' : ''}`} />
        </div>
      </div>

      {open && (
        <div className="px-4 pb-3 bg-black/20 border-t border-white/5">
          <div className="grid grid-cols-4 sm:grid-cols-5 md:grid-cols-6 lg:grid-cols-8 gap-1.5 pt-2">
            {session.images.length === 0 ? (
              <div className="col-span-full py-4 text-center text-[12px] text-slate-500 italic">Không có ảnh</div>
            ) : session.images.map(img => (
              <div key={img.filename} className="group relative aspect-video bg-black/60 rounded-md overflow-hidden border border-white/5 hover:border-indigo-500/50 cursor-pointer" onClick={() => onOpen(img)}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={img.url} alt="" className="w-full h-full object-cover opacity-70 group-hover:opacity-100 transition-opacity" />
                <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 to-transparent px-1 py-0.5 text-[8px] text-slate-400 truncate font-mono">
                  {img.filename.replace(/^\d{2}_/, '').replace(/_/g, ' ').replace('.png', '')}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Main View ──────────────────────────────────────────────────────────── */

export function ScreenshotsView() {
  const { sessions, liveShots, refreshSessions, addToast } = useApp();
  const [loading, setLoading] = useState(false);
  const [activeViewer, setActiveViewer] = useState<{ session: Session; initialImage: Screenshot; live?: boolean } | null>(null);
  const [confirmModal, setConfirmModal] = useState<{ title: string; message: string; onConfirm: () => Promise<void> } | null>(null);

  // Filters & view
  const [query, setQuery] = useState('');
  const [sortBy, setSortBy] = useState<SortMode>('newest');
  const [onlyWithImages, setOnlyWithImages] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [selectedSessions, setSelectedSessions] = useState<Set<string>>(new Set());
  const [failedLive, setFailedLive] = useState<Set<string>>(new Set());
  const [hiddenLive, setHiddenLive] = useState<Set<string>>(new Set());

  // Keep viewer data fresh
  useEffect(() => {
    if (activeViewer?.session) {
      const updated = sessions.find(s => s.id === activeViewer.session.id);
      if (updated && updated.imageCount !== activeViewer.session.imageCount) {
        setActiveViewer(prev => prev ? { ...prev, session: updated } : null);
      }
    }
  }, [sessions]);

  const refresh = useCallback(async () => {
    setLoading(true);
    await refreshSessions();
    setLoading(false);
  }, [refreshSessions]);

  const deleteSession = useCallback((sessionId: string) => {
    setConfirmModal({
      title: 'Xóa Session',
      message: `Bạn có chắc muốn xóa toàn bộ screenshots của session "${sessionId}"? Thao tác này không thể hoàn tác.`,
      onConfirm: async () => {
        const r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          addToast(`Xóa thất bại: ${err.error || `HTTP ${r.status}`}`, 'error');
        } else {
          addToast('Đã xóa session', 'success');
          setSelectedSessions(prev => { const n = new Set(prev); n.delete(sessionId); return n; });
          await refreshSessions();
        }
        setConfirmModal(null);
      }
    });
  }, [addToast, refreshSessions]);

  const deleteImage = useCallback(async (sessionId: string, filename: string) => {
    setConfirmModal({
      title: 'Xóa Ảnh',
      message: `Bạn có chắc muốn xóa ảnh "${filename}"?`,
      onConfirm: async () => {
        const r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/images/${encodeURIComponent(filename)}`, { method: 'DELETE' });
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          addToast(`Xóa thất bại: ${err.error || `HTTP ${r.status}`}`, 'error');
        } else {
          addToast('Đã xóa ảnh', 'success');
          await refreshSessions();
        }
        setConfirmModal(null);
      }
    });
  }, [addToast, refreshSessions]);

  const activeLiveEntries = Object.entries(liveShots).filter(([id]) => !hiddenLive.has(id) && !failedLive.has(id));

  const filteredSessions = useMemo(() => sessions
    .map(s => {
      const q = query.trim().toLowerCase();
      if (!q) return s;
      const sessionMatch = s.id.toLowerCase().includes(q);
      if (sessionMatch) return s;
      const matchedImages = s.images.filter(img => img.filename.toLowerCase().includes(q) || (img.email || '').toLowerCase().includes(q));
      return { ...s, images: matchedImages, imageCount: matchedImages.length };
    })
    .filter(s => {
      if (onlyWithImages && s.imageCount <= 0) return false;
      if (!query.trim()) return true;
      return s.id.toLowerCase().includes(query.trim().toLowerCase()) || s.imageCount > 0;
    })
    .sort((a, b) => {
      if (sortBy === 'most') return b.imageCount - a.imageCount;
      const ta = new Date(a.mtime).getTime();
      const tb = new Date(b.mtime).getTime();
      return sortBy === 'oldest' ? ta - tb : tb - ta;
    }), [sessions, query, sortBy, onlyWithImages]);

  const totalImages = useMemo(() => filteredSessions.reduce((s, x) => s + x.imageCount, 0), [filteredSessions]);

  const toggleSessionSelect = (sessionId: string) => {
    setSelectedSessions(prev => { const n = new Set(prev); if (n.has(sessionId)) n.delete(sessionId); else n.add(sessionId); return n; });
  };

  const toggleSelectAll = () => {
    const allSelected = filteredSessions.length > 0 && filteredSessions.every(s => selectedSessions.has(s.id));
    setSelectedSessions(prev => {
      const n = new Set(prev);
      if (allSelected) filteredSessions.forEach(s => n.delete(s.id));
      else filteredSessions.forEach(s => n.add(s.id));
      return n;
    });
  };

  const deleteSelected = async () => {
    const ids = Array.from(selectedSessions);
    if (!ids.length) return;
    setConfirmModal({
      title: 'Xóa Nhiều Session',
      message: `Bạn có chắc muốn xóa ${ids.length} session screenshots đã chọn? Hành động này không thể hoàn tác.`,
      onConfirm: async () => {
        setLoading(true);
        let ok = 0;
        for (const id of ids) {
          try { const r = await fetch(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }); if (r.ok) ok += 1; } catch {}
        }
        setLoading(false);
        if (ok === 0) addToast('Xóa thất bại', 'error');
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
    <div className="absolute inset-0 overflow-y-auto px-6 pb-10 pt-2 flex flex-col gap-5 custom-scrollbar">
      {/* Stats */}
      <div className="grid grid-cols-4 gap-4 mt-2">
        <StatBox label="Sessions" value={sessions.length} icon={History} colorClass="text-indigo-400" bgClass="bg-indigo-500/10" borderClass="border-indigo-500/50" />
        <StatBox label="Tổng ảnh" value={totalImages} icon={Camera} colorClass="text-cyan-400" bgClass="bg-cyan-500/10" borderClass="border-cyan-500/50" />
        <StatBox label="Đang Live" value={activeLiveEntries.length} icon={AlertTriangle} colorClass="text-rose-400" bgClass="bg-rose-500/10" borderClass="border-rose-500/50" />
        <StatBox label="Đã chọn" value={selectedSessions.size} icon={CheckSquare} colorClass="text-amber-400" bgClass="bg-amber-500/10" borderClass="border-amber-500/50" />
      </div>

      {/* Live Channels */}
      {activeLiveEntries.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-rose-400">
              <span className="inline-block mr-1.5 w-2 h-2 rounded-full bg-rose-500 animate-pulse" />
              Bản xem trực tiếp ({activeLiveEntries.length})
            </CardTitle>
            <Button variant="ghost" size="sm" onClick={() => setHiddenLive(new Set(Object.keys(liveShots)))} className="ml-auto">
              Dọn dẹp tất cả
            </Button>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
              {activeLiveEntries.map(([sessionId, shot]) => {
                const sessionObj = sessions.find(s => s.id === sessionId);
                return (
                  <div key={sessionId} className="group relative rounded-xl overflow-hidden bg-black/40 border border-white/10 hover:border-indigo-500/50 transition-colors shadow-lg">
                    <div className="relative aspect-video flex items-center justify-center cursor-pointer overflow-hidden bg-black/50" onClick={() => sessionObj ? handleOpenViewer(sessionObj, shot, true) : addToast('Đang tải...', 'info')}>
                      <div className="absolute top-1.5 left-1.5 z-10 flex items-center gap-1 px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-400 border border-rose-500/30 text-[8px] font-bold tracking-wider backdrop-blur-md">
                        <span className="w-1 h-1 bg-rose-500 rounded-full animate-pulse" />LIVE
                      </div>
                      <button className="absolute top-1.5 right-1.5 z-10 w-5 h-5 rounded bg-black/60 hover:bg-black text-slate-300 hover:text-white flex items-center justify-center backdrop-blur-md opacity-0 group-hover:opacity-100 transition-all border border-white/10 text-[10px]" onClick={e => { e.stopPropagation(); setHiddenLive(prev => new Set([...prev, sessionId])); }}>✕</button>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={shot.url} alt="live" className="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity" onError={() => setFailedLive(prev => new Set([...prev, sessionId]))} />
                    </div>
                    <div className="p-2.5 bg-black/20 border-t border-white/5">
                      <div className="text-[11.5px] font-bold text-slate-200 truncate">{shot.email || sessionId.replace(/^run_/, '')}</div>
                      <div className="text-[9.5px] text-slate-500 mt-0.5 truncate">{shot.filename} · {fmtDateTimeVN(shot.ts || new Date().toISOString())}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Session History */}
      <Card className="flex-1 flex flex-col min-h-0">
        <CardHeader className="flex-wrap gap-y-3">
          <CardTitle>
            <History size={15} className="text-indigo-400" />
            Lịch sử Sessions
            <span className="ml-2 px-2 py-0.5 rounded-full text-[10px] bg-white/10 text-slate-300 font-bold">{filteredSessions.length}/{sessions.length}</span>
          </CardTitle>
          <div className="flex gap-2 items-center ml-auto flex-wrap">
            {/* Search */}
            <div className="relative flex items-center">
              <Search size={13} className="absolute left-2.5 text-slate-500 pointer-events-none" />
              <Input className="pl-7 w-[180px] h-8 text-xs bg-white/5 border-white/10" placeholder="Tìm session/email..." value={query} onChange={e => setQuery(e.target.value)} />
              {query && <button onClick={() => setQuery('')} className="absolute right-2 text-slate-500 hover:text-slate-300"><X size={11} /></button>}
            </div>

            {/* Sort */}
            <select className="h-8 rounded-lg bg-black/40 border border-white/10 text-[12px] text-slate-300 px-2.5 pr-6 outline-none focus:border-indigo-500/50" value={sortBy} onChange={e => setSortBy(e.target.value as SortMode)}>
              <option value="newest">Mới nhất</option>
              <option value="oldest">Cũ nhất</option>
              <option value="most">Nhiều ảnh nhất</option>
            </select>

            {/* Filter: has images */}
            <label className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-white/5 bg-white/5 cursor-pointer hover:bg-white/10 transition-colors text-[11px] font-medium text-slate-300 select-none">
              <input type="checkbox" className="w-3.5 h-3.5 rounded border-white/20 accent-indigo-500 cursor-pointer" checked={onlyWithImages} onChange={e => setOnlyWithImages(e.target.checked)} />
              Có ảnh
            </label>

            {/* View mode toggle */}
            <div className="flex rounded-lg border border-white/10 overflow-hidden">
              <button className={`w-8 h-8 flex items-center justify-center transition-colors ${viewMode === 'grid' ? 'bg-indigo-500/20 text-indigo-400' : 'bg-white/5 text-slate-400 hover:text-slate-200'}`} onClick={() => setViewMode('grid')} title="Grid">
                <LayoutGrid size={14} />
              </button>
              <button className={`w-8 h-8 flex items-center justify-center transition-colors ${viewMode === 'list' ? 'bg-indigo-500/20 text-indigo-400' : 'bg-white/5 text-slate-400 hover:text-slate-200'}`} onClick={() => setViewMode('list')} title="List">
                <List size={14} />
              </button>
            </div>

            {/* Select all */}
            <Button variant="ghost" size="sm" onClick={toggleSelectAll} disabled={filteredSessions.length === 0} className="border border-white/5 bg-white/5">
              {filteredSessions.length > 0 && filteredSessions.every(s => selectedSessions.has(s.id)) ? <><Square size={13} className="mr-1" />Bỏ chọn</> : <><CheckSquare size={13} className="mr-1" />Chọn hết</>}
            </Button>

            {/* Bulk delete */}
            {selectedSessions.size > 0 && (
              <Button variant="danger" size="sm" onClick={deleteSelected}>
                <Trash2 size={13} /> Xóa ({selectedSessions.size})
              </Button>
            )}

            {/* Refresh */}
            <Button variant="secondary" size="icon-sm" onClick={refresh} disabled={loading} className="border-white/10 bg-white/5">
              <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
            </Button>
          </div>
        </CardHeader>

        <div className="flex-1 overflow-y-auto">
          {filteredSessions.length === 0 ? (
            <div className="py-20 flex flex-col items-center gap-3 text-center">
              <div className="text-4xl opacity-20">�</div>
              <div className="text-slate-300 font-medium">{sessions.length === 0 ? 'Chưa có screenshots' : 'Không có session phù hợp bộ lọc'}</div>
              <div className="text-[12px] text-slate-500">Screenshots sẽ được lưu tự động khi Worker chạy</div>
            </div>
          ) : viewMode === 'grid' ? (
            <div className="p-4 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
              {filteredSessions.map(s => (
                <SessionGridCard
                  key={s.id}
                  session={s}
                  selected={selectedSessions.has(s.id)}
                  onToggleSelect={() => toggleSessionSelect(s.id)}
                  onOpen={img => handleOpenViewer(s, img)}
                  onDelete={() => deleteSession(s.id)}
                />
              ))}
            </div>
          ) : (
            <div>
              {filteredSessions.map(s => (
                <SessionListRow
                  key={s.id}
                  session={s}
                  selected={selectedSessions.has(s.id)}
                  onToggleSelect={() => toggleSessionSelect(s.id)}
                  onOpen={img => handleOpenViewer(s, img)}
                  onDelete={() => deleteSession(s.id)}
                />
              ))}
            </div>
          )}
        </div>
      </Card>

      {/* Viewer */}
      {activeViewer && (
        <AdvancedViewer
          session={activeViewer.session}
          initialImage={activeViewer.initialImage}
          liveMode={activeViewer.live}
          onClose={() => setActiveViewer(null)}
          onDeleteImage={deleteImage}
        />
      )}

      {/* Confirm Modal */}
      {confirmModal && <ConfirmModal title={confirmModal.title} message={confirmModal.message} onConfirm={confirmModal.onConfirm} onCancel={() => setConfirmModal(null)} />}
    </div>
  );
}
