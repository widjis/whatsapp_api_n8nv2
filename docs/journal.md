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

## [2026-02-15 12:48:43 WITA] Copy legacy /help behavior
- Change:
  - Updated `/help` to support `/help` (list) and `/help <command>` (details).
- Reason:
  - Preserve legacy help UX from `reference/index_old.js`.
- Impact:
  - Users can discover available commands and view per-command usage text.

## [2026-02-15 12:56:04 WITA] Port legacy /finduser command
- Change:
  - Added `/finduser <name> [/photo]` command implementation in TypeScript.
  - Added LDAP search helper for CN matching and optional AD photo retrieval.
- Reason:
  - Preserve legacy AD lookup behavior from `reference/index_old.js`.
- Impact:
  - Requires search base DN env: `BASE_DN` (or `LDAP_BASE_DN` / `BASE_OU`).

## [2026-02-15 12:59:12 WITA] Fix /finduser attribute parsing
- Change:
  - Fixed LDAP search entry parsing to use `ldapjs` SearchEntry `pojo.attributes`.
  - Improved field fallbacks (mail/telephoneNumber) and photo extraction.
- Reason:
  - Prevent blank/Unknown results when LDAP returns attributes but entry object parsing was wrong.
- Impact:
  - `/finduser` now renders user fields when returned by LDAP.

## [2026-02-15 13:03:33 WITA] Fix /finduser photo extraction
- Change:
  - Improved photo extraction to handle AD attribute variants (e.g. `thumbnailPhoto;binary`).
  - Added base64 decode fallback when binary buffers are not exposed.
- Reason:
  - Prevent false "No photo available" when photo exists in AD.
- Impact:
  - `/finduser <name> /photo` sends photos more reliably.

## [2026-02-15 13:13:00 WITA] Restore legacy DB photo lookup for /finduser
- Change:
  - Ported `getUserPhotoFromDB` logic from `reference/modules/db.js` into TypeScript.
  - `/finduser ... /photo` now falls back to SQL Server `CardDB.PHOTO` by `StaffNo`.
- Reason:
  - Legacy implementation loads photos from the database (not from LDAP attributes).
- Impact:
  - Uses existing env vars: `DB_USER`, `DB_PASSWORD`, `DB_SERVER`, `DB_DATABASE` (optional `DB_PORT`).

## [2026-02-15 13:24:09 WITA] Convert legacy ticket_handle module to TypeScript
- Change:
  - Ported `reference/modules/ticket_handle.js` into `src/features/integrations/ticketHandle.ts`.
  - Moved ServiceDesk base URL and token to env (`SD_BASE_URL`, `SERVICE_DESK_TOKEN`).
- Impact:
  - Added required dependencies for ServiceDesk + attachment analysis (axios, jsdom, pdf-parse, form-data, openai, tesseract.js, @google/generative-ai).

## [2026-02-15 13:32:59 WITA] Port technicianContacts to TypeScript and wire /technician command
- Change:
  - Added `src/features/integrations/technicianContacts.ts` to manage contacts stored in JSON.
  - Implemented `/technician` CRUD commands in WhatsApp handler.
- Impact:
  - Uses `DATA_DIR` if set; otherwise reads/writes `data/technicianContacts.json`.

## [2026-02-15 13:35:38 WITA] Move technician contacts default storage to data/
- Change:
  - Default technician contacts storage moved from `reference/` to `data/technicianContacts.json`.
- Impact:
  - Keeps reference folder for legacy-only; runtime now uses `data/` unless `DATA_DIR` is set.

## [2026-02-15 13:36:24 WITA] Ignore local technicianContacts.json from git
- Change:
  - Added `data/technicianContacts.json` to `.gitignore`.
- Reason:
  - Keep local operational data out of the repository.

## [2026-02-15 13:48:15 WITA] Port legacy /send-group-message HTTP endpoint
- Change:
  - Added `/send-group-message` route with optional document/image upload and mentions.
- Impact:
  - Supports `id` (group JID) or `name` (search by group subject) and JSON `mention` arrays.

## [2026-02-15 13:53:33 WITA] Fix /resetpassword authorization for group chats
- Change:
  - Updated `/resetpassword` requester detection to use the sender participant when invoked in group chats.
- Reason:
  - Group chat messages use a group JID (`@g.us`), so extracting the phone from the chat ID breaks authorization.
- Impact:
  - `/resetpassword` can be executed from group chats by numbers listed in `ALLOWED_PHONE_NUMBERS`.

## [2026-02-15 14:03:12 WITA] Fix LDAP resetPassword modification payload
- Change:
  - Updated LDAP `Change.modification` for `/resetpassword` to use Attribute-shaped objects (`{ type, values }`).
- Reason:
  - ldapjs `Change` requires `modification` to be an Attribute (or Attribute-shaped object), otherwise it throws `modification must be an Attribute`.
- Impact:
  - `/resetpassword` no longer fails early with the modification format error.

