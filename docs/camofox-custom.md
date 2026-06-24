# Tài liệu Custom Camofox Browser

Tài liệu này ghi lại toàn bộ phần custom cho Camofox để `seellm-tools` hoạt động ổn định hơn với luồng OpenAI/Codex login.

Mục tiêu của bản custom:
- giảm polling HTML/screenshot không cần thiết,
- tránh treo lâu khi `click` không match selector,
- hỗ trợ phase 2 cho case `add_phone -> consent/workspace`,
- giữ session/cookie đủ để worker tái sử dụng sau khi mở tab mới.

## Đường dẫn Camofox trên máy

- Camofox repo local: `/Users/ndpmmo/Documents/Tools/camofox-browser`
- File server chính: `/Users/ndpmmo/Documents/Tools/camofox-browser/server.js`
- Plugin seellm-tools: `/Users/ndpmmo/Documents/Tools/camofox-browser/plugins/seellm-tools/index.js`
- Node path Tools dùng để start Camofox: `/usr/local/bin/node`
- Base URL API (local): `http://localhost:3144`

## Trạng thái bản Camofox đã kiểm tra

Phiên bản hiện tại:
- `@askjo/camofox-browser@1.11.7` (local custom branch `custom/v1.11.2-seellm`, package version đã bump lên `1.11.7`)

Ghi chú điều tra ngày 2026-06-22:
- Repo Camofox local có commit `3253a2c feat(optimize): blockResources option and custom timeoutMs support (v1.11.7)`.
- Route `POST /tabs/:tabId/navigate` dùng `page.goto(... waitUntil: "domcontentloaded")` và mặc định `NAVIGATE_TIMEOUT_MS=90000`.
- Nếu client không truyền `timeoutMs` trong body, server vẫn timeout sau 90s dù `seellm-tools` có chờ client lâu hơn.
- Warmup nên truyền `timeoutMs` server-side và bật `blockResources` khi tạo tab để giảm tải ảnh/media/font/tracker trên ChatGPT qua proxy chậm.

### Upstream routes đã có sẵn (không cần custom)

Upstream v1.8.15 đã cung cấp các route sau, thay thế cho custom routes cũ:

| Route cũ (custom v1.5.2) | Route upstream v1.8.15 | Ghi chú |
|---|---|---|
| `POST /tabs/:tabId/goto` | `POST /tabs/:tabId/navigate` | Upstream có thêm macro + Google handling + auto-create tab |
| `POST /tabs/:tabId/eval` | `POST /tabs/:tabId/evaluate` | Tên route khác, response format giống |
| `POST /tabs/:tabId/wait-for-selector` | `POST /tabs/:tabId/wait` | Upstream /wait là page-ready, KHÔNG phải selector-specific — vẫn cần custom |
| `POST /tabs/:tabId/wait-for-url` | — | Upstream không có — vẫn cần custom |
| `GET /sessions/:userId/cookies` | `POST /sessions/:userId/cookies` (import only) | Upstream chỉ có POST import, không có GET export — vẫn cần custom |
| `GET /tabs/:tabId/cookies` | — | Upstream không có — vẫn cần custom |

### Custom routes vẫn cần (plugin `seellm-tools`)

4 route sau được triển khai qua plugin `plugins/seellm-tools/index.js`:

- `GET /sessions/:userId/cookies` — Export cookies ở cấp session
- `GET /tabs/:tabId/cookies` --- Export cookies at cap tab
- `POST /tabs/:tabId/wait-for-selector` --- Wait cho CSS selector (visible/hidden/attached/detached)
- `POST /tabs/:tabId/wait-for-url` --- Wait cho URL match (string/glob/regex)

### API Reference - Custom Routes

#### GET /sessions/:userId/cookies
Export tat ca cookies cua mot user session.

**Request:**
```bash
curl http://localhost:3144/sessions/test-user/cookies
```

**Response:**
```json
[
  { "name": "auth_token", "value": "xxx", "domain": ".openai.com", "path": "/", "secure": true },
  ...
]
```

#### GET /tabs/:tabId/cookies?userId=xxx
Export cookies cua mot tab cu the.

**Request:**
```bash
curl "http://localhost:3144/tabs/tab123/cookies?userId=test-user"
```

**Response:**
```json
{ "ok": true, "cookies": [...] }
```

#### POST /tabs/:tabId/wait-for-selector
Cho doi mot phan tu HTML xuat hien voi selector cho truoc.

**Request:**
```bash
curl -X POST http://localhost:3144/tabs/tab123/wait-for-selector \
  -H 'Content-Type: application/json' \
  -d '{"userId":"test-user","selector":"button.submit","timeout":10000,"state":"visible"}'
```

