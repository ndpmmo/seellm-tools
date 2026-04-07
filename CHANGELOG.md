# Changelog

Tất cả các thay đổi đáng chú ý đối với dự án **SeeLLM Tools** sẽ được ghi lại trong tệp này.

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
