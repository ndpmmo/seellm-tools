'use client';
import React, { useState, useEffect, useCallback } from 'react';
import {
    Mail, Search, Plus, Trash2, RefreshCw, CheckCircle2, XCircle,
    ShieldCheck, Import, Filter, Copy, Check, Database, Activity, Play,
    ChevronRight, Square, CheckSquare, AlertCircle
} from 'lucide-react';
import { useApp } from '../../AppContext';
import { Button, Card, CardHeader, CardTitle, CardContent, Input, StatBox } from '../../ui';
import { ConfirmModal } from '../../Views';

/* ── Status Chip ── */
function StatusChip({ status }: { status: string }) {
    const cfg: Record<string, { label: string; cls: string; dot: string }> = {
        active: { label: 'READY', cls: 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400', dot: 'bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.5)]' },
        unknown: { label: 'UNKNOWN', cls: 'bg-amber-500/10 border-amber-500/20 text-amber-400', dot: 'bg-amber-400' },
        dead: { label: 'DEAD', cls: 'bg-rose-500/10 border-rose-500/20 text-rose-400', dot: 'bg-rose-500' },
    };
    const c = cfg[status] || cfg.unknown;
    return (
        <div className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[10.5px] font-bold uppercase tracking-wide border ${c.cls}`}>
            <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${c.dot}`} />
            {c.label}
        </div>
    );
}