**Parameters:**
- `selector` (required): CSS selector
- `timeout` (optional, default: 10000): Timeout in ms
- `state` (optional, default: "visible"): "visible", "hidden", "attached", "detached"

**Response:**
```json
{ "ok": true }
```

#### POST /tabs/:tabId/wait-for-url
Cho doi URL cua tab khop voi pattern.

**Request:**
```bash
curl -X POST http://localhost:3144/tabs/tab123/wait-for-url \
  -H 'Content-Type: application/json' \
  -d '{"userId":"test-user","url":"*example.com*","timeout":10000}'
```

**Parameters:**
- `url` (required): URL pattern (string, glob, hoac regex)
- `timeout` (optional, default: 10000): Timeout in ms

**Response:**
```json
{ "ok": true }
```

### Custom patches trong server.js (khong the chuyen sang plugin)

3 patch sau được áp dụng trực tiếp vào `server.js` vì cần truy cập hoặc khởi chạy trước trạng thái hệ thống:

1. **Per-request proxy** — Cho phép truyền `proxy`/`proxyUrl` trong `POST /tabs` body, persist proxy per user session, tự recreate context khi proxy thay đổi.
2. **forceLocale** — Cho phép truyền `locale`/`forceLocale` trong `POST /tabs` body, ép locale + Accept-Language bất kể proxy GeoIP.
3. **Port Conflict Killer** — Tự động quét và tắt tiến trình đang chiếm cổng `PORT` (mặc định là `9377`) trước khi lắng nghe, tránh lỗi `EADDRINUSE` khi khởi động song song hoặc chạy lại.

#### Chi tiết thay đổi của Port Conflict Killer:
* **Tạo file mới**: `lib/port-killer.js` định nghĩa hàm `killProcessOnPort(port)`.
* **Cập nhật server.js**: Import và gọi `killProcessOnPort(CONFIG.port)` ngay sau khi `CONFIG` được tải.
* **Tệp bản vá backup**: Tệp tin `patch_camofox_port_killer.patch` được lưu tại gốc của `seellm-tools` để tái áp dụng bản vá nếu bạn có cài đặt lại hoặc nâng cấp Camofox.

Để áp dụng tệp bản vá này trên thư mục cài đặt Camofox:
```bash
cd /Users/ndpmmo/Documents/Tools/camofox-browser
git apply /Users/ndpmmo/Documents/Github/seellm-tools/patch_camofox_port_killer.patch
```

### Plugin config (`camofox.config.json`)

```json
{
  "id": "camofox-browser",
  "name": "Camofox Browser",
  "version": "1.8.15",
  "plugins": {
    "youtube": { "enabled": true },
    "persistence": { "enabled": true },
    "vnc": { "resolution": "1920x1080" },
    "seellm-tools": { "enabled": true }
  }
}
```

## Lich su phien ban Camofox

### Phien ban hien tai: v1.8.15 (2026-04-29)

| Version | Date | Key Changes |
|---------|------|-------------|
| v1.8.15 | 2026-04 | Latest - current seellm-tools custom branch |
| v1.8.14 | 2026-03 | Bug fixes, stability improvements |
| v1.8.13 | 2026-02 | Proxy pool improvements |
| v1.8.12 | 2026-01 | Performance optimizations |
| v1.8.11 | 2025-12 | Minor fixes |
| v1.8.10 | 2025-12 | Minor fixes |
| v1.8.9 | 2025-12 | Minor fixes |
| v1.8.8 | 2025-12 | Minor fixes |
| v1.8.7 | 2025-12 | Minor fixes |
| v1.8.6 | 2025-12 | Minor fixes |
| v1.8.5 | 2025-12 | Minor fixes |
| v1.8.4 | 2025-12 | Minor fixes |
| v1.8.3 | 2025-12 | Minor fixes |
| v1.8.2 | 2025-12 | Minor fixes |
| v1.8.1 | 2025-12 | Minor fixes |
| v1.8.0 | 2025-12 | Memory leak fix, global access key |
| v1.7.2 | 2025-10 | Structured extract, session tracing, OpenAPI docs |
| v1.7.1 | 2025-09 | Bug fixes |
| v1.7.0 | 2025-09 | New features |
| v1.6.0 | 2025-08 | Plugin system, persistence, VNC, YouTube plugins |
| v1.5.2 | 2025-06 | Previous seellm-tools custom version |

---

### Chi tiet thay doi theo phien ban

#### v1.8.15 (Latest - 2026-04)
**Security & Stability**
- Bug fixes and stability improvements
- Compatible with seellm-tools custom branch

#### v1.8.0 - 1.8.14 (2025-12 to 2026-03)
**Security & Performance**
- **Global Access Key** (`CAMOFOX_ACCESS_KEY`): Bao ve API bang API key
- **Memory Leak Fix**: Fix ~930MB leak per orphaned browser
- **Crash Reporter**: Tu dong bao cao crash (anonymized)
- Proxy pool improvements
- Performance optimizations
- Bug fixes

