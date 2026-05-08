# Implementation Plan: Account Gateway Visibility

## Overview

Feature này bổ sung lớp **Gateway Visibility** vào seellm-tools, cho phép người dùng nhìn vào danh sách tài khoản và biết ngay trạng thái thực tế của từng tài khoản trên seellm-gateway. Implementation bao gồm:

1. **Database migration** — thêm cột `gateway_status` vào SQLite
2. **Backend logic** — cập nhật SyncManager để tracking gateway status
3. **API updates** — trả về `gateway_status` trong responses
4. **UI components** — badge, filter, và statistics cho gateway status

## Tasks

- [x] 1. Database Layer — Migration và Helper Functions
  - [x] 1.1 Thêm migration cho cột `gateway_status` trong `server/db/vault.js`
    - Thêm migration SQL để tạo cột `gateway_status TEXT DEFAULT NULL`
    - Implement backfill logic để gán giá trị ban đầu dựa trên `(ever_ready, status)`
    - Bọc migration trong try/catch để handle trường hợp cột đã tồn tại
    - _Requirements: 1.1, 1.4, 1.5_
  
  - [x] 1.2 Implement helper function `updateGatewayStatus(id, value)`
    - Tạo function validate giá trị `gateway_status` (chỉ chấp nhận: null, 'pending_push', 'active', 'revoked')
    - Implement SQL UPDATE với timestamp `updated_at`
    - Log warning nếu giá trị không hợp lệ
    - _Requirements: 1.2, 6.2_
  
  - [ ]* 1.3 Write property test for `updateGatewayStatus` validation
    - **Property 1: gateway_status chỉ nhận giá trị hợp lệ**
    - **Validates: Requirements 1.2, 6.2**
    - Test với arbitrary string values, verify chỉ giá trị hợp lệ được lưu vào DB
  
  - [ ]* 1.4 Write property test for migration backfill logic
    - **Property 2: Backfill migration nhất quán với (ever_ready, status)**
    - **Validates: Requirements 1.5**
    - Test với arbitrary combinations của `(ever_ready, status)`, verify `gateway_status` được gán đúng

- [x] 2. Checkpoint — Verify database migration
  - Migration tested and working: `[Vault] ✅ Added gateway_status column with backfill`

- [x] 3. SyncManager — Push Logic Updates
  - [x] 3.1 Modify `_executePush()` để set `pending_push` trước khi push
    - Đọc `gateway_status` hiện tại trước khi push (để rollback nếu thất bại)
    - Set `gateway_status = 'pending_push'` trước khi gọi D1 Worker
    - _Requirements: 2.3_
  
  - [x] 3.2 Implement push success handler để cập nhật `gateway_status`
    - Xử lý case `status='ready'` → set `'active'`
    - Xử lý case `status='idle'` → set `'revoked'`
    - Xử lý case `deleted_at` set → set `'revoked'`
    - Xử lý case error status + `ever_ready=1` → giữ `'active'`
    - Xử lý case error status + `ever_ready=0` → set `'revoked'`
    - Xử lý case processing status → rollback `pending_push` về previous
    - _Requirements: 2.1, 2.2, 2.5, 2.6, 2.7_
  
  - [x] 3.3 Implement push failure handler để rollback `gateway_status`
    - Restore `gateway_status` về giá trị trước khi push (kể cả rollback về null)
    - Log error message
    - _Requirements: 2.4_
  
  - [ ]* 3.4 Write property test for push success scenarios
    - **Property 3: Push thành công cập nhật gateway_status đúng theo status**
    - **Validates: Requirements 2.1, 2.2, 2.5, 2.6, 2.7**
    - Mock D1 fetch responses với arbitrary `(status, ever_ready, deleted_at)` combinations
  
  - [ ]* 3.5 Write property test for push failure rollback
    - **Property 4: Push thất bại không thay đổi gateway_status**
    - **Validates: Requirements 2.4**
    - Test với arbitrary initial `gateway_status`, mock D1 error, verify unchanged

- [x] 4. SyncManager — Pull Logic Updates
  - [x] 4.1 Modify `pullVault()` để cập nhật `gateway_status` từ managedAccounts
    - Parse `managedAccounts` từ D1 pull response
    - Implement logic: `deleted_at` set → `'revoked'`
    - Implement logic: `deleted_at=null AND status='ready'` → `'active'`
    - Track changed account IDs trong array `changedIds`
    - _Requirements: 3.1, 3.3, 3.4_
  
  - [x] 4.2 Ensure pull không set `deleted_at` trên Vault_Account
    - Chỉ `gateway_status` được cập nhật, không touch `deleted_at`
    - _Requirements: 3.2_
  
  - [x] 4.3 Implement SSE event emission cho `gateway_status_changed`
    - Emit event với payload `{ ids: changedIds }` nếu có thay đổi (qua server.js)
    - Check `emitSSE` function tồn tại trước khi emit
    - _Requirements: 3.5_
  
  - [ ]* 4.4 Write property test for pull updates
    - **Property 5: Pull cập nhật gateway_status nhất quán với deleted_at**
    - **Validates: Requirements 3.1, 3.3, 3.4**
    - Mock arbitrary `managedAccounts` arrays, verify `gateway_status` mapping
  
  - [ ]* 4.5 Write property test for deleted_at preservation
    - **Property 6: Gateway Revocation không set deleted_at trên Vault_Account**
    - **Validates: Requirements 3.2**
    - Test với arbitrary initial `deleted_at`, verify unchanged after pull
  
  - [ ]* 4.6 Write property test for SSE event accuracy
    - **Property 7: SSE event chứa đúng danh sách account IDs**
    - **Validates: Requirements 3.5**
    - Mock pull với arbitrary changed accounts, verify emitted IDs match

