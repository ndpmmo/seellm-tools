# Requirements Document

## Introduction

Hiện tại, danh sách tài khoản trong seellm-tools không phân biệt được tài khoản nào đang thực sự hoạt động trên seellm-gateway, tài khoản nào đã bị Gateway thu hồi, và trạng thái đồng bộ giữa local vault và cloud (Cloudflare D1 Worker) có nhất quán không.

Feature này bổ sung một lớp **Gateway Visibility** — bao gồm trường dữ liệu mới `gateway_status`, logic cập nhật tự động trong SyncManager, và nhãn/badge rõ ràng trên UI — để người dùng nhìn vào danh sách tài khoản là biết ngay cái nào đang chạy trên Gateway, cái nào đã bị thu hồi, và cái nào chưa bao giờ được deploy.

## Glossary

- **Vault**: SQLite local database (`vault.db`) lưu trữ tài khoản, proxy, API key trong seellm-tools. Đây là kho độc lập, không bị xóa khi Gateway thu hồi account.
- **Vault_Account**: Một bản ghi trong bảng `vault_accounts` của Vault, đại diện cho một tài khoản được quản lý bởi seellm-tools.
- **Gateway**: seellm-gateway — hệ thống proxy AI sử dụng tài khoản từ `provider_connections` table trên Cloudflare D1 để phục vụ API request.
- **D1_Worker**: Cloudflare D1 Worker (`seellm-gateway-worker.clicktechlimited.workers.dev`) — trung gian đồng bộ dữ liệu giữa Vault và Gateway.
- **SyncManager**: Module `server/services/syncManager.js` xử lý push/pull dữ liệu giữa Vault local và D1_Worker.
- **Gateway_Status**: Trường mới trong `vault_accounts` phản ánh trạng thái hiện tại của tài khoản trên Gateway. Các giá trị hợp lệ: `null` (chưa bao giờ push), `pending_push` (đang chờ push), `active` (đang hoạt động trên Gateway), `revoked` (đã bị Gateway thu hồi/xóa).
- **Gateway Revocation**: Sự kiện Gateway xóa account khỏi `managed_accounts` hoặc `provider_connections` (thể hiện qua `deleted_at` trong dữ liệu pull về từ D1_Worker).
- **Idle-New**: Tài khoản có `status='idle'` và `gateway_status=null` — chưa bao giờ được deploy lên Gateway.
- **Idle-Revoked**: Tài khoản có `status='idle'` và `gateway_status='revoked'` — đã từng active trên Gateway nhưng đã bị thu hồi.
- **SSE**: Server-Sent Events — cơ chế push realtime từ server Express đến UI Next.js.
- **AccountsView**: Component React `src/components/views/AccountsView.tsx` hiển thị danh sách tài khoản.

## Requirements

### Requirement 1: Trường Gateway_Status trong Vault_Account

**User Story:** Là người quản lý tài khoản, tôi muốn mỗi tài khoản trong Vault có một trường rõ ràng phản ánh trạng thái hiện tại trên Gateway, để tôi không cần đoán xem tài khoản đó có đang được Gateway sử dụng hay không.

#### Acceptance Criteria

1. THE Vault SHALL lưu trữ trường `gateway_status` trong bảng `vault_accounts` với kiểu TEXT, giá trị mặc định là `null`.
2. THE Vault SHALL chỉ chấp nhận các giá trị `gateway_status` thuộc tập hợp: `null`, `'pending_push'`, `'active'`, `'revoked'`.
3. WHEN một Vault_Account được tạo mới, THE Vault SHALL khởi tạo `gateway_status` bằng `null`.
4. THE Vault SHALL áp dụng migration tự động để thêm cột `gateway_status` vào bảng `vault_accounts` hiện có mà không làm mất dữ liệu.
5. FOR ALL Vault_Account records hiện có sau migration, THE Vault SHALL gán `gateway_status = 'active'` nếu `ever_ready = 1` và `status = 'ready'`, gán `gateway_status = 'revoked'` nếu `ever_ready = 1` và `status = 'idle'`, và giữ `gateway_status = null` cho các trường hợp còn lại.

---

### Requirement 2: SyncManager cập nhật Gateway_Status khi Push