#### v1.7.0 - v1.7.2 (2025-09 to 2025-10)
**Structured Data & Debugging**
- **Structured Extract** (`POST /tabs/:tabId/extract`): Trich xuat du lieu theo JSON Schema
- **Session Tracing**: Playwright traces cho debugging
- **OpenAPI Docs**: Tai `/openapi.json` va `/docs`
- Bug fixes and improvements

#### v1.6.0 - v1.6.x (2025-08)
**Plugin System (Major)**
- **Plugin System**: Custom routes tach rieng khoi core, de upgrade
- **Persistence Plugin**: Tu dong luu cookies + localStorage khi session close
- **VNC Plugin**: Remote desktop view cho debugging
- **YouTube Plugin**: Transcript extraction qua yt-dlp

#### v1.5.2 (2025-06 - Previous seellm-tools)
- Previous custom version used by seellm-tools
- Custom routes patched directly in server.js
- No plugin system support

### Thay doi tu ban upgrade v1.5.2 -> v1.8.15

**Loi ich chinh tu upstream:**
- Plugin System (v1.6.0): custom routes tach rieng khoi core server.js
- Persistence Plugin: tu luu cookies + localStorage khi session close/shutdown
- Structured Extract (`POST /tabs/:tabId/extract`): trich xuat du lieu theo JSON Schema
- Session Tracing: Playwright traces cho debugging
- Global Access Key (`CAMOFOX_ACCESS_KEY`): bao ve API bang API key
- Memory Leak Fix (v1.8.0): fix ~930MB leak per orphaned browser
- VNC Plugin: remote desktop view

**Thay đổi trong seellm-tools:**
- `scripts/lib/camofox.js`: `/eval` → `/evaluate`, `/wait` → `/wait-for-selector`, thêm `waitForUrl()`
- Tất cả worker/debug scripts: `/eval` → `/evaluate`
- `camofoxGoto()` giờ gọi upstream `/navigate` thay vì custom `/goto`

## Vấn đề thực tế đã gặp

Trong luồng `scripts/auto-login-worker.js`, case phổ biến là:
1. login email/password thành công,
2. nhập OTP 2FA thành công,
3. bị đẩy sang màn `add_phone`,
4. worker mở lại `https://auth.openai.com/sign-in-with-chatgpt/codex/consent`,
5. nhưng Camofox mặc định thiếu API hỗ trợ sâu hơn nên chỉ còn cách `click`,
6. nếu selector không khớp thì request treo lâu và flow đứng.

Do đó cần vá thêm API ở `server.js` của Camofox.

## Các thay đổi thực tế đã triển khai

### 1. Export cookies ở cấp session

Đã thêm `GET /sessions/:userId/cookies`.

Mục đích:
- phục vụ `scripts/get-session-token.js`,
- làm fallback cho worker khi route cookies theo tab chưa có,
- giúp debug session sau login mà không phải chọc vào browser thủ công.

### 2. Export cookies ở cấp tab

Đã thêm `GET /tabs/:tabId/cookies`.

Mục đích:
- biết tab hiện tại có thực sự giữ được OpenAI/Auth cookies không,
- xác minh việc mở `codex/consent` có đang dùng đúng browser context không,
- giảm mù khi debug case `add_phone`.

### 3. Điều hướng tab đang mở

**Đã thay bằng upstream `POST /tabs/:tabId/navigate`.**

Trước v1.8.15: custom `POST /tabs/:tabId/goto`.
Sau v1.8.15: upstream `/navigate` cung cấp cùng chức năng + thêm macro search, Google handling, auto-create tab.

`scripts/lib/camofox.js` đã cập nhật: `camofoxGoto()` giờ gọi `/navigate`.

### 4. Evaluate JS trong tab

**Đã thay bằng upstream `POST /tabs/:tabId/evaluate`.**

Trước v1.8.15: custom alias `POST /tabs/:tabId/eval`.
Sau v1.8.15: upstream `/evaluate` cung cấp cùng chức năng. Tất cả scripts đã đổi từ `/eval` sang `/evaluate`.

### 5. Đồng bộ worker phase 2

Sau khi upgrade Camofox v1.8.15, `scripts/auto-worker.js` đã được cập nhật:
- ưu tiên `navigate` trên tab hiện tại (qua `camofoxGoto`),
- chỉ mở tab mới nếu `navigate` fail,
- dùng `evaluate` để:
  - tìm button `Authorize/Allow/Continue`,
  - fallback click trong DOM,
  - fallback submit form nếu button selector không ăn.

