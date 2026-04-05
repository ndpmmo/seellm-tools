'use client';
import React, { useEffect, useState } from 'react';
import { useApp, AppConfig } from '../AppContext';
import { Spinner } from '../Views';

export function SettingsView() {
  const { config, saveConfig } = useApp();
  const [f, setF] = useState<AppConfig>({
    camofoxPath: '', camofoxPort: 3000,
    camofoxApi: 'http://localhost:9377',
    gatewayUrl: 'http://localhost:20128',
    workerAuthToken: '', pollIntervalMs: 15000, maxThreads: 3,
  });
  const [saving, setSaving]       = useState(false);
  const [showToken, setShowToken] = useState(false);

  useEffect(() => { if (config) setF(config); }, [config]);

  const set = (k: keyof AppConfig, v: any) => setF(p => ({ ...p, [k]: v }));
  const save = async () => { setSaving(true); await saveConfig(f); setSaving(false); };

  const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div className="card">
      <div className="card-head"><span className="card-title">{title}</span></div>
      <div className="card-body"><div className="settings-grid">{children}</div></div>
    </div>
  );

  const Field = ({ label, hint, full, children }: { label: string; hint?: string; full?: boolean; children: React.ReactNode }) => (
    <div className={`fg ${full ? 'full' : ''}`}>
      <label>{label}</label>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </div>
  );

  return (
    <div className="content">
      <Section title="🦊 Camofox Browser Server">
        <Field label="Đường dẫn cài đặt" hint="Thư mục gốc chứa server.js của camofox-browser" full>
          <input className="inp mono" value={f.camofoxPath}
            onChange={e => set('camofoxPath', e.target.value)}
            placeholder="/Users/.../camofox-browser" />
        </Field>
        <Field label="Port chạy Camofox" hint="Mặc định: 3000 (hoặc 3005 nếu bị xung đột)">
          <input className="inp" type="number" value={f.camofoxPort}
            onChange={e => set('camofoxPort', Number(e.target.value))} />
        </Field>
        <Field label="Camofox API URL" hint="URL API nội bộ (thường port 9377)">
          <input className="inp mono" value={f.camofoxApi}
            onChange={e => set('camofoxApi', e.target.value)}
            placeholder="http://localhost:9377" />
        </Field>
      </Section>

      <Section title="🌐 SeeLLM Gateway">
        <Field label="Gateway URL">
          <input className="inp mono" value={f.gatewayUrl}
            onChange={e => set('gatewayUrl', e.target.value)}
            placeholder="http://localhost:20128" />
        </Field>
        <Field label="Worker Auth Token">
          <div style={{ display:'flex', gap:6 }}>
            <input className="inp mono" style={{ flex:1 }}
              type={showToken ? 'text' : 'password'}
              value={f.workerAuthToken}
              onChange={e => set('workerAuthToken', e.target.value)}
              placeholder="Nhập token xác thực..." />
            <button className="btn btn-ghost btn-sm" onClick={() => setShowToken(!showToken)}>
              {showToken ? '🙈' : '👁'}
            </button>
          </div>
        </Field>
      </Section>

      <Section title="⚙️ Worker Config">
        <Field label="Poll Interval (ms)" hint="Tần suất kiểm tra task mới (ms). Mặc định: 15000">
          <input className="inp" type="number" value={f.pollIntervalMs}
            onChange={e => set('pollIntervalMs', Number(e.target.value))} />
        </Field>
        <Field label="Max Threads" hint="Tối đa bao nhiêu tài khoản xử lý song song">
          <input className="inp" type="number" min={1} max={10} value={f.maxThreads}
            onChange={e => set('maxThreads', Number(e.target.value))} />
        </Field>
      </Section>

      {/* Data paths info */}
      <div className="card">
        <div className="card-head"><span className="card-title">📁 Thư mục dữ liệu</span></div>
        <div className="card-body" style={{ display:'flex', flexDirection:'column', gap:8 }}>
          {[
            ['data/screenshots/', '📸 Ảnh chụp màn hình từ các phiên login'],
            ['data/logs/',        '📄 File log từ mỗi lần chạy process'],
            ['scripts/',          '📜 Automation scripts tích hợp sẵn'],
          ].map(([path, desc]) => (
            <div key={path} style={{ display:'flex', alignItems:'center', gap:12, padding:'9px 12px', background:'var(--glass)', borderRadius:8, border:'1px solid var(--border)' }}>
              <code style={{ fontSize:12, color:'var(--cyan)', fontFamily:'JetBrains Mono,monospace', minWidth:190 }}>{path}</code>
              <span style={{ fontSize:12, color:'var(--text-3)' }}>{desc}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Save */}
      <div style={{ display:'flex', gap:10 }}>
        <button className="btn btn-primary btn-lg" onClick={save} disabled={saving}>
          {saving ? <><Spinner/> Đang lưu...</> : '💾 Lưu cài đặt'}
        </button>
        <button className="btn btn-ghost btn-lg" onClick={() => config && setF(config)}>
          ↩ Hoàn tác
        </button>
      </div>
    </div>
  );
}