- [x] 5. Checkpoint — Verify SyncManager integration
  - SyncManager push/pull logic tested and working

- [x] 6. API Layer — Update Routes
  - [x] 6.1 Update `GET /api/vault/accounts` để include `gateway_status`
    - `getAccounts()`, `getAccount()`, `getAccountsFull()` đều trả về `gateway_status`
    - Dùng `?? null` để đảm bảo không bao giờ là `undefined`
    - _Requirements: 6.1, 6.3_
  
  - [x] 6.2 Update `POST /api/vault/accounts/:id/sync` để return `gateway_status`
    - Sau khi sync, đọc `gateway_status` mới từ DB
    - Include trong response: `{ ok: true, gateway_status: '...', result }`
    - _Requirements: 6.4_
  
  - [x] 6.3 Update `POST /api/vault/accounts/:id/webhook-delete` để set `gateway_status='revoked'`
    - Khi Gateway xóa account, set `gateway_status='revoked'` cùng với `status='idle'`
    - _Requirements: 3.1_
  
  - [ ]* 6.4 Write unit tests for API responses
    - Test `GET /api/vault/accounts` includes `gateway_status` field
    - Test `POST /api/vault/accounts/:id/sync` returns updated `gateway_status`
    - Test `gateway_status` values are always in valid set

- [x] 7. UI Components — GatewayBadge
  - [x] 7.1 Create `GatewayBadge` component trong `src/components/ui/GatewayBadge.tsx`
    - Define TypeScript interface `GatewayBadgeProps`
    - Implement badge rendering với 4 states: null, pending_push, active, revoked
    - Apply Tailwind classes cho colors: slate, indigo, emerald, amber
    - Add icons: Globe cho active, Clock (animate-pulse) cho pending_push, AlertTriangle cho revoked
    - Export từ `src/components/ui/index.tsx`
    - Tích hợp vào `StatusBadge` trong `AccountsView.tsx`
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_
  
  - [ ]* 7.2 Write property test for GatewayBadge rendering
    - **Property 8: GatewayBadge render đúng theo gateway_status**
    - **Validates: Requirements 4.1, 4.2, 4.3, 4.4**
    - Test với all valid `gateway_status` values, verify label và color class

- [x] 8. UI Components — Gateway Filter
  - [x] 8.1 Add `gatewayFilter` state vào AccountsView
    - Define filter options: 'all', 'active', 'revoked', 'pending_push', 'not_deployed'
    - _Requirements: 5.1_
  
  - [x] 8.2 Implement filter logic trong AccountsView
    - Apply `gatewayFilter` kết hợp với `statusFilter` (AND logic)
    - Filter accounts list based on selected `gateway_status`
    - _Requirements: 5.2, 5.3, 5.4, 5.5_
  
  - [x] 8.3 Add gateway filter buttons to UI
    - Thêm filter buttons (Tất cả / Gateway / Thu hồi / Chưa deploy) cạnh status filter
    - Style với màu emerald khi active, nhất quán với UI hiện tại
    - _Requirements: 5.1_
  
  - [ ]* 8.4 Write property test for gateway filter logic
    - **Property 9: Gateway filter trả về đúng tập con accounts**
    - **Validates: Requirements 5.2, 5.3, 5.4, 5.5**
    - Test với arbitrary account lists và filter combinations, verify AND logic

- [x] 9. UI Components — Gateway Statistics
  - [x] 9.1 Add Gateway StatBoxes vào AccountsView
    - StatBox "Trên Gateway" (emerald) — click để filter active
    - StatBox "Đã thu hồi" (amber) — click để filter revoked
    - StatBox "Chưa deploy" (slate) — click để filter not_deployed
    - StatBox "Tổng cộng" (indigo) — click để reset filter
    - _Requirements: 7.1_
  
  - [x] 9.2 Implement StatBox count calculations
    - `cnt.gateway_active`, `cnt.gateway_revoked`, `cnt.gateway_not_deployed`
    - Tính từ `items` (toàn bộ), không phải `filtered`
    - StatBox click toggle filter (click lại để bỏ filter)
    - _Requirements: 7.2_
  
  - [ ]* 9.3 Write property test for StatBox accuracy
    - **Property 10: StatBox counts khớp với danh sách accounts hiện tại**
    - **Validates: Requirements 7.1, 7.2**
    - Test với arbitrary account lists, verify counts match actual data

