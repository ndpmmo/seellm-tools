'use client';
import React, { useEffect, useState } from 'react';
import { useApp, AppConfig } from '../AppContext';
import { Card, CardHeader, CardTitle, CardContent, Button, Input } from '../ui';
import { 
  Settings, Globe, Cpu, FolderOpen, Save, RotateCcw, Eye, EyeOff, 
  HardDrive, Trash2, RefreshCw, Filter, Search, ChevronDown, ChevronUp, 
  SlidersHorizontal, AlertTriangle, Trash, CheckSquare, Square,
  Cloud, Wrench
} from 'lucide-react';

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
    deleteLinkedEmail: false,
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

  // Advanced Filtering, Search & Bulk Actions states
  const [selectedFolders, setSelectedFolders] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState('');
  const [filterStatus, setFilterStatus] = useState<'all' | 'orphaned' | 'active' | 'dead' | 'inactive'>('all');
  const [showAdvancedCleanup, setShowAdvancedCleanup] = useState(false);
  const [cleanOrphans, setCleanOrphans] = useState(true);
  const [cleanDead, setCleanDead] = useState(true);
  const [cleanInactive, setCleanInactive] = useState(false);
  const [minAgeHours, setMinAgeHours] = useState(0);
  const [bulkDeleting, setBulkDeleting] = useState(false);

  const [forcePushing, setForcePushing] = useState(false);
  const [forcePulling, setForcePulling] = useState(false);
  const [cleaningStale, setCleaningStale] = useState(false);

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
      const res = await fetch('/api/profiles/storage/cleanup', { 
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cleanOrphans,
          cleanDead,
          cleanInactive,
          minAgeHours
        })
      });
      const data = await res.json();
      if (data.ok) {
        addToast(`🧹 Đã dọn dẹp xong! Đã xóa ${data.cleanedCount} profiles và giải phóng ${formatBytes(data.recoveredBytes)}`, 'success');
        setSelectedFolders(new Set());
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
        setSelectedFolders(prev => {
          const next = new Set(prev);
          next.delete(folderName);
          return next;
        });
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

  const runBulkDelete = async () => {
    if (selectedFolders.size === 0) return;
    if (!confirm(`Bạn có chắc chắn muốn xóa vĩnh viễn ${selectedFolders.size} profile đã chọn khỏi đĩa cứng không? Hành động này không thể hoàn tác.`)) {
      return;
    }
    setBulkDeleting(true);
    try {
      const res = await fetch('/api/profiles/storage/bulk-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          folderNames: Array.from(selectedFolders)
        })
      });
      const data = await res.json();
      if (data.ok) {
        addToast(`🗑️ Đã xóa thành công ${data.deletedCount} profile và giải phóng ${formatBytes(data.recoveredBytes)}!`, 'success');
        setSelectedFolders(new Set());
        fetchStorageInfo();
      } else {
        addToast(`Lỗi xóa: ${data.error}`, 'error');
      }
    } catch (e: any) {
      addToast(`Lỗi kết nối: ${e.message}`, 'error');
    } finally {
      setBulkDeleting(false);
    }
  };

  const toggleSelectFolder = (folderName: string) => {
    setSelectedFolders(prev => {
      const next = new Set(prev);
      if (next.has(folderName)) {
        next.delete(folderName);
      } else {
        next.add(folderName);
      }
      return next;
    });
  };

  const filteredProfiles = storageInfo?.profiles.filter(p => {
    // 1. Filter by Search Query
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      const matchEmail = p.email ? p.email.toLowerCase().includes(query) : false;
      const matchFolder = p.folderName.toLowerCase().includes(query);
      if (!matchEmail && !matchFolder) return false;
    }
    // 2. Filter by Status
    if (filterStatus !== 'all') {
      if (filterStatus === 'orphaned' && !p.isOrphaned) return false;
      if (filterStatus === 'active' && p.status !== 'active') return false;
      if (filterStatus === 'dead' && p.status !== 'dead') return false;
      if (filterStatus === 'inactive' && p.status !== 'inactive') return false;
    }
    return true;
  }) || [];

  const toggleSelectAll = () => {
    if (selectedFolders.size === filteredProfiles.length && filteredProfiles.length > 0) {
      setSelectedFolders(new Set());
    } else {
      setSelectedFolders(new Set(filteredProfiles.map(p => p.folderName)));
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

  const handleForcePushAll = async () => {
    if (!confirm('Bạn có chắc chắn muốn ép đồng bộ toàn bộ dữ liệu Vault lên D1? Hành động này sẽ bỏ qua bộ nhớ cache và ghi đè trạng thái D1 hiện tại.')) {
      return;
    }
    setForcePushing(true);
    try {
      const res = await fetch('/api/vault/sync/all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: true })
      });
      const data = await res.json();
      if (data.ok) {
        addToast(`✅ Ép đồng bộ D1 thành công! Đã đẩy: Accounts=${data.results.accounts}, Pool=${data.results.emailPool}, Proxies=${data.results.proxies}, Keys=${data.results.keys}`, 'success');
      } else {
        addToast(`Lỗi đồng bộ: ${data.error || 'D1 push failed'}`, 'error');
      }
    } catch (e: any) {
      addToast(`Lỗi kết nối: ${e.message}`, 'error');
    } finally {
      setForcePushing(false);
    }
  };

  const handleForcePullAll = async () => {
    if (!confirm('Bạn có chắc chắn muốn ép tải toàn bộ dữ liệu D1 về local? Hành động này sẽ kéo mọi thay đổi từ trước đến nay.')) {
      return;
    }
    setForcePulling(true);
    try {
      const res = await fetch('/api/vault/sync/force-pull', { method: 'POST' });
      const data = await res.json();
      if (data.ok) {
        addToast('✅ Ép tải dữ liệu D1 về local thành công!', 'success');
      } else {
        addToast(`Lỗi: ${data.error || 'D1 pull failed'}`, 'error');
      }
    } catch (e: any) {
      addToast(`Lỗi kết nối: ${e.message}`, 'error');
    } finally {
      setForcePulling(false);
    }
  };

  const handleCleanupStale = async () => {
    setCleaningStale(true);
    try {
      const res = await fetch('/api/vault/sync/cleanup-stale', { method: 'POST' });
      const data = await res.json();
      if (data.ok) {
        if (data.cleanedCount > 0) {
          addToast(`🧹 Dọn dẹp thành công! Đã giải phóng/xóa ảo ${data.cleanedCount} connections rác trên D1.`, 'success');
        } else {
          addToast('✨ Không phát hiện connection mồ côi nào trên D1!', 'info');
        }
      } else {
        addToast(`Lỗi: ${data.error}`, 'error');
      }
    } catch (e: any) {
      addToast(`Lỗi kết nối: ${e.message}`, 'error');
    } finally {
      setCleaningStale(false);
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
          <Field
            label="Tự động xóa Email tương ứng khi xóa Account Vault"
            hint="Khi BẬT: Khi bạn xóa một tài khoản khỏi Vault, email liên kết của nó trong Workshop (Email Pool) cũng sẽ bị xóa vĩnh viễn. Khi TẮT: Chỉ đặt lại trạng thái chatgpt_status của email về 'not_created' và giữ email lại trong pool."
            full
          >
            <button
              type="button"
              onClick={() => set('deleteLinkedEmail', f.deleteLinkedEmail === true ? false : true)}
              className={`relative inline-flex items-center gap-2 px-3 py-2 rounded-lg border text-[12px] font-semibold transition-all ${
                f.deleteLinkedEmail === true
                  ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/15'
                  : 'bg-white/5 border-white/10 text-slate-400 hover:bg-white/10'
              }`}
            >
              <span className={`w-9 h-5 rounded-full transition-colors ${f.deleteLinkedEmail === true ? 'bg-emerald-500' : 'bg-slate-600'} relative`}>
                <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${f.deleteLinkedEmail === true ? 'translate-x-4' : ''}`} />
              </span>
              {f.deleteLinkedEmail === true ? 'BẬT — Tự động xóa Email liên kết' : 'TẮT — Giữ lại Email trong Pool'}
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

        {/* ☁️ Codex Remote Sync & Troubleshooting Section */}
        <Card className="col-span-1 lg:col-span-2 overflow-hidden border border-white/10 shadow-xl bg-slate-900/40 backdrop-blur-md">
          <CardHeader className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-4 border-b border-white/5 bg-white/[0.01]">
            <CardTitle className="flex items-center gap-2">
              <Cloud size={18} className="text-cyan-400 animate-pulse" />
              <span className="bg-gradient-to-r from-cyan-300 via-indigo-300 to-purple-300 bg-clip-text text-transparent font-extrabold tracking-tight">
                Đồng bộ hóa & Khắc phục sự cố Codex Remote Sync (D1)
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-4 flex flex-col gap-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="p-4 rounded-xl bg-white/[0.02] border border-white/5 flex flex-col gap-3 hover:bg-white/[0.03] transition-all">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-lg bg-indigo-500/10 flex items-center justify-center text-indigo-400">
                    <Save size={16} />
                  </div>
                  <span className="text-xs font-bold text-slate-300">Ép Đẩy Dữ liệu (Force Push All)</span>
                </div>
                <p className="text-[11px] text-slate-500 leading-relaxed min-h-[48px]">
                  Bỏ qua hoàn toàn bộ nhớ cache so sánh vân tay và ép đẩy toàn bộ 100% dữ liệu Accounts, Proxies, Pool, Keys lên cơ sở dữ liệu Cloud D1 để ghi đè mọi dữ liệu lỗi.
                </p>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleForcePushAll}
                  disabled={forcePushing}
                  className="w-full text-xs font-semibold bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-500/10 hover:scale-[1.02] active:scale-[0.98] transition-all"
                >
                  {forcePushing ? 'Đang ép đẩy...' : 'Ép Đẩy Lên Cloud D1'}
                </Button>
              </div>

              <div className="p-4 rounded-xl bg-white/[0.02] border border-white/5 flex flex-col gap-3 hover:bg-white/[0.03] transition-all">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-lg bg-cyan-500/10 flex items-center justify-center text-cyan-400">
                    <RotateCcw size={16} />
                  </div>
                  <span className="text-xs font-bold text-slate-300">Ép Tải Dữ liệu (Force Pull All)</span>
                </div>
                <p className="text-[11px] text-slate-500 leading-relaxed min-h-[48px]">
                  Xóa bộ đếm con trỏ (cursor) đồng bộ cục bộ và kéo toàn bộ lịch sử thay đổi từ Cloud D1 về local Tools để cập nhật, khôi phục hoặc sửa lỗi mất dữ liệu.
                </p>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleForcePullAll}
                  disabled={forcePulling}
                  className="w-full text-xs font-semibold border-white/10 bg-white/5 hover:bg-white/10 hover:scale-[1.02] active:scale-[0.98] transition-all"
                >
                  {forcePulling ? 'Đang ép tải...' : 'Ép Tải Từ Cloud D1'}
                </Button>
              </div>

              <div className="p-4 rounded-xl bg-white/[0.02] border border-white/5 flex flex-col gap-3 hover:bg-white/[0.03] transition-all">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-lg bg-rose-500/10 flex items-center justify-center text-rose-400">
                    <Trash2 size={16} />
                  </div>
                  <span className="text-xs font-bold text-slate-300">Dọn dẹp liên kết rác trên D1</span>
                </div>
                <p className="text-[11px] text-slate-500 leading-relaxed min-h-[48px]">
                  Tự động quét D1 để tìm các kết nối (connections) hoặc tài khoản con (managed accounts) mồ côi không khớp với bất kỳ tài khoản nào đang hoạt động và soft-delete chúng.
                </p>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleCleanupStale}
                  disabled={cleaningStale}
                  className="w-full text-xs font-semibold text-rose-400 border-rose-500/20 bg-rose-500/5 hover:bg-rose-500/10 hover:scale-[1.02] active:scale-[0.98] transition-all"
                >
                  {cleaningStale ? 'Đang dọn dẹp...' : 'Dọn dẹp mồ côi D1'}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* 🦊 Camoufox Profile & Storage Management Section */}
        <Card className="col-span-1 lg:col-span-2 overflow-hidden border border-white/10 shadow-xl bg-slate-900/40 backdrop-blur-md">
          <CardHeader className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-4 border-b border-white/5 bg-white/[0.01]">
            <CardTitle className="flex items-center gap-2">
              <HardDrive size={18} className="text-indigo-400 animate-pulse" />
              <span className="bg-gradient-to-r from-indigo-300 via-purple-300 to-pink-300 bg-clip-text text-transparent font-extrabold tracking-tight">
                Quản lý Dung lượng Profiles (Camoufox)
              </span>
            </CardTitle>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={fetchStorageInfo}
                disabled={loadingStorage}
                className="flex items-center gap-1.5 text-xs text-slate-300 border-white/10 bg-white/5 hover:bg-white/10 transition-all hover:scale-[1.02] active:scale-[0.98]"
              >
                <RefreshCw size={12} className={loadingStorage ? 'animate-spin' : ''} />
                Quét lại
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setShowAdvancedCleanup(!showAdvancedCleanup)}
                className={`flex items-center gap-1.5 text-xs transition-all hover:scale-[1.02] active:scale-[0.98] ${
                  showAdvancedCleanup
                    ? 'bg-indigo-500/20 border border-indigo-500/40 text-indigo-300 hover:bg-indigo-500/35'
                    : 'text-slate-300 border-white/10 bg-white/5 hover:bg-white/10'
                }`}
              >
                <SlidersHorizontal size={12} />
                Cấu hình Dọn dẹp
                {showAdvancedCleanup ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={runCleanup}
                disabled={cleaning}
                className="flex items-center gap-1.5 text-xs bg-red-500/10 border border-red-500/30 text-red-400 hover:bg-red-500/20 shadow-lg shadow-red-500/5 transition-all hover:scale-[1.02] active:scale-[0.98]"
              >
                <Trash2 size={12} className={cleaning ? 'animate-spin' : ''} />
                Chạy dọn dẹp ngay
              </Button>
            </div>
          </CardHeader>

          <CardContent className="pt-4 flex flex-col gap-4">
            {/* Advanced Housekeeping Options Form */}
            {showAdvancedCleanup && (
              <div className="p-4 rounded-xl bg-white/[0.02] border border-white/5 flex flex-col gap-4 animate-fadeIn transition-all">
                <div className="flex items-center gap-2 text-indigo-400 font-semibold text-xs uppercase tracking-wider">
                  <SlidersHorizontal size={14} />
                  <span>Cấu hình tiến trình dọn dẹp (Smart Housekeeping)</span>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <label className="flex items-start gap-2.5 p-3 rounded-lg bg-white/[0.01] hover:bg-white/[0.03] border border-white/5 cursor-pointer transition-colors">
                    <input
                      type="checkbox"
                      checked={cleanOrphans}
                      onChange={e => setCleanOrphans(e.target.checked)}
                      className="mt-0.5 rounded border-white/20 text-indigo-600 focus:ring-indigo-500"
                    />
                    <div className="flex flex-col gap-0.5">
                      <span className="text-[12px] font-semibold text-slate-300">Xóa thư mục mồ côi</span>
                      <span className="text-[10px] text-slate-500 leading-relaxed">Xóa các thư mục profile rác không khớp với tài khoản nào trong hệ thống.</span>
                    </div>
                  </label>

                  <label className="flex items-start gap-2.5 p-3 rounded-lg bg-white/[0.01] hover:bg-white/[0.03] border border-white/5 cursor-pointer transition-colors">
                    <input
                      type="checkbox"
                      checked={cleanDead}
                      onChange={e => setCleanDead(e.target.checked)}
                      className="mt-0.5 rounded border-white/20 text-indigo-600 focus:ring-indigo-500"
                    />
                    <div className="flex flex-col gap-0.5">
                      <span className="text-[12px] font-semibold text-slate-300">Xóa profile của tài khoản đã chết</span>
                      <span className="text-[10px] text-slate-500 leading-relaxed">Tự động xóa đĩa cứng profile của tài khoản được xác nhận đã chết (dead).</span>
                    </div>
                  </label>

                  <label className="flex items-start gap-2.5 p-3 rounded-lg bg-white/[0.01] hover:bg-white/[0.03] border border-white/5 cursor-pointer transition-colors">
                    <input
                      type="checkbox"
                      checked={cleanInactive}
                      onChange={e => setCleanInactive(e.target.checked)}
                      className="mt-0.5 rounded border-white/20 text-indigo-600 focus:ring-indigo-500"
                    />
                    <div className="flex flex-col gap-0.5">
                      <span className="text-[12px] font-semibold text-slate-300">Xóa cả profile ngưng hoạt động</span>
                      <span className="text-[10px] text-slate-500 leading-relaxed">Xóa các profile của tài khoản Deactivated hoặc không active.</span>
                    </div>
                  </label>
                </div>

                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-3 bg-indigo-500/[0.02] border border-indigo-500/10 rounded-lg">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[12px] font-semibold text-indigo-300">Thời gian bỏ qua an toàn (giờ)</span>
                    <span className="text-[10.5px] text-slate-400 leading-relaxed">
                      Giữ lại các thư mục profile mới được ghi đè hoặc tạo mới trong vòng X giờ để tránh ảnh hưởng tới phiên làm việc đang chạy.
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Input
                      type="number"
                      min={0}
                      value={minAgeHours}
                      onChange={e => setMinAgeHours(Math.max(0, parseInt(e.target.value) || 0))}
                      className="w-20 font-mono text-center text-xs !py-1.5"
                    />
                    <span className="text-xs text-slate-400">giờ qua</span>
                  </div>
                </div>
              </div>
            )}

            {/* Storage Sizing Stats Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="px-4 py-3 bg-gradient-to-br from-indigo-500/[0.03] to-purple-500/[0.03] rounded-xl border border-white/5 flex flex-col gap-1 shadow-inner">
                <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">Tổng dung lượng đĩa</span>
                <span className="text-2xl font-bold font-mono text-indigo-400">
                  {storageInfo ? formatBytes(storageInfo.totalSizeBytes) : '...'}
                </span>
              </div>
              <div className="px-4 py-3 bg-gradient-to-br from-cyan-500/[0.03] to-teal-500/[0.03] rounded-xl border border-white/5 flex flex-col gap-1 shadow-inner">
                <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">Số lượng thư mục</span>
                <span className="text-2xl font-bold font-mono text-cyan-400">
                  {storageInfo ? storageInfo.folderCount : '...'}
                </span>
              </div>
              <div className="px-4 py-3 bg-gradient-to-br from-rose-500/[0.03] to-red-500/[0.03] rounded-xl border border-white/5 flex flex-col gap-1 shadow-inner">
                <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">Thư mục mồ côi (rác)</span>
                <span className="text-2xl font-bold font-mono text-rose-400">
                  {storageInfo ? storageInfo.profiles.filter(p => p.isOrphaned).length : '...'}
                </span>
              </div>
            </div>

            {/* List and Actions Table Panel */}
            <div className="border border-white/5 rounded-xl overflow-hidden bg-white/[0.01]">
              <div className="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3 px-4 py-3 bg-white/[0.02] border-b border-white/5">
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-[12px] font-bold text-slate-300">Danh sách Thư mục Trình duyệt vật lý</span>
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 font-mono">
                    {filteredProfiles.length} thư mục
                  </span>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {/* Search bar */}
                  <div className="relative w-full sm:w-48 shrink-0">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" size={12} />
                    <input
                      type="text"
                      placeholder="Tìm email, hash folder..."
                      value={searchQuery}
                      onChange={e => setSearchQuery(e.target.value)}
                      className="w-full pl-8 pr-3 py-1 bg-white/5 border border-white/10 rounded-lg text-xs text-slate-300 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 placeholder-slate-500"
                    />
                  </div>

                  {/* Filter Dropdown */}
                  <div className="flex items-center gap-1 bg-white/5 border border-white/10 rounded-lg px-2 py-1 shrink-0">
                    <Filter size={11} className="text-indigo-400" />
                    <select
                      value={filterStatus}
                      onChange={e => setFilterStatus(e.target.value as any)}
                      className="bg-transparent text-xs text-slate-300 border-none outline-none focus:ring-0 pr-6 py-0 cursor-pointer"
                    >
                      <option value="all" className="bg-slate-900 text-slate-300">Tất cả trạng thái</option>
                      <option value="orphaned" className="bg-slate-900 text-rose-400">Chỉ Thư mục Mồ côi</option>
                      <option value="active" className="bg-slate-900 text-emerald-400">Chỉ Hoạt động (Active)</option>
                      <option value="dead" className="bg-slate-900 text-rose-400">Chỉ Đã chết (Dead)</option>
                      <option value="inactive" className="bg-slate-900 text-amber-400">Chỉ Deactivated</option>
                    </select>
                  </div>

                  <button
                    type="button"
                    onClick={() => setProfilesExpanded(!profilesExpanded)}
                    className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors font-medium ml-2"
                  >
                    {profilesExpanded ? 'Thu gọn' : 'Hiển thị danh sách'}
                  </button>
                </div>
              </div>

              {/* Dynamic Bulk Action Bar */}
              {selectedFolders.size > 0 && (
                <div className="flex items-center justify-between px-4 py-2.5 bg-gradient-to-r from-indigo-500/10 via-purple-500/10 to-pink-500/10 border-b border-indigo-500/20 text-xs animate-slideDown">
                  <div className="flex items-center gap-2">
                    <CheckSquare size={13} className="text-indigo-400" />
                    <span className="text-slate-300">
                      Đang chọn <strong className="text-indigo-300 font-mono">{selectedFolders.size}</strong> profile
                    </span>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setSelectedFolders(new Set())}
                      className="!text-[11px] !px-2.5 !py-1 text-slate-400 border border-white/10 hover:bg-white/5"
                    >
                      Bỏ chọn tất cả
                    </Button>
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={runBulkDelete}
                      disabled={bulkDeleting}
                      className="!text-[11px] !px-2.5 !py-1 bg-red-500/20 border border-red-500/40 text-red-300 hover:bg-red-500/35 flex items-center gap-1"
                    >
                      <Trash size={11} className={bulkDeleting ? 'animate-spin' : ''} />
                      {bulkDeleting ? 'Đang xóa các mục...' : 'Xóa vĩnh viễn các thư mục đã chọn'}
                    </Button>
                  </div>
                </div>
              )}

              {profilesExpanded && (
                <div className="overflow-x-auto max-h-[480px] overflow-y-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="bg-white/[0.02] border-b border-white/5 text-[10px] text-slate-400 uppercase tracking-wider font-mono select-none">
                        <th className="px-4 py-3 font-semibold w-8 text-center">
                          <input
                            type="checkbox"
                            checked={filteredProfiles.length > 0 && selectedFolders.size === filteredProfiles.length}
                            ref={el => {
                              if (el) {
                                el.indeterminate = selectedFolders.size > 0 && selectedFolders.size < filteredProfiles.length;
                              }
                            }}
                            onChange={toggleSelectAll}
                            className="rounded border-white/20 text-indigo-600 focus:ring-indigo-500 cursor-pointer"
                          />
                        </th>
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
                          <td colSpan={6} className="text-center py-10 text-slate-500">
                            <div className="flex flex-col items-center gap-2">
                              <RefreshCw size={20} className="animate-spin text-indigo-400" />
                              <span>Đang quét sâu và đo kích thước thư mục profile...</span>
                            </div>
                          </td>
                        </tr>
                      ) : filteredProfiles.length === 0 ? (
                        <tr>
                          <td colSpan={6} className="text-center py-10 text-slate-500 italic">
                            Không tìm thấy thư mục profile nào khớp với bộ lọc hiện tại.
                          </td>
                        </tr>
                      ) : (
                        filteredProfiles.map(p => {
                          const isSelected = selectedFolders.has(p.folderName);
                          return (
                            <tr
                              key={p.folderName}
                              onClick={() => toggleSelectFolder(p.folderName)}
                              className={`hover:bg-white/[0.03] transition-colors cursor-pointer select-none ${
                                isSelected ? 'bg-indigo-500/5 hover:bg-indigo-500/8' : ''
                              }`}
                            >
                              <td className="px-4 py-3 text-center" onClick={e => e.stopPropagation()}>
                                <input
                                  type="checkbox"
                                  checked={isSelected}
                                  onChange={() => toggleSelectFolder(p.folderName)}
                                  className="rounded border-white/20 text-indigo-600 focus:ring-indigo-500 cursor-pointer"
                                />
                              </td>
                              <td className="px-4 py-3 max-w-[280px]">
                                {p.email ? (
                                  <div className="font-semibold text-slate-200 truncate" title={p.email}>
                                    {p.email}
                                  </div>
                                ) : (
                                  <div className="text-rose-400/80 italic font-semibold flex items-center gap-1">
                                    <AlertTriangle size={11} className="text-rose-400 shrink-0" />
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
                                  <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-rose-500/10 text-rose-400 border border-rose-500/20">Mồ Côi (Rác)</span>
                                )}
                              </td>
                              <td className="px-4 py-3 text-[11px] text-slate-400">
                                {new Date(p.updatedAt).toLocaleString('vi-VN')}
                              </td>
                              <td className="px-4 py-3 text-right" onClick={e => e.stopPropagation()}>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => deleteFolder(p.folderName)}
                                  disabled={deletingFolder === p.folderName}
                                  className="text-rose-400 hover:text-rose-300 hover:bg-rose-500/10 !px-2.5 !py-1 text-xs transition-all hover:scale-105"
                                >
                                  {deletingFolder === p.folderName ? 'Đang xóa...' : 'Xóa đĩa'}
                                </Button>
                              </td>
                            </tr>
                          );
                        })
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
