# Changelog - SeeLLM Tools

## [0.2.20] - 2026-04-27

### 🚀 Camofox Worker Optimization — Shared Helpers & Performance Improvements

Optimized all three Camofox worker scripts (auto-connect, auto-register, auto-login) by leveraging new shared library helpers, reducing code duplication, and improving maintainability.

#### ✅ Phase 0: Auto-Login Worker Migration
- Migrated `auto-login-worker.js` to shared libraries (camofox, totp, proxy-diag, screenshot)
- Removed 213 lines of duplicate helper functions (getTOTP, getFreshTOTP, camofoxPost, camofoxGet, camofoxDelete, evalJson, proxy diagnostics)
- Replaced global `stepCount` with `createSaveStep()` closure for per-flow screenshot counters
- Updated all 24 saveStep calls to new signature (label only)
- Kept auto-login-specific functions: tryFillChatgptLoginForm, tryBypassPhoneRequirement, tryBootstrapWorkspaceSession

#### ✅ Phase 1: New Helper Functions
- **scripts/lib/camofox.js**: Added waitForSelector, pressKey, getSnapshot, clickRef, typeByRef, tripleClick helpers
- **scripts/lib/openai-login-flow.js**: Added waitForState for polling state flags with timeout
- All helpers include timeout and error handling for robustness

#### ✅ Phase 2: Auto-Connect Worker Optimization
- Replaced 30-iteration polling loop with `waitForState({ looksLoggedIn: true })`
- Reduced code from 33 lines to 12 lines for login completion polling
- Imported pressKey and waitForState from shared lib
- Kept React nativeSetter evalJson for fill email/password (already stable)

#### ✅ Phase 3: Auto-Register Worker Cleanup
- Imported waitForSelector and pressKey from shared lib
- Removed duplicate `apiHelper` function (redundant with camofoxPostWithSessionKey)
- Used camofoxPostWithSessionKey directly for MFA setup
- Kept React form fill (typeReact pattern - necessary for ChatGPT signup)

#### ✅ Phase 4: Auto-Login Worker Optimization
- Replaced 8 inline `/press` calls with `pressKey` helper
- Replaced 2 triple-click calls with `tripleClick` helper
- Added screen detection helpers to lib/openai-login-flow.js (isPhoneVerificationScreen, isConsentScreen, isAuthLoginLikeScreen)
- Imported screen detection helpers from shared lib
- Removed duplicate screen detection functions from auto-login-worker.js
- Kept inline waitForSelector with auto-healing (unique to auto-login-worker)

#### ✅ Phase 5: Camofox Server Configuration Documentation
- Added `docs/camofox-tuning.md` with recommended environment variables
- Documented performance tuning, anti-detection, and resource management settings
- Included Docker deployment examples and local development .env configuration
- Added performance impact table comparing default vs recommended values
- Included live testing commands and troubleshooting guide

#### 📊 Summary
- **Total commits**: 9 (6 phases + 1 fix + 1 version bump + 1 changelog update)
- **Code reduction**: ~250 lines of duplicate code removed
- **New helpers**: 7 helper functions added to shared libraries
- **Documentation**: 1 new tuning guide created
- **Syntax checks**: All files pass `node --check`

#### 🔧 Bug Fix
- Added missing `camofoxGoto` import to auto-login-worker.js (was used but not imported)

## [0.2.19] - 2026-04-23

### 🧩 Worker Script Refactoring — Shared Library Extraction

Extracted common code from worker scripts into reusable shared libraries for better maintainability and consistency.

#### ✅ Phase 1: Core Shared Libraries Created
- **scripts/lib/camofox.js**: Camoufox API helpers (camofoxPost, camofoxGet, camofoxDelete, evalJson, navigate)
- **scripts/lib/totp.js**: TOTP code generation (getTOTP, getFreshTOTP) based on RFC 6238
- **scripts/lib/proxy-diag.js**: Proxy diagnostics (extractIpFromText, normalizeProxyUrl, getLocalPublicIp, probeProxyExitIp)
- **scripts/lib/screenshot.js**: Screenshot helper with createSaveStep factory for per-flow step numbering
- **scripts/lib/openai-auth.js**: OpenAI auth helpers (decodeJwtPayload, extractAccountMeta, parseUuidFromText)

#### ✅ Phase 2: Auto-Connect Worker Migration
- Migrated `auto-connect-worker.js` to use shared libs
- Replaced global `_stepCount` with `createSaveStep()` closure for per-flow screenshot counters
- Tightened `looksLoggedIn` logic: now requires `hasProfileBtn` or conversation URL, removed unreliable `hasNewChat` heuristic
- All saveStep calls updated to new signature (label only)
- No behavior change to OAuth PKCE flow or sendConnectResult payload

