# 🛠 SeeLLM Tools — Kế Hoạch Nâng Cấp v3.0

> **Mục tiêu:** Biến SeeLLM Tools thành một dashboard quản lý AI cá nhân hoàn chỉnh, đa nhà cung cấp, tách biệt rõ ràng giữa nguồn dữ liệu riêng và nguồn từ Gateway/D1.

---

## 1. Vấn Đề Hiện Tại

| Tình trạng | Mô tả |
|---|---|
| ❌ Chỉ hỗ trợ ChatGPT/Codex | Chưa có cấu trúc cho các provider khác (Claude, Gemini, Cursor...) |
| ❌ Accounts không rõ nguồn gốc | Lẫn lộn account từ Gateway D1 với account thêm riêng ở Tools |
| ❌ Tools-native DB chưa tồn tại | Chưa có cơ sở dữ liệu local cho Tools (chỉ config file) |
| ❌ Không thể Export/Import | Không có cách trích xuất dữ liệu từ Tools sang Gateway |

---

## 2. Kiến Trúc 3 Lớp (3-Layer Architecture)

```
┌─────────────────────────────────────────────────────────┐
│                    SEELLM TOOLS v3                       │
│                                                          │
│  ┌──────────────┐  ┌───────────────┐  ┌──────────────┐ │
│  │  Layer 1:    │  │  Layer 2:     │  │  Layer 3:    │ │
│  │  VAULT       │  │  D1 CLOUD     │  │  GATEWAY     │ │
│  │  (Local DB)  │  │  (Cloudflare) │  │  (localhost) │ │
│  │              │  │               │  │              │ │
│  │ • Accounts   │  │ • Codex Accts │  │ • Providers  │ │
│  │ • Proxies    │  │ • Proxy Pool  │  │ • Connections│ │
│  │ • API Keys   │  │ • Slots       │  │ • Models     │ │
│  │ • Cookies    │  │               │  │ • API Keys   │ │
│  │              │  │               │  │              │ │
│  │ SQLite local │  │ REST Worker   │  │ REST/native  │ │
│  └──────┬───────┘  └───────┬───────┘  └──────┬───────┘ │
│         │                  │                  │         │
│         └──────────────────┴──────────────────┘         │
│                    Export / Import / Push                │
└─────────────────────────────────────────────────────────┘
```

---

## 3. Cấu Trúc Sidebar Mới

```
SEELLM TOOLS
├── 📊 TỔNG QUAN
│   ├── Dashboard
│   ├── Terminal Logs
│   ├── Screenshots
│   └── Log Files
│
├── 🗃 VAULT (Layer 1 — Kho Dữ Liệu Cá Nhân)
│   ├── Accounts           ← Tài khoản cá nhân (mọi provider)
│   ├── Proxies            ← Proxy list cá nhân
│   ├── API Keys           ← API keys cá nhân
│   └── Cookies            ← Cookie exports từ browser
│
├── ☁ D1 CLOUD (Layer 2 — Cloudflare)
│   ├── Codex Accounts     ← Tài khoản Codex sync với D1
│   ├── Proxy Pool         ← Pool proxy với slots
│   └── Connections        ← Trạng thái kết nối D1 worker
│
├── ⚡ GATEWAY (Layer 3 — SeeLLM-Gateway)
│   ├── Providers          ← Danh sách providers ở Gateway
│   ├── Provider Accounts  ← Accounts ở Gateway
│   └── Usage Stats        ← Thống kê sử dụng
│
├── 🔄 ĐỒNG BỘ
│   ├── Sync Hub           ← Export/Import giữa 3 lớp
│   └── Sync History
│
├── 🔧 CÔNG CỤ
│   └── Scripts
│
└── ⚙ CÀI ĐẶT
    └── Settings
```

---

## 4. Layer 1 — VAULT Schema (vault.db)

```sql
-- Tài khoản cá nhân (mọi provider)
CREATE TABLE vault_accounts (
  id            TEXT PRIMARY KEY,
  provider      TEXT NOT NULL,       -- 'openai','anthropic','codex','cursor','gemini'...
  label         TEXT,
  email         TEXT,
  password      TEXT,                -- Encrypted
  two_fa_secret TEXT,                -- Encrypted
  proxy_url     TEXT,
  cookies       TEXT,                -- JSON
  access_token  TEXT,                -- Encrypted
  refresh_token TEXT,                -- Encrypted
  status        TEXT DEFAULT 'idle', -- idle | ready | error
  notes         TEXT,
  tags          TEXT,                -- JSON array
  exported_to   TEXT,                -- 'd1' | 'gateway' | null
  exported_at   TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- Proxy cá nhân
CREATE TABLE vault_proxies (
  id          TEXT PRIMARY KEY,
  label       TEXT,
  url         TEXT NOT NULL,         -- protocol://user:pass@host:port
  type        TEXT DEFAULT 'http',   -- http | socks5
  country     TEXT,
  provider    TEXT,
  is_active   INTEGER DEFAULT 1,
  last_tested TEXT,
  latency_ms  INTEGER,
  notes       TEXT,
  created_at  TEXT NOT NULL
);

-- API Keys cá nhân
CREATE TABLE vault_api_keys (
  id            TEXT PRIMARY KEY,
  provider      TEXT NOT NULL,
  label         TEXT,
  key_value     TEXT NOT NULL,       -- Encrypted
  base_url      TEXT,
  is_active     INTEGER DEFAULT 1,
  daily_limit   INTEGER,
  monthly_limit INTEGER,
  notes         TEXT,
  created_at    TEXT NOT NULL
);

-- Cookies
CREATE TABLE vault_cookies (
  id         TEXT PRIMARY KEY,
  label      TEXT,
  domain     TEXT,
  data       TEXT NOT NULL,          -- JSON Chrome/Netscape format
  account_id TEXT,                   -- FK → vault_accounts.id
  created_at TEXT NOT NULL
);
```

