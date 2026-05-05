'use client';
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useApp, BrowserProfile } from '../AppContext';
import {
  Plus, Play, Square, Monitor, Copy, Trash2, Edit3, Search,
  Globe, Shield, Cpu, Clock, Languages, MonitorSmartphone, Zap,
  ExternalLink, RefreshCw, ChevronDown, X, Check, AlertTriangle,
  LayoutGrid, List, MoreHorizontal, Navigation, Cookie
} from 'lucide-react';
import { Button, Card, CardHeader, CardTitle, CardContent, Input, StatBox } from '../ui';
import { ConfirmModal } from '../Views';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';

dayjs.extend(relativeTime);

// ─── Status Chip ──────────────────────────────────────────────────────────
function ProfileStatusChip({ status }: { status: string }) {
  const cfg: Record<string, { label: string; cls: string; dot: string }> = {
    idle: { label: 'IDLE', cls: 'bg-slate-500/10 border-slate-500/20 text-slate-400', dot: 'bg-slate-500' },
    launching: { label: 'LAUNCHING', cls: 'bg-amber-500/10 border-amber-500/20 text-amber-400', dot: 'bg-amber-400 animate-pulse' },
    active: { label: 'ACTIVE', cls: 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400', dot: 'bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.5)]' },
    error: { label: 'ERROR', cls: 'bg-rose-500/10 border-rose-500/20 text-rose-400', dot: 'bg-rose-500' },
  };
  const c = cfg[status] || cfg.idle;
  return (
    <div className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wide border ${c.cls}`}>
      <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${c.dot}`} />
      {c.label}
    </div>
  );
}

