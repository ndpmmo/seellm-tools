'use client';
import React, { useState, useEffect, useRef } from 'react';
import { Play, SquareTerminal, CheckCircle2, XCircle, Clock, Zap, Image as ImageIcon, Settings2, Trash2, RotateCcw, AlertTriangle, AlertCircle, Copy, Check, Info, List, Mail, ShieldCheck, Database, RefreshCw } from 'lucide-react';
import { useApp } from '../../AppContext';
import { Button, Card, CardHeader, CardTitle, CardContent, Input, StatBox } from '../../ui';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
dayjs.extend(relativeTime);

// ───────────────────────────────────────────────────────────────
// Component chính
// ───────────────────────────────────────────────────────────────
export function VaultAutoRegisterView() {
    const { addToast, processes, liveShots, setView } = useApp();
    const [selectedEmail, setSelectedEmail] = useState<string | null>(null);
    const [searchTerm, setSearchTerm] = useState('');
    const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'done' | 'failed'>('all');
    const [emailPool, setEmailPool] = useState<any[]>([]);
    const [loadingPool, setLoadingPool] = useState(false);
    const [successAccounts, setSuccessAccounts] = useState<any[]>([]);
    const [inputText, setInputText] = useState('');
    // tasks chỉ lưu metadata: { id, email, raw, processId, userId }
    const [tasks, setTasks] = useState<any[]>([]);
    const [isRunning, setIsRunning] = useState(false);
    const logsEndRef = useRef<HTMLDivElement>(null);

    const [stats, setStats] = useState({ total: 0, mailReady: 0, chatGptDone: 0, failed: 0 });

    const getStatusColor = (status: string) => {
        switch (status) {
            case 'active': case 'done': return 'var(--green)';
            case 'processing': return 'var(--indigo)';
            case 'dead': case 'failed': return 'var(--rose)';
            default: return 'rgba(255,255,255,0.1)';
        }
    };

    const filteredPool = emailPool.filter(e => {
        const matchesSearch = e.email.toLowerCase().includes(searchTerm.toLowerCase());
        const matchesStatus = 
            statusFilter === 'all' ? true :
            statusFilter === 'active' ? e.mail_status === 'active' :
            statusFilter === 'done' ? e.chatgpt_status === 'done' :
            statusFilter === 'failed' ? e.chatgpt_status === 'failed' : true;
        return matchesSearch && matchesStatus;
    });

    const activeTask = tasks.find(t => t.email === selectedEmail) || tasks[0];
    const poolRecord = emailPool.find(e => e.email === selectedEmail);

    // Anim CSS
    const animStyle = `
        @keyframes pulse-indigo {
            0% { box-shadow: 0 0 0 0 rgba(99, 102, 241, 0.4); }
            70% { box-shadow: 0 0 0 8px rgba(99, 102, 241, 0); }
            100% { box-shadow: 0 0 0 0 rgba(99, 102, 241, 0); }
        }
    `;

    // ── Load dữ liệu ban đầu ──────────────────────────────────
    useEffect(() => {
        fetchPool();
        fetchSuccess();
    }, []);

    useEffect(() => {
        setStats({
            total: emailPool.length,
            mailReady: emailPool.filter(e => e.mail_status === 'active').length,
            chatGptDone: emailPool.filter(e => e.chatgpt_status === 'done').length,
            failed: emailPool.filter(e => e.chatgpt_status === 'failed').length
        });
    }, [emailPool]);

    const fetchPool = async () => {
        setLoadingPool(true);
        try {
            const res = await fetch('/api/vault/email-pool');
            const data = await res.json();
            if (data.ok) {
                setEmailPool(data.items);
                if (data.items.length > 0 && !selectedEmail) {
                    setSelectedEmail(data.items[0].email);
                }
            }
        } catch (_) {}
        setLoadingPool(false);
    };

    const fetchSuccess = async () => {
        try {
            const res = await fetch('/api/vault/accounts');
            const data = await res.json();
            if (data.ok) {
                // Lọc những acc có tag auto-register
                const filtered = data.items.filter((a: any) => 
                    (a.tags || []).includes('auto-register') || a.notes?.includes('Đăng ký tự động')
                );
                setSuccessAccounts(filtered.slice(0, 50));
            }
        } catch (_) {}
    };

    const checkEmailStatus = async (emailRecord: any) => {
        const raw = `${emailRecord.email}|${emailRecord.password}|${emailRecord.refresh_token}|${emailRecord.client_id}`;
        addToast(`Đang kiểm tra: ${emailRecord.email}`, 'info');
        try {
            const res = await fetch('/api/processes/script/run', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ scriptName: 'check-mail-worker.js', args: [raw] }),
            });
            const data = await res.json();
            if (data.error) throw new Error(data.error);
            addToast('Đang chạy kiểm tra mail...', 'success');
        } catch (err: any) {
            addToast(`Lỗi: ${err.message}`, 'error');
        }
    };

    const startAllPending = async () => {
        const pending = emailPool.filter(e => e.chatgpt_status === 'not_created' || e.chatgpt_status === 'failed');
        if (!pending.length) return addToast('Không có email nào cần đăng ký', 'info');
        
        addToast(`Bắt đầu đăng ký hàng loạt cho ${pending.length} email`, 'success');
        for (const e of pending) {
            await startRegistration(e);
            await new Promise(r => setTimeout(r, 5000));
        }
    };

    const verifyAllPool = async () => {
        const unknown = emailPool.filter(e => e.mail_status === 'unknown' || e.mail_status === 'dead');
        if (!unknown.length) return addToast('Tất cả email đã được verify', 'info');
        
        addToast(`Bắt đầu verify hàng loạt cho ${unknown.length} email`, 'success');
        for (const e of unknown) {
            await checkEmailStatus(e);
            await new Promise(r => setTimeout(r, 2000));
        }
    };

    // ── Xử lý Import Email ─────────────────────────────────────
    const handleImport = async () => {
        const lines = inputText.split('\n').map(l => l.trim()).filter(Boolean);
        if (!lines.length) return addToast('Nhập định dạng email|pass|refresh_token|client_id', 'error');

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
            } catch (_) {}
        }
        addToast(`Đã import ${count} tài khoản vào Pool`, 'success');
        setInputText('');
        fetchPool();
    };

    // ── Xử lý khi click bắt đầu từ Pool ───────────────────────
    const startRegistration = async (emailRecord: any) => {
        const raw = `${emailRecord.email}|${emailRecord.password}|${emailRecord.refresh_token}|${emailRecord.client_id}`;

        const newTask = {
            id: Math.random().toString(36).slice(2),
            raw,
            email: emailRecord.email,
            status: 'running',
            ts: new Date().toISOString()
        };

        setTasks(curr => [newTask, ...curr]);
        setSelectedEmail(emailRecord.email);

        try {
            const res = await fetch('/api/processes/script/run', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ scriptName: 'auto-register-worker.js', args: [raw] }),
            });
            const data = await res.json();
            if (data.error) throw new Error(data.error);
            setTasks(curr => curr.map(t => t.id === newTask.id ? { ...t, processId: data.id } : t));
        } catch (err: any) {
            addToast(`Lỗi: ${err.message}`, 'error');
        }
    };

    // ── Load tasks từ localStorage khi mount ───────────────────
    useEffect(() => {
        const saved = localStorage.getItem('autoRegTasks_v3');
        if (saved) {
            try { setTasks(JSON.parse(saved)); } catch (_) { }
        }
    }, []);

    // ── Lưu tasks vào localStorage khi thay đổi ───────────────
    useEffect(() => {
        if (tasks.length > 0) {
            localStorage.setItem('autoRegTasks_v3', JSON.stringify(tasks));
        } else {
            localStorage.removeItem('autoRegTasks_v3');
        }
    }, [tasks]);

    // ── Auto-scroll log khi có dữ liệu mới ───────────────────
    useEffect(() => {
        logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    });

    // ── Xử lý khi click bắt đầu ───────────────────────────────
    const handleStart = async () => {
        const lines = inputText.split('\n').map(l => l.trim()).filter(Boolean);
        if (!lines.length) return addToast('Nhập dữ liệu định dạng email|pass|refresh_token|client_id', 'error');

        const newTasks = lines.map(line => ({
            id: Math.random().toString(36).slice(2),
            raw: line,
            email: line.split('|')[0] || 'Unknown',
            processId: null as string | null,
            userId: null as string | null,
        }));

        setTasks(newTasks);
        setIsRunning(true);

        for (const task of newTasks) {
            try {
                const res = await fetch('/api/processes/script/run', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ scriptName: 'auto-register-worker.js', args: [task.raw] }),
                });
                const data = await res.json();
                if (data.error) throw new Error(data.error);

                setTasks(curr => curr.map(t => t.id === task.id ? { ...t, processId: data.id } : t));
            } catch (err: any) {
                addToast(`Lỗi khởi chạy: ${err.message}`, 'error');
            }
        }

        setIsRunning(false);
    };

    // ── Lấy logs từ AppContext.processes ─────────────────────
    const getTaskLogs = (task: any): string[] => {
        if (!task.processId) return [];
        const proc = processes[task.processId];
        if (!proc) return [];

        // Tự động cập nhật userId từ log "SESSION_ID: register_xxx"
        if (!task.userId) {
            const idLog = proc.logs.find(l => l.text?.includes('SESSION_ID:'));
            if (idLog) {
                const sid = idLog.text.split('SESSION_ID:')[1]?.trim();
                if (sid) {
                    setTimeout(() => {
                        setTasks(curr => curr.map(t =>
                            t.id === task.id && !t.userId ? { ...t, userId: sid } : t
                        ));
                    }, 0);
                }
            }
        }

        return proc.logs.map(l => `[${l.ts?.slice(11, 19) || '??:??:??'}] ${l.text}`);
    };

    const getTaskStatus = (task: any): string => {
        if (!task.processId) return 'pending';
        const proc = processes[task.processId];
        if (!proc) return 'pending';
        return proc.status;
    };

    const getScreenshots = (task: any): any[] => {
        if (!task.userId) return [];
        // Tìm tất cả sessions có userId trùng
        const shots: any[] = [];
        Object.entries(liveShots).forEach(([sid, shot]) => {
            if (sid.startsWith(task.userId)) shots.push(shot);
        });
        return shots;
    };

    const clearAll = () => {
        setTasks([]);
        localStorage.removeItem('autoRegTasks_v3');
    };

    return (
        <div className="flex-1 overflow-y-auto px-6 pb-10 flex flex-col gap-5 h-[calc(100vh-52px)]">
            <style>{animStyle}</style>
            
            <div className="flex justify-between items-end mt-2">
                <div className="flex flex-col">
                    <div className="text-xl font-bold text-slate-100">Dự án Đăng ký Tự động</div>
                    <div className="text-[13px] text-slate-400">Quản lý hệ thống đăng ký kho accounts ChatGPT tập trung.</div>
                </div>
                <div className="flex gap-3 items-center">
                    <Button variant="ghost" onClick={() => setView('vault-emails')}>
                        <List size={14} /> Quản lý Email Pool
                    </Button>
                    <div className="text-right">
                        <div className="text-[11px] font-bold text-slate-300 mb-1.5 uppercase tracking-wider">Tiến độ Pool: {stats.chatGptDone}/{stats.total}</div>
                        <div className="w-[300px] h-1.5 bg-white/10 rounded-full overflow-hidden">
                            <div className="h-full bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.8)] transition-all duration-500" style={{ width: `${stats.total > 0 ? (stats.chatGptDone / stats.total) * 100 : 0}%` }} />
                        </div>
                    </div>
                </div>
            </div>

            {/* ── Stats Header ── */}
            <div className="grid grid-cols-4 gap-5">
                <StatBox label="Tổng Email" value={stats.total} icon={Mail} colorClass="text-indigo-400" bgClass="bg-indigo-500/10" borderClass="border-indigo-500/50" active={statusFilter === 'all'} onClick={() => setStatusFilter('all')} />
                <StatBox label="Mail Ready" value={stats.mailReady} icon={ShieldCheck} colorClass="text-cyan-400" bgClass="bg-cyan-500/10" borderClass="border-cyan-500/50" active={statusFilter === 'active'} onClick={() => setStatusFilter('active')} />
                <StatBox label="ChatGPT Xong" value={stats.chatGptDone} icon={CheckCircle2} colorClass="text-emerald-400" bgClass="bg-emerald-500/10" borderClass="border-emerald-500/50" active={statusFilter === 'done'} onClick={() => setStatusFilter('done')} />
                <StatBox label="Thất bại" value={stats.failed} icon={XCircle} colorClass="text-rose-400" bgClass="bg-rose-500/10" borderClass="border-rose-500/50" active={statusFilter === 'failed'} onClick={() => setStatusFilter('failed')} />
            </div>

            <div className="grid grid-cols-[minmax(320px,1fr)_2fr_180px] gap-5 flex-1 min-h-0">
                
                {/* ── Cột 1: Explorer ── */}
                <Card className="flex flex-col overflow-hidden">
                    <CardHeader className="bg-black/10">
                        <CardTitle><Database size={14} className="text-indigo-400" /> Email Explorer</CardTitle>
                        <Button size="icon-sm" variant="ghost" onClick={fetchPool}><RefreshCw size={14} /></Button>
                    </CardHeader>
                    <div className="p-3 border-b border-white/5 flex gap-2 bg-black/5">
                        <Input 
                            placeholder="Tìm kiếm email..." 
                            value={searchTerm}
                            onChange={e => setSearchTerm(e.target.value)}
                        />
                        {statusFilter !== 'all' && (
                            <Button size="icon-sm" variant="ghost" className="shrink-0 !text-rose-400" onClick={() => setStatusFilter('all')}>
                                <XCircle size={14} />
                            </Button>
                        )}
                    </div>
                    <div className="flex-1 overflow-y-auto p-2">
                        {filteredPool.map(e => {
                            const isTaskRunning = tasks.some(t => t.email === e.email && getTaskStatus(t) === 'running');
                            return (
                                <div 
                                    key={e.email} 
                                    className={`px-3 py-2.5 rounded-lg cursor-pointer flex items-center justify-between transition-all mb-1 border-l-[3px] ${
                                        selectedEmail === e.email ? 'border-l-indigo-500 bg-white/5' : 'border-l-transparent hover:bg-white/[0.02]'
                                    }`}
                                    onClick={() => setSelectedEmail(e.email)}
                                >
                                    <div className="overflow-hidden flex-1">
                                        <div className="text-[13px] font-semibold text-slate-100">{e.email.split('@')[0]}</div>
                                        <div className="text-[10px] text-slate-400 truncate">{e.email}</div>
                                    </div>
                                    <div className="flex gap-1.5 shrink-0 ml-2">
                                        <div className="w-1.5 h-1.5 rounded-full" style={{ background: getStatusColor(e.mail_status) }} title={`Mail: ${e.mail_status}`} />
                                        <div className="w-1.5 h-1.5 rounded-full" style={{ background: getStatusColor(e.chatgpt_status) }} title={`ChatGPT: ${e.chatgpt_status}`} />
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </Card>

                {/* ── Cột 2: Monitor ── */}
                <Card className="flex flex-col overflow-hidden bg-[#1e1e23]/80 backdrop-blur-xl border border-white/10">
                    {poolRecord ? (
                        <>
                            <div className="px-5 py-4 border-b border-white/5 flex justify-between items-center bg-white/5">
                                <div className="flex items-center gap-3">
                                    <div className="text-base font-bold text-slate-100">{poolRecord.email}</div>
                                    <div className="text-[11px] text-slate-300 bg-white/10 px-2 py-0.5 rounded-full flex items-center gap-1.5">
                                        <Clock size={10} /> {poolRecord.chatgpt_status === 'done' ? 'Completed' : poolRecord.chatgpt_status === 'processing' ? 'Processing' : 'Pending'}
                                    </div>
                                </div>
                                <div className="flex gap-2">
                                    <Button size="sm" onClick={() => checkEmailStatus(poolRecord)} title="Verify Mail Access">
                                        <Mail size={12} /> Verify
                                    </Button>
                                    <Button 
                                        variant="primary"
                                        size="sm" 
                                        onClick={() => startRegistration(poolRecord)}
                                        disabled={poolRecord.chatgpt_status === 'done' || poolRecord.chatgpt_status === 'processing'}
                                    >
                                        <Play size={12} /> Register
                                    </Button>
                                </div>
                            </div>
                            <div className="flex-1 flex flex-col min-h-0 bg-black/20">
                                {activeTask ? (
                                    <div className="flex-1 flex flex-col min-h-0">
                                        <div className="grid grid-cols-[minmax(0,1.5fr)_1fr] flex-1 min-h-0">
                                            {/* Logs Section */}
                                            <div className="bg-[#0a0a0f] border-r border-white/5 flex flex-col min-h-0">
                                                <div className="px-3 py-2 text-[10px] font-bold text-slate-500 bg-white/5 flex justify-between uppercase tracking-wider">
                                                    <span>Logging Output</span>
                                                    <span>PID: {activeTask.processId || '—'}</span>
                                                </div>
                                                <div className="p-3 text-[11px] text-slate-400 overflow-y-auto flex-1 font-mono leading-relaxed break-all">
                                                    {getTaskLogs(activeTask).map((l, i) => (
                                                        <div key={i} className={`mb-0.5 ${
                                                            /❌|🔴|error|failed/i.test(l) ? 'text-rose-400' : /✅|🟢|success|thành công/i.test(l) ? 'text-emerald-400' : ''
                                                        }`}>
                                                            {l}
                                                        </div>
                                                    ))}
                                                    <div ref={logsEndRef} />
                                                </div>
                                            </div>
                                            {/* Screenshots Section */}
                                            <div className="bg-[#0d0d12] overflow-y-auto p-3">
                                                <div className="text-[10px] font-bold text-slate-500 mb-3 uppercase tracking-wider">Screenshots ({getScreenshots(activeTask).length})</div>
                                                <div className="grid grid-cols-2 gap-2.5">
                                                    {getScreenshots(activeTask).map((img: any, idx: number) => (
                                                        <div key={idx} onClick={() => window.open(img.url, '_blank')}
                                                            className="relative cursor-pointer rounded-lg overflow-hidden border border-white/10 hover:border-indigo-500/50 transition-colors group aspect-video bg-black/50 flex items-center justify-center"
                                                        >
                                                            <img src={img.url} alt="step" className="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity" />
                                                            <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent text-slate-200 text-[8px] font-mono px-2 py-1.5 truncate">
                                                                {img.filename}
                                                            </div>
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                ) : (
                                    <div className="flex-1 flex items-center justify-center text-center p-10">
                                        <div className="flex flex-col items-center">
                                            <div className="w-16 h-16 rounded-2xl bg-indigo-500/10 flex items-center justify-center text-indigo-400 mb-4">
                                                <Clock size={32} />
                                            </div>
                                            <div className="font-medium text-slate-300">Chưa có tiến trình đang chạy cho email này.</div>
                                            <Button variant="secondary" className="mt-4 !text-indigo-400 !border-indigo-500/30 hover:!bg-indigo-500/10" onClick={() => startRegistration(poolRecord)}>Bắt đầu đăng ký ngay</Button>
                                        </div>
                                    </div>
                                )}
                            </div>
                        </>
                    ) : (
                        <div className="flex-1 flex items-center justify-center text-center">
                            <div className="flex flex-col items-center gap-3">
                                <Database size={40} className="text-slate-600" />
                                <span className="text-slate-400 text-sm">Chọn một email từ danh sách bên trái để xem chi tiết</span>
                            </div>
                        </div>
                    )}
                </Card>

                {/* ── Cột 3: Actions ── */}
                <div className="flex flex-col gap-5">
                    <Card className="flex flex-col gap-3 p-4 bg-[#1e1e23]/80 backdrop-blur-xl border border-white/10">
                        <div className="text-[11px] font-bold text-slate-300 uppercase tracking-widest mb-1">Quick Actions</div>
                        <Button variant="ghost" className="justify-start border-white/10 hover:bg-white/10" onClick={() => (document.getElementById('import-modal') as any)?.showModal()}>
                            <List size={14} className="text-indigo-400" /> Import List
                        </Button>
                        <Button variant="primary" className="justify-start shadow-md shadow-indigo-500/20" onClick={startAllPending}>
                            <Play size={14} /> Start Pending
                        </Button>
                        <Button variant="ghost" className="justify-start border-white/10 hover:bg-white/10" onClick={verifyAllPool}>
                            <ShieldCheck size={14} className="text-cyan-400" /> Verify All Pool
                        </Button>
                        <Button variant="ghost" className="justify-start border-white/10 hover:bg-white/10" onClick={fetchPool}>
                            <RefreshCw size={14} className="text-slate-400" /> Refresh Pool
                        </Button>
                        <div className="h-px bg-white/10 my-1" />
                        <Button variant="danger" className="justify-start" onClick={clearAll}>
                            <Trash2 size={14} /> Clear Stats
                        </Button>
                    </Card>

                    <Card className="flex-1 p-4 bg-[#1e1e23]/80 backdrop-blur-xl border border-white/10">
                        <div className="text-[11px] font-bold text-slate-300 uppercase tracking-widest mb-4">Recent Success</div>
                        <div className="flex flex-col gap-3">
                            {successAccounts.slice(0, 5).map(a => (
                                <div key={a.id} className="pb-2.5 border-b border-white/5 last:border-0 last:pb-0">
                                    <div className="font-semibold text-slate-200 text-[12.5px]">{a.email.split('@')[0]}</div>
                                    <div className="flex justify-between items-center mt-1 text-[11px]">
                                        <span className="text-emerald-400 font-medium">Success</span>
                                        <span className="text-slate-500">{dayjs(a.created_at).fromNow()}</span>
                                    </div>
                                </div>
                            ))}
                            {successAccounts.length === 0 && (
                                <div className="text-center py-6 flex flex-col items-center gap-2">
                                    <Zap size={20} className="text-slate-600" />
                                    <span className="text-xs text-slate-500">Chưa có tài khoản nào được tạo.</span>
                                </div>
                            )}
                        </div>
                    </Card>
                </div>
            </div>

            {/* ── Modal Import ── */}
            <dialog id="import-modal" className="m-auto rounded-xl bg-[#0f111a] border border-white/10 p-0 shadow-2xl backdrop-blur-3xl w-[440px] text-slate-200">
                <div className="px-5 py-4 border-b border-white/5 font-semibold">
                    Import Email List
                </div>
                <div className="p-5 flex flex-col gap-3">
                    <p className="text-xs text-slate-400">Định dạng: <code className="font-mono text-indigo-400 bg-indigo-500/10 px-1 rounded">email|pass|refresh_token|client...</code></p>
                    <textarea 
                        className="w-full h-[300px] resize-none bg-black/40 border border-white/10 rounded-md p-3 text-[11px] font-mono text-slate-300 outline-none focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/20"
                        placeholder="user1@example.com|pass|refresh|client..."
                        value={inputText}
                        onChange={e => setInputText(e.target.value)}
                    />
                    <div className="flex justify-end gap-2 mt-2">
                        <Button variant="ghost" onClick={() => (document.getElementById('import-modal') as any)?.close()}>Hủy</Button>
                        <Button variant="primary" onClick={() => { handleImport(); (document.getElementById('import-modal') as any)?.close(); }}>Import</Button>
                    </div>
                </div>
            </dialog>

        </div>
    );
}

// ── Status Badge ───────────────────────────────────────────────
function StatusBadge({ status }: { status: string }) {
    const s: Record<string, { color: string; icon: React.ReactNode; label: string }> = {
        pending: { color: 'var(--text-3)', icon: <Clock size={11} />, label: 'Pending' },
        running: { color: 'var(--cyan)', icon: <span className="spin" style={{ width: 11, height: 11 }} />, label: 'Đang chạy' },
        stopped: { color: 'var(--green)', icon: <CheckCircle2 size={11} />, label: 'Xong' },
        success: { color: 'var(--green)', icon: <CheckCircle2 size={11} />, label: 'Thành công' },
        error: { color: 'var(--rose)', icon: <XCircle size={11} />, label: 'Lỗi' },
    };
    const cfg = s[status] || s.pending;
    return (
        <span style={{ color: cfg.color, fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }}>
            {cfg.icon} {cfg.label}
        </span>
    );
}
