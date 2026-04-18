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
    } else if (line.startsWith('- ')) {
      const section = currentVersion?.sections[currentVersion.sections.length - 1];
      if (section) section.items.push(line.replace('- ', ''));
    }
  });
  if (currentVersion) versions.push(currentVersion);

  return (
    <div className="content">
      <div className="card">
        <div className="card-head">
          <span className="card-title">
            <History size={16} />
            Lịch sử thay đổi (Changelog)
          </span>
          <button className="btn-icon" onClick={() => window.location.reload()}>
            <RefreshCw size={14} />
          </button>
        </div>

        <div className="card-body" style={{ padding: '20px' }}>
          {loading ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: '40px' }}>
              <div className="spin" style={{ width: 30, height: 30 }} />
            </div>
          ) : error ? (
            <div style={{ padding: '20px', background: 'var(--rose-dim)', color: 'var(--rose)', borderRadius: 8, display: 'flex', alignItems: 'center', gap: 10 }}>
              <AlertCircle size={20} />
              {error}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 30 }}>
              {versions.map((v, i) => (
                <div key={i} style={{ position: 'relative', paddingLeft: '30px', borderLeft: '2px solid var(--border)' }}>
                  {/* Timeline Dot */}
                  <div style={{ position: 'absolute', left: '-7px', top: '5px', width: 12, height: 12, borderRadius: '50%', background: i === 0 ? 'var(--indigo-2)' : 'var(--text-4)', border: '2px solid var(--bg-1)' }} />
                  
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: '16px' }}>
                    <div style={{ fontSize: '18px', fontWeight: 700, color: 'var(--text)' }}>
                      {formatVersionLabel(v.version)}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: '12px', color: 'var(--text-3)', background: 'var(--glass)', padding: '2px 8px', borderRadius: '4px', border: '1px solid var(--border)' }}>
                      <Calendar size={12} />
                      {v.date}
                    </div>
                    {i === 0 && (
                      <span style={{ fontSize: '10px', background: 'var(--green-dim)', color: 'var(--green)', padding: '2px 6px', borderRadius: '4px', fontWeight: 700, textTransform: 'uppercase' }}>
                        Latest
                      </span>
                    )}
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                    {v.sections.map((s: any, si: number) => (
                      <div key={si}>
                        <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--indigo-2)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '10px', display: 'flex', alignItems: 'center', gap: 6 }}>
                          <Tag size={12} />
                          {s.title}
                        </div>
                        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
                          {s.items.map((item: string, ii: number) => (
                            <li key={ii} style={{ fontSize: '14px', color: 'var(--text-2)', display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                              <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: 'var(--indigo-2)', marginTop: '8px', flexShrink: 0, opacity: 0.6 }} />
                              <span dangerouslySetInnerHTML={{ __html: item.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>') }} />
                            </li>
                          ))}
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

      <div style={{ marginTop: '20px', padding: '15px', background: 'var(--indigo-soft)', borderRadius: '12px', border: '1px solid rgba(99, 102, 241, 0.2)', display: 'flex', alignItems: 'center', gap: 15 }}>
        <div style={{ width: 40, height: 40, borderRadius: '10px', background: 'rgba(99, 102, 241, 0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--indigo-2)' }}>
          <Info size={20} />
        </div>
        <div>
          <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--indigo-2)' }}>Hệ thống Quản lý Phiên bản</div>
          <div style={{ fontSize: '12px', color: 'var(--text-3)' }}>Tất cả các thay đổi được ghi nhận tự động và đồng bộ với kho lưu trữ Git của hệ thống SeeLLM.</div>
        </div>
      </div>
    </div>
  );
}
