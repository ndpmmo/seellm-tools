# Implementation Plan: Account Gateway Visibility

## Overview

Feature này bổ sung lớp **Gateway Visibility** vào seellm-tools, cho phép người dùng nhìn vào danh sách tài khoản và biết ngay trạng thái thực tế của từng tài khoản trên seellm-gateway. Implementation bao gồm:

1. **Database migration** — thêm cột `gateway_status` vào SQLite
2. **Backend logic** — cập nhật SyncManager để tracking gateway status
3. **API updates** — trả về `gateway_status` trong responses
4. **UI components** — badge, filter, và statistics cho gateway status

## Status: ✅ COMPLETED (v0.2.50)

Tất cả task bắt buộc đã hoàn thành. Các optional tests (property-based và integration) được skipped theo quyết định của team — có thể bổ sung sau nếu cần.

---

## Tasks

- [x] 1. Database Layer — Migration và Helper Functions
  - [x] 1.1 Thêm migration cho cột `gateway_status` trong `server/db/vault.js`
    - _Requirements: 1.1, 1.4, 1.5_
  - [x] 1.2 Implement helper function `updateGatewayStatus(id, value)`
    - _Requirements: 1.2, 6.2_
  - [x]~ 1.3 Property test — `updateGatewayStatus` validation _(skipped)_
  - [x]~ 1.4 Property test — migration backfill logic _(skipped)_

- [x] 2. Checkpoint — Verify database migration ✅
  - `[Vault] ✅ Added gateway_status column with backfill`

- [x] 3. SyncManager — Push Logic Updates
  - [x] 3.1 Modify `_executePush()` — set `pending_push` trước khi push
    - _Requirements: 2.3_
  - [x] 3.2 Push success handler — cập nhật `gateway_status` theo 6 rules
    - _Requirements: 2.1, 2.2, 2.5, 2.6, 2.7_
  - [x] 3.3 Push failure handler — rollback `gateway_status` về previous
    - _Requirements: 2.4_
  - [x]~ 3.4 Property test — push success scenarios _(skipped)_
  - [x]~ 3.5 Property test — push failure rollback _(skipped)_

- [x] 4. SyncManager — Pull Logic Updates
  - [x] 4.1 Modify `pullVault()` — cập nhật `gateway_status` từ managedAccounts
    - _Requirements: 3.1, 3.3, 3.4_
  - [x] 4.2 Ensure pull không set `deleted_at` trên Vault_Account
    - _Requirements: 3.2_
  - [x] 4.3 SSE event emission cho `gateway_status_changed`
    - _Requirements: 3.5_
  - [x]~ 4.4 Property test — pull updates _(skipped)_
  - [x]~ 4.5 Property test — deleted_at preservation _(skipped)_
  - [x]~ 4.6 Property test — SSE event accuracy _(skipped)_

- [x] 5. Checkpoint — Verify SyncManager integration ✅

- [x] 6. API Layer — Update Routes
  - [x] 6.1 `GET /api/vault/accounts` — include `gateway_status`
    - _Requirements: 6.1, 6.3_
  - [x] 6.2 `POST /api/vault/accounts/:id/sync` — return `gateway_status`
    - _Requirements: 6.4_
  - [x] 6.3 `POST /api/vault/accounts/:id/webhook-delete` — set `gateway_status='revoked'`
    - _Requirements: 3.1_
  - [x]~ 6.4 Unit tests — API responses _(skipped)_

- [x] 7. UI Components — GatewayBadge
  - [x] 7.1 Create `GatewayBadge` component — 4 states (null/pending_push/active/revoked)
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_
  - [x]~ 7.2 Property test — GatewayBadge rendering _(skipped)_

- [x] 8. UI Components — Gateway Filter
  - [x] 8.1 Add `gatewayFilter` state vào AccountsView
    - _Requirements: 5.1_
  - [x] 8.2 Filter logic — AND với `statusFilter`
    - _Requirements: 5.2, 5.3, 5.4, 5.5_
  - [x] 8.3 Gateway filter buttons trong UI
    - _Requirements: 5.1_
  - [x]~ 8.4 Property test — gateway filter logic _(skipped)_

