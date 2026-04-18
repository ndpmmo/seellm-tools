# Tài liệu Custom Camofox Browser

Tài liệu này ghi lại toàn bộ phần vá thêm cho Camofox để `seellm-tools` hoạt động ổn định hơn với luồng OpenAI/Codex login.

Mục tiêu của bản vá:
- giảm polling HTML/screenshot không cần thiết,
- tránh treo lâu khi `click` không match selector,
- hỗ trợ phase 2 cho case `add_phone -> consent/workspace`,
- giữ session/cookie đủ để worker tái sử dụng sau khi mở tab mới.

## Đường dẫn Camofox trên máy

- Camofox repo local: `/Users/ndpmmo/Documents/Tools/camofox-browser`
- File server chính: `/Users/ndpmmo/Documents/Tools/camofox-browser/server.js`
- Node path Tools dùng để start Camofox: `/usr/local/bin/node`
- Base URL API (local): `http://localhost:3144`

## Cập nhật trạng thái (2026-04-19)

Những điều đã xác nhận từ log thực tế:
- Worker có thể đăng nhập ChatGPT web hoàn chỉnh (email/password + TOTP) và `GET https://chatgpt.com/api/auth/session` trả `user/account` hợp lệ.
- Sau khi gặp `add_phone`, worker có thể bootstrap lại và mở lại URL OAuth authorize gốc.
- Khi mở lại authorize, flow thường về `https://auth.openai.com/log-in` (Welcome back), nghĩa là bắt buộc cần điền lại email/password trên auth page trước khi tiếp tục.

Giới hạn hiện tại:
- Với tài khoản bị yêu cầu `add_phone`, chưa có API/bypass hợp lệ để lấy được OAuth callback code cho Codex nếu người dùng chưa hoàn tất phone verification.
- Các lỗi `workspace/select` như `invalid_auth_step` hoặc `invalid_state` là hệ quả của ngữ cảnh authorize không hợp lệ ở thời điểm gọi API, không phải lỗi selector thuần.

Kết luận vận hành:
- Login ChatGPT web thành công không đồng nghĩa authorize Codex sẽ thành công.
- Nếu tài khoản bị chặn ở `add_phone`, worker phải kết thúc với trạng thái `NEED_PHONE`.

## Trạng thái bản Camofox đã kiểm tra

Thư mục Camofox đang dùng:
- `/Users/ndpmmo/Documents/Tools/camofox-browser`

Port Tools đang trỏ tới:
- `http://localhost:3144`

Node mà Tools phải dùng để start Camofox:
- `/usr/local/bin/node`

Phiên bản đã kiểm tra:
- `@askjo/camofox-browser@1.5.2`

Những route đã có sẵn trước khi vá:
- `POST /tabs/:tabId/wait-for-selector`
- `POST /tabs/:tabId/wait-for-url`
- `POST /tabs/:tabId/evaluate`

Những route mình đã thêm mới trực tiếp vào `server.js`:
- `GET /sessions/:userId/cookies`
- `GET /tabs/:tabId/cookies`
- `POST /tabs/:tabId/goto`
- `POST /tabs/:tabId/eval` (alias cho `evaluate`)

Lý do phải thêm:
- Tools có `scripts/get-session-token.js` cần export cookies từ session.
- Worker phase 2 cần đọc cookies theo tab.
- Worker phase 2 cần `goto` để ép tab hiện tại quay lại `codex/consent`.
- Tools dùng tên `eval` ngắn gọn, nhất quán với tài liệu phase 2.

Ngoài phần vá trong Camofox, Tools cũng đã được sửa để:
- thêm cấu hình `camofoxNodePath`,
- mặc định set `camofoxNodePath=/usr/local/bin/node`,
- khi bấm Start Camofox từ UI, Tools sẽ dùng đúng Node path này thay vì phụ thuộc `PATH`.

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

Đã thêm `POST /tabs/:tabId/goto`.

Mục đích:
- cho worker điều hướng thẳng tab hiện tại từ `add_phone` về `https://auth.openai.com/sign-in-with-chatgpt/codex/consent`,
- tránh phụ thuộc hoàn toàn vào cách cũ là mở tab mới rồi click thủ công.

Triển khai hiện tại:
- validate URL,
- `page.goto(...)` trong đúng browser context đang dùng,
- refresh refs sau điều hướng,
- trả `finalUrl`, `status`, `refsAvailable`.

### 4. Alias `eval`

Đã thêm `POST /tabs/:tabId/eval`.

Mục đích:
- Tools/worker chỉ cần gọi một tên route ổn định,
- không phải phụ thuộc chỗ dùng `/evaluate`, chỗ dùng `/eval`.

Hiện tại alias này gọi cùng kiểu `page.evaluate(...)` như route gốc.