## Lỗi thực tế đã gặp khi khởi động

Khi khởi động Camofox trên `:3144`, server lên port nhưng browser pre-warm fail với lỗi ABI:

```text
better-sqlite3.node was compiled against a different Node.js version
NODE_MODULE_VERSION 141
This version of Node.js requires NODE_MODULE_VERSION 127
```

Điều này làm:
- `/health` có thể vẫn trả `ok: true`,
- nhưng `browserConnected` sẽ là `false`,
- và mở tab thật sẽ fail hoặc không ổn định.

### Cách xử lý đã áp dụng

Chạy trong thư mục Camofox:

```bash
npm rebuild better-sqlite3
```

Sau đó khởi động lại:

```bash
CAMOFOX_PORT=3144 npm start
```

Nếu khởi động từ UI của Tools, command thực tế phải tương đương:

```bash
/usr/local/bin/node server.js
```

và không được phụ thuộc `node` từ `PATH`, vì trên máy có thể tồn tại song song Node v22 và Node v25.

Kết quả mong muốn:

```json
{
  "ok": true,
  "browserConnected": true,
  "browserRunning": true
}
```

## Debug probes cho login

Trước khi sửa selector worker, nên chạy probe trực tiếp với Camofox để đọc DOM thật.

### 1. ChatGPT login modal

```bash
cd /Users/ndpmmo/Documents/Github/seellm-tools
CAMOUFOX_API=http://localhost:3144 node scripts/debug/probe-chatgpt-login-dialog.js
```

Probe này mở `chatgpt.com`, bấm `Log in`, rồi dump đúng `div[role="dialog"]` của modal login.

### 2. OpenAI login page ban đầu

```bash
cd /Users/ndpmmo/Documents/Github/seellm-tools
CAMOUFOX_API=http://localhost:3144 node scripts/debug/probe-openai-auth-pages.js
```

### 3. OpenAI sau khi submit email

```bash
cd /Users/ndpmmo/Documents/Github/seellm-tools
PROBE_EMAIL='your-test-email@example.com' CAMOUFOX_API=http://localhost:3144 node scripts/debug/probe-openai-auth-pages.js
```

### 4. OpenAI password / next step DOM

```bash
cd /Users/ndpmmo/Documents/Github/seellm-tools
PROBE_EMAIL='your-test-email@example.com' CAMOUFOX_API=http://localhost:3144 node scripts/debug/probe-openai-auth-password.js
```

### 5. Worker masked debug

```bash
cd /Users/ndpmmo/Documents/Github/seellm-tools
CHATGPT_LOGIN_DEBUG=1 npm run dev
```

Biến này bật log chi tiết cho nhánh login ChatGPT web nhưng đã mask email/password/secret trong log.

## Nhóm endpoint cần có

### 0. `GET /sessions/:userId/cookies`

Route này dùng cho:
- `scripts/get-session-token.js`
- fallback của `auto-login-worker.js` khi `GET /tabs/:tabId/cookies` chưa có

```js
app.get('/sessions/:userId/cookies', async (req, res) => {
  try {
    const userId = req.params.userId;
    const session = sessions.get(normalizeUserId(userId));
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const cookies = await session.context.cookies();
    res.json(cookies);
  } catch (err) {
    res.status(500).json({ error: safeError(err) });
  }
});
```

### 1. `wait-for-selector`

Giúp worker đợi phần tử xuất hiện bằng Playwright native wait thay vì polling.

```js
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
});
```

### 2. `wait-for-url`

Giúp worker chờ redirect/callback thay vì soi chuỗi trong HTML.

```js
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
});
```

### 3. `GET /tabs/:tabId/cookies`

Case `add_phone` cần biết session hiện tại có cookie gì trước khi mở tab consent mới. Một số bản Camofox có `GET /sessions/:userId/cookies`, nhưng worker cần thêm route theo `tabId` để debug chính xác hơn.

```js
app.get('/tabs/:tabId/cookies', async (req, res) => {
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
    log('error', 'tab cookies failed', { reqId: req.reqId, tabId, error: err.message });
    handleRouteError(err, req, res);
  }
});
```

### 4. `POST /tabs/:tabId/goto` → upstream `POST /tabs/:tabId/navigate`

**Không còn custom.** Upstream v1.8.15 `/navigate` thay thế hoàn toàn, có thêm macro search + Google handling.

`scripts/lib/camofox.js` đã cập nhật: `camofoxGoto()` gọi `/navigate`.

### 5. `POST /tabs/:tabId/eval` → upstream `POST /tabs/:tabId/evaluate`

**Không còn custom.** Upstream v1.8.15 `/evaluate` thay thế hoàn toàn.

Tất cả scripts đã đổi từ `/eval` sang `/evaluate`.

