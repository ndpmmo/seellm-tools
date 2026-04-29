'use client';
import React, { useEffect, useState } from 'react';
import { useApp, AppConfig } from '../AppContext';
import { Card, CardHeader, CardTitle, CardContent, Button, Input } from '../ui';
import { Settings, Globe, Cpu, FolderOpen, Save, RotateCcw, Eye, EyeOff } from 'lucide-react';

const DATA_DIRS = [
  ['data/screenshots/', '📸 Ảnh chụp màn hình từ các phiên login'],
  ['data/logs/', '📄 File log từ mỗi lần chạy process'],
  ['scripts/', '📜 Automation scripts tích hợp sẵn'],
];

function Section({ title, icon: Icon, children }: { title: string; icon: React.ElementType; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle><Icon size={14} className="text-indigo-400" />{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-4">
          {children}
        </div>
      </CardContent>
    </Card>
  );
}

function Field({ label, hint, full, children }: { label: string; hint?: string; full?: boolean; children: React.ReactNode }) {
  return (
    <div className={`flex flex-col gap-1.5 ${full ? 'col-span-2' : ''}`}>
      <label className="text-[11.5px] font-semibold text-slate-400">{label}</label>
      {children}
      {hint && <span className="text-[10.5px] text-slate-500 leading-relaxed">{hint}</span>}
    </div>
  );
}

export function SettingsView() {
  const { config, saveConfig, addToast } = useApp();
  const [f, setF] = useState<AppConfig>({
    camofoxPath: '', camofoxNodePath: '/usr/local/bin/node', camofoxPort: 3000,
    camofoxApi: 'http://localhost:9377',
    gatewayUrl: 'http://localhost:20128',
    workerAuthToken: '', pollIntervalMs: 15000, maxThreads: 3,
    forceEnLocale: true,
    workerMode: 'auto',
  });
  const [saving, setSaving] = useState(false);
  const [showToken, setShowToken] = useState(false);

  useEffect(() => { if (config) setF(config); }, [config]);

  const set = (k: keyof AppConfig, v: any) => setF(p => ({ ...p, [k]: v }));
  const save = async () => { setSaving(true); await saveConfig(f); setSaving(false); };

  return (
    <div className="absolute inset-0 overflow-y-auto px-6 pb-10 pt-2 flex flex-col gap-6 custom-scrollbar">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Section title="Camofox Browser Server" icon={Settings}>
          <Field label="Đường dẫn cài đặt" hint="Thư mục gốc chứa server.js của camofox-browser" full>
            <Input mono className="font-mono text-xs" value={f.camofoxPath} onChange={e => set('camofoxPath', e.target.value)} placeholder="/Users/.../camofox-browser" />
          </Field>
          <Field label="Node chạy Camofox" hint="Đặt cố định Node tương thích để tránh lệch ABI native module" full>
            <Input mono className="font-mono text-xs" value={f.camofoxNodePath || ''} onChange={e => set('camofoxNodePath', e.target.value)} placeholder="/usr/local/bin/node" />
          </Field>
          <Field label="Port chạy Camofox" hint="Mặc định: 3000 (hoặc 3005 nếu bị xung đột)">
            <Input type="number" value={f.camofoxPort} onChange={e => set('camofoxPort', Number(e.target.value))} />
          </Field>
          <Field label="Camofox API URL" hint="URL API nội bộ (thường port 9377)">
            <Input mono className="font-mono text-xs" value={f.camofoxApi} onChange={e => set('camofoxApi', e.target.value)} placeholder="http://localhost:9377" />
          </Field>
        </Section>

        <Section title="SeeLLM Gateway" icon={Globe}>
          <Field label="Gateway URL">
            <Input mono className="font-mono text-xs" value={f.gatewayUrl} onChange={e => set('gatewayUrl', e.target.value)} placeholder="http://localhost:20128" />
          </Field>
          <Field label="Worker Auth Token">
            <div className="relative flex items-center">
              <Input
                type={showToken ? 'text' : 'password'}
                mono className="font-mono text-xs pr-9"
                value={f.workerAuthToken}
                onChange={e => set('workerAuthToken', e.target.value)}
                placeholder="Nhập token xác thực..."
              />
              <button className="absolute right-2.5 text-slate-500 hover:text-slate-300 transition-colors" onClick={() => setShowToken(!showToken)}>
                {showToken ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </Field>
        </Section>

        <Section title="Worker Config" icon={Cpu}>
          <Field label="Poll Interval (ms)" hint="Tần suất kiểm tra task mới. Mặc định: 15000ms">
            <Input type="number" value={f.pollIntervalMs} onChange={e => set('pollIntervalMs', Number(e.target.value))} />
          </Field>
          <Field label="Max Threads" hint="Tối đa bao nhiêu tài khoản xử lý song song">
            <Input type="number" min={1} max={10} value={f.maxThreads} onChange={e => set('maxThreads', Number(e.target.value))} />
          </Field>
          <Field label="Worker Mode" hint="Chế độ chạy worker: auto (tự động), direct-login (nhanh), pkce-login (OAuth)">
            <select
              className="w-full px-3 py-2 rounded-lg border border-white/10 bg-white/5 text-slate-200 text-xs font-mono focus:outline-none focus:border-indigo-500/50"
              value={f.workerMode || 'auto'}
              onChange={e => set('workerMode', e.target.value)}
            >
              <option value="auto">Auto (tự động chọn)</option>
              <option value="direct-login">Direct Login (nhanh hơn)</option>
              <option value="pkce-login">PKCE Login (OAuth)</option>
            </select>
          </Field>
          <Field
            label="Ép Locale English (en-US)"
            hint="Khi BẬT: Camofox dùng locale en-US + Accept-Language header bất kể proxy GeoIP, ChatGPT/Google sẽ render UI tiếng Anh thay vì ngôn ngữ địa phương (Đức, Phần Lan, Pháp...). Yêu cầu khởi động lại worker."
            full
          >
            <button
              type="button"
              onClick={() => set('forceEnLocale', !f.forceEnLocale)}
              className={`relative inline-flex items-center gap-2 px-3 py-2 rounded-lg border text-[12px] font-semibold transition-all ${
                f.forceEnLocale
                  ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/15'
                  : 'bg-white/5 border-white/10 text-slate-400 hover:bg-white/10'
              }`}
            >
              <span className={`w-9 h-5 rounded-full transition-colors ${f.forceEnLocale ? 'bg-emerald-500' : 'bg-slate-600'} relative`}>
                <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${f.forceEnLocale ? 'translate-x-4' : ''}`} />
              </span>
              {f.forceEnLocale ? 'BẬT — Ép en-US' : 'TẮT — Theo GeoIP của proxy'}
            </button>
          </Field>
        </Section>

        <Card>
          <CardHeader>
            <CardTitle><FolderOpen size={14} className="text-cyan-400" /> Thư mục dữ liệu</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {DATA_DIRS.map(([path, desc]) => (
              <div key={path} className="flex items-center gap-4 px-4 py-3 bg-white/[0.02] rounded-lg border border-white/5">
                <code className="text-[12px] text-cyan-400 font-mono min-w-[190px] shrink-0">{path}</code>
                <span className="text-[12px] text-slate-500">{desc}</span>
              </div>
            ))}
          </CardContent>
        </Card>

        <div className="flex gap-3">
          <Button variant="primary" size="lg" onClick={save} disabled={saving} className="min-w-[140px]">
            {saving
              ? <><span className="w-3.5 h-3.5 border-2 border-white/20 border-t-white rounded-full animate-spin" /> Đang lưu...</>
              : <><Save size={15} /> Lưu cài đặt</>
            }
          </Button>
          <Button variant="ghost" size="lg" onClick={() => config && setF(config)}>
            <RotateCcw size={14} /> Hoàn tác
          </Button>
        </div>
      </div>
    </div>
  );
}
