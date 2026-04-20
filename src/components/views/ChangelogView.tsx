'use client';
import React, { useEffect, useState } from 'react';
import { History, RefreshCw, AlertCircle, Calendar, Hash, Tag, Info } from 'lucide-react';

export function ChangelogView() {
  const [content, setContent] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadChangelog() {
      try {
        const res = await fetch('/api/changelog');
        const data = await res.json();
        if (data.ok) {
          setContent(data.content);
        } else {
          // Fallback if file missing
          const text = `# SeeLLM Tools Changelog\n\n## [0.0.5] - 2026-04-06\n### Added\n- **Cloud Vault Sync**: Real-time cloud synchronization.`;
          setContent(text);
        }
      } catch (e) {
        setError('Không thể tải file CHANGELOG.md');
      }
      setLoading(false);
    }
    loadChangelog();
  }, []);

  const formatVersionLabel = (version: string) => {
    const normalized = String(version || '').trim();
    if (!normalized) return 'Unknown';
    if (normalized.toLowerCase() === 'unreleased') return 'Unreleased';
    return `v${normalized}`;
  };

  // Simple parser for human-friendly display
  const lines = content.split('\n');
  const versions: any[] = [];
  let currentVersion: any = null;

  lines.forEach(line => {
    const trimmed = line.trim();
    if (line.startsWith('## [')) {
      if (currentVersion) versions.push(currentVersion);
      const match = line.match(/\[(.*?)\] - (.*)/);
      currentVersion = {
        version: match ? match[1] : 'Unknown',
        date: match ? match[2] : '',
        sections: []
      };
    } else if (line.startsWith('### ')) {
      currentVersion?.sections.push({ title: line.replace('### ', ''), items: [] });
    } else if (trimmed.startsWith('- ')) {
      const section = currentVersion?.sections[currentVersion.sections.length - 1];
      if (section) {
        // Detect indentation to mark as sub-item
        const isSubItem = line.startsWith('  ') || line.startsWith('    ') || line.startsWith('\t');
        section.items.push({ 
          text: trimmed.replace('- ', ''), 
          isSubItem 
        });
      }
    }
  });
  if (currentVersion) versions.push(currentVersion);

  return (
    <div className="flex-1 overflow-y-auto px-6 pb-10 flex flex-col gap-5 pt-2">
      <div className="bg-[#0d111c]/70 border border-white/5 rounded-xl shadow-lg overflow-hidden">
        <div className="px-5 py-3.5 border-b border-white/5 flex items-center justify-between gap-3">
          <h3 className="text-[13.5px] font-semibold text-slate-100 flex items-center gap-2">
            <History size={15} className="text-indigo-400" />
            Lịch sử thay đổi (Changelog)
          </h3>
          <button className="w-7 h-7 rounded-md bg-white/5 border border-white/10 flex items-center justify-center text-slate-400 hover:bg-white/10 hover:text-slate-200 transition-colors" onClick={() => window.location.reload()}>
            <RefreshCw size={13} />
          </button>
        </div>

        <div className="p-6">
          {loading ? (
            <div className="flex justify-center py-10">
              <span className="w-7 h-7 border-2 border-white/10 border-t-indigo-500 rounded-full animate-spin" />
            </div>
          ) : error ? (
            <div className="p-4 bg-rose-500/10 text-rose-400 border border-rose-500/30 rounded-xl flex items-center gap-3">
              <AlertCircle size={18} /> {error}
            </div>
          ) : (
            <div className="flex flex-col gap-8">
              {versions.map((v, i) => (
                <div key={i} className="relative pl-8 border-l-2 border-white/10">
                  <div className={`absolute left-[-7px] top-1.5 w-3 h-3 rounded-full border-2 border-[#0d111c] ${i === 0 ? 'bg-indigo-400' : 'bg-slate-600'}`} />
                  <div className="flex items-center gap-3 mb-4">
                    <span className="text-[17px] font-bold text-slate-100">{formatVersionLabel(v.version)}</span>
                    <span className="flex items-center gap-1.5 text-[11.5px] text-slate-500 bg-white/5 border border-white/10 px-2 py-0.5 rounded-md">
                      <Calendar size={11} /> {v.date}
                    </span>
                    {i === 0 && <span className="text-[10px] bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 px-2 py-0.5 rounded-md font-bold uppercase tracking-wide">Latest</span>}
                  </div>
                  <div className="flex flex-col gap-5">
                    {v.sections.map((s: any, si: number) => (
                      <div key={si}>
                        <div className="text-[11.5px] font-bold text-indigo-400 uppercase tracking-wider mb-2.5 flex items-center gap-1.5">
                          <Tag size={11} /> {s.title}
                        </div>
                        <ul className="flex flex-col gap-2">
                          {s.items.map((item: any, ii: number) => {
                            const isSub = typeof item === 'object' ? item.isSubItem : false;
                            const text = typeof item === 'object' ? item.text : item;
                            return (
                              <li key={ii} className={`flex items-start gap-2.5 ${isSub ? 'ml-5 text-[12px] text-slate-500' : 'text-[13px] text-slate-300'}`}>
                                <div className={`w-1.5 h-1.5 rounded-full mt-[6px] shrink-0 ${isSub ? 'bg-slate-600' : 'bg-indigo-400'}`} />
                                <span dangerouslySetInnerHTML={{ __html: text.replace(/\*\*(.*?)\*\*/g, '<strong class="text-slate-100">$1</strong>') }} />
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="p-4 bg-indigo-500/10 border border-indigo-500/20 rounded-xl flex items-center gap-4">
        <div className="w-10 h-10 rounded-lg bg-indigo-500/20 flex items-center justify-center text-indigo-400 shrink-0">
          <Info size={18} />
        </div>
        <div>
          <div className="text-[13.5px] font-semibold text-indigo-300">Hệ thống Quản lý Phiên bản</div>
          <div className="text-[12px] text-slate-500 mt-0.5">Tất cả các thay đổi được ghi nhận tự động và đồng bộ với kho lưu trữ Git của hệ thống SeeLLM.</div>
        </div>
      </div>
    </div>
  );
}
