# Requirements Document

## Introduction

Khi một tài khoản trên seellm-gateway gặp lỗi (auth failed, Token Invalidated 401, rate limited, token expired...), người dùng cần biết ngay trong seellm-tools rằng tài khoản đó đang có vấn đề gì và cần thực hiện hành động gì để khắc phục.

Hiện tại, seellm-tools hiển thị trạng thái tài khoản dựa trên dữ liệu từ D1 Worker (Cloudflare) — được pull theo chu kỳ (mặc định 15 phút). Điều này dẫn đến:
- Trạng thái hiển thị bị trễ so với thực tế trên gateway
- Không có chỉ dẫn hành động cụ thể (cần re-login? cần refresh token? cần kiểm tra proxy?)
- Người dùng phải mở cả hai hệ thống để đối chiếu

Feature này bổ sung khả năng **fetch trực tiếp trạng thái health từ gateway**, hiển thị **badge trạng thái gateway chi tiết** kèm **hướng dẫn hành động**, và cung cấp cơ chế **đồng bộ realtime** giữa hai hệ thống.

## Glossary

- **Gateway**: seellm-gateway — hệ thống AI proxy/router quản lý provider connections, thực hiện token health check định kỳ.
- **Tools**: seellm-tools — automation control panel quản lý tài khoản, chạy worker kết nối OAuth.
- **Gateway_Health_Status**: Trạng thái sức khỏe kết nối của một tài khoản trên Gateway, bao gồm: `active` (hoạt động tốt), `error` (lỗi chung), `expired` (token hết hạn vĩnh viễn), `rate_limited` (bị giới hạn tốc độ).
- **Connection_Record**: Bản ghi trong bảng `provider_connections` trên Gateway, chứa các trường health: `testStatus`, `lastError`, `lastErrorType`, `errorCode`, `rateLimitedUntil`, `isActive`, `lastHealthCheckAt`.
- **Error_Type**: Phân loại lỗi cụ thể từ Gateway: `upstream_auth_error`, `token_refresh_failed`, `token_expired`, `upstream_rate_limited`, `network_error`, `runtime_error`, `upstream_unavailable`.
- **Action_Hint**: Gợi ý hành động mà người dùng cần thực hiện để khắc phục lỗi (ví dụ: "Cần re-login", "Chờ hết cooldown", "Kiểm tra proxy").
- **Health_Fetch**: Quá trình Tools gọi API của Gateway để lấy trạng thái health realtime của các connections.
- **AccountsView**: Component React hiển thị danh sách tài khoản trong Tools.
- **ServicesView**: Component React hiển thị danh sách tài khoản theo provider (Managed Services).
- **GatewayHealthBadge**: Component UI mới hiển thị trạng thái health từ Gateway kèm action hint.
- **Health_Sync_Interval**: Chu kỳ tự động fetch health status từ Gateway (mặc định 60 giây).
- **D1_Worker**: Cloudflare D1 Worker trung gian đồng bộ dữ liệu giữa Tools và Gateway.

## Requirements

### Requirement 1: Fetch trạng thái health từ Gateway API

**User Story:** Là người quản lý tài khoản, tôi muốn seellm-tools tự động lấy trạng thái health realtime từ gateway, để tôi thấy được tình trạng thực tế của từng tài khoản mà không cần mở gateway UI.

#### Acceptance Criteria

1. WHEN Tools server khởi động và `gatewayUrl` được cấu hình trong `tools.config.json`, THE Tools_Server SHALL gọi `GET {gatewayUrl}/api/providers/client` để lấy danh sách connections kèm trạng thái health, với timeout 10 giây cho lần fetch đầu tiên.
2. WHILE Tools server đang chạy và Gateway reachable, THE Tools_Server SHALL tự động fetch health status từ Gateway mỗi Health_Sync_Interval (mặc định 60 giây).
3. WHEN Tools_Server nhận response HTTP 200 từ Gateway API, THE Tools_Server SHALL trích xuất các trường `testStatus`, `lastError`, `lastErrorType`, `errorCode`, `rateLimitedUntil`, `isActive`, `lastHealthCheckAt` cho mỗi connection.
4. THE Tools_Server SHALL match connection từ Gateway với Vault_Account bằng cách so khớp `id` trước; nếu không khớp `id`, so khớp `email` (case-insensitive). Mỗi connection chỉ match tối đa một Vault_Account.
5. IF Gateway không reachable (network error, timeout > 5 giây) hoặc trả về HTTP status khác 200, THEN THE Tools_Server SHALL giữ nguyên dữ liệu health lần fetch gần nhất, đánh dấu `healthFetchStatus = 'stale'`, và tiếp tục retry vào chu kỳ Health_Sync_Interval tiếp theo.
6. WHEN health data được cập nhật thành công, THE Tools_Server SHALL emit SSE event `gateway_health_updated` kèm danh sách account IDs có thay đổi ở bất kỳ trường nào trong `testStatus`, `lastErrorType`, `errorCode`, `isActive`, `rateLimitedUntil` so với lần fetch trước.
7. IF Gateway API trả về response với body không parse được (không phải JSON hợp lệ hoặc thiếu trường connections), THEN THE Tools_Server SHALL xử lý tương đương trường hợp Gateway không reachable và đánh dấu `healthFetchStatus = 'stale'`.

