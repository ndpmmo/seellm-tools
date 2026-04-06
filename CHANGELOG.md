# Changelog

## [0.0.5] - 2026-04-06
### Added
- **Cloud Vault Sync (Milestone 3)**: Real-time background synchronization between local Vault (SQLite) and Cloudflare D1.
- Global accessibility: Sync personal accounts, proxies, and API keys across multiple SeeLLM Tools instances.
- Initial sync pull at startup to hydrate local database from D1 Cloud.
- Conflict prevention using version tracking (`updated_at`).
### Changed
- Refactored server configuration into a shared utility (`config.js`).
- Improved mutation hooks to trigger D1 pushes automatically.

## [0.0.3] - 2026-04-06
- Added Vault (Local) storage with SQLite.
- Interactive Proxy/Slot management.
- AES-256 encryption for secrets.
