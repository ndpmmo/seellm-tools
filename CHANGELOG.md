# Changelog - SeeLLM Tools

## [0.1.18] - 2026-04-20

### Fixed
- **OpenAI Registration MS Graph API OTP extraction**:
  - Swapped client-side date comparison for Microsoft Graph OData server-side filter (`$filter=receivedDateTime ge ...`).
  - Implemented accurate text extraction Regex `/\b(\d{6})\b/` on raw mail body instead of double-escaped strings to prevent grabbing stale or incorrect OTPs.
  - Implemented automatic 'mark as read' right after OTP extraction to prevent recycling codes.
- **SSO Login Collision in Browser Automation**:
  - Explicitly updated `Click Continue` button selectors to ignore buttons containing `with` (e.g. `Continue with Google`, `Continue with Apple`), fixing a critical auth loop blocking login tests.
- **OpenAI "About You" Form Bypass**:
  - Built an aggressive bypass logic detecting both the old (`First Name`, `Last Name`) and new (`Full name`, `Age`) registration variants in React.
  - Supplied an offline local database of **250,000 real-world name combinations** (`scripts/lib/names.js`) to generate perfectly unique user properties without external latency.
  - Randomized User Age strictly clamped within 18-40 bounds for consistent "Date of Birth" calculations regardless of form type.
- **OpenAI "What do you want to do" Survey Bypass**:
  - Implemented detection and automated clicking of the detached `Skip`/`Bỏ qua` button on the final registration prompt to drop immediately into the target ChatGPT dashboard interface.
  - Built a fallback strategy targeting generic survey answers (Personal use / Other) if `Skip` is omitted in A/B variants.
- **OpenAI "Welcome to ChatGPT" Modal Bypass**:
  - Added detection and automated interaction for the final 'OK, let's go' (Tiến hành thôi) onboarding modal, ensuring the robot reaches the chat input field autonomously.

### Added
- **Detailed Registration Documentation**:
  - Documented the entire automated OpenAI flow bypass architecture in `docs/OPENAI_REGISTRATION_FLOW.md`.

## [0.1.17] - 2026-04-19

### Added
- **Bulk Data Synchronization**:
  - Implemented "Sync All to D1" buttons in both `#accounts` and `#vault-accounts` views.
  - Allows mass synchronization of filtered/all accounts to the Cloudflare D1 database with one click.
- **Improved UX & Modals**:
  - Replaced browser `confirm()` with custom `ConfirmModal` in `#logfiles` for a seamless UI experience.
  - Displayed account email in Screenshot history list and Advanced Viewer header for better session identification.

### Changed
- **Screenshot Viewer Modernization**:
  - Rebuilt `AdvancedViewer` with minimalistic navigation and auto-updating live screenshots.
  - Optimized `z-index` for navigation controls to ensure reliable interaction.
- **API Path Sanitization**:
  - Removed hardcoded `localhost:4000` prefixes in favor of relative API paths for improved cross-environment stability.

## [0.1.16] - 2026-04-19

### Added
- **OAuth PKCE Core Integration (Auto-Connect Worker)**:
  - Integrated `crypto` SHA-256 challenge generation for full OAuth 2.0 PKCE flow.
  - Successfully acquiring raw `refresh_token`, `id_token`, and `access_token` to enable long-lived Codex connections.
- **Hybrid Automation & API Bypass Engine**:
  - Implemented a dual-layer strategy: DOM manipulation for stealthy login combined with background API calls for high-reliability navigation.
  - **Programmatic Consent Bypass**: Automates the authorization redirect by injecting scripts to extract `oai-client-auth-session` and calling `/api/accounts/workspace/select` directly.
  - **Phone Verification Workaround**: Navigates through the OAuth flow using direct API endpoints to circumvent the `/add-phone` UI wall when an authenticated session exists.

### Changed
- **Proxy-Aligned Token Exchange (Node.js/CURL)**:
  - Refactored `exchangeCodeForTokens` to use `curl` instead of native `fetch`.
  - Enforces strict proxy usage at the Node.js level, ensuring the entire OAuth lifecycle (Browser -> Code Exchange -> Token Sync) originates from the exact same Proxy IP.