---

### Requirement 2: API endpoint cung cấp gateway health cho frontend

**User Story:** Là developer frontend, tôi muốn có một API endpoint trả về trạng thái health từ gateway đã được merge với dữ liệu account local, để UI có thể hiển thị mà không cần gọi trực tiếp gateway.

#### Acceptance Criteria

1. THE Tools_Server SHALL cung cấp endpoint `GET /api/gateway/health` trả về HTTP 200 với JSON body chứa trường `accounts` (mảng các account health object) và trường `meta` (object metadata).
2. THE Tools_Server SHALL trả về mỗi account health object chứa: `accountId`, `email`, `gatewayTestStatus`, `gatewayErrorType`, `gatewayErrorCode`, `gatewayLastError`, `gatewayRateLimitedUntil`, `gatewayLastHealthCheckAt`, `gatewayIsActive`.
3. WHEN client gọi `GET /api/gateway/health`, THE Tools_Server SHALL trả về dữ liệu từ cache (lần fetch gần nhất) mà không block chờ fetch mới, với thời gian phản hồi không quá 500ms.
4. THE Tools_Server SHALL bao gồm trong `meta`: trường `lastFetchedAt` (ISO 8601 timestamp) và `fetchStatus` với giá trị `fresh` nếu dữ liệu được fetch trong vòng 1 lần Health_Sync_Interval gần nhất, `stale` nếu dữ liệu cũ hơn 1 lần Health_Sync_Interval hoặc Gateway không reachable ở lần fetch gần nhất, hoặc `unavailable` nếu chưa bao giờ fetch thành công hoặc `gatewayUrl` chưa được cấu hình.
5. WHEN client gọi `GET /api/gateway/health?force=1`, THE Tools_Server SHALL thực hiện fetch mới từ Gateway trước khi trả response (timeout 10 giây); IF fetch thất bại, THEN THE Tools_Server SHALL fallback về dữ liệu cache với `fetchStatus = 'stale'`.
6. IF `gatewayUrl` chưa được cấu hình hoặc `gatewayHealthEnabled = false`, THEN THE Tools_Server SHALL trả về HTTP 200 với `accounts` là mảng rỗng và `fetchStatus = 'unavailable'`.

---

### Requirement 3: Hiển thị Gateway Health Badge trên AccountsView và ServicesView

**User Story:** Là người quản lý tài khoản, tôi muốn thấy trạng thái health từ gateway ngay trên mỗi account card, để tôi biết tài khoản nào đang lỗi trên gateway mà không cần mở gateway UI.

#### Acceptance Criteria

