# 🛠️ SeeLLM Tools

**Automation Control Panel** cho SeeLLM Gateway — quản lý Camofox Browser Server và pipeline tự động hóa OAuth thông qua một UI dashboard hiện đại.

## ✨ Tính năng

| | |
|---|---|
| 🦊 **Camofox Server** | Khởi động/dừng headless browser server trực tiếp từ UI |
| 🤖 **Unified Auto Worker** | 1 process duy nhất — tự chọn flow connect (nhanh) hoặc login PKCE theo task |
| 📋 **Live Terminal** | Xem log realtime từ tất cả processes qua WebSocket |
| 📜 **Scripts tích hợp** | Chạy scripts ngay trong dự án — không trỏ ra ngoài |
| 📡 **Health Monitor** | Ping Camofox & Gateway, hiển thị trạng thái kết nối |
| ⚙️ **Cài đặt** | Cấu hình paths, tokens, threads — lưu vào `tools.config.json` |

## 🚀 Khởi động

```bash
npm run dev
```

Mở trình duyệt: **http://localhost:4000**

## 📁 Cấu trúc dự án

```
seellm-tools/
├── server.js                        # Custom Express + Socket.io server
├── scripts/                         # ← Tất cả automation scripts
│   ├── config.js                    #   Đọc cài đặt từ tools.config.json
│   ├── auto-worker.js               #   Worker hợp nhất: login + connect queue
│   ├── backup/                      #   Lưu bản gốc auto-login/auto-connect để đối chiếu
│   ├── get-session-token.js         #   Lấy session cookie từ Camofox
│   ├── ping-servers.js              #   Kiểm tra kết nối Camofox & Gateway
│   ├── test-camofox.js              #   Test server Camofox
│   ├── test-proxy.js                #   Test proxy qua Camofox
│   ├── gen-2fa.js                   #   Tạo mã TOTP 2FA
│   └── images/                      #   Screenshots từ automation
├── src/
│   ├── app/
│   │   ├── layout.tsx
│   │   ├── page.tsx
│   │   └── globals.css              # Design system (dark glassmorphism)
│   └── components/
│       ├── AppContext.tsx            # State + Socket.io client
│       ├── Dashboard.tsx            # Layout: sidebar + topbar
│       └── Views.tsx                # 4 views: Dashboard/Logs/Scripts/Settings
└── tools.config.json               # Runtime config (gitignored)
```

## ⚙️ Cài đặt (lần đầu)

Vào tab **⚙️ Cài đặt** thiết lập:

| Trường | Mô tả |
|--------|-------|
| **Camofox Path** | Thư mục cài camofox-browser (`/path/to/camofox-browser`) |
| **Camofox Port** | Port chạy Camofox server (mặc định: 3000) |
| **Camofox API URL** | URL API nội bộ Camofox (mặc định: `http://localhost:9377`) |
| **Gateway URL** | URL SeeLLM Gateway |
| **Worker Auth Token** | Token xác thực với Gateway |
| **Max Threads** | Số tài khoản xử lý song song |

## 🔄 Quy trình sử dụng

```
1. Cài đặt → điền Camofox Path & Gateway URL & Auth Token
2. Dashboard → bấm "🦊 Camofox" để khởi động browser server
3. Scripts → chạy "test-camofox.js" để verify
4. Dashboard → bấm "🤖 Worker" để khởi động unified worker
5. Logs → xem realtime output từ Worker
6. Scripts → chạy "get-session-token.js" để lấy session
```

## 🏗️ Kiến trúc

```
Browser (http://localhost:4000)
    ↕ WebSocket (Socket.io)
SeeLLM Tools Server (Express + Next.js)
    ├── Manages → Camofox Browser Server (spawned process)
    ├── Manages → Unified Auto Worker (spawned process)
    └── Manages → Any scripts/ script (spawned process)
                        ↕ HTTP API
              SeeLLM Gateway (external)
```