**User Story:** Là người quản lý tài khoản, tôi muốn trạng thái Gateway được cập nhật tự động mỗi khi SyncManager push dữ liệu lên D1, để tôi không cần thao tác thủ công.

#### Acceptance Criteria

1. WHEN SyncManager thực hiện push thành công một Vault_Account có `status = 'ready'`, THE SyncManager SHALL cập nhật `gateway_status = 'active'` cho Vault_Account đó trong Vault.
2. WHEN SyncManager thực hiện push thành công một Vault_Account có `status = 'idle'` (Rule 3 — soft-delete khỏi Gateway), THE SyncManager SHALL cập nhật `gateway_status = 'revoked'` cho Vault_Account đó trong Vault.
3. WHEN SyncManager bắt đầu push một Vault_Account (trước khi nhận phản hồi từ D1_Worker), THE SyncManager SHALL cập nhật `gateway_status = 'pending_push'` cho Vault_Account đó trong Vault.
4. IF SyncManager nhận lỗi từ D1_Worker khi push, THEN THE SyncManager SHALL giữ nguyên giá trị `gateway_status` trước đó và không ghi đè bằng `pending_push`.
5. WHEN SyncManager push một Vault_Account có `deleted_at` được set (hard delete — Rule 2), THE SyncManager SHALL cập nhật `gateway_status = 'revoked'` cho Vault_Account đó trong Vault.
6. WHEN SyncManager push một Vault_Account có `status` thuộc `['error', 'need_phone', 'relogin']` và `ever_ready = 1`, THE SyncManager SHALL giữ nguyên `gateway_status = 'active'` (account vẫn còn trên Gateway dù đang lỗi).
7. WHEN SyncManager push một Vault_Account có `status` thuộc `['error', 'need_phone', 'relogin']` và `ever_ready = 0`, THE SyncManager SHALL cập nhật `gateway_status = 'revoked'` (connection bị tombstone khỏi Gateway).

---

### Requirement 3: SyncManager cập nhật Gateway_Status khi Pull

**User Story:** Là người quản lý tài khoản, tôi muốn khi Gateway thu hồi một tài khoản (xóa khỏi managed_accounts), seellm-tools tự động cập nhật trạng thái Gateway của tài khoản đó, để tôi biết ngay mà không cần refresh thủ công.

#### Acceptance Criteria

1. WHEN SyncManager nhận dữ liệu pull từ D1_Worker và một `managedAccount` có `deleted_at` được set, THE SyncManager SHALL cập nhật `gateway_status = 'revoked'` cho Vault_Account tương ứng trong Vault.
2. WHEN SyncManager cập nhật `gateway_status = 'revoked'` do Gateway Revocation, THE SyncManager SHALL KHÔNG set `deleted_at` trên Vault_Account (Vault là kho độc lập).
3. WHEN SyncManager nhận dữ liệu pull và một `managedAccount` có `deleted_at = null` và `status = 'ready'`, THE SyncManager SHALL cập nhật `gateway_status = 'active'` cho Vault_Account tương ứng.
4. FOR ALL Vault_Account records được cập nhật bởi pullVault, THE SyncManager SHALL đảm bảo `gateway_status` nhất quán với trạng thái `deleted_at` của `managedAccount` tương ứng: nếu `deleted_at` set thì `gateway_status = 'revoked'`, nếu không thì `gateway_status` phản ánh trạng thái hoạt động.
5. WHEN SyncManager hoàn thành một chu kỳ pull có cập nhật `gateway_status`, THE SyncManager SHALL emit một SSE event `gateway_status_changed` kèm danh sách account ID bị thay đổi.

---

### Requirement 4: Phân biệt Idle-New và Idle-Revoked trong UI

**User Story:** Là người quản lý tài khoản, tôi muốn nhìn vào danh sách tài khoản và phân biệt ngay tài khoản nào chưa bao giờ được deploy (idle-new) với tài khoản đã bị Gateway thu hồi (idle-revoked), để tôi biết cần xử lý gì tiếp theo.

#### Acceptance Criteria

