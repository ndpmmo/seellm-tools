'use client';
import React, { useEffect, useState } from 'react';
import { useApp, AppConfig } from '../AppContext';
import { Card, CardHeader, CardTitle, CardContent, Button, Input } from '../ui';
import { Settings, Globe, Cpu, FolderOpen, Save, RotateCcw, Eye, EyeOff, HardDrive, Trash2, RefreshCw } from 'lucide-react';

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
    protocolFirst: true,
    usePersistentProfiles: true,
  });
  const [saving, setSaving] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [modeChanged, setModeChanged] = useState(false);

  // Profile Storage State
  const [storageInfo, setStorageInfo] = useState<{
    profiles: { folderName: string; sizeBytes: number; email: string | null; status: string; isOrphaned: boolean; updatedAt: string }[];
    totalSizeBytes: number;
    folderCount: number;
  } | null>(null);
  const [loadingStorage, setLoadingStorage] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [deletingFolder, setDeletingFolder] = useState<string | null>(null);
  const [profilesExpanded, setProfilesExpanded] = useState(false);

  useEffect(() => { if (config) setF(config); }, [config]);

  const fetchStorageInfo = async () => {
    setLoadingStorage(true);
    try {
      const res = await fetch('/api/profiles/storage/info');
      const data = await res.json();
      if (data.ok) {
        setStorageInfo({
          profiles: data.profiles,
          totalSizeBytes: data.totalSizeBytes,
          folderCount: data.folderCount,
        });
      }
    } catch (e) {
      console.error('Failed to fetch profile storage info', e);
    } finally {
      setLoadingStorage(false);
    }
  };

  useEffect(() => {
    fetchStorageInfo();
  }, []);

  const runCleanup = async () => {
    setCleaning(true);
    try {
      const res = await fetch('/api/profiles/storage/cleanup', { method: 'POST' });
      const data = await res.json();
      if (data.ok) {
        addToast(`🧹 Đã dọn dẹp xong! Đã xóa ${data.cleanedCount} profiles rác và giải phóng ${formatBytes(data.recoveredBytes)}`, 'success');
        fetchStorageInfo();
      } else {
        addToast(`Lỗi dọn dẹp: ${data.error}`, 'error');
      }
    } catch (e: any) {
      addToast(`Lỗi kết nối dọn dẹp: ${e.message}`, 'error');
    } finally {
      setCleaning(false);
    }
  };

  const deleteFolder = async (folderName: string) => {
    if (!confirm(`Bạn có chắc chắn muốn xóa vĩnh viễn profile "${folderName.substring(0, 10)}..." khỏi đĩa cứng không? Hành động này không thể hoàn tác.`)) {
      return;
    }
    setDeletingFolder(folderName);
    try {
      const res = await fetch(`/api/profiles/storage/${folderName}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.ok) {
        addToast('🗑️ Đã xóa profile khỏi đĩa cứng!', 'success');
        fetchStorageInfo();
      } else {
        addToast(`Lỗi: ${data.error}`, 'error');
      }
    } catch (e: any) {
      addToast(`Lỗi kết nối: ${e.message}`, 'error');
    } finally {
      setDeletingFolder(null);
    }
  };

  const formatBytes = (bytes: number) => {
    if (!bytes || bytes === 0) return '0 B';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const set = (k: keyof AppConfig, v: any) => {
    setF(p => ({ ...p, [k]: v }));
    if (k === 'workerMode' && config?.workerMode !== v) {
      setModeChanged(true);
    }
  };
  const save = async () => {
    setSaving(true);
    await saveConfig(f);
    setSaving(false);
    if (modeChanged) {
      addToast('✅ Mode đã thay đổi. Worker sẽ tự động áp dụng sau ~5s.', 'success');
      setModeChanged(false);
    } else {
      addToast('✅ Đã lưu cài đặt', 'success');
    }
  };

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
            {modeChanged && (
              <div className="mt-2 px-3 py-2 rounded bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-[11px]">
                ✅ Mode sẽ tự động áp dụng sau ~5s (không cần restart)
              </div>
            )}
          </Field>
          <Field
            label="Protocol-Mode Registration"
            hint="Khi BẬT: Worker thử đăng ký qua HTTP API trước (nhanh, ít bị phát hiện). Nếu thất bại hoặc Sentinel đòi CAPTCHA thì tự động fallback về browser. Khi TẮT: Luôn dùng browser automation."
            full
          >
            <button
              type="button"
              onClick={() => set('protocolFirst', !f.protocolFirst)}
              className={`relative inline-flex items-center gap-2 px-3 py-2 rounded-lg border text-[12px] font-semibold transition-all ${
                f.protocolFirst
                  ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/15'
                  : 'bg-white/5 border-white/10 text-slate-400 hover:bg-white/10'
              }`}
            >
              <span className={`w-9 h-5 rounded-full transition-colors ${f.protocolFirst ? 'bg-emerald-500' : 'bg-slate-600'} relative`}>
                <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${f.protocolFirst ? 'translate-x-4' : ''}`} />
              </span>
              {f.protocolFirst ? 'BẬT — API-first' : 'TẮT — Browser-only'}
            </button>
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
          <Field
            label="Chụp ảnh kết quả Warmup (Screenshots)"
            hint="Khi BẬT: Camofox sẽ tự động chụp lại các bước tương tác Q&A và kết quả chat của ChatGPT. Ảnh sẽ được lưu trữ để theo dõi trực quan tương tự như quá trình tạo hay deploy."
            full
          >
            <button
              type="button"
              onClick={() => set('warmupScreenshots', f.warmupScreenshots === false ? true : false)}
              className={`relative inline-flex items-center gap-2 px-3 py-2 rounded-lg border text-[12px] font-semibold transition-all ${
                f.warmupScreenshots !== false
                  ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/15'
                  : 'bg-white/5 border-white/10 text-slate-400 hover:bg-white/10'
              }`}
            >
              <span className={`w-9 h-5 rounded-full transition-colors ${f.warmupScreenshots !== false ? 'bg-emerald-500' : 'bg-slate-600'} relative`}>
                <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${f.warmupScreenshots !== false ? 'translate-x-4' : ''}`} />
              </span>
              {f.warmupScreenshots !== false ? 'BẬT — Chụp ảnh logs Warmup' : 'TẮT — Không chụp ảnh'}
            </button>
          </Field>
          <Field
            label="Lưu trữ Trình duyệt (Persistent Profiles)"
            hint="Khi BẬT: Trình duyệt lưu giữ cookie, phiên đăng nhập và vân tay (fingerprint) để tái sử dụng. Khi TẮT: Trình duyệt mở ẩn danh tạm thời để tiết kiệm dung lượng đĩa."
            full
          >
            <button
              type="button"
              onClick={() => set('usePersistentProfiles', f.usePersistentProfiles !== false ? false : true)}
              className={`relative inline-flex items-center gap-2 px-3 py-2 rounded-lg border text-[12px] font-semibold transition-all ${
                f.usePersistentProfiles !== false
                  ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/15'
                  : 'bg-white/5 border-white/10 text-slate-400 hover:bg-white/10'
              }`}
            >
              <span className={`w-9 h-5 rounded-full transition-colors ${f.usePersistentProfiles !== false ? 'bg-emerald-500' : 'bg-slate-600'} relative`}>
                <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${f.usePersistentProfiles !== false ? 'translate-x-4' : ''}`} />
              </span>
              {f.usePersistentProfiles !== false ? 'BẬT — Lưu trữ Persistent Profiles' : 'TẮT — Dùng trình duyệt tạm thời'}
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

        {/* 🦊 Camoufox Profile & Storage Management Section */}
        <Card className="col-span-1 lg:col-span-2">
          <CardHeader className="flex flex-row items-center justify-between pb-2 border-b border-white/5">
            <CardTitle className="flex items-center gap-2">
              <HardDrive size={16} className="text-indigo-400" />
              <span>Quản lý Dung lượng Profiles (Camoufox)</span>
            </CardTitle>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={fetchStorageInfo}
                disabled={loadingStorage}
                className="flex items-center gap-1.5 text-xs text-slate-300 border-white/10 bg-white/5 hover:bg-white/10"
              >
                <RefreshCw size={12} className={loadingStorage ? 'animate-spin' : ''} />
                Quét lại
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={runCleanup}
                disabled={cleaning}
                className="flex items-center gap-1.5 text-xs bg-red-500/10 border border-red-500/30 text-red-400 hover:bg-red-500/20"
              >
                <Trash2 size={12} className={cleaning ? 'animate-spin' : ''} />
                Dọn dẹp rác (Housekeeping)
              </Button>
            </div>
          </CardHeader>

          <CardContent className="pt-4 flex flex-col gap-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="px-4 py-3 bg-white/[0.02] rounded-lg border border-white/5 flex flex-col gap-1">
                <span className="text-[10px] text-slate-400 font-semibold uppercase tracking-wider">Tổng dung lượng đĩa</span>
                <span className="text-2xl font-bold font-mono text-indigo-400">
                  {storageInfo ? formatBytes(storageInfo.totalSizeBytes) : '...'}
                </span>
              </div>
              <div className="px-4 py-3 bg-white/[0.02] rounded-lg border border-white/5 flex flex-col gap-1">
                <span className="text-[10px] text-slate-400 font-semibold uppercase tracking-wider">Số lượng thư mục</span>
                <span className="text-2xl font-bold font-mono text-cyan-400">
                  {storageInfo ? storageInfo.folderCount : '...'}
                </span>
              </div>
              <div className="px-4 py-3 bg-white/[0.02] rounded-lg border border-white/5 flex flex-col gap-1">
                <span className="text-[10px] text-slate-400 font-semibold uppercase tracking-wider">Thư mục mồ côi (rác)</span>
                <span className="text-2xl font-bold font-mono text-rose-400">
                  {storageInfo ? storageInfo.profiles.filter(p => p.isOrphaned).length : '...'}
                </span>
              </div>
            </div>

            <div className="border border-white/5 rounded-lg overflow-hidden bg-white/[0.01]">
              <div className="flex items-center justify-between px-4 py-3 bg-white/[0.02] border-b border-white/5">
                <span className="text-[11.5px] font-semibold text-slate-300">Danh sách Thư mục Trình duyệt vật lý</span>
                <button
                  onClick={() => setProfilesExpanded(!profilesExpanded)}
                  className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
                >
                  {profilesExpanded ? 'Thu gọn' : 'Hiển thị chi tiết'}
                </button>
              </div>

              {profilesExpanded && (
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="bg-white/[0.02] border-b border-white/5 text-[10px] text-slate-400 uppercase tracking-wider font-mono">
                        <th className="px-4 py-3 font-semibold">Tài khoản / ID thư mục</th>
                        <th className="px-4 py-3 font-semibold">Dung lượng</th>
                        <th className="px-4 py-3 font-semibold">Trạng thái</th>
                        <th className="px-4 py-3 font-semibold">Cập nhật lần cuối</th>
                        <th className="px-4 py-3 font-semibold text-right">Thao tác</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5 text-xs text-slate-300">
                      {loadingStorage ? (
                        <tr>
                          <td colSpan={5} className="text-center py-8 text-slate-500">
                            Đang quét thư mục profile...
                          </td>
                        </tr>
                      ) : !storageInfo || storageInfo.profiles.length === 0 ? (
                        <tr>
                          <td colSpan={5} className="text-center py-8 text-slate-500">
                            Chưa có profile trình duyệt nào được lưu trữ trên đĩa.
                          </td>
                        </tr>
                      ) : (
                        storageInfo.profiles.map(p => (
                          <tr key={p.folderName} className="hover:bg-white/[0.02] transition-colors">
                            <td className="px-4 py-3 max-w-[280px]">
                              {p.email ? (
                                <div className="font-semibold text-slate-200 truncate" title={p.email}>
                                  {p.email}
                                </div>
                              ) : (
                                <div className="text-rose-400/80 italic truncate">
                                  [Mồ côi] Profile rác
                                </div>
                              )}
                              <div className="text-[10px] font-mono text-slate-500 truncate mt-0.5" title={p.folderName}>
                                {p.folderName}
                              </div>
                            </td>
                            <td className="px-4 py-3 font-mono font-medium">{formatBytes(p.sizeBytes)}</td>
                            <td className="px-4 py-3">
                              {p.status === 'active' && (
                                <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">Hoạt động</span>
                              )}
                              {p.status === 'dead' && (
                                <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-rose-500/10 text-rose-400 border border-rose-500/20">Đã Chết</span>
                              )}
                              {p.status === 'inactive' && (
                                <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/10 text-amber-400 border border-amber-500/20">Deactivated</span>
                              )}
                              {p.status === 'orphaned' && (
                                <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-500/10 text-slate-400 border border-slate-500/20">Mồ Côi (Rác)</span>
                              )}
                            </td>
                            <td className="px-4 py-3 text-[11px] text-slate-400">
                              {new Date(p.updatedAt).toLocaleString('vi-VN')}
                            </td>
                            <td className="px-4 py-3 text-right">
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => deleteFolder(p.folderName)}
                                disabled={deletingFolder === p.folderName}
                                className="text-rose-400 hover:text-rose-300 hover:bg-rose-500/10 !px-2.5 !py-1 text-xs"
                              >
                                {deletingFolder === p.folderName ? 'Đang xóa...' : 'Xóa đĩa'}
                              </Button>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        <div className="flex gap-3 col-span-1 lg:col-span-2 mt-2">
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