1. WHEN AccountsView hoặc ServicesView render một tài khoản có `gatewayTestStatus = 'active'` và `gatewayIsActive = true`, THE GatewayHealthBadge SHALL hiển thị "Gateway: OK" với màu xanh lá (emerald).
2. WHEN AccountsView hoặc ServicesView render một tài khoản có `gatewayErrorType = 'upstream_auth_error'` hoặc `gatewayErrorType = 'token_refresh_failed'`, THE GatewayHealthBadge SHALL hiển thị "Gateway: Auth Failed" với màu đỏ (rose), bất kể giá trị `gatewayIsActive`.
3. WHEN AccountsView hoặc ServicesView render một tài khoản có `gatewayErrorType = 'token_expired'` và `gatewayIsActive = false`, THE GatewayHealthBadge SHALL hiển thị "Gateway: Token Invalidated" với màu đỏ (rose).
4. WHEN AccountsView hoặc ServicesView render một tài khoản có `gatewayErrorType = 'upstream_rate_limited'`, THE GatewayHealthBadge SHALL hiển thị "Gateway: Rate Limited" với màu cam (amber).
5. WHEN AccountsView hoặc ServicesView render một tài khoản có `gatewayErrorType = 'network_error'`, THE GatewayHealthBadge SHALL hiển thị "Gateway: Network Error" với màu cam (amber).
6. WHEN AccountsView hoặc ServicesView render một tài khoản có `gatewayErrorType` thuộc `['runtime_error', 'upstream_unavailable', 'token_expired']` mà không khớp điều kiện cụ thể của criteria 2-5 (ví dụ `token_expired` với `gatewayIsActive = true`), THE GatewayHealthBadge SHALL hiển thị "Gateway: Error" với màu cam (amber).
7. WHEN một tài khoản không có dữ liệu health từ Gateway (chưa bao giờ fetch, không match được connection, hoặc `fetchStatus = 'unavailable'`), THE GatewayHealthBadge SHALL hiển thị "Gateway: N/A" với màu xám (slate).
8. THE GatewayHealthBadge SHALL đánh giá trạng thái theo thứ tự ưu tiên giảm dần: criteria 2 (Auth Failed) → criteria 3 (Token Invalidated) → criteria 4 (Rate Limited) → criteria 5 (Network Error) → criteria 6 (Error chung) → criteria 1 (OK) → criteria 7 (N/A); điều kiện khớp đầu tiên được áp dụng.
9. WHEN SSE event `gateway_health_updated` được nhận và danh sách account IDs có thay đổi bao gồm tài khoản đang hiển thị, THE GatewayHealthBadge SHALL tự động cập nhật trạng thái hiển thị trong vòng 2 giây mà không yêu cầu người dùng reload trang.
10. THE GatewayHealthBadge SHALL được hiển thị như một badge riêng biệt bên cạnh badge trạng thái local hiện tại (StatusBadge), không thay thế StatusBadge.

---

### Requirement 4: Hiển thị Action Hint (gợi ý hành động)

**User Story:** Là người quản lý tài khoản, tôi muốn thấy gợi ý hành động cụ thể khi một tài khoản gặp lỗi trên gateway, để tôi biết ngay cần làm gì mà không phải tự suy luận.

#### Acceptance Criteria

1. WHEN GatewayHealthBadge hiển thị trạng thái `Auth Failed`, hoặc trạng thái `Token Invalidated` với `gatewayIsActive = true`, THE GatewayHealthBadge SHALL hiển thị Action_Hint với nội dung "Cần re-login" kèm một icon hành động (action icon) liền kề text hint.
2. WHILE `gatewayRateLimitedUntil` còn trong tương lai, WHEN GatewayHealthBadge hiển thị trạng thái `Rate Limited`, THE GatewayHealthBadge SHALL hiển thị Action_Hint "Chờ đến {thời_gian}" trong đó `{thời_gian}` hiển thị dưới dạng countdown định dạng `MM:SS` nếu thời gian chờ còn lại dưới 60 phút, hoặc `HH:MM:SS` nếu từ 60 phút trở lên, và cập nhật mỗi giây.
3. WHEN GatewayHealthBadge hiển thị trạng thái `Network Error`, THE GatewayHealthBadge SHALL hiển thị Action_Hint "Kiểm tra proxy/network".
4. WHEN GatewayHealthBadge hiển thị trạng thái `Token Invalidated` với `gatewayIsActive = false`, THE GatewayHealthBadge SHALL hiển thị Action_Hint "Token bị thu hồi vĩnh viễn — cần tạo kết nối mới".
5. WHEN người dùng hover vào GatewayHealthBadge trong ít nhất 300ms hoặc click vào GatewayHealthBadge, THE GatewayHealthBadge SHALL hiển thị tooltip chứa: `gatewayLastError` (message lỗi gốc), `gatewayLastHealthCheckAt` (lần check gần nhất, định dạng relative time ví dụ "5 phút trước"), và `gatewayErrorCode`. IF một trong các trường `gatewayLastError`, `gatewayLastHealthCheckAt`, hoặc `gatewayErrorCode` không có giá trị (null hoặc rỗng), THEN THE GatewayHealthBadge SHALL ẩn dòng tương ứng trong tooltip thay vì hiển thị giá trị trống.
6. WHILE GatewayHealthBadge đang hiển thị một trạng thái lỗi (bất kỳ trạng thái nào trong `Auth Failed`, `Token Invalidated`, `Rate Limited`, `Network Error`), THE GatewayHealthBadge SHALL hiển thị Action_Hint tương ứng luôn nhìn thấy được (visible) ngay bên cạnh badge mà không cần hover hay click.
7. WHEN `gatewayRateLimitedUntil` hết hạn (thời gian hiện tại vượt qua giá trị `gatewayRateLimitedUntil`), THE GatewayHealthBadge SHALL tự động ẩn Action_Hint "Chờ đến {thời_gian}" trong vòng 2 giây sau khi hết hạn.