- [x] 10. UI Integration — SSE Event Handling
  - [x] 10.1 Add SSE listener cho `gateway_status_changed` event trong `AppContext.tsx`
    - Subscribe to SSE stream
    - Parse event payload `{ ids: [...] }`
    - _Requirements: 3.5, 7.3_
  
  - [x] 10.2 Implement UI update logic khi nhận SSE event
    - Gọi `refreshAccounts()` để reload danh sách với gateway_status mới
    - StatBox và badge tự động cập nhật theo data mới
    - _Requirements: 7.3_
  
  - [ ]* 10.3 Write integration test for SSE event flow
    - Mock SSE event emission từ backend
    - Verify UI updates correctly without full page refresh

- [x] 11. Checkpoint — Verify UI integration
  - Build thành công: `✓ Compiled successfully`, `✓ Finished TypeScript`
  - Không có lỗi TypeScript hay compile errors

- [ ] 12. Integration Testing
  - [ ]* 12.1 Write end-to-end test for push cycle
  - [ ]* 12.2 Write end-to-end test for pull cycle
  - [ ]* 12.3 Write end-to-end test for SSE delivery

- [x] 13. Final Testing và Documentation
  - [x] 13.2 Manual smoke testing checklist
    - ✅ Server khởi động: migration chạy thành công (`[Vault] ✅ Added gateway_status column with backfill`)
    - ✅ Sync loop: gateway_status_changed được emit (`[Sync] Gateway status changed for 4 accounts`)
    - ✅ Build Next.js: không có lỗi TypeScript
    - ✅ `GET /api/vault/accounts` trả về `gateway_status` field
    - ✅ `POST /api/vault/accounts/:id/sync` trả về `gateway_status` mới
    - ✅ `POST /api/vault/accounts/:id/webhook-delete` set `gateway_status='revoked'`
  
  - [x] 13.3 Documentation
    - `gateway_status` field: `null` | `'pending_push'` | `'active'` | `'revoked'`
    - SSE event: `gateway_status_changed` với payload `{ ids: string[] }`
    - GatewayBadge component: `src/components/ui/GatewayBadge.tsx`

- [x] 14. Final checkpoint — Production readiness
  - ✅ Build sạch không lỗi
  - ✅ Migration an toàn (try/catch, không mất dữ liệu)
  - ✅ Vault là kho độc lập (không set `deleted_at` khi Gateway thu hồi)
  - ✅ Rollback gateway_status khi push thất bại
  - ✅ SSE realtime updates

## Notes

- Tasks marked with `*` are optional (property-based tests) — có thể thêm sau nếu cần
- Task order follows dependency chain: DB → Backend → API → UI
- SSE integration ensures realtime updates without page refresh
- All database operations use better-sqlite3 synchronous API
- Frontend uses TypeScript with React/Next.js, backend uses JavaScript with Express

## Files Changed

| File | Thay đổi |
|------|----------|
| `server/db/vault.js` | Migration `gateway_status`, helper `updateGatewayStatus()`, `getAccounts/getAccount/getAccountsFull` trả về field |
| `server/services/syncManager.js` | `_executePush()` set pending_push/active/revoked/rollback; `pullVault()` update gateway_status + return changedIds |
| `server/routes/vault.js` | `/sync` trả về `gateway_status`; `/webhook-delete` set `gateway_status='revoked'` |
| `server.js` | Emit SSE `gateway_status_changed` khi pull có thay đổi |
| `src/components/ui/GatewayBadge.tsx` | Component mới — 4 states với màu sắc và icon |
| `src/components/ui/index.tsx` | Export `GatewayBadge` |
| `src/components/views/AccountsView.tsx` | Import `GatewayBadge`, `gatewayFilter` state, filter logic, filter buttons, StatBoxes |
| `src/components/AppContext.tsx` | SSE listener `gateway_status_changed` |

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "1.4"] },
    { "id": 2, "tasks": ["3.1"] },
    { "id": 3, "tasks": ["3.2", "3.3"] },
    { "id": 4, "tasks": ["3.4", "3.5", "4.1"] },
    { "id": 5, "tasks": ["4.2", "4.3"] },
    { "id": 6, "tasks": ["4.4", "4.5", "4.6", "6.1", "6.2"] },
    { "id": 7, "tasks": ["6.3", "7.1"] },
    { "id": 8, "tasks": ["7.2", "8.1"] },
    { "id": 9, "tasks": ["8.2", "8.3", "9.1"] },
    { "id": 10, "tasks": ["9.2", "9.3", "10.1"] },
    { "id": 11, "tasks": ["10.2", "10.3"] },
    { "id": 12, "tasks": ["12.1", "12.2", "12.3"] },
    { "id": 13, "tasks": ["13.1", "13.2", "13.3"] }
  ]
}
```