#### ✅ Phase 3: Login Flow Library
- **scripts/lib/openai-login-flow.js**: Created shared login flow helpers (getState, fillEmail, fillPassword, fillMfa, tryAcceptCookies, dismissGooglePopupAndClickLogin)
- Updated `auto-connect-worker.js` to import from openai-login-flow lib
- Added `getStateWithLogging` wrapper for auto-connect-specific logging
- Kept `fetchSessionInPage` function (auto-connect specific)

#### ✅ Phase 4: Auto-Register Worker Migration
- Migrated `auto-register-worker.js` to use shared libs
- Replaced inline helpers with imports (camofox, totp, proxy-diag, screenshot)
- Added `camofoxPostWithSessionKey` wrapper for sessionKey injection
- Updated all saveStep calls to use `createSaveStep` pattern
- Replaced hardcoded `localhost:4000` with `TOOLS_API_URL` from config
- No behavior change to registration flow or payload schema

#### ✅ Configuration Enhancement
- Added `toolsApiUrl` to config defaults (`http://localhost:4000`)
- Exported `TOOLS_API_URL` constant with env var override
- Updated `auto-register-worker.js` to use imported constant

## [0.2.18] - 2026-04-23

### ⚡ Realtime UI and state-sync optimization across Dashboard / Services / Vault

#### ✅ Core realtime reliability (`AppContext`)
- Added `process:logsHistory` handling and automatic `process:getLogs` requests after `processes:sync`.
- Added `refreshProcesses()` as shared process snapshot refresh API for all UI actions.
- Added fallback periodic sync when socket is disconnected to prevent stale process/session state.
- Reduced screenshot refresh pressure:
  - new screenshots now patch `sessions` state locally first,
  - full `/api/sessions` refresh is debounced instead of called per event.
- Start/stop/run actions now trigger a process snapshot refresh after optimistic updates, improving immediate status consistency.

#### ✅ Faster screen updates without full reload loops
- `src/components/views/ServicesView.tsx`
  - Added local row patching for `reset`, `toggle active`, `save edit`, `assign proxy`, `unassign proxy`, and delete.
  - Reduced full table reloads for deterministic single-row actions.
- `src/components/views/AccountsView.tsx`
  - Added local row patching for `reset`, `toggle active`, `save edit`, `assign proxy`, and delete.
  - Preserved full reload only for flows that still require server-side recompute.
- `src/components/views/vault/VaultAccountsView.tsx`
  - Split loader into `loadAccounts()` and `loadProxies()` to avoid re-fetching proxy state after every account action.
  - Switched multiple account actions to lightweight local patching or `loadAccounts()` only.
  - Manual refresh button now refreshes both account and proxy sources explicitly.
- `src/components/views/vault/VaultProxiesView.tsx`
  - Proxy test now patches row state directly (`is_active`, latency, last tested, notes/IP, country) instead of full reload each test.
  - Reduced import/test reload amplification and improved immediate visual feedback.
  - Delete flows now update local table instantly.

#### 🧪 Verification
- `npm run build` passed successfully (Next.js compile + TypeScript check).
- `npm run lint` still reports legacy repository-wide warnings/errors outside this patch scope (baseline existed before this release).

## [0.2.17] - 2026-04-23

### 🪵 Process log writer now auto-recovers if `data/logs` is removed

- Fixed `server.js` process logging so it recreates the parent log directory before each append.
- Prevents repeated `ENOENT` / `uncaughtException` when `data/logs` is deleted while the server is still running.
- Result: process output continues normally and log streaming no longer crashes on missing log directory.

## [0.2.16] - 2026-04-23

### 🔬 Deep verification: proxy diagnostics now validate the real worker session

#### ✅ Diagnostic scope tightened
- Updated all main workers so proxy verification no longer opens a probe under a different `userId`.
- The verification tab now uses the same worker `userId`, ensuring the check reflects the exact browser session that the task is using.

#### 🧪 Final runtime confirmation
- Re-ran end-to-end verification against the real patched Camoufox API:
  - Host public IP: `2405:4803:d75e:760:b41b:8110:b027:375f`
  - Main worker session IP: `2001:19f0:4400:4a41:688d:ec3a:13ab:132a`
  - Same-user follow-up tab IP: `2001:19f0:4400:4a41:688d:ec3a:13ab:132a`
- Conclusion: proxy is applied on the actual worker session and persists across tabs in the same session.

## [0.2.15] - 2026-04-23

### 🔎 Clarified Host-vs-Proxy IP diagnostics and re-verified same-session proxy routing

#### ✅ Diagnostic meaning clarified
- Updated worker and diagnostic logs to use `Host Public IP` instead of `Local IP`.
- This avoids confusion between:
  - the host machine public IP used for comparison, and
  - the browser/tab exit IP that should come from proxy.