---

### Requirement 5: Nút hành động nhanh từ trạng thái gateway

**User Story:** Là người quản lý tài khoản, tôi muốn có nút hành động nhanh ngay trên account card khi gateway báo lỗi, để tôi có thể khắc phục ngay mà không cần navigate đi nơi khác.

#### Acceptance Criteria

1. WHEN GatewayHealthBadge hiển thị `Auth Failed` hoặc `Token Invalidated` cho một tài khoản có `status = 'ready'` hoặc `status = 'idle'`, THE AccountsView SHALL hiển thị nút "Re-login" cho phép trigger worker re-connect tài khoản đó.
2. WHEN người dùng click nút "Re-login", THE Tools_Server SHALL cập nhật `status = 'pending'` cho Vault_Account tương ứng và đưa tài khoản vào queue của worker, và THE AccountsView SHALL disable nút "Re-login" và hiển thị trạng thái loading cho đến khi nhận response từ server hoặc hết timeout 15 giây.
3. WHEN GatewayHealthBadge hiển thị `Rate Limited`, THE AccountsView SHALL hiển thị nút "Force Refresh" cho phép trigger gateway health check lại tài khoản đó (gọi `PUT {gatewayUrl}/api/providers/{id}` với `testStatus: null` để reset), và THE AccountsView SHALL disable nút "Force Refresh" và hiển thị trạng thái loading cho đến khi nhận response từ server hoặc hết timeout 15 giây.
4. WHEN người dùng click nút hành động và request được gửi thành công, THE AccountsView SHALL cập nhật badge và trạng thái trong UI trước khi nhận xác nhận cuối cùng từ server (optimistic update).
5. IF request từ nút hành động thất bại (server trả lỗi hoặc timeout sau 15 giây), THEN THE AccountsView SHALL rollback optimistic update về trạng thái trước đó, enable lại nút hành động, và hiển thị thông báo lỗi cho người dùng trong tối thiểu 3 giây.
6. WHILE tài khoản có `status = 'pending'` hoặc `status = 'connecting'`, THE AccountsView SHALL ẩn nút "Re-login" để tránh trigger trùng lặp.

---

### Requirement 6: Bộ lọc theo trạng thái Gateway Health

**User Story:** Là người quản lý tài khoản, tôi muốn lọc danh sách tài khoản theo trạng thái health trên gateway, để tôi nhanh chóng tìm tất cả tài khoản đang gặp vấn đề cần xử lý.

#### Acceptance Criteria

1. THE AccountsView SHALL cung cấp bộ lọc "Gateway Health" với các tùy chọn: `all` (tất cả), `healthy` (gateway OK), `auth_failed` (auth lỗi), `rate_limited` (bị giới hạn), `network_error` (lỗi mạng), `no_data` (chưa có dữ liệu gateway), và giá trị mặc định khi tải trang là `all`.
2. WHEN người dùng chọn bộ lọc `healthy`, THE AccountsView SHALL chỉ hiển thị tài khoản có `gatewayTestStatus = 'active'` và `gatewayIsActive = true` và không có `gatewayErrorType`.
3. WHEN người dùng chọn bộ lọc `auth_failed`, THE AccountsView SHALL chỉ hiển thị tài khoản có `gatewayErrorType` thuộc `['upstream_auth_error', 'token_refresh_failed', 'token_expired']`.
4. WHEN người dùng chọn bộ lọc `rate_limited`, THE AccountsView SHALL chỉ hiển thị tài khoản có `gatewayErrorType = 'upstream_rate_limited'` hoặc `gatewayRateLimitedUntil` là timestamp trong tương lai so với thời điểm hiện tại của client.
5. WHEN người dùng chọn bộ lọc `network_error`, THE AccountsView SHALL chỉ hiển thị tài khoản có `gatewayErrorType` thuộc `['network_error', 'upstream_unavailable']`.
6. WHEN người dùng chọn bộ lọc `no_data`, THE AccountsView SHALL chỉ hiển thị tài khoản không có dữ liệu health từ Gateway (tài khoản chưa được match với connection hoặc chưa bao giờ fetch health, tức `gatewayTestStatus` là null hoặc undefined).
7. WHILE bộ lọc Gateway Health có giá trị khác `all`, THE AccountsView SHALL kết hợp với các bộ lọc hiện có (status, provider) bằng AND logic.
8. THE AccountsView SHALL hiển thị số lượng tài khoản matching bên cạnh mỗi tùy chọn lọc (ví dụ: "Auth Failed (3)") và cập nhật số lượng này trong vòng 2 giây khi nhận SSE event `gateway_health_updated`.

