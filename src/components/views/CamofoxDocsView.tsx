import React from 'react';
import { FileText, Info, Code, AlertTriangle, CheckCircle } from 'lucide-react';

export function CamofoxDocsView() {
  return (
    <div className="absolute inset-0 overflow-y-auto px-6 pb-10 pt-2 custom-scrollbar">
      <div className="bg-[#0d111c]/70 border border-white/5 rounded-xl shadow-lg overflow-hidden">
        <div className="px-5 py-3.5 border-b border-white/5">
          <h3 className="text-[13.5px] font-semibold text-slate-100 flex items-center gap-2">
            <FileText size={15} className="text-indigo-400" />
            Tài liệu Custom Camofox Browser
          </h3>
        </div>

        <div className="p-6 text-[13.5px] leading-relaxed text-slate-300">
          <div className="p-4 bg-blue-500/10 border border-blue-500/20 rounded-lg mb-6 flex gap-3">
            <Info size={18} className="text-blue-400 mt-0.5 shrink-0" />
            <div>
              Camofox gốc đủ cho thao tác tab cơ bản, nhưng chưa đủ tốt cho luồng OpenAI/Codex có <code className="text-cyan-400 bg-cyan-500/10 px-1 rounded text-[12px]">add_phone</code>, <code className="text-cyan-400 bg-cyan-500/10 px-1 rounded text-[12px]">consent</code>, redirect OAuth và session reuse.
              <br />
              Tài liệu này ghi lại toàn bộ phần vá cần thiết để sau này cập nhật Camofox vẫn có thể patch lại nhanh và đúng.
            </div>
          </div>

          <h3 className="flex items-center gap-2 text-[13.5px] font-bold text-slate-100 border-b border-white/10 pb-2 mb-4 mt-4">
            <CheckCircle size={16} className="text-emerald-400" /> Bản Đã Vá
          </h3>
          <div className="p-4 bg-white/[0.03] border border-white/10 rounded-lg mb-4 text-[12.5px] space-y-1.5">
            <div className="font-semibold text-slate-200 mb-2">Đường dẫn Camofox trên máy</div>
            {[
              ['Repo local', '/Users/ndpmmo/Documents/Tools/camofox-browser'],
              ['Server file', '/Users/ndpmmo/Documents/Tools/camofox-browser/server.js'],
              ['Node path', '/usr/local/bin/node'],
              ['API base', 'http://localhost:3144'],
            ].map(([label, val]) => (
              <div key={label} className="text-slate-400">{label}: <code className="text-cyan-400 bg-cyan-500/10 px-1 rounded">{val}</code></div>
            ))}
          </div>
          <ul className="pl-5 text-slate-400 flex flex-col gap-2 list-disc mb-6 text-[12.5px]">
            <li>Thư mục đã vá: <code className="text-cyan-400 bg-cyan-500/10 px-1 rounded">/Users/ndpmmo/Documents/Tools/camofox-browser</code></li>
            <li>Port đang dùng với Tools: <code className="text-cyan-400 bg-cyan-500/10 px-1 rounded">http://localhost:3144</code></li>
            <li>Node Tools phải dùng để start Camofox: <code className="text-cyan-400 bg-cyan-500/10 px-1 rounded">/usr/local/bin/node</code></li>
            <li>Phiên bản đã kiểm tra: <code className="text-cyan-400 bg-cyan-500/10 px-1 rounded">@askjo/camofox-browser@1.5.2</code></li>
          </ul>

          <h3 className="flex items-center gap-2 text-[13.5px] font-bold text-slate-100 border-b border-white/10 pb-2 mb-4 mt-6">
            <AlertTriangle size={16} className="text-amber-400" /> Vì sao cần vá
          </h3>
          <ul className="pl-5 text-slate-400 flex flex-col gap-2 list-disc mb-6 text-[12.5px]">
            <li>`auto-login-worker.js` cần native wait để bỏ polling snapshot nặng.</li>
            <li>Case `add_phone` cần đọc cookies và giữ nguyên session khi chuyển sang `codex/consent`.</li>
            <li>Click selector có thể treo lâu nếu DOM khác dự kiến, nên cần thêm API mạnh hơn như `goto` và `eval`.</li>
          </ul>

          {[
            ['GET /sessions/:userId/cookies', `app.get('/sessions/:userId/cookies', async (req, res) => {\n  const session = sessions.get(normalizeUserId(req.params.userId));\n  if (!session) return res.status(404).json({ error: 'Session not found' });\n  res.json(await session.context.cookies());\n});`],
            ['POST /tabs/:tabId/goto', `app.post('/tabs/:tabId/goto', async (req, res) => {\n  const { userId, url, waitUntil = 'domcontentloaded', timeout = 15000 } = req.body;\n  const found = sessions.get(normalizeUserId(userId)) && findTab(session, req.params.tabId);\n  if (!found) return res.status(404).json({ error: 'Tab not found' });\n  const response = await withTabLock(tabId, () => found.tabState.page.goto(url, { waitUntil, timeout }));\n  res.json({ ok: true, finalUrl: found.tabState.page.url() });\n});`],
            ['POST /tabs/:tabId/eval', `app.post('/tabs/:tabId/eval', async (req, res) => {\n  const { userId, expression, arg } = req.body;\n  // Evaluate expression in browser context\n  const result = await withTabLock(tabId, () => tabState.page.evaluate(\n    ({ expression, arg }) => new Function('arg', expression)(arg), { expression, arg }\n  ));\n  res.json({ ok: true, result });\n});`],
          ].map(([title, code]) => (
            <div key={title} className="mb-5">
              <h4 className="text-[12.5px] font-mono font-bold text-indigo-300 mb-2">{title}</h4>
              <pre className="bg-[#050810] border border-white/10 rounded-lg p-4 text-[11.5px] font-mono text-slate-300 overflow-x-auto">{code}</pre>
            </div>
          ))}

          <h3 className="flex items-center gap-2 text-[13.5px] font-bold text-slate-100 border-b border-white/10 pb-2 mb-4 mt-6">
            <CheckCircle size={16} className="text-emerald-400" /> Test Đã Xác Nhận
          </h3>
          <ul className="pl-5 text-slate-400 flex flex-col gap-2 list-disc text-[12.5px]">
            <li><code className="text-cyan-400 bg-cyan-500/10 px-1 rounded">/health</code> trả <code className="text-emerald-400 bg-emerald-500/10 px-1 rounded">browserConnected: true</code></li>
            <li>Tools start Camofox bằng <code className="text-cyan-400 bg-cyan-500/10 px-1 rounded">/usr/local/bin/node</code>, không phải <code className="text-slate-400 bg-white/5 px-1 rounded">node</code> chung chung</li>
            <li>Tạo tab thành công / <code className="text-cyan-400 bg-cyan-500/10 px-1 rounded">snapshot</code> thành công</li>
            <li><code className="text-cyan-400 bg-cyan-500/10 px-1 rounded">GET /tabs/:tabId/cookies</code> trả JSON hợp lệ</li>
            <li><code className="text-cyan-400 bg-cyan-500/10 px-1 rounded">POST /tabs/:tabId/goto</code> điều hướng thành công</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