#### 🧪 Same-session proxy routing verified
- Re-tested Camoufox session behavior directly on the patched server:
  - main tab created with proxy used exit IP `2001:19f0:4400:4a41:688d:ec3a:13ab:132a`
  - second tab with the same `userId` and no extra proxy field still used the same proxy exit IP
  - control tab under a different `userId` and no proxy used host IP `2405:4803:d75e:760:b41b:8110:b027:375f`
- Conclusion: proxy is now attached to the browser session correctly and persists across tabs within the same worker session.

## [0.2.14] - 2026-04-23

### ✅ Verification Pass: All proxy workers + build stability

Post-fix verification was executed to ensure proxy logic and worker runtime remain stable across all main automation paths.

#### 🧪 Runtime verification completed
- `scripts/auto-register-worker.js`
  - Proxy diagnostic verified: Exit IP and Local IP are different when proxy is assigned.
  - Worker flow continues after diagnostic (no false stop).
- `scripts/auto-connect-worker.js`
  - Worker starts and runs poll loop normally without startup crash.
- `scripts/auto-login-worker.js`
  - Worker starts and runs poll loop normally without startup crash.

#### 🧱 Build verification completed
- Ran production build successfully:
  - `npm run build`
  - Next.js compile + type checks completed without errors.

#### 🌐 Proxy connectivity re-check
- `scripts/test-camofox-proxy-ip.js` passed with:
  - Local IP: `2405:4803:d75e:760:b41b:8110:b027:375f`
  - Proxy Exit IP: `2001:19f0:4400:4a41:688d:ec3a:13ab:132a`
  - Status: proxy applied correctly (`Exit IP != Local IP`) and `chatgpt.com/auth/login` accessible.

## [0.2.13] - 2026-04-23

### 🔧 Root-Cause Fix: Camoufox ignored per-task proxy on `/tabs`

#### 🧠 Root cause identified
- Worker scripts already sent proxy correctly (`proxy`, `proxyUrl`, and normalized values).
- The Camoufox API server used by Tools (`http://localhost:3144`) did not apply request proxy fields when creating session/context.
- Result: browser traffic stayed on local network, causing:
  - `Exit IP == Local IP`
  - hard-fail message: `Proxy chưa được áp dụng (Exit IP trùng Local IP).`

#### ✅ Permanent fix applied and validated
- Patched local Camoufox server (`/Users/ndpmmo/Documents/Tools/camofox-browser/server.js`) to:
  - accept inline proxy from `POST /tabs` request body,
  - parse multiple proxy formats (`proxy` string/object, `proxyUrl`, `proxyServer+proxyUsername+proxyPassword`),
  - persist proxy binding per `userId` session,
  - recreate session context when proxy changes.
- Restarted Camoufox and re-tested:
  - with proxy: exit IP `2001:19f0:4400:4a41:688d:ec3a:13ab:132a`
  - without proxy: exit IP remained local (`2405:...` / `42.115...`)
  - auto-register diagnostic now passes proxy check (Exit IP != Local IP).

## [0.2.12] - 2026-04-23

### 🩹 Worker Proxy Diagnostics Stabilization & Crash Fix

#### ✅ Fixed Auto-Register crash on proxy validation failure
- `scripts/auto-register-worker.js`:
  - Fixed runtime crash `TypeError: Cannot read properties of undefined (reading 'success')` in CLI mode.
  - `runAutoRegister(...)` now always returns a structured failure object in `catch`.
  - Added top-level `.catch(...)` for CLI runner to prevent unhandled failure exits.

#### 🌐 Reduced false proxy mismatch due local-IP detection path
- `scripts/auto-register-worker.js`
- `scripts/auto-connect-worker.js`
- `scripts/auto-login-worker.js`
  - Reworked `getLocalPublicIp()` to use direct `https` requests (no implicit fetch proxy path), improving reliability of local-vs-exit IP comparison.

#### 🧪 Improved diagnostic script parity
- `scripts/test-camofox-proxy-ip.js`
  - Updated local IP check to use direct `https` request for consistency with worker diagnostics.

## [0.2.11] - 2026-04-23

### 📌 Changelog Traceability Update (Detailed Commit Mapping)

This patch focuses on improving release auditability by documenting exact commit history for the latest proxy hardening wave and confirming release metadata consistency.

#### 🧾 Detailed Commit Mapping (Latest Proxy Series)
- `e932133` — `feat(proxy): unify proxy state and bulk assignment UX across vault/services/workshop/proxies`
  - Unified proxy state API and cross-screen mapping.
  - Added bulk assign/unassign flow and improved visibility across views.
- `1775967` — `fix(proxies): fallback to legacy inspect endpoint when proxy state route is unavailable`
  - Added safe fallback path to avoid UI blind spots when unified state endpoint is temporarily unavailable.
