'use client';
import React, { useState, useEffect, useCallback } from 'react';
import {
    Mail, Search, Plus, Trash2, RefreshCw, CheckCircle2, XCircle,
    Clock, Play, ShieldCheck, List, FileText, Database, Import,
    Layers, Filter, ChevronRight, MoreHorizontal, Copy, Check, Activity
} from 'lucide-react';
import { useApp } from '../../AppContext';
import { Button, Card, CardHeader, CardTitle, CardContent, Input, StatBox } from '../../ui';
import dayjs from 'dayjs';

/* ── Status Badge ── */
function StatusChip({ status, label }: { status: string; label: string }) {
    const isReady = status === 'active';
    return (
        <div className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-semibold border ${
            isReady ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400' : 'bg-white/5 border-white/5 text-slate-400'
        }`}>
            <div className={`w-1.5 h-1.5 rounded-full ${isReady ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]' : 'bg-slate-500'}`} />
            {label}
        </div>
    );
}

/* ── Service Tag ── */
function ServiceTag({ name, status }: { name: string; status: string }) {
    const configs: Record<string, { color: string; bg: string; border: string }> = {
        chatgpt: { color: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/20' },
        claude: { color: 'text-orange-400', bg: 'bg-orange-500/10', border: 'border-orange-500/20' },
        gemini: { color: 'text-blue-400', bg: 'bg-blue-500/10', border: 'border-blue-500/20' },
        anthropic: { color: 'text-orange-300', bg: 'bg-orange-500/10', border: 'border-orange-500/20' },
        cursor: { color: 'text-teal-400', bg: 'bg-teal-500/10', border: 'border-teal-500/20' },
        codex: { color: 'text-indigo-400', bg: 'bg-indigo-500/10', border: 'border-indigo-500/20' }
    };

    const cfg = configs[name.toLowerCase()] || { color: 'text-slate-400', bg: 'bg-slate-500/10', border: 'border-slate-500/20' };
    const isDone = status === 'done';

    return (
        <div className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-widest border ${
            isDone ? `${cfg.bg} ${cfg.border} ${cfg.color}` : 'bg-transparent border-white/5 text-slate-500'
        }`}>
            {name}
        </div>
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
        failed: items.filter(e => e.chatgpt_status === 'failed').length
    };

    const filtered = items.filter(e => {
        const matchesSearch = e.email.toLowerCase().includes(searchTerm.toLowerCase());
        const matchesStatus =
            statusFilter === 'all' ? true :
                statusFilter === 'active' ? e.mail_status === 'active' :
                    statusFilter === 'dead' ? e.mail_status === 'dead' :
                        statusFilter === 'done' ? (Object.keys(e.services || {}).length > 0 || e.chatgpt_status === 'done') : true;
        return matchesSearch && matchesStatus;
    });

    const onCopy = (text: string) => {
        navigator.clipboard.writeText(text);
        setCopied(text);
        setTimeout(() => setCopied(null), 1500);
    };

    const handleImport = async () => {
        const lines = inputText.split('\n').map(l => l.trim()).filter(Boolean);
        if (!lines.length) return addToast('Nhập định dạng email|pass|refresh|client_id', 'error');

        let count = 0;
        for (const line of lines) {
            const [email, password, refresh_token, client_id] = line.split('|');
            if (!email) continue;
            try {
                await fetch('/api/vault/email-pool', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email, password, refresh_token, client_id }),
                });
                count++;
            } catch (_) { }
        }
        addToast(`✅ Đã import ${count} tài khoản vào Pool`, 'success');
        setInputText('');
        setShowImport(false);
        fetchPool();
    };

    const deleteEmail = async (email: string) => {
        if (!confirm(`Xóa ${email}?`)) return;
        try {
            const res = await fetch(`/api/vault/email-pool/${encodeURIComponent(email)}`, { method: 'DELETE' });
            if (res.ok) { fetchPool(); addToast('Đã xóa', 'success'); }
        } catch (_) { }
    };

    const checkStatus = async (it: any) => {
        const raw = `${it.email}|${it.password}|${it.refresh_token}|${it.client_id}`;
        addToast(`🔍 Checking: ${it.email}`, 'info');
        try {
            const res = await fetch('/api/processes/script/run', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ scriptName: 'check-mail-worker.js', args: [raw] }),
            });
            if (res.ok) addToast('Worker started', 'success');
        } catch (_) { }
    };

    return (
        <div className="flex-1 overflow-y-auto px-6 pb-10">
            {/* ── Header Area ── */}
            <div className="flex justify-between items-center mb-6 mt-2">
                <div>
                    <h2 className="text-xl font-bold text-slate-100 mb-1">Email Inventory</h2>
                    <p className="text-[13px] text-slate-400">Quản lý kho tài khoản đầu vào để dập dịch vụ hàng loạt.</p>
                </div>
                <div className="flex gap-3">
                    <Button variant="ghost" onClick={() => setView('vault-register')}>
                        <Layers size={14} /> Dự án Đăng ký
                    </Button>
                    <Button variant="primary" onClick={() => setShowImport(!showImport)}>
                        <Import size={14} /> Import Pool
                    </Button>
                </div>
            </div>

            {/* ── Stats Area ── */}
            <div className="grid grid-cols-4 gap-4 mb-6">
                <StatBox label="Total Pool" value={stats.total} icon={Mail} colorClass="text-indigo-400" bgClass="bg-indigo-500/10" borderClass="border-indigo-500/50" />
                <StatBox label="Mail Ready" value={stats.ready} icon={ShieldCheck} colorClass="text-emerald-400" bgClass="bg-emerald-500/10" borderClass="border-emerald-500/50" />
                <StatBox label="Registered" value={stats.registered} icon={CheckCircle2} colorClass="text-blue-400" bgClass="bg-blue-500/10" borderClass="border-blue-500/50" />
                <StatBox label="Check Failed" value={stats.failed} icon={XCircle} colorClass="text-rose-400" bgClass="bg-rose-500/10" borderClass="border-rose-500/50" />
            </div>

            {/* ── Main List Card ── */}
            <Card>
                {/* Card Filters */}
                <CardHeader>
                    <div className="flex items-center gap-4 w-full">
                        <div className="relative w-80">
                            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
                            <Input 
                                placeholder="Tìm theo email..." 
                                value={searchTerm} 
                                onChange={e => setSearchTerm(e.target.value)} 
                                className="pl-9"
                            />
                        </div>

                        <div className="flex items-center p-1 bg-white/5 border border-white/5 rounded-lg gap-1">
                            <FilterBtn active={statusFilter === 'all'} onClick={() => setStatusFilter('all')} label="Tất cả" />
                            <FilterBtn active={statusFilter === 'active'} onClick={() => setStatusFilter('active')} label="Ready" />
                            <FilterBtn active={statusFilter === 'done'} onClick={() => setStatusFilter('done')} label="Đã dập" />
                            <FilterBtn active={statusFilter === 'dead'} onClick={() => setStatusFilter('dead')} label="Dead" />
                        </div>

                        <Button variant="ghost" size="icon-sm" onClick={fetchPool} className="ml-auto">
                            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
                        </Button>
                    </div>
                </CardHeader>

                {/* Import Panel */}
                {showImport && (
                    <div className="p-5 border-b border-white/5 bg-black/10">
                        <label className="block text-xs font-semibold text-slate-400 mb-2">
                            Dán danh sách Email (Định dạng: <code className="text-indigo-400 font-mono">email|pass|refresh_token|client_id</code>)
                        </label>
                        <textarea
                            className="w-full h-40 bg-black/40 border border-white/10 rounded-md p-3 text-xs font-mono text-slate-200 focus:outline-none focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/20"
                            value={inputText}
                            onChange={e => setInputText(e.target.value)}
                            placeholder="user1@hotmail.com|pass123|...&#10;user2@hotmail.com|pass456|..."
                        />
                        <div className="mt-3 flex justify-end gap-2">
                            <Button variant="ghost" onClick={() => setShowImport(false)}>Hủy</Button>
                            <Button variant="primary" onClick={handleImport}>Bắt đầu nạp</Button>
                        </div>
                    </div>
                )}

                {/* Table Area */}
                <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse">
                        <thead>
                            <tr className="bg-white/5 border-b border-white/5">
                                <th className="px-5 py-3 text-[11px] font-bold text-slate-400 uppercase tracking-wider">Account / Credentials</th>
                                <th className="px-5 py-3 text-[11px] font-bold text-slate-400 uppercase tracking-wider">Status</th>
                                <th className="px-5 py-3 text-[11px] font-bold text-slate-400 uppercase tracking-wider">Services Registered</th>
                                <th className="px-5 py-3 text-[11px] font-bold text-slate-400 uppercase tracking-wider text-right">Actions</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-white/5">
                            {filtered.map(it => (
                                <tr key={it.email} className="hover:bg-white/[0.02] transition-colors group">
                                    <td className="px-5 py-4">
                                        <div className="flex items-center gap-3">
                                            <div className="w-8 h-8 rounded-lg bg-indigo-500/10 text-indigo-400 flex items-center justify-center shrink-0">
                                                <Mail size={16} />
                                            </div>
                                            <div>
                                                <div className="flex items-center gap-2">
                                                    <span className="font-semibold text-[13px] text-slate-200">{it.email}</span>
                                                    <button className="text-slate-500 hover:text-indigo-400 transition-colors" onClick={() => onCopy(it.email)}>
                                                        {copied === it.email ? <Check size={12} className="text-emerald-500" /> : <Copy size={12} />}
                                                    </button>
                                                </div>
                                                <div className="text-[11.5px] text-slate-500 mt-0.5 font-mono">Pass: {it.password}</div>
                                            </div>
                                        </div>
                                    </td>
                                    <td className="px-5 py-4">
                                        <StatusChip status={it.mail_status} label={it.mail_status === 'active' ? 'READY' : it.mail_status.toUpperCase()} />
                                    </td>
                                    <td className="px-5 py-4">
                                        <div className="flex gap-1.5 flex-wrap">
                                            {Object.keys(it.services || {}).length > 0 ? (
                                                Object.entries(it.services || {}).map(([s, st]) => (
                                                    <ServiceTag key={s} name={s} status={st as string} />
                                                ))
                                            ) : (
                                                it.chatgpt_status === 'done' ? <ServiceTag name="chatgpt" status="done" /> :
                                                    <span className="text-[11px] text-slate-500 italic">Chưa đăng ký</span>
                                            )}
                                        </div>
                                    </td>
                                    <td className="px-5 py-4 text-right">
                                        <div className="flex gap-2 justify-end opacity-0 group-hover:opacity-100 transition-opacity">
                                            <Button variant="ghost" size="icon-sm" title="Check mail status" onClick={() => checkStatus(it)} className="text-indigo-400 hover:bg-indigo-500/10 hover:border-indigo-500/20">
                                                <Activity size={14} />
                                            </Button>
                                            <Button variant="danger" size="icon-sm" onClick={() => deleteEmail(it.email)}>
                                                <Trash2 size={14} />
                                            </Button>
                                        </div>
                                    </td>
                                </tr>
                            ))}
                            {filtered.length === 0 && (
                                <tr>
                                    <td colSpan={4} className="py-16 text-center text-slate-500 text-[13px]">
                                        Không tìm thấy dữ liệu phù hợp.
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </Card>
        </div>
    );
}

/* ── UI Helpers ── */

function FilterBtn({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
    return (
        <button
            onClick={onClick}
            className={`px-3 py-1.5 rounded-md text-[11px] font-semibold transition-all ${
                active ? 'bg-white text-black shadow-sm' : 'bg-transparent text-slate-400 hover:text-slate-200 hover:bg-white/5'
            }`}
        >
            {label}
        </button>
    );
}
