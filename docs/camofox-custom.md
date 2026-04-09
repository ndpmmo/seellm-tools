# Tài liệu Custom Camofox Browser

Phiên bản Camofox gốc (`@askjo/camofox-browser`) được thiết kế cực kỳ mạnh mẽ để chống bot (bypass Cloudflare), quản lý session và xoay vòng Proxy. Tuy nhiên, API nguyên bản của nó thiếu một số tính năng chờ (wait) ở cấp độ Playwright, khiến cho `auto-login-worker` của chúng ta phải sử dụng cơ chế poll ảnh màn hình (snapshot polling) rất tốn tài nguyên và thời gian.

Để tối ưu hóa, chúng ta đã can thiệp vào mã nguồn của file `server.js` trong Camofox để mở rộng API. Trang tài liệu này ghi lại những thay đổi đó để bạn có thể áp dụng lại mỗi khi cập nhật bản Camofox mới.

---

## Các tính năng API đã thêm

Chúng ta đã mở khóa luồng gọi sự kiện Native trực tiếp từ Playwright. Việc này cho phép bot phản ứng với giao diện theo độ trễ ms thay vì chờ vài giây.

### 1. Endpoint Đợi Selector (`wait-for-selector`)

**Sự cố:** `auto-login-worker` trước đây mất từ `2s` đến `15s` chờ các màn hình load vì nó sử dụng `setTimeout` và `Get Snapshot` liên tục.
**Cách giải quyết:** Đợi trực tiếp qua event listeners của trình duyệt. 

Đoạn code cần thêm (ngay sau endpoint `/tabs/:tabId/wait` trong `server.js` của Camofox):

```javascript
// Wait for selector
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

### 2. Endpoint Đợi URL thay đổi (`wait-for-url`)

**Sự cố:** Luồng tự động cần chắc chắn đã chuyển hướng sang màn hình Dashboard sau khi đăng nhập thay vì soi chữ.

```javascript
// Wait for URL
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

---

## Cập nhật tại Worker (`auto-login-worker.js`)

Để tận dụng sự nâng cấp của Camofox ở bên trên, Worker tại SeeLLM Tools được tối ưu hóa như sau:

1. **Xóa `setTimeout` vô ích:** Đã cắt giảm độ trễ tĩnh (từ `15s` xuống `2s`, `6s` xuống `1s` v.v...) và thay thế bằng chờ đợi động (dynamic waiting).
2. **Graceful Fallback:** Hàm `waitForSelector()` được đổi thành việc gọi API `wait-for-selector`. Nếu API này không tồn tại (trong trường hợp người dùng lỡ update Camofox mà quên vá lại tính năng), hệ thống sẽ không sập mà sẽ tự lỏng lẻo quay về cơ chế soi màn hình như cũ!
3. **Auto-Healing Detection:** Thuật toán bắt lỗi UI được làm gọn hơn bằng việc nhổ HTML tag trước khi kiểm tra (giúp loại chặn chữ có chứa strong hay class).

---

## Hướng dẫn cập nhật Camofox trong tương lai

Nếu Camofox ra phiên bản mới (như bản 1.5.2):
1. **Bước 1:** Kéo bản mới về thông qua git (`git reset --hard` & `git pull`).
2. **Bước 2:** Chạy `npm install` và `npx camoufox-js fetch`.
3. **Bước 3:** Mở `/Users/ndpmmo/Documents/Tools/camofox-browser/server.js`.
4. **Bước 4:** Copy 2 endpoint bên trên và dán tụi nó vào bên dưới hàm `app.post('/tabs/:tabId/wait', ...)` như trước.
5. **Bước 5:** Khởi động lại Camofox (hoặc server.js của nó) là xong!
