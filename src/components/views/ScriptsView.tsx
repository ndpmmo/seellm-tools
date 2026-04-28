'use client';
import React, { useEffect, useState } from 'react';
import { useApp } from '../AppContext';
import { Play, RefreshCw, Terminal, FileCode } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent, Button, Input } from '../ui';

const META: Record<string, { ico: string; desc: string; arg?: string }> = {
  'auto-worker.js': { ico: '🤖', desc: 'Unified worker: chạy cả login + connect queue trong một process duy nhất', arg: 'both | login-only | connect-only' },
  'get-session-token.js': { ico: '🔑', desc: 'Lấy session token từ cookies Camofox sau khi login xong' },
  'ping-servers.js': { ico: '📡', desc: 'Kiểm tra kết nối Camofox và SeeLLM Gateway' },
  'test-camofox.js': { ico: '🦊', desc: 'Test server Camofox: mở tab, snapshot, screenshot' },
  'test-proxy.js': { ico: '🔀', desc: 'Test proxy qua Camofox và kiểm tra IP thực', arg: 'http://user:pass@host:port' },
  'gen-2fa.js': { ico: '🔐', desc: 'Tạo mã TOTP 2FA từ Base32 secret key', arg: 'SECRET_KEY_BASE32' },
};

const FLOW = [
  ['1', '📡', 'Chạy ping-servers để kiểm tra kết nối'],
  ['2', '🦊', 'Khởi động Camofox (sidebar hoặc Dashboard)'],
  ['3', '🦊', 'Chạy test-camofox để verify Camofox OK'],
  ['4', '🤖', 'Khởi động Worker — sẽ tự poll task từ Gateway'],
  ['5', '📸', 'Theo dõi Screenshots để thấy browser đang làm gì'],
  ['6', '🔑', 'Sau khi xong, chạy get-session-token để lấy token'],
];

export function ScriptsView() {
  const { runScript, getScripts, setView, setSelectedLog } = useApp();
  const [scripts, setScripts] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState<Record<string, boolean>>({});
  const [args, setArgs] = useState<Record<string, string>>({});

  const load = () => {
    setLoading(true);
    getScripts().then(s => { setScripts(s); setLoading(false); }).catch(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const run = async (name: string) => {
    setRunning(p => ({ ...p, [name]: true }));
    const a = args[name]?.trim();
    const id = await runScript(name, a ? [a] : []);
    setRunning(p => ({ ...p, [name]: false }));
    if (id) { setTimeout(() => { setSelectedLog(id); setView('terminal'); }, 600); }
  };

  return (
    <div className="absolute inset-0 overflow-y-auto px-6 pb-10 pt-2 flex flex-col gap-6 custom-scrollbar">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
        {/* Scripts list */}
        <Card>
          <CardHeader>
            <CardTitle>
              <FileCode size={15} className="text-indigo-400" />
              Scripts ({scripts.length})
            </CardTitle>
            <div className="flex items-center gap-2 ml-auto">
              <span className="text-[11px] font-mono text-slate-500">seellm-tools/scripts/</span>
              <Button variant="ghost" size="icon-sm" onClick={load} disabled={loading}>
                <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {loading ? (
              <div className="py-12 flex items-center justify-center gap-3 text-slate-500">
                <span className="w-4 h-4 border-2 border-white/10 border-t-indigo-500 rounded-full animate-spin" />
                Đang tải danh sách scripts...
              </div>
            ) : scripts.length === 0 ? (
              <div className="py-12 text-center text-slate-500 text-sm">Không tìm thấy scripts nào</div>
            ) : (
              <div className="divide-y divide-white/5">
                {scripts.map(name => {
                  const m = META[name] || { ico: '📜', desc: '' };
                  return (
                    <div key={name} className="flex items-center gap-4 px-5 py-4 hover:bg-white/[0.02] transition-colors group">
                      <div className="text-xl shrink-0 select-none">{m.ico}</div>
                      <div className="flex-1 min-w-0">
                        <div className="font-mono text-[13px] font-semibold text-slate-200">{name}</div>
                        {m.desc && <div className="text-[11.5px] text-slate-500 mt-0.5">{m.desc}</div>}
                        {m.arg && (
                          <Input
                            className="mt-2 h-7 text-[11px] font-mono max-w-xs"
                            placeholder={m.arg}
                            value={args[name] || ''}
                            onChange={e => setArgs(p => ({ ...p, [name]: e.target.value }))}
                          />
                        )}
                      </div>
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => run(name)}
                        disabled={running[name]}
                        className="shrink-0 opacity-70 group-hover:opacity-100 transition-opacity"
                      >
                        {running[name]
                          ? <span className="w-3 h-3 border-2 border-white/20 border-t-white rounded-full animate-spin" />
                          : <Play size={12} />
                        }
                        Run
                      </Button>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Flow guide */}
        <Card>
          <CardHeader>
            <CardTitle>
              <Terminal size={14} className="text-cyan-400" />
              Quy trình đề xuất
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2.5">
            {FLOW.map(([n, ico, txt]) => (
              <div key={n} className="flex items-center gap-3 p-3 bg-white/[0.03] rounded-lg border border-white/5">
                <div className="w-6 h-6 bg-indigo-600 rounded-full flex items-center justify-center text-[11px] font-bold text-white shrink-0">{n}</div>
                <span className="text-[13px] text-slate-300">{ico} {txt}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