/* ── Service Tag ── */
function ServiceTag({ name, status }: { name: string; status: string }) {
    const cfg: Record<string, { color: string; bg: string; border: string }> = {
        chatgpt: { color: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/20' },
        claude: { color: 'text-orange-400', bg: 'bg-orange-500/10', border: 'border-orange-500/20' },
        gemini: { color: 'text-blue-400', bg: 'bg-blue-500/10', border: 'border-blue-500/20' },
        cursor: { color: 'text-teal-400', bg: 'bg-teal-500/10', border: 'border-teal-500/20' },
        codex: { color: 'text-indigo-400', bg: 'bg-indigo-500/10', border: 'border-indigo-500/20' },
    };
    const c = cfg[name.toLowerCase()] || { color: 'text-slate-400', bg: 'bg-slate-500/10', border: 'border-slate-500/20' };
    const isDone = status === 'done';
    return (
        <div className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-widest border ${isDone ? `${c.bg} ${c.border} ${c.color}` : 'bg-transparent border-white/5 text-slate-600'
            }`}>
            {name}
        </div>
    );
}

/* ── FilterBtn ── */
function FilterBtn({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count?: number }) {
    return (
        <button onClick={onClick} className={`px-3 py-1.5 rounded-md text-[11px] font-semibold transition-all flex items-center gap-1.5 ${active ? 'bg-white text-black shadow-sm' : 'bg-transparent text-slate-400 hover:text-slate-200 hover:bg-white/5'
            }`}>
            {label}
            {count !== undefined && <span className={`px-1.5 py-0.5 rounded text-[10px] ${active ? 'bg-black/15' : 'bg-white/10'}`}>{count}</span>}
        </button>
    );
}

export function VaultEmailsView() {
    const { addToast, setView } = useApp();
    const [items, setItems] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [searchTerm, setSearchTerm] = useState('');
    const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'dead' | 'done'>('all');
    const [showImport, setShowImport] = useState(false);
    const [inputText, setInputText] = useState('');
    const [copied, setCopied] = useState<string | null>(null);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [confirm, setConfirm] = useState<{ title: string; message: string; onConfirm: () => Promise<void> } | null>(null);
    const [actionLoading, setActionLoading] = useState(false);

    const fetchPool = useCallback(async () => {
        setLoading(true);
        try {
            const res = await fetch('/api/vault/email-pool');
            const data = await res.json();
            if (data.ok) setItems(data.items);
        } catch (_) { }
        setLoading(false);
    }, []);

    useEffect(() => { fetchPool(); }, [fetchPool]);

    const stats = {
        total: items.length,
        ready: items.filter(e => e.mail_status === 'active').length,
        registered: items.filter(e => Object.keys(e.services || {}).length > 0 || e.chatgpt_status === 'done').length,
        failed: items.filter(e => e.chatgpt_status === 'failed' || e.mail_status === 'dead').length,
    };

    const filtered = items.filter(e => {
        const matchSearch = e.email.toLowerCase().includes(searchTerm.toLowerCase());
        const matchStatus =
            statusFilter === 'all' ? true :
                statusFilter === 'active' ? e.mail_status === 'active' :
                    statusFilter === 'dead' ? e.mail_status === 'dead' :
                        statusFilter === 'done' ? (Object.keys(e.services || {}).length > 0 || e.chatgpt_status === 'done') : true;
        return matchSearch && matchStatus;
    });

    const onCopy = (text: string, label = 'Email') => {
        navigator.clipboard.writeText(text);
        setCopied(text);
        addToast(`Đã sao chép ${label}`, 'success');
        setTimeout(() => setCopied(null), 1500);
    };

    const onCopyFull = (it: any) => {
        const raw = `${it.email}|${it.password || ''}|${it.refresh_token || ''}|${it.client_id || ''}`;
        onCopy(raw, 'Full String');
    };

    const handleImport = async () => {
        const lines = inputText.split('\n').map(l => l.trim()).filter(Boolean);
        if (!lines.length) return addToast('Vui lòng nhập danh sách', 'error');
        let count = 0;
        
        for (const line of lines) {
            const parts = line.split('|');
            let email, password, refresh_token, client_id, auth_method;

            if (parts.length === 3) {
                // OAuth2 mode: email|refresh_token|client_id
                [email, refresh_token, client_id] = parts;
                password = ''; 
                auth_method = 'oauth2';
            } else if (parts.length >= 4) {
                // Graph API mode: email|password|refresh_token|client_id
                [email, password, refresh_token, client_id] = parts;
                auth_method = 'graph';
            } else {
                continue; // invalid
            }

            if (!email || !refresh_token) continue;

            try {
                // 1. Insert to Pool
                await fetch('/api/vault/email-pool', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email, password, refresh_token, client_id, auth_method }),
                });
                count++;

                // 2. Auto-trigger check-mail-worker
                const raw = `${email}|${password || ''}|${auth_method}|${refresh_token}|${client_id}`;
                fetch('/api/processes/script/run', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ scriptName: 'check-mail-worker.js', args: [raw] }),
                }).catch(() => {});
                
            } catch (_) { }
        }

        addToast(`✅ Đã import và bắt đầu kiểm tra ${count} email`, 'success');
        setInputText('');
        setShowImport(false);
        fetchPool();
    };

    const doDeleteOne = async (email: string) => {
        setActionLoading(true);
        try {
            await fetch(`/api/vault/email-pool/${encodeURIComponent(email)}`, { method: 'DELETE' });
            await fetchPool();
            addToast('Đã xóa', 'success');
        } catch (_) { }
        setActionLoading(false);
        setConfirm(null);
    };

    const doDeleteSelected = async () => {
        setActionLoading(true);
        for (const email of Array.from(selected)) {
            try { await fetch(`/api/vault/email-pool/${encodeURIComponent(email)}`, { method: 'DELETE' }); } catch (_) { }
        }
        setSelected(new Set());
        await fetchPool();
        addToast(`Đã xóa ${selected.size} email`, 'success');
        setActionLoading(false);
        setConfirm(null);
    };

    const confirmDeleteOne = (email: string) => setConfirm({
        title: 'Xóa Email',
        message: `Bạn có chắc muốn xóa ${email} khỏi Pool?`,
        onConfirm: () => doDeleteOne(email),
    });

    const confirmDeleteSelected = () => setConfirm({
        title: `Xóa ${selected.size} Email`,
        message: `Bạn có chắc muốn xóa ${selected.size} email đã chọn? Hành động này không thể hoàn tác.`,
        onConfirm: doDeleteSelected,
    });

    const checkStatus = async (it: any) => {
        const raw = `${it.email}|${it.password || ''}|${it.auth_method || 'graph'}|${it.refresh_token || ''}|${it.client_id || ''}`;
        addToast(`🔍 Đang kiểm tra: ${it.email}`, 'info');
        try {
            const res = await fetch('/api/processes/script/run', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ scriptName: 'check-mail-worker.js', args: [raw] }),
            });
            if (res.ok) addToast('Worker đã khởi động', 'success');
        } catch (_) { }
    };

    const startRegistration = async (it: any) => {
        const raw = `${it.email}|${it.password || ''}|${it.auth_method || 'graph'}|${it.refresh_token || ''}|${it.client_id || ''}`;
        addToast(`🚀 Bắt đầu đăng ký: ${it.email}`, 'info');
        try {
            const res = await fetch('/api/processes/script/run', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ scriptName: 'auto-register-worker.js', args: [raw] }),
            });
            if (res.ok) {
                addToast('Worker đăng ký đã khởi động!', 'success');
                setView('vault-register');
            }
        } catch (_) { }
    };

    const syncAllToD1 = async () => {
        setActionLoading(true);
        addToast('🔄 Đang ép đồng bộ toàn bộ Pool lên Cloud D1...', 'info');
        try {
            const res = await fetch('/api/vault/email-pool/sync-all', { method: 'POST' });
            const data = await res.json();
            if (data.ok) {
                addToast(`✅ Đồng bộ thành công ${data.success}/${data.total} email!`, 'success');
            } else {
                addToast(`❌ Lỗi đồng bộ: ${data.error}`, 'error');
            }
        } catch (e: any) {
            addToast(`❌ Lỗi kết nối server: ${e.message}`, 'error');
        }
        setActionLoading(false);
    };

    const allFilteredSelected = filtered.length > 0 && filtered.every(e => selected.has(e.email));
    const toggleSelectAll = () => {
        if (allFilteredSelected) {
            setSelected(prev => { const n = new Set(prev); filtered.forEach(e => n.delete(e.email)); return n; });
        } else {
            setSelected(prev => { const n = new Set(prev); filtered.forEach(e => n.add(e.email)); return n; });
        }
    };
    const toggleOne = (email: string) => {
        setSelected(prev => { const n = new Set(prev); n.has(email) ? n.delete(email) : n.add(email); return n; });
    };

    return (
        <div className="absolute inset-0 overflow-y-auto px-6 pb-10 pt-2 flex flex-col gap-5 custom-scrollbar">

            {/* ── Stats Bar ── */}
            <div className="grid grid-cols-4 gap-4 mt-2">
                <StatBox label="Tổng Pool" value={stats.total} icon={Mail} colorClass="text-indigo-400" bgClass="bg-indigo-500/10" borderClass="border-indigo-500/50" active={statusFilter === 'all'} onClick={() => setStatusFilter('all')} />
                <StatBox label="Mail Ready" value={stats.ready} icon={ShieldCheck} colorClass="text-emerald-400" bgClass="bg-emerald-500/10" borderClass="border-emerald-500/50" active={statusFilter === 'active'} onClick={() => setStatusFilter('active')} />
                <StatBox label="Đã Đăng Ký" value={stats.registered} icon={CheckCircle2} colorClass="text-blue-400" bgClass="bg-blue-500/10" borderClass="border-blue-500/50" active={statusFilter === 'done'} onClick={() => setStatusFilter('done')} />
                <StatBox label="Lỗi / Dead" value={stats.failed} icon={XCircle} colorClass="text-rose-400" bgClass="bg-rose-500/10" borderClass="border-rose-500/50" active={statusFilter === 'dead'} onClick={() => setStatusFilter('dead')} />
            </div>

            {/* ── Main Card ── */}
            <Card className="flex flex-col min-h-0 shrink-0">
                {/* Header */}
                <CardHeader>
                    <div className="flex items-center gap-4 w-full flex-wrap">
                        <div className="relative w-72">
                            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
                            <Input placeholder="Tìm theo email..." value={searchTerm} onChange={e => setSearchTerm(e.target.value)} className="pl-9" />
                        </div>

                        <div className="flex items-center p-1 bg-white/5 border border-white/5 rounded-lg gap-1">
                            <FilterBtn active={statusFilter === 'all'} onClick={() => setStatusFilter('all')} label="Tất cả" count={items.length} />
                            <FilterBtn active={statusFilter === 'active'} onClick={() => setStatusFilter('active')} label="Ready" count={stats.ready} />
                            <FilterBtn active={statusFilter === 'done'} onClick={() => setStatusFilter('done')} label="Đã dập" count={stats.registered} />
                            <FilterBtn active={statusFilter === 'dead'} onClick={() => setStatusFilter('dead')} label="Dead" count={stats.failed} />
                        </div>

                        <div className="ml-auto flex items-center gap-2">
                            {selected.size > 0 && (
                                <Button variant="danger" size="sm" onClick={confirmDeleteSelected}>
                                    <Trash2 size={13} /> Xóa ({selected.size})
                                </Button>
                            )}
                            <Button variant="ghost" size="sm" onClick={() => setShowImport(v => !v)}>
                                <Import size={14} /> Import Pool
                            </Button>
                            <Button variant="ghost" size="sm" onClick={syncAllToD1} disabled={actionLoading}>
                                <Database size={14} className={actionLoading ? 'animate-pulse text-indigo-400' : ''} />
                                {actionLoading ? 'Đang Sync...' : 'Sync All to D1'}
                            </Button>
                            <Button variant="primary" size="sm" onClick={() => setView('vault-register')}>
                                <Play size={13} /> Auto Register →
                            </Button>
                            <Button variant="ghost" size="icon-sm" onClick={fetchPool}>
                                <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
                            </Button>
                        </div>
                    </div>
                </CardHeader>

                {/* Import Panel */}
                {showImport && (
                    <div className="px-5 py-4 border-b border-white/5 bg-black/20">
                        <label className="block text-[11.5px] font-semibold text-slate-400 mb-2">
                            Dán danh sách (Tự động nhận diện 3 cột hoặc 4 cột): <br/>
                            <code className="text-indigo-400 font-mono mt-1 inline-block">email|pass|refresh|client</code> hoặc <code className="text-teal-400 font-mono mt-1 inline-block">email|refresh|client</code>
                        </label>
                        <textarea
                            className="w-full h-36 bg-black/40 border border-white/10 rounded-md p-3 text-[11.5px] font-mono text-slate-200 focus:outline-none focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/20 resize-none"
                            value={inputText}
                            onChange={e => setInputText(e.target.value)}
                            placeholder="user1@hotmail.com|pass123|refresh|client_id&#10;user2@hotmail.com|refresh|client_id"
                        />
                        <div className="mt-3 flex justify-end gap-2">
                            <Button variant="ghost" onClick={() => setShowImport(false)}>Hủy</Button>
                            <Button variant="primary" onClick={handleImport}>Bắt đầu nạp</Button>
                        </div>
                    </div>
                )}

                {/* Table */}
                <div className="overflow-x-auto custom-scrollbar">
                    <table className="w-full min-w-[1000px] text-left border-collapse">
                        <thead>
                            <tr className="bg-white/[0.03] border-b border-white/5">
                                <th className="px-4 py-3 w-10">
                                    <button onClick={toggleSelectAll} className="text-slate-500 hover:text-slate-200 transition-colors">
                                        {allFilteredSelected ? <CheckSquare size={15} className="text-indigo-400" /> : <Square size={15} />}
                                    </button>
                                </th>
                                <th className="px-4 py-3 text-[11px] font-bold text-slate-400 uppercase tracking-wider">Email / Credentials</th>
                                <th className="px-4 py-3 text-[11px] font-bold text-slate-400 uppercase tracking-wider">Mail Status</th>
                                <th className="px-4 py-3 text-[11px] font-bold text-slate-400 uppercase tracking-wider">Services</th>
                                <th className="px-4 py-3 text-[11px] font-bold text-slate-400 uppercase tracking-wider text-right">Thao tác</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-white/[0.04]">
                            {loading ? (
                                <tr><td colSpan={5} className="py-16 text-center text-slate-500"><span className="inline-block w-5 h-5 border-2 border-white/10 border-t-indigo-500 rounded-full animate-spin" /></td></tr>
                            ) : filtered.length === 0 ? (
                                <tr>
                                    <td colSpan={5} className="py-20 text-center">
                                        <div className="flex flex-col items-center gap-3 text-slate-500">
                                            <AlertCircle size={32} className="opacity-30" />
                                            <span className="text-[13px]">Không có email nào phù hợp bộ lọc</span>
                                        </div>
                                    </td>
                                </tr>
                            ) : filtered.map(it => (
                                <tr key={it.email} className={`hover:bg-white/[0.025] transition-colors group ${selected.has(it.email) ? 'bg-indigo-500/5' : ''}`}>
                                    <td className="px-4 py-3.5">
                                        <button onClick={() => toggleOne(it.email)} className="text-slate-500 hover:text-slate-200 transition-colors">
                                            {selected.has(it.email) ? <CheckSquare size={15} className="text-indigo-400" /> : <Square size={15} />}
                                        </button>
                                    </td>
                                    <td className="px-4 py-3.5">
                                        <div className="flex items-center gap-3">
                                            <div className="w-8 h-8 rounded-lg bg-indigo-500/10 text-indigo-400 flex items-center justify-center shrink-0">
                                                <Mail size={15} />
                                            </div>
                                            <div className="flex flex-col gap-0.5">
                                                <div className="flex items-center gap-2">
                                                    <span className="text-[12.5px] font-medium text-slate-200">{it.email}</span>
                                                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                                        <button
                                                            onClick={() => onCopy(it.email)}
                                                            className="p-1 hover:bg-white/10 rounded text-slate-500 hover:text-indigo-400 transition-colors"
                                                            title="Copy Email"
                                                        >
                                                            {copied === it.email ? <Check size={12} /> : <Copy size={12} />}
                                                        </button>
                                                        <button
                                                            onClick={() => onCopyFull(it)}
                                                            className="p-1 hover:bg-white/10 rounded text-slate-500 hover:text-amber-400 transition-colors"
                                                            title="Copy Full String (email|pass|token|uuid)"
                                                        >
                                                            <Database size={12} />
                                                        </button>
                                                    </div>
                                                </div>
                                                <div className="flex items-center gap-2">
                                                    <span className="text-[10px] font-mono text-slate-500 truncate max-w-[200px]">
                                                        {it.password ? '•'.repeat(8) : 'no-pass'} {it.refresh_token ? '| token' : ''}
                                                    </span>
                                                    <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider border ${it.auth_method === 'oauth2' ? 'bg-teal-500/10 text-teal-400 border-teal-500/20' : 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20'}`}>
                                                        {it.auth_method === 'oauth2' ? 'OAuth2' : 'GraphAPI'}
                                                    </span>
                                                </div>
                                            </div>
                                        </div>
                                    </td>
                                    <td className="px-4 py-3.5">
                                        <StatusChip status={it.mail_status} />
                                    </td>
                                    <td className="px-4 py-3.5">
                                        <div className="flex gap-1.5 flex-wrap">
                                            {Object.keys(it.services || {}).length > 0 ? (
                                                Object.entries(it.services || {}).map(([s, st]) => (
                                                    <ServiceTag key={s} name={s} status={st as string} />
                                                ))
                                            ) : it.chatgpt_status === 'done' ? (
                                                <ServiceTag name="chatgpt" status="done" />
                                            ) : (
                                                <span className="text-[11px] text-slate-600 italic">Chưa đăng ký</span>
                                            )}
                                        </div>
                                    </td>
                                    <td className="px-4 py-3.5">
                                        <div className="flex gap-2 justify-end opacity-0 group-hover:opacity-100 transition-opacity">
                                            <Button variant="ghost" size="sm" title="Verify mail" onClick={() => checkStatus(it)} className="text-cyan-400 hover:bg-cyan-500/10 border-cyan-500/20">
                                                <Activity size={13} /> Verify
                                            </Button>
                                            <Button variant="ghost" size="sm" title="Bắt đầu đăng ký" onClick={() => startRegistration(it)} className="text-emerald-400 hover:bg-emerald-500/10 border-emerald-500/20">
                                                <Play size={13} /> Register
                                            </Button>
                                            <Button variant="danger" size="icon-sm" onClick={() => confirmDeleteOne(it.email)}>
                                                <Trash2 size={13} />
                                            </Button>
                                        </div>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>

                {/* Footer */}
                {filtered.length > 0 && (
                    <div className="px-5 py-3 border-t border-white/5 flex items-center justify-between text-[11.5px] text-slate-500">
                        <span>Hiển thị {filtered.length} / {items.length} email</span>
                        {selected.size > 0 && <span className="text-indigo-400 font-semibold">Đã chọn {selected.size} email</span>}
                    </div>
                )}
            </Card>

            {confirm && (
                <ConfirmModal
                    title={confirm.title}
                    message={confirm.message}
                    onConfirm={confirm.onConfirm}
                    onCancel={() => setConfirm(null)}
                    isLoading={actionLoading}
                />
            )}
        </div>
    );
}