- `c0c33e8` — `fix(proxy): enforce fail-closed proxy verification with ipv6-aware diagnostics`
  - Introduced strict verification policy in workers to stop immediately when proxy validation fails.
- `d61bd9c` — `fix(proxy): harden proxy verification and normalize worker proxy inputs`
  - Normalized schema-less proxy strings and strengthened diagnostics across worker flows.
  - Added gateway delete-notify cooldown circuit breaker to reduce repeated network-failure noise.

#### 🔢 Version Consistency
- Bumped application version to `0.2.11` in:
  - `package.json`
  - `package-lock.json`
- No runtime behavior changes in this patch beyond documentation/release metadata alignment.

## [0.2.10] - 2026-04-23

### 🧩 Proxy Reliability Hardening & Gateway-Down Resilience

Focused improvements to prevent false proxy usage, normalize malformed proxy inputs, and reduce noisy gateway errors when local gateway service is offline.

#### 🔐 Strict Proxy Validation in Workers
- **Applied to `auto-connect-worker.js`, `auto-login-worker.js`, `auto-register-worker.js`**.
- Added fail-closed checks for proxy-required tasks:
  - Stop when Exit IP cannot be read.
  - Stop when Local IP cannot be read for verification.
  - Stop when Exit IP equals Local IP (proxy not actually applied).
- This guarantees tasks do not proceed over local network path when proxy is expected.

#### 🧱 Proxy URL Normalization
- Added `normalizeProxyUrl(...)` in workers so inputs like:
  - `user:pass@host:port`
  are automatically normalized to:
  - `http://user:pass@host:port`
- This prevents inconsistent behavior caused by schema-less proxy strings stored in vault records.

#### 🌐 Improved Diagnostic Test Coverage
- Upgraded `scripts/test-camofox-proxy-ip.js`:
  - Auto-normalizes proxy URL input.
  - Tests both IP-routing and real `chatgpt.com/auth/login` accessibility.
  - Prints local-vs-exit IP comparison and page-state indicators (login/signup/challenge flags).
- Expanded parser support for both IPv4 and IPv6 formats.

#### 🛡️ Gateway Notification Circuit Breaker
- Updated `server.js` D1 account-delete interceptor:
  - Added local gateway availability probe before delete notify.
  - Added 60-second cooldown when gateway is unreachable (network failure).
  - Suppresses repetitive noisy error spam while preserving core D1 delete flow.
- Result: account synchronization with cloud D1 remains stable even when `gatewayUrl` local service is down.

## [0.2.9] - 2026-04-23

### 🛡️ Strict Proxy Enforcement, IPv6-Aware Diagnostics & Camoufox Verification

Focused hardening for automation workers to guarantee fail-closed behavior when proxy assignment is required.

#### 🔒 Fail-Closed Proxy Policy (All Main Workers)
- **Applied to `auto-login-worker.js`, `auto-connect-worker.js`, `auto-register-worker.js`**.
- If an account/email has `proxy` assigned, workers now stop immediately when:
  - Exit IP cannot be fetched.
  - Local IP cannot be fetched for verification.
  - Exit IP equals Local IP (proxy bypass / proxy not applied).
- This prevents tasks from continuing on local network path when a proxy is expected.

#### 🌐 IPv6-Compatible Proxy Checks
- Updated worker diagnostic probes to use IPv6-friendly endpoint:
  - `https://api64.ipify.org/?format=json`
- Expanded IP parsing to support:
  - JSON fields: `ip`, `query`, `address`
  - Both IPv4 and IPv6 textual formats.

#### 🧪 New End-to-End Camoufox Proxy Test Script
- Added `scripts/test-camofox-proxy-ip.js` with deep checks:
  1. Camoufox `/health`
  2. Exit IP check via browser context
  3. Local IP comparison (proxy-applied detection)
  4. Real navigation to `https://chatgpt.com/auth/login`
  5. Page-state verification (URL/title/login/signup/challenge flags + snapshot snippet)

#### 🧭 Environment Type Reference Refresh
- `next-env.d.ts` route-types import path updated by Next.js runtime (`.next/dev/types/routes.d.ts`).

## [0.2.8] - 2026-04-23

### 🔗 Unified Proxy UX Across Vault Accounts, Workshop, Services, and Proxy Pool

This release unifies proxy assignment data flows and introduces bulk operations so all proxy-related screens are easier to read, safer to operate, and visually consistent.

#### 🧠 Unified Proxy Backend State
- **New Aggregated API**: Added `GET /api/proxy/state` to return a consolidated payload (`proxies`, `proxySlots`, `accounts`, `bindings`, `proxyStats`) for all UI screens.
- **Binding Resolver**: Implemented centralized proxy-account binding resolution that maps by `proxy_id`, `proxy_url`, and slot ownership.
- **Operational Consistency**: Added `POST /api/proxy-assign/bulk` with `assign|unassign` actions to support multi-account proxy operations in one request.

