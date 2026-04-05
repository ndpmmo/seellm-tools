'use client';
import React, { useEffect, useState } from 'react';
import { useApp } from '../AppContext';
import { Spinner } from '../Views';

const META: Record<string, { ico: string; desc: string; arg?: string }> = {
  'auto-login-worker.js': { ico:'🤖', desc:'Worker chính: poll task từ Gateway, tự động OAuth login qua Camofox' },
  'get-session-token.js': { ico:'🔑', desc:'Lấy session token từ cookies Camofox sau khi login xong' },
  'ping-servers.js':      { ico:'📡', desc:'Kiểm tra kết nối Camofox và SeeLLM Gateway' },
  'test-camofox.js':      { ico:'🦊', desc:'Test server Camofox: mở tab, snapshot, screenshot' },
  'test-proxy.js':        { ico:'🔀', desc:'Test proxy qua Camofox và kiểm tra IP thực', arg:'http://user:pass@host:port' },
  'gen-2fa.js':           { ico:'🔐', desc:'Tạo mã TOTP 2FA từ Base32 secret key', arg:'SECRET_KEY_BASE32' },
};

export function ScriptsView() {
  const { runScript, getScripts, setView, setSelectedLog } = useApp();
  const [scripts,  setScripts]  = useState<string[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [running,  setRunning]  = useState<Record<string,boolean>>({});
  const [args,     setArgs]     = useState<Record<string,string>>({});

  useEffect(() => {
    getScripts().then(s => { setScripts(s); setLoading(false); }).catch(() => setLoading(false));
  }, []);

  const run = async (name: string) => {
    setRunning(p => ({ ...p, [name]: true }));
    const a = args[name]?.trim();
    const id = await runScript(name, a ? [a] : []);
    setRunning(p => ({ ...p, [name]: false }));
    if (id) { setTimeout(() => { setSelectedLog(id); setView('terminal'); }, 600); }
  };

  return (
    <div className="content">
      <div className="card">
        <div className="card-head">
          <span className="card-title">📜 Scripts ({scripts.length})</span>
          <div style={{ display:'flex', gap:8, alignItems:'center' }}>
            <span style={{ fontSize:11, fontFamily:'JetBrains Mono,monospace', color:'var(--text-3)' }}>seellm-tools/scripts/</span>
            <button className="btn btn-ghost btn-sm" onClick={() => { setLoading(true); getScripts().then(s => { setScripts(s); setLoading(false); }); }}>↻</button>
          </div>
        </div>
        <div className="card-body">
          {loading ? (
            <div style={{ display:'flex', gap:10, color:'var(--text-3)' }}><Spinner/> Đang tải...</div>
          ) : (
            <div className="script-list">
              {scripts.map(name => {
                const m = META[name] || { ico:'📜', desc:'' };
                return (
                  <div key={name} className="scr-item">
                    <span className="scr-ico">{m.ico}</span>
                    <div className="scr-info">
                      <div className="scr-name">{name}</div>
                      {m.desc && <div className="scr-desc">{m.desc}</div>}
                      {m.arg && (
                        <input
                          className="inp mono"
                          style={{ marginTop:7, padding:'4px 8px', fontSize:11 }}
                          placeholder={m.arg}
                          value={args[name]||''}
                          onChange={e => setArgs(p => ({ ...p, [name]: e.target.value }))}
                        />
                      )}
                    </div>
                    <div className="scr-acts">
                      <button className="btn btn-primary btn-sm" onClick={() => run(name)} disabled={running[name]}>
                        {running[name] ? <Spinner/> : '▶'} Run
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Flow guide */}
      <div className="card">
        <div className="card-head"><span className="card-title">📋 Quy trình đề xuất</span></div>
        <div className="card-body" style={{ display:'flex', flexDirection:'column', gap:8 }}>
          {[
            ['1','📡','Chạy ping-servers để kiểm tra kết nối'],
            ['2','🦊','Khởi động Camofox (sidebar hoặc Dashboard)'],
            ['3','🦊','Chạy test-camofox để verify Camofox OK'],
            ['4','🤖','Khởi động Worker — sẽ tự poll task từ Gateway'],
            ['5','📸','Theo dõi Screenshots để thấy browser đang làm gì'],
            ['6','🔑','Sau khi xong, chạy get-session-token để lấy token'],
          ].map(([n,ico,txt]) => (
            <div key={n} style={{ display:'flex', alignItems:'center', gap:10, padding:'8px 12px', background:'var(--glass)', borderRadius:8, border:'1px solid var(--border)' }}>
              <div style={{ width:22, height:22, background:'var(--indigo)', borderRadius:'50%', display:'flex', alignItems:'center', justifyContent:'center', fontSize:11, fontWeight:700, flexShrink:0 }}>{n}</div>
              <span style={{ fontSize:13, color:'var(--text-2)' }}>{ico} {txt}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
