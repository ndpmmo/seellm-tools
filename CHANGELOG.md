# Changelog - SeeLLM Tools

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
