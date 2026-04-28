'use client';
import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
    Mail, Search, Plus, Trash2, RefreshCw, CheckCircle2, XCircle,
    ShieldCheck, Import, Filter, Copy, Check, Database, Activity, Play,
    ChevronRight, Square, CheckSquare, AlertCircle, Clock, Zap, List,
    LayoutGrid, Settings2, BarChart3, ArrowRight, Terminal, Link2,
    Inbox, MailOpen
} from 'lucide-react';
import { useApp } from '../../AppContext';
import { Button, Card, CardHeader, CardTitle, CardContent, Input, StatBox } from '../../ui';
import { ConfirmModal } from '../../Views';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';

dayjs.extend(relativeTime);

// ───────────────────────────────────────────────────────────────
// Sub-components
// ───────────────────────────────────────────────────────────────

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

function ServiceTag({ name, status }: { name: string; status: string }) {
    const cfg: Record<string, { color: string; bg: string; border: string }> = {
        chatgpt: { color: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/20' },
        claude: { color: 'text-orange-400', bg: 'bg-orange-500/10', border: 'border-orange-500/20' },
        gemini: { color: 'text-blue-400', bg: 'bg-blue-500/10', border: 'border-blue-500/20' },
    };
    const c = cfg[name.toLowerCase()] || { color: 'text-slate-400', bg: 'bg-slate-500/10', border: 'border-slate-500/20' };
    const isDone = status === 'done';
    return (
        <div className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-widest border ${isDone ? `${c.bg} ${c.border} ${c.color}` : 'bg-transparent border-white/5 text-slate-600'}`}>
            {name}
        </div>
    );
}

// ───────────────────────────────────────────────────────────────
// Main View
// ───────────────────────────────────────────────────────────────

export function VaultWorkshopView() {
    const { addToast, processes, liveShots, socket } = useApp();
    const [activeTab, setActiveTab] = useState<'pool' | 'queue' | 'results' | 'inbox'>('pool');
    
    // Pool State
    const [items, setItems] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [searchTerm, setSearchTerm] = useState('');
    const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'dead' | 'done'>('all');
    const [showImport, setShowImport] = useState(false);
    const [inputText, setInputText] = useState('');
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [actionLoading, setActionLoading] = useState(false);
    const [confirm, setConfirm] = useState<{ title: string; message: string; onConfirm: () => Promise<void> } | null>(null);
    const [copied, setCopied] = useState<string | null>(null);

    // Queue State
    const [tasks, setTasks] = useState<any[]>([]);
    const [selectedTaskEmail, setSelectedTaskEmail] = useState<string | null>(null);
    const logsEndRef = useRef<HTMLDivElement>(null);

    // Inbox state
    const [inboxSelectedEmail, setInboxSelectedEmail] = useState<string | null>(null);
    const [inboxMessages, setInboxMessages] = useState<any[]>([]);
    const [inboxLoading, setInboxLoading] = useState(false);
    const [inboxSelectedMsg, setInboxSelectedMsg] = useState<any | null>(null);
    const [inboxMsgLoading, setInboxMsgLoading] = useState(false);
    const [inboxMsgContent, setInboxMsgContent] = useState<any | null>(null);
    const [inboxSearch, setInboxSearch] = useState('');

    // Proxy assignment state (per email → proxy URL)
    const [proxyMap, setProxyMap] = useState<Record<string, string>>({});
    const [vaultProxies, setVaultProxies] = useState<{ id: string; label: string; url: string }[]>([]);

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

    // Load unified proxy state for selector + restore account mappings
    useEffect(() => {
        fetch('/api/proxy/state')
            .then(r => r.json())
            .then(d => {
                const p = Array.isArray(d?.proxies) ? d.proxies : [];
                setVaultProxies(p.map((it: any) => ({ id: it.id, label: it.label || '', url: it.url })));
                const bindings = Array.isArray(d?.bindings) ? d.bindings : [];
                const mapFromBindings: Record<string, string> = {};
                for (const b of bindings) {
                    if (b?.email && b?.proxy_url) mapFromBindings[String(b.email)] = String(b.proxy_url);
                }
                setProxyMap(prev => {
                    const merged = { ...mapFromBindings, ...prev };
                    localStorage.setItem('workshopProxyMap_v1', JSON.stringify(merged));
                    return merged;
                });
            }).catch(() => {});
    }, []);

    // Subscribe to socket events for real-time email pool updates
    useEffect(() => {
        if (!socket) return;

        const handleEmailPoolUpdate = () => {
            fetchPool();
        };

        socket.on('email-pool-updated', handleEmailPoolUpdate);
        return () => {
            socket.off('email-pool-updated', handleEmailPoolUpdate);
        };
    }, [socket]); // eslint-disable-line react-hooks/exhaustive-deps

    // Restore proxy map from localStorage
    useEffect(() => {
        try { const s = localStorage.getItem('workshopProxyMap_v1'); if (s) setProxyMap(JSON.parse(s)); } catch (_) {}
    }, []);

    // Persistent Tasks
    useEffect(() => {
        const saved = localStorage.getItem('autoRegTasks_v4');
        if (saved) {
            try { setTasks(JSON.parse(saved)); } catch (_) { }
        }
    }, []);

    useEffect(() => {
        localStorage.setItem('autoRegTasks_v4', JSON.stringify(tasks));
    }, [tasks]);

    // Auto-scroll logs
    useEffect(() => {
        if (logsEndRef.current) {
            logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
        }
    }, [processes, selectedTaskEmail]);

    // Sync Task Session ID from logs
    useEffect(() => {
        tasks.forEach(task => {
            if (!task.userId && task.processId) {
                const proc = processes[task.processId];
                if (proc) {
                    const idLog = proc.logs.find(l => l.text?.includes('SESSION_ID:'));
                    if (idLog) {
                        const sid = idLog.text.split('SESSION_ID:')[1]?.trim();
                        if (sid) {
                            setTasks(curr => curr.map(t => 
                                t.id === task.id ? { ...t, userId: sid } : t
                            ));
                        }
                    }
                }
            }
        });
    }, [processes, tasks]);
    
    // Sync missing tasks from global background processes (for persistence/refresh)
    useEffect(() => {
        Object.keys(processes).forEach(pid => {
            const proc = processes[pid];
            // Match relevant worker scripts
            const isRelevant = proc.name === 'auto-register-worker.js' || proc.name === 'check-mail-worker.js';
            if (isRelevant) {
                setTasks(curr => {
                    if (curr.some(t => t.processId === pid)) return curr;

                    // Extract email from logs or args
                    let email = 'Unknown';
                    const regLog = proc.logs.find(l => l.text?.includes('Bắt đầu đăng ký:'));
                    if (regLog) {
                        email = regLog.text.split('Bắt đầu đăng ký:')[1]?.split(' ')[0]?.trim() || 'Unknown';
                    } else if (proc.args && proc.args[0]) {
                        email = proc.args[0].split('|')[0] || 'Unknown';
                    }

                    if (email === 'Unknown') return curr;

                    const newTask = {
                        id: `synced_${pid}_${Date.now()}`,
                        email: email,
                        status: proc.status,
                        ts: proc.startedAt || new Date().toISOString(),
                        processId: pid,
                        userId: null
                    };
                    return [newTask, ...curr];
                });
            }
        });
    }, [processes]);

    // Common Actions
    const startRegistration = async (emailRecord: any, proxyUrl?: string) => {
        const proxy = proxyUrl || proxyMap[emailRecord.email] || '';
        const raw = `${emailRecord.email}|${emailRecord.password || ''}|${emailRecord.auth_method || 'graph'}|${emailRecord.refresh_token || ''}|${emailRecord.client_id || ''}|${proxy}`;
        
        const newTask = {
            id: Math.random().toString(36).slice(2),
            email: emailRecord.email,
            status: 'running',
            ts: new Date().toISOString(),
            userId: null
        };

        setTasks(curr => [newTask, ...curr]);
        setSelectedTaskEmail(emailRecord.email);
        setActiveTab('queue');

        try {
            const res = await fetch('/api/processes/script/run', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ scriptName: 'auto-register-worker.js', args: [raw] }),
            });
            const data = await res.json();
            if (data.error) throw new Error(data.error);
            setTasks(curr => curr.map(t => t.id === newTask.id ? { ...t, processId: data.id } : t));
            addToast(`🚀 Đã bắt đầu đăng ký: ${emailRecord.email}`, 'success');
        } catch (err: any) {
            addToast(`❌ Lỗi: ${err.message}`, 'error');
        }
    };

    const checkStatus = async (it: any) => {
        const raw = `${it.email}|${it.password || ''}|${it.auth_method || 'graph'}|${it.refresh_token || ''}|${it.client_id || ''}`;
        addToast(`🔍 Đang kiểm tra: ${it.email}`, 'info');
        try {
            await fetch('/api/processes/script/run', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ scriptName: 'check-mail-worker.js', args: [raw] }),
            });
        } catch (_) { }
    };

    const startRegistrationWithConnect = async (emailRecord: any, proxyUrl?: string) => {
        const proxy = proxyUrl || proxyMap[emailRecord.email] || '';
        const raw = `${emailRecord.email}|${emailRecord.password || ''}|${emailRecord.auth_method || 'graph'}|${emailRecord.refresh_token || ''}|${emailRecord.client_id || ''}|${proxy}|oauth=1`;

        const newTask = {
            id: Math.random().toString(36).slice(2),
            email: emailRecord.email,
            status: 'running',
            ts: new Date().toISOString(),
            userId: null,
            mode: 'register+connect',
        };

        setTasks(curr => [newTask, ...curr]);
        setSelectedTaskEmail(emailRecord.email);
        setActiveTab('queue');

        try {
            const res = await fetch('/api/processes/script/run', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ scriptName: 'auto-register-worker.js', args: [raw] }),
            });
            const data = await res.json();
            if (data.error) throw new Error(data.error);
            setTasks(curr => curr.map(t => t.id === newTask.id ? { ...t, processId: data.id } : t));
            addToast(`🚀 Đăng ký + Kết nối Codex: ${emailRecord.email}`, 'success');
        } catch (err: any) {
            addToast(`❌ Lỗi: ${err.message}`, 'error');
        }
    };

    // Filtered Pool
    const filteredPool = items.filter(e => {
        const matchSearch = e.email.toLowerCase().includes(searchTerm.toLowerCase());
        const matchStatus =
            statusFilter === 'all' ? true :
                statusFilter === 'active' ? e.mail_status === 'active' :
                    statusFilter === 'dead' ? e.mail_status === 'dead' :
                        statusFilter === 'done' ? (Object.keys(e.services || {}).length > 0 || e.chatgpt_status === 'done') : true;
        return matchSearch && matchStatus;
    });

    const handleImport = async () => {
        const lines = inputText.split('\n').map(l => l.trim()).filter(Boolean);
        if (!lines.length) return addToast('Vui lòng nhập danh sách', 'error');
        let count = 0;
        const newEmails: any[] = [];
        
        for (const line of lines) {
            const parts = line.split('|');
            let email, password, refresh_token, client_id, auth_method;

            if (parts.length === 3) {
                [email, refresh_token, client_id] = parts;
                password = ''; 
                auth_method = 'oauth2';
            } else if (parts.length >= 4) {
                [email, password, refresh_token, client_id] = parts;
                auth_method = 'graph';
            } else {
                continue;
            }

            if (!email || !refresh_token) continue;

            try {
                const res = await fetch('/api/vault/email-pool', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email, password, refresh_token, client_id, auth_method }),
                });
                if (res.ok) {
                    count++;
                    // Optimistic update: add email to state immediately with checking status
                    newEmails.push({
                        email,
                        password: '********',
                        refresh_token: '********',
                        client_id: '********',
                        auth_method,
                        mail_status: 'unknown',
                        chatgpt_status: null,
                        linked_chatgpt_id: null,
                        services: {},
                        created_at: new Date().toISOString(),
                        updated_at: new Date().toISOString(),
                    });
                }

                // Auto-trigger check-mail-worker
                const raw = `${email}|${password || ''}|${auth_method}|${refresh_token}|${client_id}`;
                fetch('/api/processes/script/run', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ scriptName: 'check-mail-worker.js', args: [raw] }),
                }).catch(() => {});
            } catch (_) { }
        }

        if (count > 0) {
            addToast(`✅ Đã import và bắt đầu kiểm tra ${count} email`, 'success');
            // Optimistic update: add new emails to the top of the list
            setItems(prev => [...newEmails, ...prev]);
        }

        setInputText('');
        setShowImport(false);
        // Remove fetchPool() call to avoid full reload - optimistic update already done
        // fetchPool();
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

    const startAllPending = async () => {
        const pending = items.filter(e => e.chatgpt_status === 'not_created' || e.chatgpt_status === 'failed');
        if (!pending.length) return addToast('Không có email nào cần đăng ký', 'info');

        addToast(`Bắt đầu đăng ký hàng loạt cho ${pending.length} email`, 'success');
        for (const e of pending) {
            await startRegistration(e);
            await new Promise(r => setTimeout(r, 5000));
        }
    };

    const startAllPendingWithConnect = async () => {
        const pending = items.filter(e => e.chatgpt_status === 'not_created' || e.chatgpt_status === 'failed');
        if (!pending.length) return addToast('Không có email nào cần đăng ký', 'info');

        addToast(`Bắt đầu đăng ký + connect hàng loạt cho ${pending.length} email`, 'success');
        for (const e of pending) {
            await startRegistrationWithConnect(e);
            await new Promise(r => setTimeout(r, 5000));
        }
    };

    const verifyAllPool = async () => {
        const unknown = items.filter(e => e.mail_status === 'unknown' || e.mail_status === 'dead');
        if (!unknown.length) return addToast('Tất cả email đã được verify', 'info');

        addToast(`Bắt đầu verify hàng loạt cho ${unknown.length} email`, 'success');
        for (const e of unknown) {
            await checkStatus(e);
            await new Promise(r => setTimeout(r, 2000));
        }
    };

    const clearAllTasks = () => {
        setTasks([]);
        localStorage.removeItem('autoRegTasks_v4');
        addToast('Đã xoá lịch sử Queue', 'success');
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

    const toggleSelectAll = () => {
        if (filteredPool.length > 0 && filteredPool.every(e => selected.has(e.email))) {
            setSelected(prev => { const n = new Set(prev); filteredPool.forEach(e => n.delete(e.email)); return n; });
        } else {
            setSelected(prev => { const n = new Set(prev); filteredPool.forEach(e => n.add(e.email)); return n; });
        }
    };

    const toggleOne = (email: string) => {
        setSelected(prev => { const n = new Set(prev); n.has(email) ? n.delete(email) : n.add(email); return n; });
    };

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

    // ── Inbox helpers ──────────────────────────────────────────────────────
    const openInbox = async (email: string) => {
        setActiveTab('inbox');
        setInboxSelectedEmail(email);
        setInboxMessages([]);
        setInboxSelectedMsg(null);
        setInboxMsgContent(null);
        setInboxLoading(true);
        try {
            const res = await fetch(`/api/vault/inbox/${encodeURIComponent(email)}`);
            const data = await res.json();
            if (data.ok) setInboxMessages(data.messages);
            else addToast(`❌ ${data.error}`, 'error');
        } catch (e: any) { addToast(`❌ ${e.message}`, 'error'); }
        setInboxLoading(false);
    };

    const openMessage = async (msg: any) => {
        if (inboxSelectedMsg?.id === msg.id) return;
        setInboxSelectedMsg(msg);
        setInboxMsgContent(null);
        setInboxMsgLoading(true);
        // Optimistically mark as read in list
        if (!msg.isRead) {
            setInboxMessages(prev => prev.map(m => m.id === msg.id ? { ...m, isRead: true } : m));
            fetch('/api/vault/inbox/mark-read', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: inboxSelectedEmail, messageId: msg.id }),
            }).catch(() => {});
        }
        try {
            const res = await fetch('/api/vault/inbox/message', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: inboxSelectedEmail, messageId: msg.id }),
            });
            const data = await res.json();
            if (data.ok) setInboxMsgContent(data.message);
            else addToast(`❌ ${data.error}`, 'error');
        } catch (e: any) { addToast(`❌ ${e.message}`, 'error'); }
        setInboxMsgLoading(false);
    };

    const deleteInboxMessage = async (msgId: string) => {
        try {
            const res = await fetch('/api/vault/inbox/delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: inboxSelectedEmail, messageId: msgId }),
            });
            const data = await res.json();
            if (data.ok) {
                setInboxMessages(prev => prev.filter(m => m.id !== msgId));
                if (inboxSelectedMsg?.id === msgId) { setInboxSelectedMsg(null); setInboxMsgContent(null); }
                addToast('🗑️ Đã xóa email', 'success');
            } else addToast(`❌ ${data.error}`, 'error');
        } catch (e: any) { addToast(`❌ ${e.message}`, 'error'); }
    };

    return (
        <div className="absolute inset-0 overflow-y-auto px-6 pb-10 pt-2 flex flex-col gap-5 custom-scrollbar">
            {/* Header / Tabs */}
            <div className="flex justify-between items-end mt-4">
                <div className="flex flex-col gap-1">
                    <div className="text-2xl font-bold text-slate-100 flex items-center gap-3">
                        <Zap className="text-indigo-400" size={24} /> Vault Workshop
                    </div>
                    <div className="text-slate-400 text-sm">Hệ thống quản lý và dập account tự động tập trung.</div>
                </div>
                
                <div className="flex bg-black/20 p-1 rounded-xl border border-white/5 backdrop-blur-md">
                    <button 
                        onClick={() => setActiveTab('pool')}
                        className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all ${activeTab === 'pool' ? 'bg-white text-black shadow-lg' : 'text-slate-400 hover:text-slate-200'}`}
                    >
                        <Database size={16} /> Email Pool
                    </button>
                    <button 
                        onClick={() => setActiveTab('queue')}
                        className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all ${activeTab === 'queue' ? 'bg-white text-black shadow-lg' : 'text-slate-400 hover:text-slate-200'}`}
                    >
                        <Activity size={16} /> Workshop Queue
                        {tasks.filter(t => (processes[t.processId]?.status === 'running')).length > 0 && (
                            <span className="w-2 h-2 rounded-full bg-indigo-500 animate-pulse ml-1" />
                        )}
                    </button>
                    <button 
                        onClick={() => setActiveTab('results')}
                        className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all ${activeTab === 'results' ? 'bg-white text-black shadow-lg' : 'text-slate-400 hover:text-slate-200'}`}
                    >
                        <CheckCircle2 size={16} /> Results
                    </button>
                    <button 
                        onClick={() => setActiveTab('inbox')}
                        className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all ${activeTab === 'inbox' ? 'bg-white text-black shadow-lg' : 'text-slate-400 hover:text-slate-200'}`}
                    >
                        <Inbox size={16} /> Inbox
                        {inboxMessages.filter(m => !m.isRead).length > 0 && (
                            <span className="min-w-[18px] h-[18px] px-1 rounded-full bg-indigo-500 text-white text-[10px] font-bold flex items-center justify-center">
                                {inboxMessages.filter(m => !m.isRead).length}
                            </span>
                        )}
                    </button>
                </div>
            </div>

            {/* Content Rendering */}
            <div className="flex-1 min-h-0 flex flex-col gap-6">
                {activeTab === 'pool' && (
                    <div className="flex flex-col gap-5">
                        <div className="grid grid-cols-4 gap-4">
                            <StatBox label="Tổng Pool" value={items.length} icon={Mail} colorClass="text-indigo-400" bgClass="bg-indigo-500/10" active={statusFilter === 'all'} onClick={() => setStatusFilter('all')} />
                            <StatBox label="Mail Ready" value={items.filter(e => e.mail_status === 'active').length} icon={ShieldCheck} colorClass="text-emerald-400" bgClass="bg-emerald-500/10" active={statusFilter === 'active'} onClick={() => setStatusFilter('active')} />
                            <StatBox label="Đã Dập" value={items.filter(e => e.chatgpt_status === 'done').length} icon={CheckCircle2} colorClass="text-blue-400" bgClass="bg-blue-500/10" active={statusFilter === 'done'} onClick={() => setStatusFilter('done')} />
                            <StatBox label="Lỗi / Dead" value={items.filter(e => e.mail_status === 'dead').length} icon={XCircle} colorClass="text-rose-400" bgClass="bg-rose-500/10" active={statusFilter === 'dead'} onClick={() => setStatusFilter('dead')} />
                        </div>

                        <Card className="flex flex-col flex-1 min-h-[320px]">
                            <CardHeader>
                                <div className="flex items-center gap-4 w-full">
                                    <div className="relative w-72">
                                        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
                                        <Input placeholder="Tìm kiếm email..." value={searchTerm} onChange={e => setSearchTerm(e.target.value)} className="pl-9" />
                                    </div>
                                    <div className="ml-auto flex items-center gap-2">
                                        {selected.size > 0 && (
                                            <Button variant="danger" size="sm" onClick={() => setConfirm({ title: 'Xóa Email', message: `Xóa ${selected.size} email đã chọn?`, onConfirm: doDeleteSelected })}>
                                                <Trash2 size={13} /> Xóa ({selected.size})
                                            </Button>
                                        )}
                                        <Button variant="ghost" size="sm" onClick={verifyAllPool}>
                                            <ShieldCheck size={14} className="text-cyan-400" /> Verify WaitList
                                        </Button>
                                        <Button variant="primary" size="sm" onClick={startAllPending} className="shadow-indigo-500/20">
                                            <Play size={14} /> Start Pending
                                        </Button>
                                        <Button variant="primary" size="sm" onClick={startAllPendingWithConnect} className="bg-emerald-600 hover:bg-emerald-500">
                                            <Link2 size={14} /> Start Pending + Connect
                                        </Button>
                                        <Button variant="ghost" size="sm" onClick={syncAllToD1} disabled={actionLoading}>
                                            <Database size={14} className={actionLoading ? 'animate-pulse text-indigo-400' : ''} />
                                            {actionLoading ? 'Đang Sync...' : 'Sync All to D1'}
                                        </Button>
                                        <Button variant="ghost" size="sm" onClick={() => setShowImport(!showImport)}>
                                            <Import size={14} /> Import Pool
                                        </Button>
                                        <Button variant="ghost" size="icon-sm" onClick={fetchPool}>
                                            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
                                        </Button>
                                    </div>
                                </div>
                            </CardHeader>

                            {showImport && (
                                <div className="px-5 py-4 border-b border-white/5 bg-black/20">
                                    <label className="block text-[11px] font-semibold text-slate-400 mb-2 uppercase tracking-wider">
                                        Nhập danh sách (email|pass|refresh|client hoặc email|refresh|client)
                                    </label>
                                    <textarea
                                        className="w-full h-32 bg-black/40 border border-white/10 rounded-lg p-3 text-[12px] font-mono text-slate-200 focus:outline-none focus:border-indigo-500/50 resize-none"
                                        value={inputText}
                                        onChange={e => setInputText(e.target.value)}
                                        placeholder="user@outlook.com|pass|refresh|client_id"
                                    />
                                    <div className="mt-3 flex justify-end gap-2">
                                        <Button variant="ghost" size="sm" onClick={() => setShowImport(false)}>Hủy</Button>
                                        <Button variant="primary" size="sm" onClick={handleImport}>Nạp dữ liệu</Button>
                                    </div>
                                </div>
                            )}

                            <div className="flex-1 min-h-0 overflow-auto custom-scrollbar">
                                <table className="w-full min-w-[1100px] text-left border-collapse">
                                    <thead>
                                        <tr className="bg-white/[0.03] border-b border-white/5">
                                            <th className="px-4 py-3 w-10">
                                                <button onClick={toggleSelectAll} className="text-slate-500 hover:text-slate-200 transition-colors">
                                                    {filteredPool.length > 0 && filteredPool.every(e => selected.has(e.email)) ? <CheckSquare size={15} className="text-indigo-400" /> : <Square size={15} />}
                                                </button>
                                            </th>
                                            <th className="px-4 py-3 text-[11px] font-bold text-slate-400 uppercase tracking-wider">Email / Credentials</th>
                                            <th className="px-4 py-3 text-[11px] font-bold text-slate-400 uppercase tracking-wider">Status</th>
                                            <th className="px-4 py-3 text-[11px] font-bold text-slate-400 uppercase tracking-wider">Services</th>
                                            <th className="px-4 py-3 text-[11px] font-bold text-slate-400 uppercase tracking-wider min-w-[160px]">Proxy</th>
                                            <th className="px-4 py-3 text-[11px] font-bold text-slate-400 uppercase tracking-wider text-right">Actions</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-white/[0.04]">
                                        {filteredPool.map(it => (
                                            <tr key={it.email} className={`hover:bg-white/[0.025] transition-colors group ${selected.has(it.email) ? 'bg-indigo-500/5' : ''}`}>
                                                <td className="px-4 py-3.5">
                                                    <button onClick={() => toggleOne(it.email)} className="text-slate-500 hover:text-slate-200 transition-colors">
                                                        {selected.has(it.email) ? <CheckSquare size={15} className="text-indigo-400" /> : <Square size={15} />}
                                                    </button>
                                                </td>
                                                <td className="px-4 py-3.5">
                                                    <div className="flex items-center gap-3">
                                                        <div className="w-8 h-8 rounded-lg bg-indigo-500/10 text-indigo-400 flex items-center justify-center shrink-0">
                                                            <Mail size={14} />
                                                        </div>
                                                        <div className="flex flex-col gap-0.5">
                                                            <div className="flex items-center gap-2">
                                                                <span className="text-[13px] font-medium text-slate-200">{it.email}</span>
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
                                                            <span className="text-[10px] text-slate-500 font-mono mt-0.5">
                                                                {it.auth_method === 'oauth2' ? 'OAuth2' : 'GraphAPI'} | {it.password ? 'Has Password' : 'No Pass'}
                                                            </span>
                                                        </div>
                                                    </div>
                                                </td>
                                                <td className="px-4 py-3.5"><StatusChip status={it.mail_status} /></td>
                                                <td className="px-4 py-3.5">
                                                    <div className="flex gap-1">
                                                        {it.chatgpt_status === 'done' ? <ServiceTag name="chatgpt" status="done" /> : <span className="text-slate-600 text-[11px] italic">Chưa dập</span>}
                                                    </div>
                                                </td>
                                                {/* Proxy column */}
                                                <td className="px-4 py-3.5 min-w-[160px]">
                                                    <div className="flex flex-col gap-1">
                                                        <select
                                                            className="h-7 rounded-md bg-black/30 border border-white/10 text-[11px] text-slate-300 px-2 outline-none focus:border-indigo-500/50 w-full"
                                                            value={proxyMap[it.email] || ''}
                                                            onChange={e => {
                                                                const val = e.target.value;
                                                                setProxyMap(prev => {
                                                                    const n = { ...prev, [it.email]: val };
                                                                    localStorage.setItem('workshopProxyMap_v1', JSON.stringify(n));
                                                                    return n;
                                                                });
                                                            }}
                                                        >
                                                            <option value="">(Không proxy)</option>
                                                            {vaultProxies.map(p => (
                                                                <option key={p.id} value={p.url} className="bg-[#0f172a]">
                                                                    {p.label || p.url}
                                                                </option>
                                                            ))}
                                                        </select>
                                                        {proxyMap[it.email] && (
                                                            <code className="text-[10px] text-indigo-400 font-mono truncate max-w-[150px]" title={proxyMap[it.email]}>
                                                                {proxyMap[it.email]}
                                                            </code>
                                                        )}
                                                    </div>
                                                </td>
                                                <td className="px-4 py-3.5 text-right">
                                                    <div className="flex gap-2 justify-end opacity-0 group-hover:opacity-100 transition-all">
                                                        <Button variant="ghost" size="sm" onClick={() => checkStatus(it)} className="text-cyan-400" title="Verify Mail"><Activity size={13} /></Button>
                                                        <Button variant="ghost" size="sm" onClick={() => openInbox(it.email)} className="text-indigo-400" title="Xem Inbox"><Inbox size={13} /></Button>
                                                        <Button variant="primary" size="sm" onClick={() => startRegistration(it)} disabled={it.chatgpt_status === 'done' || it.chatgpt_status === 'processing'} title="Start Register"><Play size={13} /></Button>
                                                        <Button variant="primary" size="sm" onClick={() => startRegistrationWithConnect(it)} disabled={it.chatgpt_status === 'processing'} title="Register + Connect Codex" className="bg-emerald-600 hover:bg-emerald-500"><Link2 size={13} /></Button>
                                                    </div>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </Card>
                    </div>
                )}

                {activeTab === 'queue' && (
                    <div className="flex-1 min-h-0 grid grid-cols-[300px_1fr] gap-6">
                        <Card className="flex flex-col min-h-0">
                            <CardHeader className="bg-white/5 py-3">
                                <CardTitle><List size={14} /> Queue List ({tasks.length})</CardTitle>
                                <div className="ml-auto">
                                    {tasks.length > 0 && <Button variant="ghost" size="icon-sm" onClick={() => setConfirm({ title: 'Clear Queue', message: 'Bạn có chắc chắn muốn xoá toàn bộ lịch sử chạy của Queue này không?', onConfirm: async () => clearAllTasks() })} title="Clear Tasks"><Trash2 size={13} className="text-slate-400 hover:text-rose-500 transition-colors" /></Button>}
                                </div>
                            </CardHeader>
                            <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-1">
                                {tasks.map(t => {
                                    const proc = processes[t.processId];
                                    const status = proc?.status || 'pending';
                                    return (
                                        <div 
                                            key={t.id}
                                            onClick={() => setSelectedTaskEmail(t.email)}
                                            className={`p-3 rounded-xl cursor-pointer transition-all border ${selectedTaskEmail === t.email ? 'bg-indigo-500/10 border-indigo-500/30' : 'bg-white/[0.02] border-transparent hover:bg-white/5'}`}
                                        >
                                            <div className="flex justify-between items-start mb-1">
                                                <div className="text-[13px] font-bold text-slate-100 truncate flex-1">{t.email.split('@')[0]}</div>
                                                <div className="flex items-center gap-1">
                                                    {t.mode === 'register+connect' && (
                                                        <span className="text-[9px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-400 uppercase font-bold tracking-wider">OAUTH</span>
                                                    )}
                                                    <div className={`text-[10px] px-1.5 py-0.5 rounded uppercase font-bold ${status === 'running' ? 'bg-indigo-500/20 text-indigo-400 animate-pulse' : status === 'stopped' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-500/20 text-slate-400'}`}>
                                                        {status}
                                                    </div>
                                                </div>
                                            </div>
                                            <div className="text-[10px] text-slate-500">{t.email}</div>
                                        </div>
                                    );
                                })}
                            </div>
                        </Card>

                        <div className="flex flex-col gap-6 min-h-0">
                            {selectedTaskEmail ? (
                                <>
                                    <div className="grid grid-cols-2 gap-6 flex-1 min-h-0">
                                        <Card className="flex flex-col bg-black/40 border-indigo-500/10">
                                            <CardHeader className="bg-white/5">
                                                <CardTitle><SquareTerminal size={14} /> Logic Logs</CardTitle>
                                                {selectedTaskEmail && <div className="text-[11px] text-slate-500">{selectedTaskEmail}</div>}
                                            </CardHeader>
                                            <div className="flex-1 p-4 font-mono text-[11px] text-slate-400 overflow-y-auto leading-relaxed custom-scrollbar bg-black/20">
                                                {(() => {
                                                    const task = tasks.find(t => t.email === selectedTaskEmail);
                                                    if (!task?.processId) return <div className="text-slate-600 italic">Chưa có logs...</div>;
                                                    const proc = processes[task.processId];
                                                    return proc?.logs.map((l, i) => (
                                                        <div key={i} className="mb-1">
                                                            <span className="text-slate-600 mr-2">[{l.ts?.slice(11, 19)}]</span>
                                                            <span className={/error|fail|❌/i.test(l.text) ? 'text-rose-400' : /success|done|✅/i.test(l.text) ? 'text-emerald-400' : ''}>
                                                                {l.text}
                                                            </span>
                                                        </div>
                                                    ));
                                                })()}
                                                <div ref={logsEndRef} />
                                            </div>
                                        </Card>

                                        <Card className="flex flex-col bg-black/40 border-indigo-500/10 overflow-hidden">
                                            <CardHeader className="bg-white/5">
                                                <CardTitle><LayoutGrid size={14} /> Screen Timeline</CardTitle>
                                            </CardHeader>
                                            <div className="flex-1 p-4 overflow-y-auto grid grid-cols-1 gap-4 custom-scrollbar">
                                                {(() => {
                                                    const task = tasks.find(t => t.email === selectedTaskEmail);
                                                    if (!task) return null;
                                                    const shots = Object.entries(liveShots)
                                                        .filter(([sid]) => sid.startsWith(task.userId || 'none'))
                                                        .map(([_, s]) => s);
                                                    
                                                    return shots.length > 0 ? shots.map((img: any, idx) => (
                                                        <div key={idx} className="relative group rounded-xl overflow-hidden border border-white/10 bg-black/50 aspect-video flex items-center justify-center">
                                                            <img src={img.url} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" />
                                                            <div className="absolute inset-x-0 bottom-0 p-3 bg-gradient-to-t from-black/90 to-transparent">
                                                                <div className="text-[10px] font-mono text-slate-300">{img.filename}</div>
                                                            </div>
                                                        </div>
                                                    )) : (
                                                        <div className="h-full flex flex-col items-center justify-center text-slate-600 gap-3">
                                                            <LayoutGrid size={32} strokeWidth={1} />
                                                            <div className="text-sm italic">Chưa có screenshot...</div>
                                                        </div>
                                                    );
                                                })()}
                                            </div>
                                        </Card>
                                    </div>
                                </>
                            ) : (
                                <div className="flex-1 flex flex-col items-center justify-center text-slate-500 gap-4 border-2 border-dashed border-white/5 rounded-2xl">
                                    <Activity size={48} strokeWidth={1} />
                                    <div>Chọn một email trong hàng đợi để theo dõi live.</div>
                                </div>
                            )}
                        </div>
                    </div>
                )}

                {activeTab === 'results' && (
                    <div className="flex flex-col gap-6 items-center justify-center py-20 text-slate-500 border-2 border-dashed border-white/5 rounded-3xl">
                        <CheckCircle2 size={64} strokeWidth={1} className="text-emerald-500/30" />
                        <div className="text-center">
                            <div className="text-xl font-bold text-slate-300">Kết quả sẽ hiển thị tại đây</div>
                            <div className="text-sm mt-2">Dữ liệu được lấy từ Vault Accounts với tag 'auto-register'.</div>
                        </div>
                        <Button variant="secondary" className="mt-4" onClick={() => setActiveTab('pool')}>Quay lại Pool</Button>
                    </div>
                )}

                {activeTab === 'inbox' && (
                    <div className="flex-1 min-h-0 grid grid-cols-[260px_320px_1fr] rounded-2xl overflow-hidden border border-white/[0.07] bg-black/20">
                        {/* ─── Left: Email list ─────────────────────────────────────── */}
                        <div className="flex flex-col border-r border-white/[0.07]">
                            <div className="px-4 py-3 border-b border-white/[0.07] bg-white/[0.02] shrink-0">
                                <div className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-2">Email Pool ({items.length})</div>
                                <div className="relative">
                                    <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
                                    <input
                                        className="w-full h-7 bg-black/30 border border-white/10 rounded-lg text-[11px] pl-7 pr-2 text-slate-300 outline-none focus:border-indigo-500/50"
                                        placeholder="Tìm email..."
                                        value={inboxSearch}
                                        onChange={e => setInboxSearch(e.target.value)}
                                    />
                                </div>
                            </div>
                            <div className="flex-1 overflow-y-auto custom-scrollbar">
                                {items
                                    .filter(e => e.email.toLowerCase().includes(inboxSearch.toLowerCase()))
                                    .map(it => (
                                        <div
                                            key={it.email}
                                            onClick={() => openInbox(it.email)}
                                            className={`px-3 py-2.5 cursor-pointer border-b border-white/[0.04] transition-colors ${
                                                inboxSelectedEmail === it.email
                                                    ? 'bg-indigo-500/10 border-l-2 border-l-indigo-500'
                                                    : 'hover:bg-white/[0.025]'
                                            }`}
                                        >
                                            <div className="flex items-center gap-2">
                                                <Mail size={13} className={inboxSelectedEmail === it.email ? 'text-indigo-400 shrink-0' : 'text-slate-600 shrink-0'} />
                                                <div className="flex-1 min-w-0">
                                                    <div className="text-[12px] font-medium text-slate-200 truncate">{it.email.split('@')[0]}</div>
                                                    <div className="text-[10px] text-slate-500 truncate">@{it.email.split('@')[1]}</div>
                                                </div>
                                                <div className={`w-2 h-2 rounded-full shrink-0 ${
                                                    it.mail_status === 'active' ? 'bg-emerald-500'
                                                    : it.mail_status === 'dead' ? 'bg-rose-500'
                                                    : 'bg-amber-400'
                                                }`} />
                                            </div>
                                        </div>
                                    ))
                                }
                            </div>
                        </div>

                        {/* ─── Middle: Message list ─────────────────────────────────── */}
                        <div className="flex flex-col border-r border-white/[0.07] min-h-0">
                            {inboxSelectedEmail ? (
                                <>
                                    <div className="px-4 py-2.5 border-b border-white/[0.07] bg-white/[0.02] flex items-center gap-2 shrink-0">
                                        <Inbox size={14} className="text-indigo-400 shrink-0" />
                                        <div className="flex-1 min-w-0">
                                            <div className="text-[11px] font-semibold text-slate-300 truncate">{inboxSelectedEmail}</div>
                                            {!inboxLoading && <div className="text-[10px] text-slate-500">{inboxMessages.length} thư · {inboxMessages.filter(m => !m.isRead).length} chưa đọc</div>}
                                        </div>
                                        <button
                                            onClick={() => openInbox(inboxSelectedEmail)}
                                            className="p-1 hover:bg-white/10 rounded text-slate-500 hover:text-indigo-400 transition-colors"
                                            title="Tải lại hộp thư"
                                        >
                                            <RefreshCw size={12} className={inboxLoading ? 'animate-spin text-indigo-400' : ''} />
                                        </button>
                                    </div>
                                    <div className="flex-1 overflow-y-auto custom-scrollbar">
                                        {inboxLoading ? (
                                            <div className="flex items-center justify-center h-32 text-slate-500 text-sm gap-2">
                                                <RefreshCw size={16} className="animate-spin" /> Đang tải...
                                            </div>
                                        ) : inboxMessages.length === 0 ? (
                                            <div className="flex flex-col items-center justify-center h-32 text-slate-600 gap-2 text-sm">
                                                <Inbox size={28} strokeWidth={1} /> Hộp thư trống
                                            </div>
                                        ) : inboxMessages.map(msg => (
                                            <div
                                                key={msg.id}
                                                onClick={() => openMessage(msg)}
                                                className={`px-4 py-3 cursor-pointer border-b border-white/[0.04] transition-colors ${
                                                    inboxSelectedMsg?.id === msg.id
                                                        ? 'bg-indigo-500/10 border-l-2 border-l-indigo-500'
                                                        : 'hover:bg-white/[0.025]'
                                                }`}
                                            >
                                                <div className="flex items-start gap-2">
                                                    <div className={`w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 ${
                                                        !msg.isRead ? 'bg-indigo-400' : 'bg-transparent'
                                                    }`} />
                                                    <div className="flex-1 min-w-0">
                                                        <div className={`text-[12px] truncate ${
                                                            !msg.isRead ? 'font-semibold text-slate-100' : 'font-normal text-slate-300'
                                                        }`}>
                                                            {msg.subject || '(no subject)'}
                                                        </div>
                                                        <div className="text-[10px] text-slate-500 truncate mt-0.5">
                                                            {msg.from?.emailAddress?.address || ''}
                                                        </div>
                                                        <div className="text-[10px] text-slate-600 line-clamp-1 mt-0.5">{msg.bodyPreview}</div>
                                                        <div className="text-[10px] text-slate-600 mt-1">{dayjs(msg.receivedDateTime).fromNow()}</div>
                                                    </div>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </>
                            ) : (
                                <div className="flex-1 flex flex-col items-center justify-center text-slate-600 gap-3">
                                    <Inbox size={32} strokeWidth={1} />
                                    <div className="text-sm">Chọn email để xem hộp thư</div>
                                </div>
                            )}
                        </div>

                        {/* ─── Right: Message detail ────────────────────────────────── */}
                        <div className="flex flex-col min-h-0">
                            {inboxSelectedMsg ? (
                                <>
                                    <div className="px-5 py-3 border-b border-white/[0.07] bg-white/[0.02] shrink-0">
                                        <div className="flex items-start justify-between gap-3">
                                            <div className="flex-1 min-w-0">
                                                <div className="text-[14px] font-semibold text-slate-100 leading-tight">
                                                    {(inboxMsgContent || inboxSelectedMsg)?.subject || '(no subject)'}
                                                </div>
                                                <div className="text-[11px] text-slate-500 mt-1">
                                                    From: {(inboxMsgContent || inboxSelectedMsg)?.from?.emailAddress?.address || '—'}
                                                </div>
                                                <div className="text-[11px] text-slate-600 mt-0.5">
                                                    {dayjs((inboxMsgContent || inboxSelectedMsg)?.receivedDateTime).format('DD/MM/YYYY HH:mm')}
                                                </div>
                                            </div>
                                            <button
                                                onClick={() => deleteInboxMessage((inboxMsgContent || inboxSelectedMsg).id)}
                                                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-400 hover:bg-rose-500/20 transition-colors text-[12px] font-medium shrink-0"
                                                title="Xóa email này"
                                            >
                                                <Trash2 size={12} /> Xóa
                                            </button>
                                        </div>
                                    </div>
                                    <div className="flex-1 overflow-y-auto custom-scrollbar">
                                        {inboxMsgLoading ? (
                                            <div className="flex items-center justify-center h-32 text-slate-500 gap-2">
                                                <RefreshCw size={16} className="animate-spin" /> Đang tải nội dung...
                                            </div>
                                        ) : inboxMsgContent?.body?.content ? (
                                            inboxMsgContent.body.contentType === 'html' ? (
                                                <iframe
                                                    srcDoc={inboxMsgContent.body.content}
                                                    className="w-full border-0 bg-white rounded-b-2xl"
                                                    style={{ minHeight: '400px', height: '100%' }}
                                                    sandbox="allow-same-origin allow-popups"
                                                    title="Email content"
                                                />
                                            ) : (
                                                <pre className="p-5 text-[12px] text-slate-300 whitespace-pre-wrap leading-relaxed font-mono">
                                                    {inboxMsgContent.body.content}
                                                </pre>
                                            )
                                        ) : (
                                            <div className="p-5 text-[12px] text-slate-500 italic">
                                                {inboxSelectedMsg?.bodyPreview || 'Đang tải...'}
                                            </div>
                                        )}
                                    </div>
                                </>
                            ) : (
                                <div className="flex-1 flex flex-col items-center justify-center text-slate-600 gap-3">
                                    <MailOpen size={40} strokeWidth={1} />
                                    <div className="text-sm">Chọn thư để đọc</div>
                                </div>
                            )}
                        </div>
                    </div>
                )}
            </div>

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

const SquareTerminal = ({ size, className }: any) => <Terminal size={size} className={className} />;