1. WHEN AccountsView hiển thị một Vault_Account có `status = 'idle'` và `gateway_status = null`, THE AccountsView SHALL hiển thị badge "Chưa deploy" với màu xám trung tính (slate).
2. WHEN AccountsView hiển thị một Vault_Account có `status = 'idle'` và `gateway_status = 'revoked'`, THE AccountsView SHALL hiển thị badge "Đã thu hồi" với màu cam (amber) để phân biệt với idle thông thường.
3. WHEN AccountsView hiển thị một Vault_Account có `gateway_status = 'active'`, THE AccountsView SHALL hiển thị badge "Trên Gateway" với màu xanh lá (emerald) kèm icon Globe.
4. WHEN AccountsView hiển thị một Vault_Account có `gateway_status = 'pending_push'`, THE AccountsView SHALL hiển thị badge "Đang đồng bộ" với animation spinner hoặc màu xanh dương (indigo).
5. THE AccountsView SHALL hiển thị Gateway_Status badge như một nhãn phụ riêng biệt, không thay thế badge trạng thái local hiện tại (`status`), để người dùng thấy cả hai chiều thông tin.

---

### Requirement 5: Bộ lọc theo Gateway Status trong AccountsView

**User Story:** Là người quản lý tài khoản, tôi muốn lọc danh sách tài khoản theo trạng thái Gateway, để tôi nhanh chóng tìm thấy các tài khoản cần xử lý (ví dụ: tất cả tài khoản đã bị thu hồi).

#### Acceptance Criteria

1. THE AccountsView SHALL cung cấp bộ lọc `gateway_status` với các tùy chọn: `all`, `active`, `revoked`, `pending_push`, `not_deployed`.
2. WHEN người dùng chọn bộ lọc `active`, THE AccountsView SHALL chỉ hiển thị các Vault_Account có `gateway_status = 'active'`.
3. WHEN người dùng chọn bộ lọc `revoked`, THE AccountsView SHALL chỉ hiển thị các Vault_Account có `gateway_status = 'revoked'`.
4. WHEN người dùng chọn bộ lọc `not_deployed`, THE AccountsView SHALL chỉ hiển thị các Vault_Account có `gateway_status = null`.
5. WHILE bộ lọc `gateway_status` đang active, THE AccountsView SHALL kết hợp bộ lọc này với bộ lọc `status` hiện tại (AND logic), không thay thế.

---

### Requirement 6: API trả về Gateway_Status

**User Story:** Là developer tích hợp, tôi muốn các API endpoint trả về trường `gateway_status` trong dữ liệu tài khoản, để frontend và các công cụ khác có thể hiển thị và xử lý trạng thái Gateway mà không cần join thêm bảng.

#### Acceptance Criteria

1. WHEN client gọi `GET /api/vault/accounts`, THE Vault_API SHALL trả về trường `gateway_status` trong mỗi object tài khoản.
2. FOR ALL tài khoản được trả về bởi `GET /api/vault/accounts`, THE Vault_API SHALL đảm bảo `gateway_status` thuộc tập hợp `{null, 'pending_push', 'active', 'revoked'}` — không bao giờ là `undefined`.
3. WHEN client gọi `GET /api/d1/inspect/accounts`, THE Vault_API SHALL bao gồm `gateway_status` trong response để AccountsView có thể hiển thị mà không cần gọi thêm endpoint.
4. WHEN client gọi `POST /api/vault/accounts/:id/sync` (force sync), THE Vault_API SHALL cập nhật `gateway_status` dựa trên kết quả push và trả về `gateway_status` mới trong response.

---

### Requirement 7: Thống kê Gateway trên Dashboard

**User Story:** Là người quản lý tài khoản, tôi muốn thấy tổng quan nhanh về số lượng tài khoản đang active trên Gateway, đã bị thu hồi, và chưa deploy, để tôi nắm được tình trạng tổng thể mà không cần cuộn qua toàn bộ danh sách.

#### Acceptance Criteria

1. THE AccountsView SHALL hiển thị các StatBox tóm tắt bao gồm: số tài khoản có `gateway_status = 'active'`, số tài khoản có `gateway_status = 'revoked'`, và số tài khoản có `gateway_status = null` (chưa deploy).
2. WHEN dữ liệu tài khoản được tải lại (refresh), THE AccountsView SHALL cập nhật các StatBox thống kê Gateway đồng thời với danh sách tài khoản.
3. WHEN AccountsView nhận SSE event `gateway_status_changed`, THE AccountsView SHALL tự động cập nhật StatBox và các badge liên quan mà không yêu cầu người dùng nhấn refresh.
