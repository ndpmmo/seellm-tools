import React from 'react';
import { FileText, Info, Code, CheckCircle, AlertTriangle } from 'lucide-react';

export function CamofoxDocsView() {
  return (
    <div className="content">
      <div className="card">
        <div className="card-head">
          <span className="card-title">
            <FileText size={16} />
            Tài liệu Custom Camofox Browser
          </span>
        </div>
        <div className="card-body" style={{ padding: '24px', lineHeight: 1.7, fontSize: 14 }}>
          
          <div style={{ padding: '16px', background: 'var(--blue-dim)', border: '1px solid rgba(59, 130, 246, 0.2)', borderRadius: 8, marginBottom: 24, display: 'flex', gap: 12 }}>
            <Info size={20} color="var(--blue)" style={{ marginTop: 2, flexShrink: 0 }} />
            <div style={{ color: 'var(--text)' }}>
              Phiên bản Camofox gốc (<code>@askjo/camofox-browser</code>) được thiết kế để chống bot, bypass Cloudflare và xoay vòng Proxy. Tuy nhiên, nó thiếu một số tính năng chờ (wait) ở cấp độ Playwright.<br/>
              <b>Giải pháp:</b> Chúng ta đã can thiệp vào mã nguồn của <code>server.js</code> trong Camofox để bổ sung API. Tài liệu này lưu trữ các thay đổi đó để bạn dễ dàng "vá" lại khi cập nhật phiên bản Camofox mới.
            </div>
          </div>

          <h3 style={{ borderBottom: '1px solid var(--border-2)', paddingBottom: 8, marginBottom: 16, marginTop: 32, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Code size={18} /> Các API Endpoint Đã Thêm (Native Wait)
          </h3>
          <p style={{ color: 'var(--text-2)', marginBottom: 16 }}>
            Các Endpoint này giúp <code>auto-login-worker</code> từ bỏ việc Poll hình ảnh liên tục, thay vào đó phản ứng với giao diện ngay lập tức với tốc độ mili-giây. Chèn các đoạn code sau vào dưới <code>app.post('/tabs/:tabId/wait')</code> trong <code>server.js</code> của Camofox.
          </p>

          <h4 style={{ color: 'var(--text)' }}>1. Endpoint `wait-for-selector`</h4>
          <pre style={{ background: 'var(--bg-1)', padding: 16, borderRadius: 8, overflowX: 'auto', border: '1px solid var(--border-2)', color: 'var(--text-2)', fontFamily: 'monospace', fontSize: 13, marginBottom: 24 }}>
{`// Wait for selector
app.post('/tabs/:tabId/wait-for-selector', async (req, res) => {
  const tabId = req.params.tabId;
  try {
    const { userId, selector, timeout = 10000, state = 'visible' } = req.body;
    if (!userId || !selector) return res.status(400).json({ error: 'userId and selector required' });
    const session = sessions.get(normalizeUserId(userId));
    const found = session && findTab(session, tabId);
    if (!found) return res.status(404).json({ error: 'Tab not found' });

    const { tabState } = found;
    await withTabLock(tabId, async () => {
      await tabState.page.waitForSelector(selector, { timeout, state });
    });
    res.json({ ok: true });
  } catch (err) {
    if (err.message && err.message.toLowerCase().includes('timeout')) {
      return res.status(408).json({ ok: false, error: 'Timeout waiting for selector' });
    }
    log('error', 'wait-for-selector failed', { reqId: req.reqId, tabId, error: err.message });
    handleRouteError(err, req, res);
  }
});`}
          </pre>

          <h4 style={{ color: 'var(--text)' }}>2. Endpoint `wait-for-url`</h4>
          <pre style={{ background: 'var(--bg-1)', padding: 16, borderRadius: 8, overflowX: 'auto', border: '1px solid var(--border-2)', color: 'var(--text-2)', fontFamily: 'monospace', fontSize: 13, marginBottom: 24 }}>
{`// Wait for URL
app.post('/tabs/:tabId/wait-for-url', async (req, res) => {
  const tabId = req.params.tabId;
  try {
    const { userId, url, timeout = 10000 } = req.body;
    if (!userId || !url) return res.status(400).json({ error: 'userId and url required' });
    const session = sessions.get(normalizeUserId(userId));
    const found = session && findTab(session, tabId);
    if (!found) return res.status(404).json({ error: 'Tab not found' });

    const { tabState } = found;
    await withTabLock(tabId, async () => {
      await tabState.page.waitForURL(url, { timeout });
    });
    res.json({ ok: true });
  } catch (err) {
    if (err.message && err.message.toLowerCase().includes('timeout')) {
      return res.status(408).json({ ok: false, error: 'Timeout waiting for URL' });
    }
    log('error', 'wait-for-url failed', { reqId: req.reqId, tabId, error: err.message });
    handleRouteError(err, req, res);
  }
});`}
          </pre>

          <h3 style={{ borderBottom: '1px solid var(--border-2)', paddingBottom: 8, marginBottom: 16, marginTop: 40, display: 'flex', alignItems: 'center', gap: 8 }}>
            <AlertTriangle size={18} /> Quy trình vá (Patch) khi cập nhật bản mới
          </h3>
          <ol style={{ paddingLeft: 24, color: 'var(--text-2)', display: 'flex', flexDirection: 'column', gap: 12 }}>
            <li>Di chuyển vào thư mục cài đặt gốc Camofox: <code>cd /Users/.../camofox-browser</code></li>
            <li>Reset và xóa mọi thay đổi để tránh lỗi khi Pull: <code>git reset --hard</code></li>
            <li>Tải phiên bản mới nhất từ Github: <code>git pull</code></li>
            <li>Cập nhật các dependency: <code>npm install</code> &amp; <code>npx camoufox-js fetch</code> (Bật VPN nếu fetch lỗi DNS Github).</li>
            <li>Mở tệp <code>server.js</code> của Camofox. Tìm kiếm chuỗi <code>app.post('/tabs/:tabId/wait'</code></li>
            <li>Sao chép toàn bộ code 2 khối trên chèn ngay xuống bên dưới Endpoint vừa tìm thấy.</li>
            <li>Khởi động lại Camofox Browser.</li>
          </ol>

        </div>
      </div>
    </div>
  );
}