## [2026-02-15 14:05:14 WITA] Resolve resetPassword DN via LDAP search
- Change:
  - Updated `/resetpassword` to resolve the target user's DN by searching LDAP before modifying.
- Reason:
  - Using `CN=<username>` fails when the command input is `sAMAccountName` (e.g. `widji.santoso`), causing `No Such Object`.
- Impact:
  - `/resetpassword <sAMAccountName> ...` now targets the correct DN when `BASE_DN`/`LDAP_BASE_DN`/`BASE_OU` is set.

## [2026-02-15 14:07:21 WITA] Expand resetPassword lookup to match /finduser style
- Change:
  - Expanded `/resetpassword` user lookup to try exact and partial matches across common AD attributes.
- Reason:
  - Operators may provide displayName/CN fragments similar to `/finduser`, and exact `sAMAccountName` may differ from the provided identifier.
- Impact:
  - `/resetpassword` can resolve users via `sAMAccountName`, `userPrincipalName`, `mail`, `cn`, or `displayName` when the match is unique.

## [2026-02-15 14:09:28 WITA] Improve resetPassword lookup for AD email aliases
- Change:
  - Added lookup fallback for mail aliases like `first.last` by searching UPN/mail/proxyAddresses patterns.
  - Tightened search to `objectCategory=person` and `objectClass=user`.
- Reason:
  - Some environments use different `sAMAccountName` formats; operators often know the email alias instead.
- Impact:
  - `/resetpassword widji.santoso ...` can resolve accounts where UPN/mail is `widji.santoso@...`.

## [2026-02-15 14:03:17 WITA] Implement legacy ServiceDesk webhook in TypeScript HTTP server
- Change:
  - Added `/webhook` route to send WhatsApp notifications on new/updated ServiceDesk tickets.
  - Added ticket state storage (Redis when available, otherwise in-memory) to detect technician/status/priority changes.
  - Added ServiceDesk technician assignment helper via `PUT /requests/:id/assign`.
- Impact:
  - Requires `SD_BASE_URL` and `SERVICE_DESK_TOKEN` (already used by ServiceDesk integration).
  - Optional: `REDIS_HOST`/`REDIS_PORT` for persistent state across restarts; falls back to in-memory.

## [2026-02-15 14:14:55 WITA] Fix resetPassword DN extraction from LDAP search entries
- Change:
  - Updated DN extraction for `/resetpassword` lookup to use `ldapjs` SearchEntry `pojo.objectName`.
- Reason:
  - `SearchEntry.objectName` may not be a string in ldapjs, causing DN resolution to return zero matches.
- Impact:
  - `/resetpassword <sAMAccountName> ...` can correctly resolve the target DN and proceed with password reset.

## [2026-02-15 14:19:12 WITA] Add first-reaction ticket claim flow
- Change:
  - Stored the outbound WhatsApp message ID for each new ticket notification.
  - Added reaction handler to let the first technician claim a ticket.
  - Claim updates ServiceDesk status to `In Progress` and assigns the technician.
- Impact:
  - Requires `TICKET_REACTION_GROUP_IDS` (comma-separated group JIDs) to enable claiming.
  - Uses `REDIS_HOST`/`REDIS_PORT` when available for durable claim locking.

## [2026-02-15 14:19:28 WITA] Port legacy /getbitlocker command
- Change:
  - Added `/getbitlocker <hostname>` command to lookup BitLocker recovery keys via LDAP.
- Impact:
  - Requires `LDAP_BASE_DN` (or `BASE_DN` / `BASE_OU`) plus LDAP bind settings.

## [2026-02-15 14:22:18 WITA] Port legacy /getasset command
- Change:
  - Added `/getasset [type]` command backed by Snipe-IT API.
  - Added Snipe-IT integration module and category mapping.
- Impact:
  - Requires `SNIPEIT_URL` and `SNIPEIT_TOKEN`.

## [2026-02-15 14:23:12 WITA] Improve /getbitlocker message formatting
- Change:
  - Reformatted `/getbitlocker` WhatsApp output with clearer headings and key sections.

## [2026-02-15 14:27:34 WITA] Improve /getasset response formatting
- Change:
  - Reformatted `/getasset` output with a consistent header and aligned tables.

## [2026-02-15 14:31:20 WITA] Improve /technician response formatting
- Change:
  - Reformatted `/technician` list/search/view/add/update replies with aligned tables.

## [2026-02-15 14:31:17 WITA] Add Docker production setup
- Change:
  - Added Dockerfile and docker-compose.yml for production runs.
  - Added `DATA_DIR` support so Baileys auth/store/uploads persist under one mounted path.
- Impact:
  - `docker compose up --build` runs the service on port 8192.
  - Mounting `/data` persists `auth_info_baileys/`, `baileys_store.json`, `uploads/`, and `data/`.

## [2026-02-15 14:33:31 WITA] Persist repo ./data via docker-compose bind mount
- Change:
  - Updated docker-compose to mount `./data` into the container and use it as `DATA_DIR`.