#### ⚡ Professional Bulk Operations in Account Screens
- **`VaultAccountsView`**:
  - Added row selection with select-all control.
  - Added bulk proxy tools: assign selected (specific proxy or auto-best), unassign selected.
  - Switched proxy selector datasource to unified `proxy/state` endpoint.
- **`ServicesView`**:
  - Added row selection with select-all control.
  - Added bulk proxy assign/unassign actions.
  - Added per-row unassign shortcut in action bar.
  - Switched proxy datasource to unified `proxy/state` endpoint.

#### 🛰️ Proxy Visibility Upgrade in Proxy Pool
- **`ProxiesView` now shows account ownership directly**:
  - New “Assigned Accounts” panel per proxy card.
  - Displays mapped account/email and slot index for each assignment.
  - Added one-click unassign per mapped account from the proxy screen.
- **Slot Tooltips Improved**:
  - Busy slot hover now shows account email when available (instead of raw ID-only display).

#### 🧩 Vault Workshop Synchronization Improvement
- **Unified Data Source First**:
  - `VaultWorkshopView` now loads proxy catalog and existing account mappings from `GET /api/proxy/state`.
  - Falls back to legacy `/api/vault/proxies/list` only when unified state endpoint is unavailable.
- **Mapping Continuity**:
  - Server-provided mappings are merged into persisted local proxy preferences for smoother transition.

## [0.2.7] - 2026-04-22

### 🏗️ Proxy Hardening, Auto-Sync & Workshop UI Synchronization

Stabilized the proxy assignment engine, hardened automation workers against network failures, and ensured 100% data consistency between local and cloud environments.

#### 🛡️ Robust Proxy Assignment & Auto-Sync
- **Intelligent Auto-Sync**: Implemented automatic account mirroring to Cloud D1 during proxy assignment. If a local account is not yet on the cloud, the system now pushes it automatically before binding slots, eliminating "Account not found" errors.
- **Graceful Slot Handling**: Relaxed strict slot requirements in `rebindProxySlotForAccount` to allow URL-only assignment when pre-defined slots are missing, ensuring uninterrupted operation.
- **Recursive Auto-Assignment**: Enhanced the `Auto Assign Proxy` tool to support accounts stored only in the local vault by performing a pre-emptive sync to the cloud.

#### 🔌 Hardened Automation Workers
- **Multi-Source Resilience**: Expanded the diagnostic loop to include `icanhazip.com`, `ip-api.com`, and `ipify.org`. Increased timeouts and added detailed error reporting for `fetch failed` scenarios.
- **Hard-Fail Security Policy**: Enforced mandatory proxy verification. If a proxy is assigned but the connection check fails, the process terminates immediately to prevent IP leaks.
- **Variable Scoping Fixes**: Resolved critical `ReferenceError` bugs (e.g., `account is not defined`) in error-handling blocks across all main worker scripts.

#### 🔄 UI & Diagnostic Empowerment
- **Workshop Queue Persistence**: Rebuilt `VaultWorkshopView` to reconstruct the active task queue from global process state on refresh, providing a seamless multi-tab experience.
- **Diagnostic Tooling**: Added `scripts/test-proxy-connection.js` and `scripts/test-proxy-direct.js` to allow rapid verification of Camoufox API and proxy credentials independently of the main UI.
- **Process Visibility**: Exposed full command-line arguments and precise start timestamps in the process management API to better track long-running automation tasks.

## [0.2.6] - 2026-04-22

### 🛡️ Proxy Management Professionalization & Cloud Integrity

Unified proxy infrastructure with automated geolocation, deduplication, and a redundant cloud synchronization layer.

#### 🛰️ Automated Proxy Intelligence
- **Dual-Stack Geolocation**: Switched to `ifconfig.co/json` to reliably detect country codes for both IPv4 and IPv6 exit IPs.
- **Auto-Test on Import**: Implemented immediate network testing and geo-tagging for manually added or bulk-imported proxies.
- **Smart Deduplication**: Added URL-based proximity checks in `upsertProxy`. Re-adding an existing URL now restores the original record, preventing ID fragmentation.

#### ☁️ Cloud Consistency (D1 Support)
- **Soft-Delete Sync**: Updated D1 Worker to support and respect `deleted_at`, ensuring local deletions are permanently reflected on Cloudflare.
- **Schema Migration**: Implemented a `/sync/migrate` endpoint to bridge D1 table gaps by adding missing state columns.
- **Comprehensive Sync-All**: Added a global synchronization endpoint (`/api/vault/sync/all`) to reconcile Accounts, Proxies, and Keys in a single transaction.