## Thứ tự ưu tiên khi vá

Nếu bạn chỉ có thời gian vá tối thiểu:
1. `GET /sessions/:userId/cookies`
2. `wait-for-selector`
3. `wait-for-url`
4. `GET /tabs/:tabId/cookies`
5. `POST /tabs/:tabId/goto`

Nếu muốn xử lý `add_phone -> consent/workspace` đúng nghĩa phase 2:
1. tất cả các route trên,
2. thêm `POST /tabs/:tabId/eval`.

## Worker trong Tools đang dùng phần nào

Hiện tại `scripts/auto-worker.js` đã:
- fallback lấy cookies qua `/sessions/:userId/cookies` nếu `/tabs/:tabId/cookies` chưa tồn tại,
- dùng timeout ngắn cho `click` trong nhánh bypass để tránh treo 30 giây,
- thử `navigate` lại `codex/consent` trong cùng tab/session trước (qua `camofoxGoto`),
- chỉ mở tab mới nếu `navigate` fail,
- dùng `evaluate` để click/submit consent trước khi fail `NEED_PHONE`.

Điều này là phase 2 thực tế đang chạy, không còn chỉ là phase 1.

## Gợi ý triển khai phase 2 sau khi Camofox đã vá

Luồng đề xuất:
1. đang ở `add_phone`,
2. gọi `POST /tabs/:tabId/navigate` tới `https://auth.openai.com/sign-in-with-chatgpt/codex/consent`,
3. gọi `POST /tabs/:tabId/evaluate` để:
   - đọc HTML,
   - tìm `workspace id`,
   - hoặc tìm submit action/nút authorize thực tế,
4. nếu có consent thì bấm/submit,
5. nếu có redirect `code=` thì kết thúc,
6. nếu không thì mới trả `NEED_PHONE`.

## Quy trình cập nhật Camofox bản mới (plugin-based)

Từ v1.8.15 trở đi, custom routes được triển khai qua plugin, không cần vá trực tiếp `server.js`.

1. Đi vào thư mục cài Camofox: `cd /Users/ndpmmo/Documents/Tools/camofox-browser`
2. Tạo branch mới từ tag upstream: `git checkout -b custom/vX.Y.Z-seellm vX.Y.Z`
3. Re-apply 2 server.js patches (per-request proxy + forceLocale) nếu upstream chưa có.
4. Kiểm tra plugin `seellm-tools` vẫn tương thích với `pluginCtx` API của bản mới.
5. Cập nhật `camofox.config.json` version field.
6. `npm install && npm rebuild better-sqlite3`
7. Kiểm tra `seellm-tools/tools.config.json` vẫn có:

```json
{
  "camofoxNodePath": "/usr/local/bin/node"
}
```

8. Khởi động lại Camofox: `CAMOFOX_PORT=3144 /usr/local/bin/node server.js`
9. Test tối thiểu:
   - `/health` → `browserConnected: true`
   - tạo tab + snapshot
   - `GET /sessions/:userId/cookies`
   - `GET /tabs/:tabId/cookies`
   - `POST /tabs/:tabId/wait-for-selector`
   - `POST /tabs/:tabId/wait-for-url`
   - `POST /tabs/:tabId/navigate` (upstream)
   - `POST /tabs/:tabId/evaluate` (upstream)

## Checklist sau khi cập nhật xong

- `/health` trả `browserConnected: true`
- Plugin `seellm-tools` load thành công (kiểm tra log startup)
- Tools start Camofox bằng `/usr/local/bin/node`, không phải `node` chung chung
- `scripts/test-camofox.js` chạy pass
- mở tab test thật được
- `scripts/auto-worker.js` không còn log `cookies 404`
- khi gặp `add_phone`, bypass không còn treo 30 giây ở `click`
- `#camofox-docs` vẫn khớp với code thực tế đang dùng

## Test HTTP đã xác nhận sau bản upgrade v1.8.15

Đã test thực tế trên `http://localhost:3144`:
- tạo tab thành công,
- `GET /tabs/:tabId/snapshot` thành công,
- `GET /tabs/:tabId/cookies` trả JSON hợp lệ (plugin),
- `POST /tabs/:tabId/navigate` điều hướng thành công (upstream),
- `POST /tabs/:tabId/evaluate` trả về `location.href` (upstream),
- `GET /sessions/:userId/cookies` trả danh sách cookie (plugin),
- `POST /tabs/:tabId/wait-for-selector` hoạt động (plugin),
- `POST /tabs/:tabId/wait-for-url` hoạt động (plugin),
- đóng tab thành công.

## Tích hợp features mới vào seellm-tools (v0.3.6)

Từ Camofox v1.8.15, seellm-tools tích hợp thêm các functions trong `scripts/lib/camofox.js`:

### 1. Structured Extract (`extractData`)

Trích xuất dữ liệu theo JSON Schema:

```js
import { extractData } from './lib/camofox.js';

const data = await extractData(tabId, userId, {
  type: 'object',
  properties: {
    email: { type: 'string', selector: '#email' },
    error: { type: 'string', selector: '.error-message' }
  }
});
// { ok: true, data: { email: 'test@example.com' } }
```

### 2. Session Tracing (`getTraces`, `getTrace`)

Debug workers với Playwright traces:

```js
import { getTraces, getTrace, camofoxPost } from './lib/camofox.js';

// Tạo tab với trace
const tab = await camofoxPost('/tabs', { userId, sessionKey, url, trace: true });

// List traces
const traces = await getTraces(userId);
// Download trace
const traceBlob = await getTrace(userId, traces.traces[0].filename);
// Xem: npx playwright show-trace session.zip
```

### 3. Prometheus Metrics (`getMetrics`)

Monitor Camofox health:

```js
import { getMetrics } from './lib/camofox.js';
const metrics = await getMetrics();
// Prometheus format metrics
```

Cần bật `PROMETHEUS_ENABLED=1` trên Camofox server.

### 4. Unified /act Endpoint (`act`, `actClick`, `actType`, etc.)

Thay thế nhiều endpoints riêng lẻ bằng một:

```js
import { act, actClick, actType, actPress, actScroll, actWait } from './lib/camofox.js';

await act(tabId, userId, 'click', { ref: 'e1' });
await act(tabId, userId, 'type', { ref: 'e2', text: 'hello' });
await act(tabId, userId, 'press', { key: 'Enter' });
await act(tabId, userId, 'scroll', { direction: 'down', amount: 500 });
```

## Tối ưu hóa tải cao và hàng đợi luồng tạo tab (v0.3.143 - v0.3.144)

Khi chạy đồng thời hàng chục luồng worker song song, Camofox có thể bị nghẽn tài nguyên dẫn đến lỗi timeout. Hai cơ chế tối ưu hóa chính đã được áp dụng:

### 1. Cơ chế Hàng đợi Khởi tạo (Semaphore Queue)
- **Mục đích**: Giới hạn số lượng trình duyệt/tab được khởi tạo đồng thời để tránh đột biến CPU/RAM khi mở trình duyệt và tải trang đầu tiên.
- **Hoạt động**: Sử dụng một Semaphore toàn cục trên Camofox Server với dung lượng mặc định là `3` (cấu hình qua thuộc tính `maxConcurrentTabCreations`). Yêu cầu vượt quá giới hạn sẽ xếp hàng đợi, chỉ bắt đầu tính thời gian timeout của request khi slot đã được cấp phát.
- **Tích hợp UI**: Cấu hình `Số luồng tạo tab đồng thời tối đa` có thể được chỉnh sửa trực quan trong tab **Settings** của SeeLLM Tools và được tự động đồng bộ sang tiến trình Camofox qua biến môi trường `MAX_CONCURRENT_TAB_CREATIONS`.

### 2. Tự động đồng bộ và tăng giới hạn Timeout
- **Tăng mặc định Server-side Timeouts**:
  - `handlerTimeoutMs` tăng lên **60 giây** (60000ms) để cho phép các action phức tạp hoàn thành dưới tải cao.
  - `navigateTimeoutMs` tăng lên **60 giây** (60000ms) giúp các trang load chậm qua proxy không bị timeout sớm.
- **Thay thế timeout gán cứng**: Các câu lệnh `page.goto` trong `server.js` của Camofox (tại route `/tabs` và `/tabs/:tabId/navigate`) đã chuyển từ giá trị gán cứng `30000ms` sang sử dụng hằng số `NAVIGATE_TIMEOUT_MS`.
- **Tab Lock Timeout**: Lock acquire timeout của tab được gán động bằng `HANDLER_TIMEOUT_MS + 5000` (mặc định là 65 giây) để tránh tình trạng hàng đợi lock bị timeout trước khi tác vụ đang hoạt động kết thúc.
- **Worker Timeout**: Hàm wrapper client `camofoxPostWithSessionKey` tăng thời gian chờ mặc định lên **90 giây** để tạo đủ thời gian chờ (headroom) khi phải xếp hàng ở server.

## Tối ưu hóa Hiệu năng Đa luồng (High Concurrency) & Tránh Bot Detection (v0.3.177 / Camofox v1.11.7)

Trong bản cập nhật này, hệ thống đã tinh chỉnh các cài đặt cho phép mở rộng quy mô chạy song song 10+ luồng tự động đăng ký tài khoản (Auto Register) một cách ổn định:

### 1. Tránh kẹt Turnstile & Chặn Bot trên OpenAI
- **Thời gian chờ sau nhập Mật khẩu (Turnstile check)**: Trong kịch bản đăng ký `openai-login-flow.js`, thời gian chờ sau khi nhập mật khẩu đã được tăng từ **800ms lên 2500ms**. Khoảng trễ này đảm bảo các thách thức Turnstile/Cloudflare có đủ thời gian để hoàn thành kiểm tra và kích hoạt hoàn toàn nút Submit (Continue), tránh việc click quá nhanh khiến cơ chế Native click của Camofox lỗi và buộc phải sử dụng DOM click (bị OpenAI gắn nhãn bot và trả về `BLOCKED_BY_OPENAI`).

### 2. Nới lỏng Client-side API Timeouts để chống tắt nghẽn
- Khi chạy đồng thời nhiều tab trên cùng một server Camofox, tài nguyên CPU và I/O tăng mạnh dễ gây ra độ trễ phản hồi tạm thời của API.
- Các timeout trên API Client (`scripts/lib/camofox.js`) được tăng lên để tránh Client huỷ kết nối sớm (Premature abort) khi server thực chất vẫn đang xử lý:
  - `camofoxEval` (xử lý evaluate javascript): Tăng từ **8s lên 12s**.
  - `camofoxDelete` (dọn dẹp tab): Tăng từ **8s lên 12s**.
  - `camofoxGet` (lấy dữ liệu/cookies): Tăng từ **15s lên 20s**.

### 3. Khuyến nghị triển khai đa luồng
- Sử dụng biến môi trường mẫu trong `.env.high-concurrency` trên Camofox để tối ưu hóa Firefox content processes (`FIREFOX_PROCESS_COUNT=4`) và cấp phát RAM V8.
- Triển khai **Staggered Start (Jitter)**: Khởi động các worker đăng ký giãn cách từ 2.5s - 4s để giảm tải CPU spike khi render trang đồng thời.

## Tối ưu hóa Log & Lọc rác (Log Noise Reduction) (v0.3.178)

Để màn hình Console hoặc Log của Camofox không bị ngập tràn bởi các cảnh báo vô hại từ ChatGPT, một bộ lọc đã được vá (patch) trực tiếp vào `server.js` của Camofox:
- **Loại bỏ Lỗi tải Font chữ / CORS**: Lọc các lỗi `Cross-Origin Request Blocked` và `downloadable font: download failed` liên quan đến `cdn.openai.com/common/fonts`.
- **Loại bỏ Cảnh báo Trình theo dõi (Trackers)**: Bỏ qua cảnh báo từ ETP của Firefox về `bounce tracker` và `preloaded with link preload was not used`.
- **Loại bỏ Cảnh báo Bảo mật & Phân tích nội bộ (ChatGPT)**: Chặn in log khi CSP của trang web chặn `eval()` (`Content-Security-Policy`) và chặn các lỗi mạng khi hệ thống phân tích người dùng `Statsig` của ChatGPT gặp lỗi `token_revoked` (`[Statsig] A networking error occurred`).
- *Lưu ý*: Bản patch này được áp dụng trực tiếp lên server của Camofox mà **không làm thay đổi số version của Camofox gốc (vẫn là 1.11.6)**, giúp cho việc re-base hoặc pull cập nhật từ upstream sau này dễ dàng hơn.

## Tối ưu hóa Proxy IP Probing (v0.3.179)

Trước đây, hàm `probeProxyExitIp()` trong `scripts/lib/proxy-diag.js` mở tab trình duyệt Camofox, navigate đến `api64.ipify.org` qua proxy, rồi evaluate JavaScript để lấy IP. Phương pháp này có nhiều vấn đề:

- **Chậm (30-60s)**: Navigate browser qua proxy tunnel IPv6 thường vượt timeout 30s
- **Tốn tài nguyên**: Mỗi batch 10 worker tạo 20+ tab probe (PreFlight + PostVerify) chỉ để kiểm tra IP
- **78% lỗi timeout**: `NS_ERROR_NET_TIMEOUT` trên Camofox server log đều từ navigate đến `api64.ipify.org`

### Giải pháp

Viết lại `probeProxyExitIp` sử dụng `requestViaCurlCffi` — gọi HTTP trực tiếp từ Node.js qua proxy daemon:

```js
// Trước (browser-based): tạo tab → navigate → evaluate → đóng tab
const opened = await camofoxPost('/tabs', { userId, proxy: proxyUrl, ... });
await camofoxPost(`/tabs/${probeTabId}/navigate`, { userId, url });
const bodyText = await evalJson(probeTabId, userId, 'document.body.innerText');

// Sau (direct fetch): gọi trực tiếp, không cần browser
const res = await requestViaCurlCffi({ method: 'GET', url, proxyUrl, timeoutMs: 15000 });
const ip = extractIpFromText(res.body);
```