---

### Requirement 7: Thống kê tổng quan Gateway Health trên Dashboard

**User Story:** Là người quản lý tài khoản, tôi muốn thấy tổng quan nhanh về sức khỏe tài khoản trên gateway ngay đầu trang, để tôi nắm được tình trạng tổng thể mà không cần cuộn qua danh sách.

#### Acceptance Criteria

1. THE AccountsView SHALL hiển thị một dải thống kê (stat bar) ở đầu trang bao gồm: số tài khoản "Gateway OK", số tài khoản "Auth Failed", số tài khoản "Rate Limited", và số tài khoản "Không có dữ liệu", trong đó tổng 4 giá trị phải bằng tổng số tài khoản hiện có trong danh sách.
2. WHEN dữ liệu gateway health được cập nhật (qua SSE event `gateway_health_updated`), THE AccountsView SHALL cập nhật stat bar trong vòng 2 giây mà không yêu cầu người dùng refresh.
3. IF stat bar hiển thị số tài khoản "Auth Failed" > 0, THEN THE AccountsView SHALL hiển thị stat "Auth Failed" với màu nền rose và cho phép click để tự động áp dụng bộ lọc `auth_failed` lên danh sách tài khoản.
4. IF stat bar hiển thị số tài khoản "Rate Limited" > 0, THEN THE AccountsView SHALL hiển thị stat "Rate Limited" với màu nền cảnh báo (amber) và cho phép click để tự động áp dụng bộ lọc `rate_limited` lên danh sách tài khoản.
5. THE stat bar SHALL hiển thị timestamp "Cập nhật lần cuối: {lastFetchedAt}" theo định dạng thời gian tương đối (ví dụ: "3 phút trước") và cập nhật mỗi 60 giây.
6. IF kết nối SSE bị mất hoặc không nhận được event `gateway_health_updated` trong vòng 120 giây, THEN THE stat bar SHALL hiển thị chỉ báo trạng thái "Mất kết nối" để người dùng biết dữ liệu có thể không còn chính xác.

---

### Requirement 8: Cấu hình Gateway Health Sync

**User Story:** Là người quản lý hệ thống, tôi muốn cấu hình tần suất và hành vi đồng bộ health từ gateway, để tôi có thể điều chỉnh phù hợp với môi trường triển khai.

#### Acceptance Criteria

1. THE Tools_Server SHALL đọc cấu hình `gatewayHealthSyncInterval` (giây) từ `tools.config.json`, mặc định 60 giây; IF giá trị được cấu hình nhỏ hơn 30 giây, THEN THE Tools_Server SHALL sử dụng 30 giây làm giá trị tối thiểu.
2. THE Tools_Server SHALL đọc cấu hình `gatewayHealthEnabled` (boolean) từ `tools.config.json`, mặc định `true`.
3. WHILE `gatewayHealthEnabled = false`, THE Tools_Server SHALL không thực hiện Health_Fetch tự động và GatewayHealthBadge SHALL hiển thị "Disabled" với màu xám (slate).
4. WHEN `gatewayUrl` không được cấu hình hoặc rỗng, THE Tools_Server SHALL không thực hiện Health_Fetch và GatewayHealthBadge SHALL hiển thị "Gateway: N/A" với tooltip "Chưa cấu hình Gateway URL".
5. THE Settings view SHALL cho phép người dùng bật/tắt Gateway Health Sync và điều chỉnh interval từ UI, với thay đổi có hiệu lực ngay lập tức mà không cần restart server.