#### 🧹 UI/UX Cleanup
- **Phantom Record Suppression**: Hardened database queries to exclude soft-deleted proxies from all dropdowns and selector menus.
- **Dropdown Redundancy Fix**: Resolved the "multiplying proxies" bug in Vault Workshop by enforcing clean state filtering on the backend.

## [0.2.5] - 2026-04-21

### 🚀 Email Pool Modernization & Multi-Method Sync

Major infrastructure update to support Graph API and OAuth2 authentication methods for email accounts, with real-time D1 synchronization.

#### 📧 Multi-Method Authentication Support
- **Auto-Detection UI**: Refactored `VaultEmailsView` to intelligently parse input strings, automatically detecting whether an entry is Graph API (4 parts) or OAuth2 (3 parts) based on content.
- **Enhanced Validation**: Updated `vault_email_pool` schema to include `auth_method` and improved `services_json` handling to prevent data loss during status updates.
- **Credential Flexibility**: Modified `scripts/auto-register-worker.js` to support the new 5-part credential format, enabling password-less registration for OAuth2 accounts.

#### ☁️ Real-time D1 Synchronization
- **SyncManager Hardening**: Fixed a critical bug where `cacheKey` collisions prevented email pool updates from reaching D1.
- **Immediate Push**: Configured Email Pool, Proxy, and Key updates to bypass the sync debounce period, ensuring instant cloud availability.
- **Full Sync Utility**: Added a **"Sync All to D1"** button in the UI to allow manual bulk recovery of the email pool to Cloudflare.

#### 🐛 Stability & Connectivity
- **Graph API Scope fix**: Removed strict permission requirements in `ms-graph-email.js` to resolve `AADSTS70000` errors during mailbox access.
- **Automated Health Checks**: Integrated real-time worker triggers during email import to verify credential validity immediately upon addition.

## [0.2.4] - 2026-04-21

### ✨ Vault Enhancements & UI Polish

Improved data portability in the Email Vault and refined the layout density across management views.

#### 📋 Intelligent Copy (Vault Emails)
- **Copy Full Record**: Implemented a secondary copy action (Database icon) that reconstructs the raw credential string (`email|password|refresh_token|client_id`) in a single click.
- **Improved Semantic Icons**: Replaced generic `Activity` icons with `Database` icons for raw data operations, providing better visual cues.
- **Contextual Feedback**: Added specific toast messages to distinguish between copying just the email and copying the full record.

#### 📐 Layout & UX Optimization
- **AccountsView Refinement**: Resolved a structural layout bug where the "Add Account" card occupied 50% of vertical space, creating a large empty gap. The view now collapses correctly based on content.
- **Consistent Scaling**: Updated `Cards` and `Containers` to use `shrink-0` for input forms and `flex-1` for data tables, ensuring high-density information display.

#### 🐛 Stability Fixes
- **ReferenceError Fix**: Resolved a crash in `VaultEmailsView` where `Activity` was used without being imported after icon refactoring.

## [0.2.3] - 2026-04-21

### 🧹 D1 Cloud Purge & Smart Sync Hardening

Comprehensive cleanup of Cloudflare D1 environment and implementation of definitive sync rules to prevent database pollution.

#### 🧼 D1 Hard Cleanup (Wrangler execution)
- **Database Purge**: Executed a hard `DELETE` via `wrangler d1` to permanently remove 17+ orphaned/redundant records from `codex_managed_accounts` and `codex_connections`.
- **Foreign Key Cleanup**: Cleared legacy `codex_account_limits` and `codex_proxy_slots` records that were tied to deleted accounts.

#### 🧠 Smart Synchronization (SyncManager)
- **4-Rule Sync Dispatch**: Rewrote `_executePush` logic to be context-aware:
  - **Account Deleted**: Sends a minimal tombstone record to Gateway side.
  - **Account Idle**: Recalls the account from Gateway (soft-delete in D1) but preserves it in local Vault.
  - **Account Active**: Syncs full credentials and status to keep the fleet running.
- **D1 Pollution Prevention**: Guaranteed that non-active/idle accounts are automatically hard-deleted or ignored by Gateway handlers during sync.

#### 🐛 Process Monitoring & Worker Robustness
- **Status-Based Filtering**: Updated Dashboard and Terminal sidebar to only display `RUNNING` processes, hiding stopped or historical worker instances.
- **`NEED_PHONE` Detection**: Optimized the auto-connect worker to explicitly detect and flag accounts requiring phone verification with a specific label.
- **ReferenceError Fix**: Resolved `USER_ID is not defined` crash in `auto-connect-worker.js` during fallback session capture.

## [0.2.2] - 2026-04-21

### 🛡️ Data Integrity & D1 Sync Optimization

Deep audit and hardening of the D1 synchronization pipeline to prevent data loss and ensure provider consistency.