### 5. Đồng bộ worker phase 2

Sau khi Camofox có route mới, `scripts/auto-login-worker.js` đã được cập nhật:
- ưu tiên `goto` trên tab hiện tại,
- chỉ mở tab mới nếu `goto` fail,
- dùng `eval` để:
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

### 4. `POST /tabs/:tabId/goto`

Đây là endpoint quan trọng cho phase 2. Worker phải điều hướng ngay trong cùng session sang `codex/consent` hoặc URL callback khác mà không cần mở tab mới bằng workaround.

```js
app.post('/tabs/:tabId/goto', async (req, res) => {
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

    res.json({
      ok: true,
      finalUrl: tabState.page.url(),
      status: response?.status?.() ?? null,
    });
  } catch (err) {
    log('error', 'goto failed', { reqId: req.reqId, tabId, error: err.message });
    handleRouteError(err, req, res);
  }
});
```

### 5. `POST /tabs/:tabId/eval`

Đây là bước mở đường cho logic giống `any-auto-register`: parse HTML, đọc biến JS, lấy href/button/workspace id trực tiếp trong browser context.

Lưu ý: chỉ cho phép các script ngắn, có kiểm soát. Không nên mở endpoint này ra public internet.

```js
app.post('/tabs/:tabId/eval', async (req, res) => {
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
    log('error', 'eval failed', { reqId: req.reqId, tabId, error: err.message });
    handleRouteError(err, req, res);
  }
});
```

Lưu ý:
- Nếu Camofox đã có `POST /tabs/:tabId/evaluate`, vẫn nên thêm alias `/eval` để Tools và tài liệu dùng một tên thống nhất.

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

Hiện tại `scripts/auto-login-worker.js` đã:
- fallback lấy cookies qua `/sessions/:userId/cookies` nếu `/tabs/:tabId/cookies` chưa tồn tại,
- dùng timeout ngắn cho `click` trong nhánh bypass để tránh treo 30 giây,
- thử `goto` lại `codex/consent` trong cùng tab/session trước,
- chỉ mở tab mới nếu `goto` fail,
- dùng `eval` để click/submit consent trước khi fail `NEED_PHONE`.

Điều này là phase 2 thực tế đang chạy, không còn chỉ là phase 1.

## Gợi ý triển khai phase 2 sau khi Camofox đã vá

Luồng đề xuất:
1. đang ở `add_phone`,
2. gọi `POST /tabs/:tabId/goto` tới `https://auth.openai.com/sign-in-with-chatgpt/codex/consent`,
3. gọi `POST /tabs/:tabId/eval` để:
   - đọc HTML,
   - tìm `workspace id`,
   - hoặc tìm submit action/nút authorize thực tế,
4. nếu có consent thì bấm/submit,
5. nếu có redirect `code=` thì kết thúc,
6. nếu không thì mới trả `NEED_PHONE`.

## Quy trình vá khi cập nhật Camofox bản mới

1. Đi vào thư mục cài Camofox.
2. Pull hoặc update bản mới.
3. Kiểm tra `seellm-tools/tools.config.json` vẫn có:

```json
{
  "camofoxNodePath": "/usr/local/bin/node"
}
```

4. Mở `server.js`.
5. Tìm các route tabs hiện có như `/tabs/:tabId/wait`.
6. Kiểm tra bản mới còn sẵn route nào và vá lại đúng các route còn thiếu.
7. Khởi động lại Camofox.
8. Test tối thiểu:
   - mở tab,
   - `snapshot`,
   - `GET /sessions/:userId/cookies`,
   - `wait-for-selector`,
   - `goto`,
   - `GET /tabs/:tabId/cookies`,
   - `POST /tabs/:tabId/eval`.

## Checklist sau khi vá xong

- `/health` trả `browserConnected: true`
- Tools start Camofox bằng `/usr/local/bin/node`, không phải `node` chung chung
- `scripts/test-camofox.js` chạy pass
- mở tab test thật được
- `scripts/auto-login-worker.js` không còn log `cookies 404`
- khi gặp `add_phone`, bypass không còn treo 30 giây ở `click`
- `#camofox-docs` vẫn khớp với code thực tế đang dùng

## Test HTTP đã xác nhận sau bản vá

Đã test thực tế trên `http://localhost:3144`:
- tạo tab thành công,
- `GET /tabs/:tabId/snapshot` thành công,
- `GET /tabs/:tabId/cookies` trả JSON hợp lệ,
- `POST /tabs/:tabId/goto` điều hướng từ `example.com` sang `example.org`,
- `POST /tabs/:tabId/eval` trả về `location.href`,
- `GET /sessions/:userId/cookies` trả danh sách cookie,
- đóng tab thành công.
