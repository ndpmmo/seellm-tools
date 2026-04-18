import React from 'react';
import { FileText, Info, Code, AlertTriangle, CheckCircle } from 'lucide-react';

const box: React.CSSProperties = {
  background: 'var(--bg-1)',
  padding: 16,
  borderRadius: 8,
  overflowX: 'auto',
  border: '1px solid var(--border-2)',
  color: 'var(--text-2)',
  fontFamily: 'monospace',
  fontSize: 13,
  marginBottom: 20,
};

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

        <div className="card-body" style={{ padding: 24, lineHeight: 1.7, fontSize: 14 }}>
          <div style={{ padding: 16, background: 'var(--blue-dim)', border: '1px solid rgba(59, 130, 246, 0.2)', borderRadius: 8, marginBottom: 24, display: 'flex', gap: 12 }}>
            <Info size={20} color="var(--blue)" style={{ marginTop: 2, flexShrink: 0 }} />
            <div style={{ color: 'var(--text)' }}>
              Camofox gốc đủ cho thao tác tab cơ bản, nhưng chưa đủ tốt cho luồng OpenAI/Codex có <code>add_phone</code>, <code>consent</code>, redirect OAuth và session reuse.
              <br />
              Tài liệu này ghi lại toàn bộ phần vá cần thiết để sau này cập nhật Camofox vẫn có thể patch lại nhanh và đúng.
            </div>
          </div>

          <h3 style={{ borderBottom: '1px solid var(--border-2)', paddingBottom: 8, marginBottom: 16, marginTop: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
            <CheckCircle size={18} />
            Bản Đã Vá
          </h3>
          <div style={{ padding: 12, border: '1px solid var(--border-2)', borderRadius: 8, background: 'var(--bg-1)', marginBottom: 14 }}>
            <div style={{ fontWeight: 700, color: 'var(--text)', marginBottom: 6 }}>Đường dẫn Camofox trên máy</div>
            <div style={{ color: 'var(--text-2)' }}>Repo local: <code>/Users/ndpmmo/Documents/Tools/camofox-browser</code></div>
            <div style={{ color: 'var(--text-2)' }}>Server file: <code>/Users/ndpmmo/Documents/Tools/camofox-browser/server.js</code></div>
            <div style={{ color: 'var(--text-2)' }}>Node path: <code>/usr/local/bin/node</code></div>
            <div style={{ color: 'var(--text-2)' }}>API base: <code>http://localhost:3144</code></div>
          </div>
          <ul style={{ paddingLeft: 20, color: 'var(--text-2)', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <li>Thư mục đã vá: <code>/Users/ndpmmo/Documents/Tools/camofox-browser</code></li>
            <li>Port đang dùng với Tools: <code>http://localhost:3144</code></li>
            <li>Node Tools phải dùng để start Camofox: <code>/usr/local/bin/node</code></li>
            <li>Phiên bản đã kiểm tra: <code>@askjo/camofox-browser@1.5.2</code></li>
            <li>Route có sẵn trước khi vá: <code>wait-for-selector</code>, <code>wait-for-url</code>, <code>evaluate</code></li>
            <li>Route đã thêm mới: <code>GET /sessions/:userId/cookies</code>, <code>GET /tabs/:tabId/cookies</code>, <code>POST /tabs/:tabId/goto</code>, <code>POST /tabs/:tabId/eval</code></li>
          </ul>

          <h3 style={{ borderBottom: '1px solid var(--border-2)', paddingBottom: 8, marginBottom: 16, marginTop: 28, display: 'flex', alignItems: 'center', gap: 8 }}>
            <AlertTriangle size={18} />
            Vì sao cần vá
          </h3>
          <ul style={{ paddingLeft: 20, color: 'var(--text-2)', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <li>`auto-login-worker.js` cần native wait để bỏ polling snapshot nặng.</li>
            <li>Case `add_phone` cần đọc cookies và giữ nguyên session khi chuyển sang `codex/consent`.</li>
            <li>Click selector có thể treo lâu nếu DOM khác dự kiến, nên cần thêm API mạnh hơn như `goto` và `eval`.</li>
          </ul>

          <h3 style={{ borderBottom: '1px solid var(--border-2)', paddingBottom: 8, marginBottom: 16, marginTop: 32, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Info size={18} />
            Trạng thái hiện tại (2026-04-19)
          </h3>
          <ul style={{ paddingLeft: 20, color: 'var(--text-2)', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <li>Flow login ChatGPT web có thể hoàn tất đầy đủ (email/password/TOTP), xác nhận bằng <code>/api/auth/session</code> có user/account.</li>
            <li>Sau nhánh <code>add_phone</code>, bootstrap lại authorize thường quay về <code>https://auth.openai.com/log-in</code> và phải điền lại email/password.</li>
            <li>Lỗi <code>workspace/select</code> dạng <code>invalid_auth_step</code> hoặc <code>invalid_state</code> là lỗi ngữ cảnh authorize, không phải lỗi click đơn thuần.</li>
            <li>Nếu tài khoản bắt buộc xác minh số điện thoại, worker phải kết thúc <code>NEED_PHONE</code>; không có bypass API hợp lệ để lấy callback code.</li>
          </ul>

          <h3 style={{ borderBottom: '1px solid var(--border-2)', paddingBottom: 8, marginBottom: 16, marginTop: 32, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Code size={18} />
            Endpoint cần có
          </h3>

          <h4 style={{ color: 'var(--text)' }}>0. `GET /sessions/:userId/cookies`</h4>
          <pre style={box}>{`app.get('/sessions/:userId/cookies', async (req, res) => {
  try {
    const userId = req.params.userId;
    const session = sessions.get(normalizeUserId(userId));
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const cookies = await session.context.cookies();
    res.json(cookies);
  } catch (err) {
    res.status(500).json({ error: safeError(err) });
  }
});`}</pre>

          <h4 style={{ color: 'var(--text)' }}>1. `wait-for-selector`</h4>
          <pre style={box}>{`app.post('/tabs/:tabId/wait-for-selector', async (req, res) => {
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
    if (err.message?.toLowerCase().includes('timeout')) {
      return res.status(408).json({ ok: false, error: 'Timeout waiting for selector' });
    }
    handleRouteError(err, req, res);
  }
});`}</pre>

          <h4 style={{ color: 'var(--text)' }}>2. `wait-for-url`</h4>
          <pre style={box}>{`app.post('/tabs/:tabId/wait-for-url', async (req, res) => {
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
    if (err.message?.toLowerCase().includes('timeout')) {
      return res.status(408).json({ ok: false, error: 'Timeout waiting for URL' });
    }
    handleRouteError(err, req, res);
  }
});`}</pre>

          <h4 style={{ color: 'var(--text)' }}>3. `GET /tabs/:tabId/cookies`</h4>
          <pre style={box}>{`app.get('/tabs/:tabId/cookies', async (req, res) => {
  const tabId = req.params.tabId;
  try {
    const userId = req.query.userId || req.headers['x-user-id'];
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const session = sessions.get(normalizeUserId(userId));
    const found = session && findTab(session, tabId);
    if (!found) return res.status(404).json({ error: 'Tab not found' });
    const { tabState } = found;
    const cookies = await withTabLock(tabId, async () => {
      return await tabState.page.context().cookies();
    });
    res.json({ ok: true, cookies });
  } catch (err) {
    handleRouteError(err, req, res);
  }
});`}</pre>

          <h4 style={{ color: 'var(--text)' }}>4. `POST /tabs/:tabId/goto`</h4>
          <pre style={box}>{`app.post('/tabs/:tabId/goto', async (req, res) => {
  const tabId = req.params.tabId;
  try {
    const { userId, url, waitUntil = 'domcontentloaded', timeout = 15000 } = req.body;
    if (!userId || !url) return res.status(400).json({ error: 'userId and url required' });
    const session = sessions.get(normalizeUserId(userId));
    const found = session && findTab(session, tabId);
    if (!found) return res.status(404).json({ error: 'Tab not found' });
    const { tabState } = found;
    const response = await withTabLock(tabId, async () => {
      return await tabState.page.goto(url, { waitUntil, timeout });
    });
    res.json({ ok: true, finalUrl: tabState.page.url(), status: response?.status?.() ?? null });
  } catch (err) {
    handleRouteError(err, req, res);
  }
});`}</pre>

          <h4 style={{ color: 'var(--text)' }}>5. `POST /tabs/:tabId/eval`</h4>
          <pre style={box}>{`app.post('/tabs/:tabId/eval', async (req, res) => {
  const tabId = req.params.tabId;
  try {
    const { userId, expression, arg } = req.body;
    if (!userId || !expression) return res.status(400).json({ error: 'userId and expression required' });
    const session = sessions.get(normalizeUserId(userId));
    const found = session && findTab(session, tabId);
    if (!found) return res.status(404).json({ error: 'Tab not found' });
    const { tabState } = found;
    const result = await withTabLock(tabId, async () => {
      return await tabState.page.evaluate(
        ({ expression, arg }) => {
          const fn = new Function('arg', expression);
          return fn(arg);
        },
        { expression, arg }
      );
    });
    res.json({ ok: true, result });
  } catch (err) {
    handleRouteError(err, req, res);
  }
});`}</pre>

          <div style={{ color: 'var(--text-2)', marginTop: -6, marginBottom: 20 }}>
            Nếu Camofox đã có <code>/tabs/:tabId/evaluate</code>, vẫn nên giữ thêm alias <code>/eval</code> để Tools và tài liệu dùng cùng một tên route.
          </div>

          <h3 style={{ borderBottom: '1px solid var(--border-2)', paddingBottom: 8, marginBottom: 16, marginTop: 36, display: 'flex', alignItems: 'center', gap: 8 }}>
            <AlertTriangle size={18} />
            Lỗi Đã Gặp
          </h3>
          <div style={{ color: 'var(--text-2)', marginBottom: 12 }}>
            Khi khởi động Camofox trên <code>:3144</code>, đã gặp lỗi ABI của <code>better-sqlite3</code>. Dấu hiệu là <code>/health</code> vẫn sống nhưng <code>browserConnected</code> = <code>false</code>.
          </div>
          <pre style={box}>{`better-sqlite3.node was compiled against a different Node.js version
NODE_MODULE_VERSION 141
This version of Node.js requires NODE_MODULE_VERSION 127`}</pre>
          <div style={{ color: 'var(--text-2)', marginBottom: 8 }}>
            Cách xử lý đã áp dụng:
          </div>
          <pre style={box}>{`cd /Users/ndpmmo/Documents/Tools/camofox-browser
npm rebuild better-sqlite3
CAMOFOX_PORT=3144 npm start`}</pre>
          <div style={{ color: 'var(--text-2)', marginBottom: 8 }}>
            Nếu start từ UI của Tools, lệnh thực tế phải tương đương:
          </div>
          <pre style={box}>{`/usr/local/bin/node server.js`}</pre>
          <div style={{ color: 'var(--text-2)', marginBottom: 8 }}>
            Tools đã được sửa để dùng <code>camofoxNodePath=/usr/local/bin/node</code>, tránh phụ thuộc <code>PATH</code> và tránh chạy nhầm Node v25.
          </div>

          <h3 style={{ borderBottom: '1px solid var(--border-2)', paddingBottom: 8, marginBottom: 16, marginTop: 36, display: 'flex', alignItems: 'center', gap: 8 }}>
            <CheckCircle size={18} />
            Worker đang dùng phần nào
          </h3>
          <ul style={{ paddingLeft: 20, color: 'var(--text-2)', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <li>Đã fallback lấy cookies qua <code>/sessions/:userId/cookies</code> nếu route theo tab chưa có.</li>
            <li>Đã giảm timeout thao tác click ở nhánh bypass để tránh treo khoảng 30 giây.</li>
            <li>Đã ưu tiên <code>goto</code> lại <code>codex/consent</code> trên tab hiện tại.</li>
            <li>Đã chỉ mở tab mới nếu <code>goto</code> thất bại.</li>
            <li>Đã dùng <code>eval</code> để click/submit consent nếu selector thường không hoạt động.</li>
          </ul>

          <h3 style={{ borderBottom: '1px solid var(--border-2)', paddingBottom: 8, marginBottom: 16, marginTop: 36, display: 'flex', alignItems: 'center', gap: 8 }}>
            <FileText size={18} />
            Quy trình vá khi cập nhật bản mới
          </h3>
          <ol style={{ paddingLeft: 22, color: 'var(--text-2)', display: 'flex', flexDirection: 'column', gap: 10 }}>
            <li>Vào thư mục cài Camofox.</li>
            <li>Pull bản mới và cài lại dependency.</li>
            <li>Kiểm tra <code>tools.config.json</code> vẫn còn <code>camofoxNodePath=/usr/local/bin/node</code>.</li>
            <li>Nếu browser không connect sau khi start, chạy <code>npm rebuild better-sqlite3</code>.</li>
            <li>Mở `server.js`.</li>
            <li>Kiểm tra route nào đã có sẵn, chỉ vá lại route còn thiếu.</li>
            <li>Khởi động lại Camofox.</li>
            <li>Kiểm tra tối thiểu: `health`, `snapshot`, `GET /sessions/:userId/cookies`, `goto`, `GET /tabs/:tabId/cookies`, `eval`.</li>
          </ol>

          <h3 style={{ borderBottom: '1px solid var(--border-2)', paddingBottom: 8, marginBottom: 16, marginTop: 36, display: 'flex', alignItems: 'center', gap: 8 }}>
            <FileText size={18} />
            Debug Probes
          </h3>
          <div style={{ color: 'var(--text-2)', marginBottom: 8 }}>
            Dùng các probe dưới đây để đọc DOM thật trước khi thay selector trong worker.
          </div>
          <pre style={box}>{`cd /Users/ndpmmo/Documents/Github/seellm-tools
CAMOUFOX_API=http://localhost:3144 node scripts/debug/probe-chatgpt-login-dialog.js`}</pre>
          <pre style={box}>{`cd /Users/ndpmmo/Documents/Github/seellm-tools
CAMOUFOX_API=http://localhost:3144 node scripts/debug/probe-openai-auth-pages.js`}</pre>
          <pre style={box}>{`cd /Users/ndpmmo/Documents/Github/seellm-tools
PROBE_EMAIL='your-test-email@example.com' CAMOUFOX_API=http://localhost:3144 node scripts/debug/probe-openai-auth-pages.js`}</pre>
          <pre style={box}>{`cd /Users/ndpmmo/Documents/Github/seellm-tools
PROBE_EMAIL='your-test-email@example.com' CAMOUFOX_API=http://localhost:3144 node scripts/debug/probe-openai-auth-password.js`}</pre>
          <pre style={box}>{`cd /Users/ndpmmo/Documents/Github/seellm-tools
CHATGPT_LOGIN_DEBUG=1 npm run dev`}</pre>

          <h3 style={{ borderBottom: '1px solid var(--border-2)', paddingBottom: 8, marginBottom: 16, marginTop: 36, display: 'flex', alignItems: 'center', gap: 8 }}>
            <CheckCircle size={18} />
            Test Đã Xác Nhận
          </h3>
          <ul style={{ paddingLeft: 20, color: 'var(--text-2)', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <li><code>/health</code> trả <code>browserConnected: true</code></li>
            <li>Tools start Camofox bằng <code>/usr/local/bin/node</code>, không phải <code>node</code> chung chung</li>
            <li>Tạo tab thành công</li>
            <li><code>snapshot</code> thành công</li>
            <li><code>GET /tabs/:tabId/cookies</code> trả JSON hợp lệ</li>
            <li><code>POST /tabs/:tabId/goto</code> điều hướng thành công</li>
            <li><code>POST /tabs/:tabId/eval</code> trả kết quả hợp lệ</li>
            <li><code>GET /sessions/:userId/cookies</code> trả danh sách cookie</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