#### 🔐 Critical Data Protection
- **Disappearing Account Fix**: Resolved a critical race condition where D1 `pullVault` would propagate `deleted_at` status from Gateway to local Vault, causing active accounts to "vanish" from UI.
- **Independent Vault Guard**: Implemented protective logic in `upsertAccount` to ensure remote-origin soft-deletions never overwrite live local records during sync.
- **Recall-to-Idle Logic**: When an account is deleted on Gateway, Vault now correctly reverts it to `idle` (Cold Storage) rather than deleting it locally.

#### 🔄 Sync Consistency & Multi-Provider Support
- **Provider Normalization**: Removed hardcoded `'codex'` defaults in `SyncManager` push payloads and server mirroring; system now correctly preserves the `openai` provider type.
- **Unified Task Polling**: Expanded auto-register and auto-connect task queries to include both `codex` and `openai` accounts, enabling multi-source automation.
- **Proxy Metadata Fix**: Ensured original `created_at` timestamps are preserved when syncing proxies from remote databases.

#### 🖥️ Vault UX Redesign (Final Polish)
- **`VaultEmailsView`**: Implemented bulk management (Select All, Bulk Delete), per-row "Register" & "Verify" actions, and live filter counts.
- **`VaultAccountsView`**: Standardized all management actions (Deploy, Connect, Proxy) for both ChatGPT and Codex account types.
- **Provider Labels**: Unified display naming to **"ChatGPT | Codex"** across the dashboard for better visual clarity.

## [0.2.1] - 2026-04-21

### 🛠 UI Optimization & Terminal Redesign

Refined the layout architecture for better scrolling stability and completely redesigned the Terminal interface.

#### 🐚 Enhanced Terminal Experience
- **Redesigned Layout**: Fixed the process sidebar width (`w-72`) to prevent "crushing" and text truncation.
- **Mac-style Window**: Added authentic-feel window controls (Red/Yellow/Green dots) to the terminal header.
- **Timestamp Fix**: Guaranteed log readability by fixing timestamp wrapping using `min-w-[70px]`.
- **Responsive Stacking**: Implemented smart stacking for mobile/small screens (sidebar stacks at 45% height).
- **Modern Empty State**: Applied a grain-noise radial gradient background for the "no process selected" screen.

#### 📐 Layout & Scrolling Robustness
- **Global Scroll Pattern**: Standardized all 15 views using the `absolute inset-0 overflow-y-auto` pattern, preventing views from getting "stuck".
- **Router Container**: Wrapped `ContentRouter` in a `relative flex-1 min-h-0` container in `Dashboard.tsx` to provide a stable coordinate system for views.
- **Changelog Parser**: Rebuilt the parser with robust Regex logic to prevent content truncation when encountering special characters or high-length logs.

## [0.2.0] - 2026-04-21

### 🎨 UI Overhaul — Premium Dark Glassmorphism Design System (Tailwind CSS v4)

Complete redesign of the entire dashboard interface. Replaced ~1950 lines of legacy CSS with a scalable,
component-driven system powered by **Tailwind CSS v4** and a custom dark-mode design language.

#### Design System Foundation
- **Tailwind CSS v4**: Migrated from v3 syntax (`@tailwind base/utilities`) to v4 (`@import "tailwindcss"` + `@theme {}`)
- **PostCSS**: Updated `postcss.config.js` to use `@tailwindcss/postcss` with ESM export
- **`globals.css`**: Stripped from 1950+ lines down to ~70 lines (CSS vars, scrollbars, font import)
- **New UI Component Library** (`src/components/ui/index.tsx`): Centralized reusable Tailwind components:
  - `Button` — 6 variants (primary, secondary, ghost, danger, success, icon-sm), 4 sizes
  - `Card`, `CardHeader`, `CardTitle`, `CardContent` — glassmorphism panels
  - `Input` — unified dark-mode input field with focus ring
  - `StatBox` — animated stat card with icon, value, label, and active state

#### Core Layout & Navigation
- **`Dashboard.tsx`**: Wrapped in `AppProvider`, redesigned with `AppProvider > Layout > Sidebar > Topbar > ContentRouter`
- **`Sidebar`**: Full Tailwind dark nav with grouped menu sections (Tổng Quan, Vault Local, D1 Cloud, Công Cụ, Tài Nguyên), lucide icons, active state highlight
- **`Topbar`**: Glassmorphism header with page title/desc, icon, and Live/Offline status badge
- **`Views.tsx`**: Migrated shared components:
  - `ConfirmModal` — proper dark overlay + glassmorphism dialog
  - `ToastContainer` — slide-in toast notifications with type icons
  - `Spinner` — CSS animated ring
  - `Badge` — status badge with colored variants

#### View-by-View Migrations
All 13 views fully migrated to Tailwind CSS:

- **`DashboardView`**: Stats grid with `StatBox`, process table with status badges, quick actions
- **`AccountsView`**: Multi-provider accounts table, `CopyBadge` for password/2FA copy-to-clipboard, plan badges, inline edit modal, D1 sync button
- **`VaultAccountsView`**: Vault local accounts, service badges (ChatGPT, etc.), `CopyBadge` credentials, auto-assign proxy, export to D1
- **`VaultEmailsView`**: Email pool inventory, service registration badges, import/add panel, status filter tabs, check-status action
- **`VaultAutoRegisterView`**: Auto-register wizard with live log streaming, screenshot panel, stats, `setView` navigation to Email Pool
- **`VaultProxiesView`**: Proxy pool table with slot count, usage indicator, add/delete, date column
- **`ProxiesView`**: D1 Proxy Pool full management — add single/bulk import, slot grid (busy/free), inline edit, slot reset, confirm dialogs
- **`TerminalView`**: Split 2-column layout — process sidebar selector + scrollable log output with color-coded lines (stdout/stderr/system)
- **`ScreenshotsView`**: Session cards grid, Advanced Viewer overlay with filmstrip, live viewer with blinking badge
- **`ConnectionsView`**: Authenticated connections table with status dots, token display
- **`ScriptsView`**: Script cards with emoji icons, description, optional arg input, Run button, flow guide steps
- **`LogFilesView`**: File list with search/size filter, bulk select+delete, file viewer with line numbers and color-coded log levels
- **`SettingsView`**: Section cards (Camofox, Gateway, Worker, Folders), show/hide token, eye icon
- **`ChangelogView`**: Timeline layout with version dots, section tags, sub-items
- **`CamofoxDocsView`**: Docs article with code blocks, info banners, checklist

#### Bug Fixes
- Fixed `Button` `size="icon"` → `size="icon-sm"` type mismatch across vault views
- Fixed `allowRun`/`allowDeploy` scope error in `VaultAccountsView` map loop
- Fixed missing `CardTitle` import in `TerminalView`
- Fixed log type comparison `l.type === 'err'` → `l.type === 'stderr'`
- Fixed `fmtDateTimeVN` missing import in `VaultProxiesView`
- Fixed `setView` not destructured in `VaultAutoRegisterView`
- Fixed `AppProvider` missing wrapper in `Dashboard.tsx` causing `Error: no ctx` on SSR prerender
- Fixed `@import` order in `globals.css` (Google Fonts import must precede `@import "tailwindcss"`)
- Fixed `postcss.config.js` CommonJS syntax in ESM project (changed `module.exports` to `export default`)

### Added
- **Copy-to-Clipboard badges** on password & 2FA secret fields across `AccountsView` and `VaultAccountsView`
- **VaultEmailsView** extracted as standalone menu item under Vault (Local) section
- **Service registration badges** on email pool entries (ChatGPT, etc.)
- **`check-mail-worker.js`** script for automated mailbox status verification

## [0.1.19] - 2026-04-20

### Added
- **Auto-Saving to Vault**: Worker now automatically persists successful registrations to the local database via `POST /api/vault/accounts`.
- **MFA Pipeline**: Integrated standalone `lib/mfa-setup.js` for automated Authenticator App enrollment during registration.
- **Strong Password Policy**: Automated unique, 16+ character password generation (uppercase, lowercase, numbers, symbols) for every account registered.

### Fixed
- **Registration Logic**: Corrected button detection for "Finish creating account" variant (fixing regression where the worker would hang on the final registration step).
- **Dashboard UI**: Rewrote `VaultAutoRegisterView` to correctly synchronize process logs and screenshots via centralized AppContext, preventing data loss on page refresh.
- **MFA Stability**: Updated "Trouble scanning" selector to handle a wider range of DOM structures (a, button, span, p).

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
- **Infrastructure Modernization**: Unified Proxy Management with bulk import and real-time network detection.
- **Proxy Intelligence**:
  - Auto-validation and country detection using `ifconfig.co/json` (dual-stack support).
  - Proxy IP Verification Diagnostic: Workers now check and log exit IP at session start.
- **Data Integrity**:
  - Implemented URL-based proxy deduplication and soft-delete restoration.
  - Added comprehensive `POST /api/vault/sync/all` endpoint for full state reconciliation with D1.
- **Smart Sync Trigger**: Implemented a local webhook trigger system. When toggling an account's status in Tools, it now sends an immediate notification to the Gateway over the local network to trigger an on-demand pull, reducing sync latency to near-zero.

### Fixed
- **Soft-Delete Handling**: Local vault queries now correctly filter out `deleted_at IS NOT NULL` records.
- **Build Errors**: Fixed missing `accounts` and `refreshAccounts` members in `AppContext` type definition.
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
