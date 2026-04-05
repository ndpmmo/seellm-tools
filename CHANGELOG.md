# SeeLLM Tools Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.2] - 2026-04-05

### Added
- **Proxy Management Interactive (v2.0)**:
  - Cho phép chỉnh sửa URL và Label trực tiếp trên từng proxy đã tồn tại (Inline Edit).
  - Thêm chức năng **Gia tăng Slot (Add Slot)** riêng biệt cho từng proxy mà không cần tạo lại.
  - Hỗ trợ **Xóa Slot trống** bằng click chuột trái, và **Xóa Slot bận** khi dùng tổ hợp Alt+Click.
  - Chức năng **Giải phóng Slot (Reset)** hỗ trợ gỡ nhanh connection_id bị kẹt ra khỏi slot ngay trên giao diện.
  - Cải thiện UI hàng đợi slot: Trạng thái hiển thị sống động hơn (màu sắc, bóng đổ, hiệu ứng hover).



## [0.0.1] - 2026-04-06

### Added
- **Khởi tạo dự án SeeLLM Tools**: Dashboard quản lý trung tâm dành riêng cho cá nhân.
- **Tích hợp Cloudflare D1**: Trực tiếp kết nối và đồng bộ với hệ thống `seellm-gateway` dùng chung D1 database qua REST API ở Worker (`/api/d1/*`).
- **Giao diện Accounts (Managed Accounts)**:
  - Hiển thị danh sách tài khoản theo lưới (Grid Table).
  - Có các chức năng thống kê (Tổng, Ready, Pending, Error).
  - Hỗ trợ thêm tài khoản đơn lẻ, hoặc dùng tính năng **Thêm hàng loạt (Bulk Import)** hỗ trợ các format (`email:pass:2fa`, Tab-separated).
  - Tích hợp CRUD (Sửa thông tin trực tiếp, Reset trạng thái, Xóa).
  - Hiện chi tiết lỗi kết nối dưới email.
- **Giao diện Proxy Pool**:
  - Quản lý danh sách proxy (URL, Tên, Số lượng slots).
  - Thống kê tỷ lệ Slot đang trống/đang dùng.
  - Hỗ trợ tính năng **Thêm hàng loạt (Bulk Import)** proxy.
- **Design System v2.0**:
  - Áp dụng phong cách UI Dark Theme (Glassmorphism), màu sắc tinh tế, hiện đại.
  - Sử dụng icon vector chuẩn mực từ thư viện `lucide-react`.
  - Fix các lỗi responsive, alignment đảm bảo trải nghiệm thống nhất.
- **Server tích hợp**:
  - Tích hợp PTY/Terminal WebSocket trong `server.js` để cho phép chạy script `auto-login-worker` ngay trên trình duyệt (hiển thị Logs thời gian thực).
- **Scripts Utility**:
  - `auto-login-worker.js` và `test-camofox.js` cho nhiệm vụ giả lập trình duyệt và giải quyết các vấn đề xác thực OAuth/2FA.
