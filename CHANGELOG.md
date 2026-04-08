# Changelog

Tất cả các thay đổi đáng chú ý đối với dự án **SeeLLM Tools** sẽ được ghi lại trong tệp này.

## [0.1.5] - 2026-04-09
### Refactored
- **Cold Storage Concept**: Bóc tách chức năng giữa `Vault Accounts` (Kho lưu trữ lạnh) và `Codex Accounts`/Gateway (Trạm kết nối đang vận hành). Các tài khoản thêm vào Vault giờ đây theo mặc định sẽ ở trạng thái `Idle` (chỉ lưu trữ và đồng bộ dự phòng lên Cloud) mà không tự động chạy Worker.
- **Deploy to Codex Button**: Thêm tính năng `Deploy to Codex` cụ thể tại màn hình Vault Accounts. Công cụ Bot Worker chỉ xử lý đăng nhập và mở cổng API cho Gateway khi người dùng chủ ý ra lệnh bấm kết nối.

## [0.1.4] - 2026-04-09
### Optimized
- **Real-time Proxy Pool Mirroring**: Tích hợp thêm các bộ chặn (Interceptors) cho tác vụ `POST /api/d1/proxies/add` và `DELETE /api/d1/proxies/:id` giúp cho công cụ tự động phản chiếu trạng thái Proxy trực tiếp từ Gateway UI xuống Local Vault ngay lập tức, không còn độ trễ.
- **Database Self-Healing**: Bổ sung tiến trình tự động quét "chữa lành" chạy ngầm mỗi 3 tiếng. Hệ thống sẽ kết nối với D1 Cloud để tải toàn bộ bảng ghi từ mốc ban đầu (Cursor 0) và tự sửa chữa những tài khoản/proxy bị lệch nội dung hoặc sai hỏng thời gian.


## [0.1.3] - 2026-04-09
### Fixed
- **Unique Identity Sync**: Khắc phục triệt để lỗi mất đồng bộ ID khi import tài khoản sang Gateway. Tools hiện gởi kèm ID nội bộ sang Gateway để đảm bảo hai bên nhìn cùng một đối tượng, ngăn chặn tình trạng đứt gãy Database.


## [0.1.2] - 2026-04-09
### Fixed
- **Bi-directional Deletion Sync**: Cập nhật interceptor để bắt tín hiệu xóa tự động (`DELETE /api/d1/accounts/:id`), đẩy trực tiếp vào local vault ngăn chặn tình trạng xoá trên Cloudflare D1 nhưng không mất ở hệ thống cục bộ.
- **Active Directory Removal**: Giải tỏa "Protective Logic" chặn đồng bộ trên máy nhánh khiến các thay đổi ghi đè khi đồng bộ tài khoản giữa hai máy bị hỏng.


## [0.1.1] - 2026-04-08
### Added
- **Instant Account Mirroring**: Thêm Interceptor cho `POST /api/d1/accounts/add`. Khi người dùng thêm tài khoản qua tab "Codex Accts", tài khoản sẽ được mirror ngay lập tức vào local vault, giúp Worker tìm thấy task và sinh PKCE tức thì mà không cần đợi chu kỳ sync 5 phút.
- **Direct Gateway Token Push**: Sau khi Exchange Token thành công, SeeLLM Tools sẽ tự động đẩy (Push) token trực tiếp sang SeeLLM Gateway (local) thông qua action `import` mới. Điều này đảm bảo Gateway luôn có kết nối mới nhất mà không bị lỗi dùng lại mã `code`.

### Fixed
- **Sync Persistence**: Triển khai tệp `data/sync_cursor.json` để lưu trữ điểm đồng bộ cuối cùng. Sau khi restart, Tools sẽ không còn phải tải lại toàn bộ lịch sử từ năm 1970, giúp giảm tải cho D1 Cloud.
- **Startup Sync Catch-up**: Bổ sung vòng lặp đồng bộ lúc khởi động (Startup Loop), tự động pull nhiều lần cho đến khi bắt kịp hoàn toàn dữ liệu mới nhất trên Cloud.
- **Active Record Protection**: Tăng cường bộ lọc trong `SyncManager`, ngăn chặn việc dữ liệu "xóa ảo" (`deleted_at`) từ Cloud ghi đè lên các tài khoản đang hoạt động (Ready/Pending) tại máy local.

## [0.1.0] - 2026-04-08
### Fixed
- **Sync Pipeline Stabilization**: Sửa lỗi nghiêm trọng khiến `req.body` bị `undefined` tại endpoint `/accounts/result`, giúp Worker có thể gửi kết quả login về Tools thành công.
- **PKCE Persistence**: Triển khai `pkceStore` trong bộ nhớ để giữ cố định mã xác thực PKCE cho mỗi tài khoản, loại bỏ hoàn toàn lỗi `400 invalid_request` khi Worker poll task nhiều lần.
- **Ghost Record Elimination**: Hoàn thiện cơ chế dọn rác 2 chiều. Thêm hỗ trợ `deleted_at` cho D1 Cloud và bộ lọc email rác trong `SyncManager`, đảm bảo dữ liệu "ma" không bao giờ quay trở lại sau khi xóa.
- **Improved Reliability**: Bổ sung tự động import `path` và `fs` thiếu hụt, cùng cơ chế ghi log lỗi critical cho các trường hợp Exchange Token thất bại.