- Impact:
  - Host path `./data` now persists Baileys auth/store/uploads and technician contacts.

## [2026-02-15 14:45:26 WITA] Fix Docker build stage missing package.json
- Change:
  - Copied `package.json` and `package-lock.json` into the Docker build stage.
- Reason:
  - `npm run build` needs `package.json` inside the build stage.

## [2026-02-15 16:07:36 WITA] Improve /technician list empty state
- Change:
  - `/technician list` now prints the technicianContacts.json storage path and add command usage when empty.

## [2026-02-15 16:06:59 WITA] Fix ticket claim reactions handled as messages
- Change:
  - Added support for ticket claim reactions arriving via `messages.upsert` reactionMessage.

## [2026-02-15 16:21:07 WITA] Skip ServiceDesk category AI on OpenAI auth errors
- Change:
  - Service category AI suggestion no longer fails the webhook when OpenAI returns 401.
  - Added `SERVICE_CATEGORY_AI_ENABLED=false` option to disable category AI.

## [2026-02-15 16:29:25 WITA] Standardize ticketing WhatsApp notifications
- Change:
  - Reformatted ServiceDesk Plus webhook notifications using consistent English labels and spacing.
  - Reformatted ticket claim reaction replies with consistent labels and outcomes.

## [2026-02-15 16:36:06 WITA] Improve ticket claim storage error visibility
- Change:
  - Ticket claim failures now include the underlying Redis error message when available.

## [2026-02-15 16:44:42 WITA] Stabilize ticket claim Redis and reaction sender detection
- Change:
  - Prevented Redis "already connecting/connected" errors by serializing connect attempts.
  - Improved reaction sender extraction to avoid mis-identifying the claimant number.

## [2026-02-15 16:54:18 WITA] Add toggle to disable requester notification on new tickets
- Change:
  - Added `NOTIFY_REQUESTER_NEW_TICKET=false` to skip requester WhatsApp message for new tickets.

## [2026-02-15 17:02:41 WITA] Add webhook control for requester notification on new tickets
- Change:
  - Added `notify_requester_new` field to `/webhook` payload to enable/disable requester notification per request.

## [2026-02-15 17:05:05 WITA] Remove env toggle for requester notification on new tickets
- Change:
  - Removed `NOTIFY_REQUESTER_NEW_TICKET` support; use `notify_requester_new` in webhook payload.

## [2026-02-15 17:13:47 WITA] Avoid treating bot as reaction claimant
- Change:
  - Skipped ticket-claim handling when the reaction participant resolves to the bot JID.

## [2026-02-15 17:18:21 WITA] Fix bot claimant detection for device and LID JIDs
- Change:
  - Resolved reaction participants before comparing to the bot user JID.
  - Supported device JID formats (e.g. `628xxx:device@s.whatsapp.net`) when extracting phone digits.

## [2026-02-15 17:26:08 WITA] Support unclaim when reaction removed
- Change:
  - Removing a claim reaction now clears the stored claim when removed by the original claimer.

## [2026-02-15 17:37:52 WITA] Revert ServiceDesk status and assignment on unclaim
- Change:
  - Ticket unclaim now reverts ServiceDesk status to Open and restores previous assignment when available.

## [2026-02-15 19:12:18 WITA] Apply service category suggestion on webhook new tickets
- Change:
  - Suggested service category is applied before sending new-ticket notifications.
  - Category updates no longer overwrite ictTechnician on webhook new.

## [2026-02-15 19:22:24 WITA] Document Docker rebuild for code changes
- Change:
  - Added Docker rebuild steps to avoid running an old baked image.

## [2026-02-15 20:06:04 WITA] Improve bot reactor detection in Docker
- Change:
  - Reaction sender picking now also skips bot JID when sock user is @c.us.
  - Added DEBUG_TICKET_REACTIONS toggle for diagnosing reaction participant formats.

## [2026-02-15 19:32:46 WITA] Port legacy message reply rules and media attachments
- Change:
  - Updated `messages.upsert` handling to reply to direct chats unless the message is a `/command`.
  - Updated group handling to reply only when the bot is tagged (text `@...` or `mentionedJid`).
  - Added inbound media downloading and base64 encoding for image/video/audio/document messages.
  - Extended N8N payload with optional `attachments` metadata and base64 content.

## [2026-02-15 19:40:32 WITA] Ensure users always get a reply from n8n flow
- Change:
  - Added legacy-style fallback reply when n8n response is empty or webhook fails.
  - Added legacy-style typing indicator support (`TYPING_ENABLED=true`) for n8n replies.
  - Added optional message buffering controls (`MESSAGE_BUFFER_ENABLED` and presence buffering flags).

## [2026-02-15 20:01:42 WITA] Match legacy n8n payload keys for compatibility
- Change:
  - Added legacy-compatible payload fields (`fromNumber`, `replyTo`, `messageType`, `mediaInfo`, `attachmentCount`).
  - Added mentioned JIDs extraction and forwarded into n8n payload.