- [x] 9. UI Components — Gateway Statistics
  - [x] 9.1 Gateway StatBoxes — Trên Gateway / Đã thu hồi / Chưa deploy / Tổng cộng
    - _Requirements: 7.1_
  - [x] 9.2 StatBox count calculations từ `items`
    - _Requirements: 7.2_
  - [x]~ 9.3 Property test — StatBox accuracy _(skipped)_

- [x] 10. UI Integration — SSE Event Handling
  - [x] 10.1 SSE listener `gateway_status_changed` trong `AppContext.tsx`
    - _Requirements: 3.5, 7.3_
  - [x] 10.2 UI update logic — `refreshAccounts()` khi nhận SSE
    - _Requirements: 7.3_
  - [x]~ 10.3 Integration test — SSE event flow _(skipped)_

- [x] 11. Checkpoint — Verify UI integration ✅
  - `✓ Compiled successfully`, `✓ Finished TypeScript` — 0 errors

- [x] 12. Integration Testing _(all skipped)_
  - [x]~ 12.1 E2E test — push cycle với D1 Worker thật _(skipped — cần D1 Worker running)_
  - [x]~ 12.2 E2E test — pull cycle: D1 revocation _(skipped — cần D1 Worker running)_
  - [x]~ 12.3 E2E test — SSE delivery _(skipped — cần D1 Worker running)_

- [x] 13. Final Testing và Documentation ✅
  - [x]~ 13.1 Run full test suite _(skipped — no test framework configured)_
  - [x] 13.2 Manual smoke testing
    - ✅ Migration: `[Vault] ✅ Added gateway_status column with backfill`
    - ✅ Sync loop: `[Sync] Gateway status changed for 4 accounts`
    - ✅ Build: `✓ Compiled successfully`, `✓ Finished TypeScript`
    - ✅ API trả về `gateway_status` field
    - ✅ `/sync` trả về `gateway_status` mới
    - ✅ `/webhook-delete` set `gateway_status='revoked'`
  - [x] 13.3 Documentation trong tasks.md + CHANGELOG.md v0.2.50

- [x] 14. Final checkpoint — Production readiness ✅
  - ✅ Build sạch, 0 TypeScript errors
  - ✅ Migration an toàn (try/catch, không mất dữ liệu)
  - ✅ Vault độc lập (không set `deleted_at` khi Gateway thu hồi)
  - ✅ Rollback gateway_status khi push thất bại
  - ✅ SSE realtime updates
  - ✅ Committed: `4df55c6` — v0.2.50

---

## Notes

- Tasks `~` = skipped (optional, có thể bổ sung sau)
- Property tests dùng `fast-check` — mock D1, chạy trong seellm-tools
- Integration tests (12.x) cần D1 Worker thật từ seellm-gateway
- Cloudflare Worker **không cần cập nhật** — `gateway_status` là metadata nội bộ seellm-tools

## Files Changed

| File | Thay đổi |
|------|----------|
| `server/db/vault.js` | Migration `gateway_status`, `updateGatewayStatus()`, `getAccounts/getAccount/getAccountsFull` |
| `server/services/syncManager.js` | `_executePush()` pending_push/active/revoked/rollback; `pullVault()` gateway_status + changedIds |
| `server/routes/vault.js` | `/sync` → `gateway_status`; `/webhook-delete` → `gateway_status='revoked'` |
| `server.js` | Emit SSE `gateway_status_changed` |
| `src/components/ui/GatewayBadge.tsx` | **New** — 4 states |
| `src/components/ui/index.tsx` | Export `GatewayBadge` |
| `src/components/views/AccountsView.tsx` | Badge + filter + StatBox |
| `src/components/AppContext.tsx` | SSE listener |