// ─── Create/Edit Profile Modal ────────────────────────────────────────────
function ProfileModal({
  profile, onClose, onSave, options
}: {
  profile: Partial<BrowserProfile> | null; // null = create mode
  onClose: () => void;
  onSave: (data: Partial<BrowserProfile> & { name: string }) => void;
  options: any;
}) {
  const isEdit = !!profile?.id;
  const [form, setForm] = useState({
    name: profile?.name || '',
    group_name: profile?.group_name || '',
    proxy_url: profile?.proxy_url || '',
    start_url: profile?.start_url || 'about:blank',
    user_agent: profile?.user_agent || '',
    screen_resolution: profile?.screen_resolution || '1920x1080',
    language: profile?.language || 'en-US,en',
    timezone: profile?.timezone || 'America/New_York',
    webgl_vendor: profile?.webgl_vendor || '',
    webgl_renderer: profile?.webgl_renderer || '',
    canvas_noise: profile?.canvas_noise ?? 0,
    notes: profile?.notes || '',
    preset: '',
  });
  const [tab, setTab] = useState<'basic' | 'fingerprint'>('basic');

  const applyPreset = useCallback((presetKey: string) => {
    if (!presetKey || !options?.presets) return;
    // Presets are just labels — actual values come from backend on save
    setForm(f => ({ ...f, preset: presetKey }));
  }, [options]);

  const handleSave = () => {
    if (!form.name.trim()) return;
    const { preset, ...rest } = form;
    const data: any = { ...rest };
    if (preset) data.preset = preset;
    onSave(data);
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="relative bg-[#111827] border border-white/10 rounded-2xl shadow-2xl w-[640px] max-w-[90vw] max-h-[85vh] overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center gap-3 px-6 py-4 border-b border-white/5">
          <div className="w-9 h-9 rounded-lg bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center shrink-0">
            <Edit3 size={18} className="text-indigo-400" />
          </div>
          <h3 className="text-[15px] font-bold text-slate-100">{isEdit ? 'Edit Profile' : 'New Profile'}</h3>
          <button className="ml-auto p-1 rounded-md hover:bg-white/5 text-slate-400" onClick={onClose}><X size={16} /></button>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 px-6 pt-3">
          {(['basic', 'fingerprint'] as const).map(t => (
            <button key={t} className={`px-3 py-1.5 rounded-md text-[12px] font-medium transition-colors ${tab === t ? 'bg-indigo-500/10 text-indigo-400 border border-indigo-500/20' : 'text-slate-400 hover:bg-white/5 border border-transparent'}`} onClick={() => setTab(t)}>
              {t === 'basic' ? 'Basic' : 'Fingerprint'}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {tab === 'basic' && (
            <>
              <div>
                <label className="text-[11px] font-medium text-slate-400 mb-1 block">Name *</label>
                <Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. ChatGPT #1" />
              </div>
              <div>
                <label className="text-[11px] font-medium text-slate-400 mb-1 block">Group</label>
                <Input value={form.group_name} onChange={e => setForm(f => ({ ...f, group_name: e.target.value }))} placeholder="e.g. Work" />
              </div>
              <div>
                <label className="text-[11px] font-medium text-slate-400 mb-1 block">Proxy</label>
                <select className="w-full bg-white/5 border border-white/10 rounded-md px-3 py-2 text-[13px] text-slate-100 outline-none focus:border-indigo-500/50" value={form.proxy_url} onChange={e => setForm(f => ({ ...f, proxy_url: e.target.value }))}>
                  <option value="">No Proxy</option>
                  {options?.proxies?.map((p: any) => (
                    <option key={p.id} value={p.url}>{p.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-[11px] font-medium text-slate-400 mb-1 block">Start URL</label>
                <Input value={form.start_url} onChange={e => setForm(f => ({ ...f, start_url: e.target.value }))} placeholder="https://chat.openai.com" />
              </div>
              <div>
                <label className="text-[11px] font-medium text-slate-400 mb-1 block">Notes</label>
                <textarea className="w-full bg-white/5 border border-white/10 rounded-md px-3 py-2 text-[13px] text-slate-100 outline-none focus:border-indigo-500/50 resize-none h-20" value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
              </div>
            </>
          )}

          {tab === 'fingerprint' && (
            <>
              {/* Preset */}
              <div>
                <label className="text-[11px] font-medium text-slate-400 mb-1 block">Preset</label>
                <div className="grid grid-cols-3 gap-2">
                  {options?.presets?.map((p: any) => (
                    <button key={p.key} className={`px-3 py-2 rounded-lg text-[11px] font-medium border transition-all ${form.preset === p.key ? 'bg-indigo-500/10 border-indigo-500/30 text-indigo-400' : 'bg-white/5 border-white/10 text-slate-300 hover:bg-white/10'}`} onClick={() => applyPreset(p.key)}>
                      {p.icon} {p.label}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="text-[11px] font-medium text-slate-400 mb-1 block">User-Agent</label>
                <Input value={form.user_agent} onChange={e => setForm(f => ({ ...f, user_agent: e.target.value }))} placeholder="Mozilla/5.0 ..." mono />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[11px] font-medium text-slate-400 mb-1 block">Screen Resolution</label>
                  <select className="w-full bg-white/5 border border-white/10 rounded-md px-3 py-2 text-[13px] text-slate-100 outline-none focus:border-indigo-500/50" value={form.screen_resolution} onChange={e => setForm(f => ({ ...f, screen_resolution: e.target.value }))}>
                    {options?.resolutions?.map((r: string) => <option key={r} value={r}>{r}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-[11px] font-medium text-slate-400 mb-1 block">Language</label>
                  <select className="w-full bg-white/5 border border-white/10 rounded-md px-3 py-2 text-[13px] text-slate-100 outline-none focus:border-indigo-500/50" value={form.language} onChange={e => setForm(f => ({ ...f, language: e.target.value }))}>
                    {options?.languages?.map((l: any) => <option key={l.value} value={l.value}>{l.label}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <label className="text-[11px] font-medium text-slate-400 mb-1 block">Timezone</label>
                <select className="w-full bg-white/5 border border-white/10 rounded-md px-3 py-2 text-[13px] text-slate-100 outline-none focus:border-indigo-500/50" value={form.timezone} onChange={e => setForm(f => ({ ...f, timezone: e.target.value }))}>
                  {options?.timezones?.map((t: string) => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[11px] font-medium text-slate-400 mb-1 block">WebGL Vendor</label>
                  <Input value={form.webgl_vendor} onChange={e => setForm(f => ({ ...f, webgl_vendor: e.target.value }))} placeholder="Google Inc. (NVIDIA)" />
                </div>
                <div>
                  <label className="text-[11px] font-medium text-slate-400 mb-1 block">WebGL Renderer</label>
                  <Input value={form.webgl_renderer} onChange={e => setForm(f => ({ ...f, webgl_renderer: e.target.value }))} placeholder="ANGLE (NVIDIA, ...)" />
                </div>
              </div>
              <div className="flex items-center gap-3">
                <label className="text-[11px] font-medium text-slate-400">Canvas Noise</label>
                <button className={`w-10 h-5 rounded-full transition-colors ${form.canvas_noise ? 'bg-indigo-500' : 'bg-white/10'}`} onClick={() => setForm(f => ({ ...f, canvas_noise: f.canvas_noise ? 0 : 1 }))}>
                  <div className={`w-4 h-4 rounded-full bg-white shadow transition-transform ${form.canvas_noise ? 'translate-x-5' : 'translate-x-0.5'}`} />
                </button>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex gap-3 justify-end px-6 py-4 border-t border-white/5">
          <button className="px-4 py-2 text-[13px] font-medium rounded-lg bg-white/5 border border-white/10 text-slate-300 hover:bg-white/10 transition-colors" onClick={onClose}>Cancel</button>
          <button className="px-4 py-2 text-[13px] font-semibold rounded-lg bg-gradient-to-br from-indigo-500 to-indigo-600 text-white border border-indigo-500/40 hover:shadow-[0_0_15px_rgba(99,102,241,0.3)] transition-all" onClick={handleSave} disabled={!form.name.trim()}>
            {isEdit ? 'Save Changes' : 'Create Profile'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Profile Card ─────────────────────────────────────────────────────────
function ProfileCard({
  profile, onLaunch, onClose, onVNC, onEdit, onClone, onDelete, onNavigate
}: {
  profile: BrowserProfile;
  onLaunch: () => void;
  onClose: () => void;
  onVNC: () => void;
  onEdit: () => void;
  onClone: () => void;
  onDelete: () => void;
  onNavigate: (url: string) => void;
}) {
  const [showMenu, setShowMenu] = useState(false);
  const [navUrl, setNavUrl] = useState('');
  const [showNav, setShowNav] = useState(false);
  const isActive = profile.status === 'active';
  const isLaunching = profile.status === 'launching';

  return (
    <Card className={`group transition-all duration-200 h-full flex flex-col ${isActive ? 'border-emerald-500/30 shadow-[0_0_20px_rgba(16,185,129,0.1)] bg-emerald-500/[0.02]' : 'hover:border-white/10 bg-white/[0.01]'}`}>
      <CardContent className="p-5 flex flex-col h-full">
        {/* Header row */}
        <div className="flex items-start justify-between gap-3 mb-auto">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1.5">
              <h3 className="text-[15px] font-bold text-slate-100 truncate group-hover:text-indigo-400 transition-colors leading-tight">{profile.name}</h3>
              <ProfileStatusChip status={profile.status} />
            </div>
            {profile.group_name && (
              <div className="inline-flex items-center px-1.5 py-0.5 rounded bg-slate-500/10 text-[9px] font-bold text-slate-500 uppercase tracking-widest border border-slate-500/10">
                {profile.group_name}
              </div>
            )}
          </div>
          <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity translate-y--1">
            <button className="p-1.5 rounded-md hover:bg-white/10 text-slate-400 hover:text-white transition-colors" title="Edit" onClick={onEdit}>
              <Edit3 size={14} />
            </button>
            <button className="p-1.5 rounded-md hover:bg-white/10 text-slate-400 hover:text-white transition-colors" title="Clone" onClick={onClone}>
              <Copy size={14} />
            </button>
            <button className="p-1.5 rounded-md hover:bg-rose-500/10 text-slate-400 hover:text-rose-400 transition-colors" title="Delete" onClick={onDelete}>
              <Trash2 size={14} />
            </button>
          </div>
        </div>

        {/* Info row */}
        <div className="flex flex-wrap gap-2 mt-4">
          {profile.proxy_url && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-blue-500/10 border border-blue-500/20 text-blue-400">
              <Globe size={9} /> Proxy
            </span>
          )}
          {profile.screen_resolution && profile.screen_resolution !== '1920x1080' && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-violet-500/10 border border-violet-500/20 text-violet-400">
              <MonitorSmartphone size={9} /> {profile.screen_resolution}
            </span>
          )}
          {profile.timezone && profile.timezone !== 'America/New_York' && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-amber-500/10 border border-amber-500/20 text-amber-400">
              <Clock size={9} /> {profile.timezone.split('/').pop()?.replace(/_/g, ' ')}
            </span>
          )}
          {profile.language && !profile.language.startsWith('en-US') && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-cyan-500/10 border border-cyan-500/20 text-cyan-400">
              <Languages size={9} /> {profile.language.split(',')[0]}
            </span>
          )}
        </div>

        {/* Runtime info */}
        {isActive && (
          <div className="mt-3 px-3 py-2 rounded-lg bg-emerald-500/5 border border-emerald-500/10">
            <div className="flex items-center gap-4 text-[11px] text-slate-400">
              <span className="text-emerald-400">PID: {profile.camofox_pid}</span>
            </div>
          </div>
        )}

        {/* Navigate bar (when active) */}
        {isActive && showNav && (
          <div className="mt-3 flex gap-2">
            <Input value={navUrl} onChange={e => setNavUrl(e.target.value)} placeholder="Enter URL..." className="text-[12px]" />
            <Button variant="secondary" size="sm" onClick={() => { onNavigate(navUrl); setNavUrl(''); setShowNav(false); }} disabled={!navUrl}>
              <Navigation size={12} />
            </Button>
          </div>
        )}

        {/* Action buttons */}
        <div className="flex gap-2 mt-3">
          {!isActive && !isLaunching && (
            <Button variant="success" size="sm" onClick={onLaunch} className="flex-1">
              <Play size={12} /> Launch
            </Button>
          )}
          {isLaunching && (
            <Button variant="secondary" size="sm" disabled className="flex-1">
              <RefreshCw size={12} className="animate-spin" /> Starting...
            </Button>
          )}
          {isActive && (
            <>
              <Button variant="secondary" size="sm" onClick={() => setShowNav(!showNav)}>
                <Navigation size={12} />
              </Button>
              <Button variant="danger" size="sm" onClick={onClose}>
                <Square size={12} />
              </Button>
            </>
          )}
        </div>

        {/* Last opened */}
        {profile.last_opened_at && (
          <div className="mt-2 text-[10px] text-slate-500">
            Last opened {dayjs(profile.last_opened_at).fromNow()}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function MultiProfileView() {
  const {
    profiles, profileOptions, refreshProfiles, refreshProfileOptions,
    launchProfile, closeProfile, createProfile, updateProfile, deleteProfile,
    cloneProfile, navigateProfile, addToast, runScript, setView
  } = useApp();

  const [searchTerm, setSearchTerm] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [editProfile, setEditProfile] = useState<BrowserProfile | null>(null);
  const [confirm, setConfirm] = useState<{ title: string; message: string; onConfirm: () => Promise<void> } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    refreshProfiles().then(() => setLoading(false));
    refreshProfileOptions();
  }, []);

  const filteredProfiles = profiles.filter(p =>
    !searchTerm || p.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    p.group_name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
    p.proxy_url?.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const activeCount = profiles.filter(p => p.status === 'active').length;
  const idleCount = profiles.filter(p => p.status !== 'active').length;

  const handleCreate = async (data: any) => {
    setShowCreate(false);
    await createProfile(data);
  };

  const handleEdit = async (data: any) => {
    if (!editProfile) return;
    setEditProfile(null);
    await updateProfile(editProfile.id, data);
  };

  const handleLaunch = async (id: string) => {
    const x = profiles.find(p => p.id === id);
    if (!x) return;
    
    // Optimistic status update
    x.status = 'launching';
    refreshProfiles();
    
    try {
      await launchProfile(id);
    } catch (e: any) {
      addToast(e.message || 'Launch failed', 'error');
    }
  };

  const handleDelete = async (id: string) => {
    const x = profiles.find(p => p.id === id);
    if (!x) return;
    setConfirm({
      title: 'Delete Profile',
      message: `Are you sure you want to delete "${x.name}"?`,
      onConfirm: async () => { await deleteProfile(id); setConfirm(null); }
    });
  };

  const handleClose = async (id: string) => {
    const x = profiles.find(p => p.id === id);
    if (!x) return;
    setConfirm({
      title: 'Close Profile',
      message: `Are you sure you want to close "${x.name}"?`,
      onConfirm: async () => { await closeProfile(id); setConfirm(null); }
    });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <RefreshCw size={24} className="animate-spin text-slate-500" />
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-6">
      {/* Stats */}
      <div className="grid grid-cols-4 gap-3 mb-6">
        <StatBox label="Total Profiles" value={profiles.length} icon={Monitor} colorClass="text-indigo-400" borderClass="border-indigo-500/20" bgClass="bg-indigo-500/10" />
        <StatBox label="Active" value={activeCount} icon={Play} colorClass="text-emerald-400" borderClass="border-emerald-500/20" bgClass="bg-emerald-500/10" />
        <StatBox label="Idle" value={idleCount} icon={Square} colorClass="text-slate-400" borderClass="border-slate-500/20" bgClass="bg-slate-500/10" />
        <StatBox label="With Proxy" value={profiles.filter(p => p.proxy_url).length} icon={Globe} colorClass="text-blue-400" borderClass="border-blue-500/20" bgClass="bg-blue-500/10" />
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-3 mb-4">
        <div className="relative flex-1 max-w-md">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <Input value={searchTerm} onChange={e => setSearchTerm(e.target.value)} placeholder="Search profiles..." className="pl-9" />
        </div>
        
        <Button variant="primary" size="sm" onClick={() => setShowCreate(true)}>
          <Plus size={14} /> New Profile
        </Button>
      </div>

      {/* Profile Grid */}
      {filteredProfiles.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-slate-500">
          <Monitor size={48} className="mb-4 opacity-30" />
          <p className="text-[14px] font-medium mb-1">No profiles yet</p>
          <p className="text-[12px] mb-4">Create your first browser profile to get started</p>
          <Button variant="primary" size="sm" onClick={() => setShowCreate(true)}>
            <Plus size={14} /> Create Profile
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredProfiles.map(p => (
            <ProfileCard
              key={p.id}
              profile={p}
              onLaunch={() => handleLaunch(p.id)}
              onClose={() => handleClose(p.id)}
              onVNC={() => {}} 
              onEdit={() => setEditProfile(p)}
              onClone={() => cloneProfile(p.id)}
              onDelete={() => handleDelete(p.id)}
              onNavigate={(url) => navigateProfile(p.id, url)}
            />
          ))}
        </div>
      )}

      {/* Create Modal */}
      {showCreate && (
        <ProfileModal
          profile={null}
          onClose={() => setShowCreate(false)}
          onSave={handleCreate}
          options={profileOptions}
        />
      )}

      {/* Edit Modal */}
      {editProfile && (
        <ProfileModal
          profile={editProfile}
          onClose={() => setEditProfile(null)}
          onSave={handleEdit as any}
          options={profileOptions}
        />
      )}

      {/* Confirm Dialog */}
      {confirm && (
        <ConfirmModal
          title={confirm.title}
          message={confirm.message}
          onConfirm={confirm.onConfirm}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  );
}
