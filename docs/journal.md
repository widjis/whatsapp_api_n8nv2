## [2025-12-29] Add Missing extractMessageContent Function
- Change:
  - Added `extractMessageContent` function to `index.js`.
  - Implemented logic to extract text from `conversation`, `imageMessage`, `videoMessage`, `extendedTextMessage`, `documentMessage`, `buttonsResponseMessage`, `listResponseMessage`, `templateButtonReplyMessage`, and `ephemeralMessage`.
- Reason:
  - The function was referenced in `messages.upsert` handler but was not defined, causing runtime errors.
- Impact:
  - Fixes the `ReferenceError: extractMessageContent is not defined`.
  - Enables correct message content logging and processing for various message types.

## [2025-12-29] Initialize README for API Gateway
- Change:
  - Added `README.md` documenting setup, configuration, endpoints, and inbound handling.
- Reason:
  - Provide clear instructions for installing, configuring, and using the API.
- Impact:
  - Improves onboarding and integration. No runtime changes.

## [2025-12-29] Add /resetpassword Command with LDAP Support
- Change:
  - Implemented `/resetpassword` command in `handleCommand`.
  - Added LDAP client helper and `resetPassword` function.
  - Introduced `ALLOWED_PHONE_NUMBERS` check for admin authorization.
  - Added `ldapjs` dependency.
- Reason:
  - Enable admin-controlled password resets via WhatsApp.
- Impact:
  - Requires `.env` variables: `LDAP_URL`, `BIND_DN`, `BIND_PW`, `BASE_OU`, `ALLOWED_PHONE_NUMBERS`.
  - Security-sensitive; restricted to authorized phone numbers.

## [2026-01-05] Add local lint and typecheck commands
- Change:
  - Added `lint` script to run `node --check` against core files.
  - Added `typescript` dev dependency and `tsconfig.json` for `npx tsc --noEmit`.
  - Updated README with the new check commands.
- Reason:
  - Provide a repeatable local integrity check before running the service.
- Impact:
  - Enables `npm run lint` and `npx tsc --noEmit` for quick verification.

## [2026-01-31] Add Qontak WhatsApp direct-send test script
- Change:
  - Added `qontak.js` for sending a WhatsApp template via Qontak Open API.
  - Updated lint/typecheck coverage to include `qontak.js`.
  - Updated README with environment variables and run command.
- Reason:
  - Enable quick verification of Qontak WhatsApp sending from this repo.
- Impact:
  - Requires Qontak/Mekari credentials and a template/channel integration.

## [2026-02-01] Add Qontak template listing command
- Change:
  - Added `list-templates` command in `qontak.js`.
  - Updated README with the list templates command.
- Reason:
  - Enable discovering template IDs and metadata needed for outbound sends.
- Impact:
  - Uses the same Qontak auth mode as sending (HMAC or Bearer).

## [2026-02-01] Fix Qontak env keys
- Change:
  - Normalized Qontak-related `.env` keys and added missing assignments.
- Reason:
  - Prevent misconfigured environment variables from breaking Qontak commands.
- Impact:
  - Enables `node qontak.js list-templates` to read required env consistently.

## [2026-02-01] Add OAuth refresh support for Qontak bearer auth
- Change:
  - Added optional Mekari OAuth2 refresh-token flow to `qontak.js` when using bearer auth.
  - Added CLI overrides for bearer credentials when running `qontak.js`.
  - Retried OAuth refresh using JSON, form, and basic auth.
- Reason:
  - Reduce 401 errors caused by expired access tokens.
- Impact:
  - Allows `QONTAK_AUTH_MODE=bearer` to work with either a fixed access token or refresh-token settings.

## [2026-02-01] Fix Qontak HMAC signing secret handling
- Change:
  - Updated `qontak.js` to use `MEKARI_API_CLIENT_SECRET` as-is for HMAC signing.
- Reason:
  - Prevent signature mismatches caused by decoding or transforming the secret.
- Impact:
  - Reduces risk of 401 Unauthorized when using HMAC auth.

## [2026-02-01] Improve template listing endpoint fallback
- Change:
  - Updated `qontak.js` to try an alternate templates endpoint when the default path is not found.
- Reason:
  - Some Qontak environments expose WhatsApp templates under different chat API paths.
- Impact:
  - Makes `list-templates` more resilient across deployments.

## [2026-02-15 12:29:22 WITA] Convert runtime to modular TypeScript
- Change:
  - Added `src/` TypeScript entrypoint and extracted WhatsApp, HTTP, LDAP, and N8N modules.
  - Updated scripts for dev (`tsx`) and prod build (`tsc` to `dist/`).
- Reason:
  - Improve maintainability and type-safety while keeping the same runtime behavior.
- Impact:
  - Use `npm run dev` for local development and `npm run build && npm start` for production.

## [2026-02-15 12:32:39 WITA] Move legacy JS into reference folder
- Change:
  - Moved prior JS entrypoints/scripts into `reference/`.
- Reason:
  - Keep old implementations for comparison without cluttering the root.
- Impact:
  - Runtime now uses `src/` and `dist/`; legacy JS remains available under `reference/`.
