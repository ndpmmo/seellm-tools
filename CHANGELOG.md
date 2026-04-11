# Changelog - SeeLLM Tools

## [Unreleased] - 2026-04-11

### Changed
- **Managed Accounts status labels parity with Gateway (`#accounts`)**:
  - Expanded status presentation to map Gateway-equivalent states:
    - `Connected`, `Disabled`, `Auth Failed`, `Rate Limited`, `Runtime Issue`, `Network Issue`, `Test Unsupported`, `Unavailable`, `Failed`, `Error`.
  - Added secondary error-type badges (e.g. `Upstream Auth`, `Token Expired`, `Refresh Failed`) when diagnostics exist.
  - Status counters/filter buckets now use normalized status logic instead of raw `status` only.

### Fixed
- **Status diagnostics merge from D1 connections**:
  - Accounts view now merges and uses richer connection diagnostics fields where available:
    - `test_status`, `error_code`, `last_error_type`, `rate_limited_until`, `last_error`, `is_active`.
  - Improves cross-surface consistency between Gateway `providers/codex#connections` and Tools `#accounts`.

### Performance
- **Phase 2 cursor-preflight sync optimization**:
  - `SyncManager.pullVault()` now checks remote `sync/cursor` first and skips heavy `sync/pull` when there is no new cursor.
- **Lower default D1 polling pressure**:
  - Event poll default changed from 30s -> 60s.
  - Self-healing full scan default changed from 3h -> 12h.
  - Added env overrides:
    - `SEELLM_TOOLS_D1_PULL_INTERVAL_MS`
    - `SEELLM_TOOLS_D1_EVENT_POLL_MS`
    - `SEELLM_TOOLS_D1_SELF_HEAL_MS`
- **Phase 3 targeted D1 pull**:
  - `SyncManager.pullVault()` now requests only required tables via `sync/pull?tables=...`:
    - `vaultAccounts,vaultProxies,vaultKeys,managedAccounts,connections`
  - Reduces unnecessary D1 reads on each sync cycle.
- **Phase 3 event bus ack**:
  - Tools event poll now uses `ack=1` so fetched events are marked consumed server-side, reducing repeated row scans.
- **Phase 3 Accounts screen read optimization (`#accounts`)**:
  - Switched to paged D1 loading (`limit=100` + load more) instead of fetching large account batches upfront.
  - Removed eager proxy pool fetch from initial load; proxies are now loaded lazily when opening edit.
  - Keeps UI responsive while reducing baseline D1 reads.

## [0.1.9] - 2026-04-11

### Added
- **Proxy assignment APIs (Tools backend)**:
  - Added `POST /api/proxy-assign/assign` to assign one account to proxy pool.
  - Added `POST /api/proxy-assign/auto` to auto-assign proxies for accounts without proxy.
- **Proxy pool UX in both account screens**:
  - Added `Auto Assign Proxy` action in `#accounts` and `#vault-accounts`.
  - Added per-account quick assign action from proxy pool.
  - Added proxy-pool select input in account edit/create flows.

### Fixed
- **Immediate local mirror on account PATCH**:
  - Added intercept for `PATCH /api/d1/accounts/:id` to mirror updated account state to local vault instantly.
  - Ensures auto-login worker reads latest proxy config without waiting for periodic pull.
- **Proxy slot occupancy sync (Phase 2)**:
  - Implemented slot rebind flow on account proxy change:
    - release old `proxy_slots.connection_id`,
    - claim free slot in target proxy,
    - support unassign when proxy is cleared.
  - Integrated slot sync into:
    - manual assign API,
    - auto-assign API,
    - generic account patch path.

## [0.1.8] - 2026-04-10

### Fixed
- **Gateway quota refresh trigger auth**:
  - Updated post-login quota refresh calls to include `x-sync-secret` header when calling Gateway `GET /api/usage/:connectionId`.
  - This pairs with Gateway auth fix so Tools can trigger immediate quota snapshot successfully instead of silent `401`.
  - Helps `#accounts` receive fresh `quota_json/quotas_json` data after token sync.

## [0.1.7] - 2026-04-10

### Fixed
- **Accounts quota visibility (`#accounts`)**:
  - Fixed usage rendering condition to include `quota_json` (previously only checked `discovered_limit`/`quotas_json`, causing false `Unknown`).
  - Merged usage data from multiple sources on load:
    - D1 managed accounts (`/api/d1/inspect/accounts`)
    - D1 connections (`/api/d1/inspect/connections`)
    - local vault accounts (`/api/vault/accounts`)
  - Added robust quota parser for both array/object payload formats and normalized `% remaining` display in the Usage column.
- **TypeScript build stability**:
  - Extended live screenshot type to include optional `email`/`ts` fields so dashboard live view compiles cleanly.

## [0.1.6] - 2026-04-10

### Fixed
- **Tools → Gateway toggle propagation**:
  - Updated Smart Sync trigger call to include `x-sync-secret` when Tools notifies Gateway after toggling account `is_active`.
  - This fixes the case where toggle from `http://localhost:4000/#accounts` changed D1 state but Gateway `providers/codex#connections` did not refresh immediately.
- **Trigger safety diagnostics**:
  - Added explicit warning log when `gatewayUrl` exists but `d1SyncSecret` is missing, so skipped trigger calls are visible in server logs.

### Changed
- **Smart Sync request contract**:
  - `POST /api/sync/trigger` from Tools now uses secret-auth headers instead of anonymous JSON-only POST calls.

## [Unreleased] - 2026-04-10

### Added
- **Smart Sync Trigger**: Implemented a local webhook trigger system. When toggling an account's status in Tools, it now sends an immediate notification to the Gateway over the local network to trigger an on-demand pull, reducing sync latency to near-zero.

### Fixed
- **Direct D1 Sync**: Switched the account toggle mechanism to use a direct Worker PATCH endpoint instead of the standard synchronization pipeline. This bypasses version-based conflict checks on Cloudflare D1, ensuring status changes are always applied immediately.
- **Sync Resilience**: Improved error handling and fallback logic in the D1 Proxy and SyncManager services.

## [Unreleased] - 2026-04-09


### Added
- **Camofox Documentation**: Integrated custom documentation for Camofox browser integration.
- **CamofoxDocsView**: New UI component to display specialized browser documentation.

### Fixed
- **Account Synchronization Logic**:
  - Refactored `SyncManager.js` to ensure `is_active` status is correctly propagated to Cloudflare D1 for both `vault_accounts` and `codex_connections`.
  - Removed dependency on account status when determining connectivity state, allowing accounts to be toggled off even if in "idle" or other states.
  - Forced immediate synchronization (bypassing debounce) when toggling account status from the UI.
- **UI Consistency**:
  - Improved `AccountsView.tsx` and `VaultAccountsView.tsx` to handle `undefined` or legacy `is_active` states, defaulting to active (1).
  - Added visual feedback (strikethrough and opacity) for disabled accounts in the dashboard.
  - Standardized toggle component behavior across different views.
- **Performance**: Improved `server.js` proxying logic to handle Cloudflare D1 requests more robustly with better timeout handling.

### Changed
- **Vault Schema**: Updated local database handling to support synchronization of activation states and metadata.
- **Dashboard Layout**: Refined layout of various views for better readability and a more premium aesthetic.