- **End-to-End Data Fidelity**:
  - Worker now returns the full, unmodified OAuth response (`token_type`, `scope`, `expires_in`) in snake_case to match production API standards.
  - Prevents "CamelCase data loss" that previously caused Gateway 401 errors due to missing `token_type: "Bearer"`.

### Fixed
- **Gateway Connectivity (401 Unauthorized)**:
  - Fixed a critical bug where `Vault -> Gateway` sync was filtering out root token properties.
  - Spread operator used in `gwPayload` now ensures `token_type` and `scope` reach the Gateway's `provider_connections` table.
- **Device ID Binding**:
  - Prioritizes `oai-device-id` cookies captured during the login flow to ensure the Gateway uses a stable hardware signature.



## [0.1.15] - 2026-04-19

### Fixed
- **Gateway activation sync robustification**:
  - `POST /accounts/connect-result` now explicitly pushes `isActive: true` to Gateway's `/api/oauth/codex/import` endpoint.
  - Ensures newly connected accounts are immediately usable for model routing without manual activation.
- **Provider metadata consistency**:
  - Standardized the mapping of `workspacePlanType` in the Gateway import payload.

## [0.1.14] - 2026-04-14

### Changed
- **Codex metadata persistence for Gateway compatibility**:
  - `vault_accounts` now persists `workspace_id`, `device_id`, `machine_id`, and `provider_specific_data`.
  - OAuth result processing now derives workspace metadata from Codex `id_token` and stores provider-specific fields before sync.
- **Tools -> Gateway import payload enrichment**:
  - `POST /api/oauth/codex/import` payload now includes `tokens.providerSpecificData` to preserve workspace/device binding context.
- **D1 connection payload alignment**:
  - `SyncManager.pushVault('account')` now fills `connections.workspace_id` and `connections.provider_specific_data` from local Codex metadata instead of hardcoded `null`.
- **Critical-change immediate sync path**:
  - Account sync dedupe now uses hashed normalized state instead of `HAVE_TOKEN/NO_TOKEN` marker only.
  - Critical account changes (token/workspace/provider-specific metadata/is_active/deleted/status transitions) bypass debounce and push immediately.

### Fixed
- **Pull merge metadata fidelity**:
  - `SyncManager.pullVault()` now merges `workspace_id` and `provider_specific_data` from remote `connections` into local account records when newer remote data is available.
- **Manual fix script sync contract**:
  - `scripts/fix_and_sync.mjs` now forwards `workspace_id` and `provider_specific_data` in connection payload when present.

## [0.1.13] - 2026-04-12

### Added
- **Screenshots & Log Files management controls**:
  - Added search/filter controls and delete actions in `#screenshots` and `#logfiles`.
  - Added bulk-select + bulk-delete flows for log files and screenshot sessions.
  - Added API delete endpoints for screenshots sessions/images and log files.

### Changed
- **Vietnam timezone timestamps across history views**:
  - Added detailed VN time (`Asia/Ho_Chi_Minh`) display for:
    - `#screenshots` history and live cards
    - `#logfiles` list
    - `#vault-accounts` rows
    - `#accounts` rows
- **D1 account timeline continuity**:
  - `SyncManager.pushVault('account')` now includes `created_at` for `vaultAccounts`, `managedAccounts`, and `connections` payloads.
  - Pull merge now keeps `created_at` from D1-managed records when available.

### Fixed
- **Screenshot delete UX after successful removal**:
  - Stopped repeated 404 live-image fetch loops by auto-hiding stale live entries on image load errors.
- **Delete error diagnostics**:
  - Improved UI delete toasts to show API error detail/HTTP status when delete fails.

## [0.1.12] - 2026-04-11

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

## [0.1.11] - 2026-04-10

### Added
- **Smart Sync Trigger**: Implemented a local webhook trigger system. When toggling an account's status in Tools, it now sends an immediate notification to the Gateway over the local network to trigger an on-demand pull, reducing sync latency to near-zero.

### Fixed
- **Direct D1 Sync**: Switched the account toggle mechanism to use a direct Worker PATCH endpoint instead of the standard synchronization pipeline. This bypasses version-based conflict checks on Cloudflare D1, ensuring status changes are always applied immediately.
- **Sync Resilience**: Improved error handling and fallback logic in the D1 Proxy and SyncManager services.

## [0.1.10] - 2026-04-09


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
