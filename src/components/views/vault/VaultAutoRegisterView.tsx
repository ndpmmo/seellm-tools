'use client';
import React, { useState, useEffect, useRef } from 'react';
import { Play, SquareTerminal, CheckCircle2, XCircle, Clock, Zap, Image as ImageIcon, Trash2, RefreshCw } from 'lucide-react';
import { useApp } from '../../AppContext';

// ───────────────────────────────────────────────────────────────
// Component chính
// ───────────────────────────────────────────────────────────────
export function VaultAutoRegisterView() {
    const { addToast, processes, liveShots } = useApp();
    const [inputText, setInputText] = useState('');
    // tasks chỉ lưu metadata: { id, email, raw, processId, userId }
    const [tasks, setTasks] = useState<any[]>([]);
    const [isRunning, setIsRunning] = useState(false);
    const logsEndRef = useRef<HTMLDivElement>(null);

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
        <div className="content">
            <div style={{ display: 'grid', gridTemplateColumns: '360px 1fr', gap: 20, height: 'calc(100vh - 120px)' }}>

                {/* ── Panel trái: Input ── */}
                <div className="card" style={{ display: 'flex', flexDirection: 'column' }}>
                    <div className="card-head">
                        <span className="card-title"><Zap size={14} color="var(--indigo)" /> Cấu hình Hàng loạt</span>
                        {tasks.length > 0 && (
                            <button onClick={clearAll} title="Xóa lịch sử" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-4)', padding: 4, display: 'flex' }}>
                                <Trash2 size={14} />
                            </button>
                        )}
                    </div>
                    <div className="card-body" style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 12 }}>
                        <p style={{ fontSize: 13, color: 'var(--text-3)' }}>
                            Mỗi dòng 1 tài khoản theo định dạng:<br />
                            <code style={{ fontSize: 11, color: 'var(--cyan)' }}>email|pass_email|refresh_token|client_id</code>
                        </p>

                        <textarea className="inp mono"
                            style={{ flex: 1, resize: 'none', fontSize: 11, lineHeight: 1.6 }}
                            placeholder={'email|password|refresh_token|client_id\nemail2|password2|...'}
                            value={inputText}
                            onChange={e => setInputText(e.target.value)}
                            disabled={isRunning}
                        />

                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                            <button className="btn btn-primary" style={{ height: 44 }} onClick={handleStart}
                                disabled={isRunning || !inputText.trim()}>
                                {isRunning
                                    ? <><span className="spin" style={{ width: 14, height: 14 }} /><span style={{ marginLeft: 8 }}>Đang khởi chạy...</span></>
                                    : <><Play size={15} /><span style={{ marginLeft: 8 }}>Bắt đầu Auto Register</span></>
                                }
                            </button>

                            {tasks.length > 0 && (
                                <div style={{ fontSize: 12, color: 'var(--text-4)', textAlign: 'center' }}>
                                    {tasks.length} tác vụ · Dữ liệu được giữ lại khi reload
                                </div>
                            )}
                        </div>
                    </div>
                </div>

                {/* ── Panel phải: Theo dõi ── */}
                <div className="card" style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                    <div className="card-head">
                        <span className="card-title"><SquareTerminal size={14} /> Theo dõi tiến trình ({tasks.length})</span>
                    </div>
                    <div className="card-body" style={{ padding: 0, flex: 1, overflowY: 'auto' }}>
                        {tasks.length === 0 ? (
                            <div style={{ padding: 60, textAlign: 'center', color: 'var(--text-4)' }}>
                                <RefreshCw size={28} strokeWidth={1} style={{ marginBottom: 12, opacity: 0.3 }} />
                                <div>Chưa có tác vụ nào. Nhập dữ liệu và nhấn bắt đầu.</div>
                            </div>
                        ) : (
                            <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
                                {tasks.map(t => {
                                    const logs = getTaskLogs(t);
                                    const status = getTaskStatus(t);
                                    const shots = getScreenshots(t);

                                    return (
                                        <div key={t.id} style={{ background: '#0c0c0f', border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
                                            {/* Header */}
                                            <div style={{ padding: '10px 16px', background: 'rgba(255,255,255,0.03)', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                                    <StatusBadge status={status} />
                                                    <span style={{ fontWeight: 600, fontSize: 13 }}>{t.email}</span>
                                                </div>
                                                <span style={{ fontSize: 10, color: 'var(--text-4)', fontFamily: 'monospace' }}>
                                                    {t.userId || t.processId || '—'}
                                                </span>
                                            </div>

                                            {/* Body: Logs + Screenshots */}
                                            <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr' }}>
                                                {/* Logs */}
                                                <div className="mono" style={{
                                                    padding: 12, fontSize: 11, lineHeight: 1.65,
                                                    color: '#8a8a9a', height: 240, overflowY: 'auto',
                                                    background: '#000', borderRight: '1px solid var(--border)'
                                                }}>
                                                    {logs.length === 0 ? (
                                                        <span style={{ color: 'var(--text-4)' }}>Đang đợi log từ tiến trình...</span>
                                                    ) : (
                                                        logs.map((l, i) => {
                                                            const isErr = /lỗi|error|fail|thất bại|❌|🔴/i.test(l);
                                                            const isOk = /✅|🎉|thành công|🟢/.test(l);
                                                            return (
                                                                <div key={i} style={{ color: isErr ? 'var(--rose)' : isOk ? 'var(--green)' : undefined, borderBottom: '1px solid rgba(255,255,255,0.025)', padding: '1px 0' }}>
                                                                    {l}
                                                                </div>
                                                            );
                                                        })
                                                    )}
                                                    <div ref={logsEndRef} />
                                                </div>

                                                {/* Screenshots */}
                                                <div style={{ padding: 12, background: '#111116', height: 240, overflowY: 'auto' }}>
                                                    <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-4)', marginBottom: 8, display: 'flex', gap: 5, alignItems: 'center' }}>
                                                        <ImageIcon size={11} /> ẢNH CHỤP ({shots.length})
                                                    </div>
                                                    {shots.length === 0 ? (
                                                        <div style={{ textAlign: 'center', paddingTop: 40, color: 'var(--text-4)', fontSize: 11 }}>
                                                            Chờ screenshot...
                                                        </div>
                                                    ) : (
                                                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(75px, 1fr))', gap: 6 }}>
                                                            {shots.map((img: any, idx: number) => (
                                                                <div key={idx} onClick={() => window.open(img.url, '_blank')}
                                                                    style={{ position: 'relative', cursor: 'pointer', borderRadius: 4, overflow: 'hidden', border: '1px solid var(--border)' }}>
                                                                    {/* eslint-disable-next-line @next/next/no-img-element */}
                                                                    <img src={img.url} alt="step" style={{ width: '100%', display: 'block' }} />
                                                                    <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, background: 'rgba(0,0,0,0.75)', color: '#eee', fontSize: 7, padding: '2px 3px', textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }}>
                                                                        {img.filename?.replace('.png', '')}
                                                                    </div>
                                                                </div>
                                                            ))}
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                </div>
            </div>
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
