# Hệ Thống Tự Động Hóa Đăng Ký OpenAI (ChatGPT) qua Camoufox và MS Graph API

Tài liệu này ghi lại toàn bộ quy trình, logic xử lý và chi tiết các lần fix lỗi xuyên suốt quá trình thiết kế hệ thống Auto Register cho ChatGPT. 

## 1. Vấn Đề Quan Trọng: Nút bấm "Continue with Google"
Trong suốt chặng đường test login và test nhập Email/Password, đã nảy sinh một lỗi kẹt thao tác nghiêm trọng:
- **Nguyên nhân:** Khối giao diện của SSO Google (Button: `Continue with Google`) và Apple bật đè lên giao diện Auth0 của bản thân ứng dụng ChatGPT.
- **Lỗi thuật toán:** Script click của chúng ta dùng điều kiện `textContent.includes('Continue')`. Do button của Google render đầu tiên và có chữ "Continue" nên script liên tục click nhầm vào Google/Apple Login thay vì nút Continue của Email chính chủ. Điều này khiến toàn bộ chuỗi DOM đứt gãy.
- **Giải pháp (Fix):** Thay đổi logic tìm kiếm nút. Xoáy sâu vào điều kiện kiểm tra độ dài hoặc chuỗi chữ: 
  `b.textContent.includes('Continue') && !b.textContent.toLowerCase().includes('with')`
  *Bằng cách này, mọi phần tử chứa từ `with` (VD: with Google, with Apple, with Microsoft) sẽ bị loại trừ tuyệt đối.* Lỗi click nhầm đã được vá 100%.

## 2. API Đọc Mail OTP (MS Graph)
Hệ thống lấy OTP từ thư của Outlook/Hotmail đã gặp rất nhiều gián đoạn (timeout 90s) do cơ chế hoạt động cũ kỹ:
- **Lỗi So sánh Thời Gian rác (Client-side Date Compare):** Quá trình lọc Mail cũ và mới bằng `date.getTime()` trên client gặp sai số hệ thống, dẫn đến bắt nhầm các OTP của những tài khoản từng đăng ký trước đó.
- **Regex Double-Escape Lỗi:** Regex lấy chuỗi 6 số chịu lỗi double-escape string `\\b\\d{6}\\b` làm OTP lấy từ Body Text trật nhịp.
- **Cải tiến Đỉnh Cao (Giải Quyết):** 
  - Khởi tạo **Query OData Filter trực tiếp trên Server** ($filter=receivedDateTime ge {TIME}), đảm bảo Microsoft chỉ xuất ra thư **Mới Nhất sau khi Script phát tín hiệu gửi mã**.
  - Kiểm tra Header "To: " xem có khớp chính xác `toRecipients` hay không để luồng Multi-threads Worker không "đọc lén" Mail của nhau.
  - Sau khi bắt được OTP `(/\b(\d{6})\b/)`, hệ thống ngay lập tức gọi API Graph `markMailAsRead` để đảm bảo OTP này sẽ chìm đi, không bị tái sử dụng ở lệnh lấy mã lần sau.

## 3. Form Điền "About You" (Tên, Tuổi ngẫu nhiên)
- **Vấn đề:** OpenAI thay đổi Form đăng ký mới chuyển từ điền (`First/Last Name`, `DOB (DD/MM/YYYY)`) sang Form tối giản hơn (`Full name`, `Age`).
- **Giải quyết:** Hệ thống nhúng một module Database siêu nhẹ (`scripts/lib/names.js`) bao gồm **500 First Names phổ biến nhất** và **500 Last Names phổ biến nhất** (Tương đương 250,000 cái tên ngẫu nhiên, tỉ lệ trùng lặp: ~0%).
- Script cũng đồng thời lùi năm `Age` từ Range cố định [18 tuổi - 40 tuổi] xuống `Date.getFullYear()` để chuẩn hóa thông tin người dùng cho cả Form Mới lẫn Cũ.
- **Tương tác React:** Dùng `Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set` và dispatchEvent `bubbles` tinh túy để qua mặt hook Validation nội tạng của React. Nút `Finish creating account` đã có thể kích hoạt bình thường.

## 4. Bỏ Qua Khảo Sát Usage ("What do you want to do with ChatGPT?") 
Ngay sau khi qua mặt Form Tên/Tuổi, một Form Khảo sát mục đích sử dụng sẽ trồi lên ngay trên Dashboard. 
- **Giải quyết:** Script tạo ra mảng tìm kiếm rà soát linh hoạt trên toàn bộ các thẻ `<button>`, `<a>`, `<div role="button">`. 
- Nếu tìm thấy chữ **"Skip"** hoặc **"Bỏ qua"**, thao tác Click được thực thi tức thời để vượt qua Dashboard.
- Cấu hình Fallback (kế hoạch dự phòng) nếu không có Skip: Script nhấp vào các cụm từ "Personal" (Sá nhân) / "Other" (Khác), sau đó bấm "Continue/Next" để buộc tài khoản chuyển trạng thái thành viên bình thường.

## CHANGELOGS (Cập nhật phiên bản)
- `v1.2.0:` Chỉnh sửa MS Graph mail parser, kích hoạt filter chuẩn Server-side.
- `v1.2.1:` Vá lổ hổng SSO Login. Fix cứng logic click nút Continue thuần, cấm đụng nút "Continue with Google".
- `v1.2.2:` Hoàn thiện cơ sở dữ liệu `lib/names.js` tự thân với 250k names mix chéo.
- `v1.2.3:` Tích hợp thuật toán Native React Setter nhắm thẳng vào form đăng ký The "How old are you?" (Kèm xử lý cả Age và DOB Fallback).
- `v1.2.4:` Vượt mặt bảng Survey Welcome-board bằng Bypass 'Skip' clicker. Giao diện về thẳng Dashboard chính thức của ChatGPT. Lấy Session hoàn thiện 100%.

---
*(Tài liệu này được xuất và lưu trữ tại `docs/OPENAI_REGISTRATION_FLOW.md` phục vụ việc Scale-up luồng tự động sau này).*