---

## 5. Sync Hub — Đồng Bộ 3 Chiều

```
VAULT Account ──────[Push]──────→ D1 Codex accounts
              ──────[Push]──────→ Gateway provider_connections

D1 Account ─────────[Pull]──────→ VAULT (backup)
Gateway Account ────[Pull]──────→ VAULT (backup)
```

**Auto-sync rules (cài trong Settings):**
- Khi thêm account Codex vào Vault → tự động push lên D1
- Khi D1 có account mới → tự động kéo về Vault

---

## 6. Roadmap — 4 Milestones

### ✅ M0 — Hoàn thành
- Dashboard, Proxy Pool D1 interactive, Accounts D1 CRUD

### 🎯 M1 — Backend Vault Infrastructure
- [ ] `server/db/vault.js` — SQLite helpers
- [ ] Schema migration (vault_accounts, vault_proxies, vault_api_keys, vault_cookies)
- [ ] API `/api/vault/accounts` CRUD
- [ ] API `/api/vault/proxies` CRUD
- [ ] API `/api/vault/api-keys` CRUD
- [ ] Bulk import (CSV/JSON)

### 🎯 M2 — UI Restructure + Vault Views
- [ ] Sidebar tách 4 sections (Vault / D1 Cloud / Gateway / Công Cụ)
- [ ] `VaultAccountsView.tsx` — CRUD, multi-provider, tags, filter
- [ ] `VaultProxiesView.tsx` — CRUD proxies cá nhân
- [ ] `VaultApiKeysView.tsx` — CRUD API keys + masking
- [ ] Dynamic form theo từng provider

### 🎯 M3 — Gateway Integration
- [ ] `GatewayProvidersView.tsx`
- [ ] `GatewayAccountsView.tsx`
- [ ] `GatewayUsageView.tsx` (charts)

### 🎯 M4 — Sync Hub
- [ ] `SyncView.tsx` — UI wizard đồng bộ
- [ ] Vault → D1 export (account, proxy mapping)
- [ ] Vault → Gateway export
- [ ] D1/Gateway → Vault import
- [ ] Auto-sync rules trong Settings

---

## 7. Cấu Trúc File Đề Xuất

```
seellm-tools/
├── server.js
├── server/
│   ├── db/
│   │   └── vault.js              🆕 SQLite vault helpers
│   ├── routes/
│   │   ├── vault.js              🆕 /api/vault/*
│   │   ├── gateway.js            🆕 /api/gateway/*
│   │   └── d1.js                 (trích từ server.js)
│   └── sync/
│       └── syncEngine.js         🆕 Logic đồng bộ 3 chiều
├── data/
│   ├── vault.db                  🆕 SQLite vault
│   ├── screenshots/
│   └── logs/
└── src/components/views/
    ├── vault/
    │   ├── VaultAccountsView.tsx 🆕
    │   ├── VaultProxiesView.tsx  🆕
    │   └── VaultApiKeysView.tsx  🆕
    ├── d1/
    │   ├── CodexAccountsView.tsx (= AccountsView hiện tại)
    │   └── ProxyPoolView.tsx     (= ProxiesView hiện tại)
    ├── gateway/
    │   ├── GatewayProvidersView.tsx 🆕
    │   ├── GatewayAccountsView.tsx  🆕
    │   └── GatewayUsageView.tsx     🆕
    └── sync/
        └── SyncView.tsx          🆕
```

---

## 8. Câu Hỏi Cần Chốt Trước Khi Triển Khai

1. **Mã hóa Vault?** Có cần mã hóa passwords/tokens không? Dùng master password hay key tự động?
2. **Bắt đầu từ Milestone nào?** M1 (Backend) hay M2 (Sidebar restructure) trước?
3. **Provider ưu tiên?** Ngoài OpenAI/Codex, provider nào cần ngay trong v3?
4. **Gateway — read-only hay write?** Chỉ xem hay cũng cho phép sửa trực tiếp từ Tools?