## [0.0.9] - 2026-04-07
### Added
- **Instant Cloud Deletion**: Kích hoạt cơ chế đồng bộ xóa tức thì (`pushVault('delete')`). Khi bạn xóa tài khoản/proxy ở Tools, Cloud D1 sẽ được cập nhật ngay lập tức.
- **Smart Auth Assistant**: Bổ sung tự động `loginUrl` và `codeVerifier` chuẩn giao thức PKCE cho Codex khi thêm tài khoản, giúp Worker đăng nhập trơn tru mà không cần cấu hình tay.
- **Worker Flow Simplification**: Tái cấu trúc Auto-Login Worker để coi Gateway/Cloud là nguồn lệnh duy nhất, tách bạch hoàn toàn khỏi kho lưu trữ Vault để tăng tốc độ phản hồi.
- **macOS ioreg Compatibility**: Sửa lỗi `ioreg: command not found` bằng cách nạp đường dẫn tuyệt đối cho Machine ID trên Mac, ổn định cơ chế mã hóa.

## [0.0.8] - 2026-04-07
### Added
- **Live Quota Badges**: Hiển thị các nhãn hạn mức nhỏ (Session, Weekly, Code Review) trực quan với màu sắc động (Xanh/Vàng/Đỏ) trên trang quản lý tài khoản.
- **Unified Usage View**: Thêm cột **Usage** vào trang **Connections**, giúp theo dõi hạn mức của cả kết nối OAuth trực tiếp.
- **Worker Integration**: Cập nhật khả năng trích xuất dữ liệu `quotas_json` từ Cloud D1 qua Worker API mới.

## [0.0.7] - 2026-04-07
### Optimized
- **Auto Cloud Sync Polling**: Hệ thống giờ đây tự động kiểm tra thay đổi từ Cloud sau mỗi 5 phút (Background Interval).
- **Real-time Push Hooks**: Tích hợp lệnh đồng bộ đẩy (Push) ngay lập tức khi người dùng thực hiện Thêm/Sửa/Xóa tài khoản trên giao diện Tools.
- **Lightweight Pull**: Sử dụng dấu thời gian (Cursor) để chỉ tải về những dữ liệu mới, tiết kiệm tài nguyên mạng.

## [0.0.6] - 2026-04-07
### Fixed
- **Tương thích Node.js 25**: Sửa lỗi import ESM cho các thư viện CommonJS (`node-machine-id`, `cryptlib`).
- **Lỗi hệ thống macOS**: Bổ sung tự động `/usr/sbin` vào PATH để chạy lệnh `ioreg` lấy phần cứng ID.
- **Cơ chế Dự phòng (Hardware ID)**: Thêm try-catch và fallback ID nếu không lấy được hardware ID của máy.
- **Proxy JSON Error**: Sửa lỗi parse JSON tại giao diện Proxy do sai lệch tệp cấu hình.
- **Tự động nhận diện cấu hình**: Hỗ trợ nạp tự động tệp `tools.config.json` nếu có.

### Added
- **Dynamic Changelog UI**: Liên kết trực tiếp giao diện `/#changelog` với tệp `CHANGELOG.md` thông qua API server mới (`/api/changelog`).

## [0.0.5] - 2026-04-06
### Added
- **Đồng bộ Cloud Vault (Milestone 3)**: Tích hợp đồng bộ hóa dữ liệu thời gian thực giữa Local Vault (SQLite) và Cloudflare D1.
- **Tính năng Truy cập mọi nơi**: Tự động đồng bộ tài khoản cá nhân, proxy và API keys giữa nhiều thực thể SeeLLM Tools khác nhau.
- **Initial Sync Pull**: Cơ chế tự động tải dữ liệu từ D1 Cloud khi khởi động máy để cập nhật database local.
- **Versioning**: Sử dụng tracking `updated_at` và `deleted_at` để quản lý xung đột dữ liệu khi đồng bộ.

### Changed
- **Refactor Config**: Chuyển đổi cơ chế quản lý cấu hình sang module dùng chung `config.js`.
- **Hỗ trợ Sync**: Cập nhật các route API Vault để tự động kích hoạt tiến trình đồng bộ ngầm khi có thay đổi dữ liệu.

## [0.0.3] - 2026-04-06
### Added
- **Hạ tầng Vault (Local)**: Khởi tạo cơ sở dữ liệu SQLite local để lưu trữ tài khoản cá nhân.
- **Bảo mật AES-256**: Triển khai mã hóa dữ liệu nhạy cảm (Password, Token, 2FA) dựa trên Machine ID của máy chủ.
- **Quản lý Proxy Interactive**: Thêm giao diện chỉnh sửa URL/Label và quản lý Slot cho proxy trực tiếp từ Dashboard.
- **Sidebar v3.0**: Tái cấu trúc thanh điều hướng thành 4 phần: Tổng quan, Vault (Cá nhân), D1 Cloud (Dùng chung) và Công cụ.

### Fixed
- **Camofox Monitor**: Sửa lỗi `ReferenceError: stopMemoryReporter` khi dừng tiến trình Camofox.

## [0.0.2] - 2026-04-05
### Added
- Giao diện Dashboard hiện đại với Dark Mode và Glassmorphism.
- Tích hợp biểu đồ giám sát tài nguyên thời gian thực.
- Cải thiện UX cho bảng danh sách tài khoản và proxy.

## [0.0.1] - 2026-04-03
### Added
- Bản phát hành đầu tiên: Hỗ trợ quản lý tài khoản Codex, kết nối D1 Cloud và giao diện điều khiển trung tâm.