### Kết quả

- **0 tab browser** thay vì 20+ tab probe/batch
- Thời gian probe: **3-5s** thay vì 30-60s
- Loại bỏ hoàn toàn import `camofoxPost`, `camofoxDelete`, `evalJson` khỏi `proxy-diag.js`
- Không ảnh hưởng API: param `reuseExistingSession` vẫn được giữ để tương thích ngược
- *Lưu ý*: Thay đổi này là ở phía `seellm-tools`, **KHÔNG** sửa đổi code Camofox

```

## Chi tiết tùy biến & Tối ưu trên nhánh Camofox local (v1.11.2 -> v1.11.9-seellm)

Camofox trên máy chạy nhánh `custom/v1.11.2-seellm` (phiên bản hiện tại đã được nâng cấp lên `1.11.9`). Dưới đây là các thay đổi và tối ưu hóa chính được triển khai trực tiếp trên mã nguồn của Camofox `/Users/ndpmmo/Documents/Tools/camofox-browser`:

### 1. Tự động hóa & Resource Blocking (`blockResources`)
- **API `POST /tabs`**: Bổ sung tham số `"blockResources": true`. Khi được bật, Camofox sẽ kích hoạt cơ chế `page.route` toàn cục để tự động chặn các tài nguyên nặng và không cần thiết (`image`, `media`, `font`) cùng các thư viện tracking/analytics phổ biến như `sentry.io`, `datadoghq.com`.
- **Cơ chế Bypass OpenAI/ChatGPT (v1.11.9)**:
  - **Sửa đổi**: Bổ sung danh sách whitelist các domain bypass bao gồm: `openai.com`, `chatgpt.com`, `oaistatic.com`, `auth0.com`, `cloudflare.com`, `statsigapi.net`.
  - **Mục đích**: Tránh việc chặn nhầm các icon SVG, font chữ, và các script cốt lõi của giao diện ChatGPT UI, giúp nút gửi và composer không bị trắng/trơ hoặc lỗi giao diện trên gói Free.
  - **Vị trí sửa đổi**: `server.js` (core) và `plugins/seellm-tools/index.js` (chuyển đổi từ `!isCloudflare` sang `!isBypassDomain`).

### 2. Tùy biến Timeout trong các Request
- **Tham số `timeoutMs`**: Hỗ trợ truyền `timeoutMs` trong body của `POST /tabs` và `POST /tabs/:tabId/navigate`.
- **Hoạt động**: Thay vì giới hạn cứng `30000ms`, client có thể cấu hình động mức timeout phù hợp dựa trên tốc độ proxy (Ví dụ: `seellm-tools` gọi với `timeoutMs: 35000` cho proxy chậm).

### 3. Tùy chọn Mốc chờ Navigation (`waitUntil` - v1.11.8)
- **Hoạt động**: Cho phép tùy biến tham số `waitUntil` (`commit`, `load`, `domcontentloaded`, `networkidle`) khi tạo tab hoặc navigate.
- **Tối ưu**: Trong môi trường proxy chậm, có thể cấu hình `commit` để kết thúc chờ ngay khi server trả về response header ban đầu, tránh việc trình duyệt bị treo timeout chờ đợi các asset/font load sau.

### 4. Khôi phục Fail-fast Navigation (v1.11.9)
- **Thay đổi**: Đưa mặc định `NAVIGATE_TIMEOUT_MS` về `30000ms` (30s) và `HANDLER_TIMEOUT_MS` về `60000ms` (60s).
- **Mục đích**: Đảm bảo nếu proxy bị kẹt hoặc ChatGPT không phản hồi, luồng sẽ fail nhanh để script chính (như `warmup.js`) thực hiện đóng tab và retry ngay lập tức, tránh treo cứng tab lock gây nghẽn hàng đợi (CPU/queue starvation).

### 5. Sửa lỗi import Cookie (v1.11.5)
- **Sửa đổi**: Trong API `POST /sessions/:userId/cookies`, tự động gán path mặc định là `'/'` cho các cookie không định nghĩa trường path.
- **Mục đích**: Tránh lỗi crash validation của Playwright (`addCookies` validation error) khi nạp cookie thô từ database.

### 6. Tự động dọn dẹp Port xung đột (`killProcessOnPort` - v1.11.5)
- **Hoạt động**: Khi bắt đầu khởi động Camofox, tự động gọi script kiểm tra cổng `9377`. Nếu phát hiện có tiến trình cũ chiếm dụng (do Node.js crash hoặc exit không dọn dẹp), nó sẽ tự động chạy `lsof` để quét và `kill` tiến trình cũ nhằm tránh lỗi `EADDRINUSE`.

