# Scripts Map

This file is a quick navigation map for `scripts/` in SeeLLM Tools.
It groups files by purpose so you can find the right entrypoint faster.

## Main Entrypoints

- `auto-worker.js`: unified login/connect worker for production runs.
- `auto-register-worker.js`: automated account registration flow.
- `warmup.js`: account warmup and health-maintenance flow.
- `setup-mfa.js`: full MFA setup flow for ChatGPT accounts.
- `regenerate-2fa.js`: rebuild 2FA for an existing account.
- `batch-fix-mfa.js`: batch repair for accounts missing MFA.

## Browser and Camofox

- `lib/camofox.js`: shared Camofox API wrapper and browser helpers.
- `test-camofox.js`: basic Camofox health check.
- `test-camoufox.js`: browser connectivity test against Google.
- `test-camofox-ui.js`: UI exploration for ChatGPT landing pages.
- `test-camofox-proxy-ip.js`: verify proxy exit IP through Camofox.
- `test-proxy.js`: proxy test through Camofox.
- `test-proxy-connection.js`: low-level proxy connectivity test.
- `test-proxy-direct.js`: direct proxy test without Camofox.
- `check-proxy-status.js`: monitor proxy-related state.

## Login, OAuth, and Session

- `lib/openai-login-flow.js`: shared DOM/login flow helpers.
- `lib/openai-oauth.js`: PKCE/OAuth helpers.
- `lib/openai-auth.js`: JWT decoding and account metadata helpers.
- `lib/openai-protocol-register.js`: protocol-first registration engine.
- `check-session.js`: validate whether stored session cookies still work.
- `test-login.js`: login test script.
- `test-login-full-flow.js`: end-to-end login trace with screenshots.
- `test-oauth-diag.js`: OAuth diagnostic runner.
- `test-workspace-selection.js`: reproduce workspace selection errors.
- `test-cookie-restore-workspace.js`: session restore and workspace selection test.

## MFA, OTP, and Mail

- `lib/totp.js`: TOTP generation.
- `lib/mfa-setup.js`: MFA setup helper.
- `lib/ms-graph-email.js`: Microsoft Graph email reader helper.
- `lib/imap-email.js`: IMAP email reader helper.
- `check-mail.js`: quick mail API test.
- `check-mail-worker.js`: worker version of the mail health check.
- `sweep-mail.js`: fetch and mark unread mail.
- `test-otp.js`: OTP retrieval test.
- `gen-2fa.js`: generate 2FA code or secret-related data.

## Database, Sync, and Maintenance

- `check-account.mjs`: inspect one vault account directly.
- `inspect-db.js`: inspect local DB state.
- `debug-full-state.mjs`: dump local vault plus D1 state.
- `debug-check-sync.mjs`: compare sync status.
- `push-all-accounts.mjs`: force sync all accounts to D1.
- `repair-gateway-status.mjs`: repair inconsistent gateway status.
- `reset-all-accounts-idle.mjs`: reset active accounts to idle.
- `cleanup-tombstones.mjs`: purge soft-deleted records locally.
- `cleanup-d1-stale-connections.mjs`: remove stale D1 connections.
- `cleanup-d1-stale-connections-v2.mjs`: newer cleanup variant.
- `diagnose_d1.mjs`: D1 troubleshooting helper.

## Debug and Probe

- `debug/inspect-page.js`: inspect page DOM and selectors.
- `debug/test-signup-flows.js`: compare signup flow variants.
- `debug/test-selectors.js`: verify selector logic.
- `debug/test-timing.js`: measure redirect timing.
- `debug/test-waitForUrlChange.js`: test URL change detection.
- `debug/probe-openai-auth-pages.js`: probe auth page states.
- `debug/probe-openai-auth-password.js`: probe password-step behavior.
- `debug/probe-new-openai-flow.js`: study the new signup flow.
- `debug/probe-signup-page.js`: inspect signup page state.
- `debug/test-email-exists.js`: test duplicate-email behavior.
- `debug/test-with-proxy.js`: signup flow with proxy enabled.

## Utilities and Support

- `config.js`: shared config loader from `tools.config.json`.
- `ping-servers.js`: ping Camofox and Gateway.
- `dump-active-tabs.js`: list active browser tabs.
- `reassign-proxies.js`: reassign proxies for accounts.
- `insert-test-emails.js`: seed test email data.
- `test-tokens.js`: validate stored email tokens.
- `test-token-live.mjs`: live token scope/endpoint test.
- `test-graph-scopes.mjs`: probe Graph scope behavior.
- `test-warmup-run.js`: wrapper for warmup validation.
- `run-test.js`: small harness for auto-register testing.

## Shared Libraries

- `lib/screenshot.js`: screenshot capture and step recording.
- `lib/proxy-diag.js`: proxy diagnostics and IP detection.
- `lib/warmup-prompts.js`: warmup prompt generator.
- `lib/sentinel-vm.js`: Sentinel/Turnstile solver.
- `lib/names.js`: sample name lists for test generation.
- `lib/curl_cffi_fetch.py`: Chrome-impersonating fetch helper.
- `lib/curl_cffi_daemon.py`: persistent Chrome-impersonating daemon.

## Legacy and Backup

- `backup/auto-login-worker.js`: archived auto-login worker.
- `backup/auto-connect-worker.js`: archived auto-connect worker.

## Suggested Reading Order

1. `README.md`
2. `auto-worker.js`
3. `lib/camofox.js`
4. `lib/openai-login-flow.js`
5. `lib/openai-oauth.js`
6. `lib/ms-graph-email.js`
7. `lib/totp.js`

## Notes

- Many debug scripts contain hardcoded test credentials or temporary values.
- Treat those files as investigation tools, not reusable production entrypoints.
- If you add a new script, update this map first so the directory stays easy to scan.
