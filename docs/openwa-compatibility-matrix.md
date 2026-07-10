# OpenWA Compatibility Matrix

## Purpose
This document evaluates whether the current Baileys-based WhatsApp gateway can be migrated to OpenWA API `0.7.17` (`http://10.60.10.59:2785/api/docs#/`) without losing the current business features.

The goal is not only "can OpenWA send messages", but "can this repository keep its current operational behavior" across:
- session lifecycle
- inbound event handling
- command execution
- helpdesk and dispatcher flows
- integrations such as LDAP, Snipe-IT, SharePoint, N8N, and OpenAI

## Scope
This matrix is based on:
- current repository behavior in `src/index.ts`
- WhatsApp runtime and commands in `src/features/whatsapp/start.ts`
- HTTP routes in `src/features/http/routes/messages.ts`
- dispatcher behavior in `src/features/dispatcher/helpdeskDispatcher.ts`
- OpenWA API spec from `/api/docs-json`

## Verdict
OpenWA is a strong candidate to replace Baileys as the WhatsApp transport layer for this project.

The migration is realistic because most of this repository's value is not in Baileys itself. The value is in:
- command orchestration
- helpdesk workflow logic
- dispatcher rules
- external system integrations
- operational controls

Those parts can stay. The main migration work is building an OpenWA adapter that replaces direct socket calls and normalizes webhook payloads into the event shape the current app expects.

## Status Legend
- `Native`: OpenWA has direct first-class support.
- `Adapter`: OpenWA supports it, but this repo needs an adapter/mapping layer.
- `Partial`: partly supported, but behavior or payload parity still needs validation.
- `Gap`: no clear support found in the current OpenWA spec.

## Capability Matrix
| Domain | Current repo behavior | OpenWA support | Status | Migration notes |
| --- | --- | --- | --- | --- |
| Session create/list/delete | Today the app relies on local Baileys auth folders and process lifecycle. | `/api/sessions`, `/api/sessions/{id}`, delete/list/create are available. | `Native` | Session lifecycle can move from filesystem-first to API-managed sessions. |
| Session start/stop/recover | Current startup is handled in-process by `startWhatsApp()`. | `/api/sessions/{id}/start`, `/stop`, `/force-kill` are available. | `Native` | Operational runbook can target OpenWA session endpoints instead of container restarts for many cases. |
| QR authentication | Web UI currently waits for Baileys `connection.update.qr`. | `/api/sessions/{id}/qr` returns QR as data URL. | `Native` | Cleaner than current socket-event dependency. |
| Pairing code | Current repo has optional `WA_PAIRING_PHONE`. | `/api/sessions/{id}/pairing-code` is available. | `Native` | Keep as optional capability; no need to depend on it for QR-first flow. |
| Session state monitoring | Current code listens to `connection.update` and close reasons. | Webhooks include `session.status`, `session.qr`, `session.authenticated`, `session.disconnected`. | `Adapter` | Build a session-event mapper so the web UI and reconnection logic consume a stable internal event model. |
| Multi-session / multi-number | Current multi-instance design uses separate containers, ports, and `DATA_DIR`. | OpenWA exposes first-class session objects plus overview stats. | `Native` | Likely simplifies multi-number operations; each number becomes a named session instead of a separate Node runtime. |
| Send text | Used in commands, helpdesk, dispatcher, and API routes. | `/messages/send-text` | `Native` | Straight mapping. |
| Send image | Used in `/send-message` and some command replies. | `/messages/send-image` | `Native` | Straight mapping. |
| Send document | Used in `/send-group-message`. | `/messages/send-document` | `Native` | Straight mapping. |
| Send audio / voice | Current repo already handles audio-related flows for N8N media replies. | `/messages/send-audio` with `ptt` flag | `Native` | Better than current custom handling because PTT is explicit. |
| Send video | Needed for richer automation parity. | `/messages/send-video` | `Native` | Straight mapping. |
| Send location/contact/sticker | Not core to current flows, but useful future parity. | Dedicated endpoints exist. | `Native` | Extra upside, not a blocker. |
| Reply to a specific message | Current repo mostly sends fresh messages; quoted replies are useful for UX parity. | `/messages/reply` | `Native` | Good fit for future UX improvement and some helpdesk replies. |
| Forward message | Not central today. | `/messages/forward` | `Native` | Optional future use. |
| React to a message | Current ticket-claim flow depends on reactions. | `/messages/react` and `/messages/{chatId}/{messageId}/reactions` | `Native` | Important enabler for helpdesk claim flow. |
| Delete message/chat | Not a major current flow. | Message delete and chat delete endpoints exist. | `Native` | Operational bonus, not migration-critical. |
| Bulk outbound messaging | Current `/send-bulk-message` loops in app code with random delay. | `/messages/send-bulk` with async batch status/cancel | `Native` | OpenWA is stronger here; existing route can become a compatibility wrapper. |
| Group messaging | Current `/send-group-message` supports group id or subject-name lookup plus mentions and attachments. | Group send works via normal chat IDs; group list endpoints exist. | `Adapter` | Keep app-side name-to-group resolution if user still wants subject-based sends. |
| Group list and metadata | Current code uses `groupFetchAllParticipating()` and local subject matching. | `/groups`, `/groups/{groupId}` | `Native` | Needed for subject lookup cache and admin operations. |
| Contact listing | Current store keeps contact info opportunistically from Baileys events. | `/contacts`, `/contacts/{contactId}` | `Native` | Can replace or enrich local store behavior. |
| Check whether number exists on WhatsApp | Current repo uses `sock.onWhatsApp()`. | `/contacts/check/{number}` | `Native` | Direct replacement for registered-number checks in `/send-message`. |
| Resolve `@lid` to phone | Current repo needs this for authorization and JID normalization. | `/contacts/{contactId}/phone` explicitly resolves `@lid` best-effort. | `Native` | This is a key migration win because the current project already needs LID-safe behavior. |
| Inbound message receive | Current repo parses `messages.upsert` into commands vs automation. | Webhooks support `message.received`. | `Adapter` | Need a canonical inbound-event mapper so command parsing stays untouched above the adapter layer. |
| Inbound reaction receive | Current ticket claim/unclaim listens to `messages.reaction` and reaction message info. | Webhooks support `message.reaction`. | `Adapter` | Need to verify webhook payload includes enough fields for `chatId`, `messageId`, sender, and removed-reaction semantics. |
| Delivery/ack events | Helpful for diagnostics and future reliability. | Webhooks support `message.sent`, `message.ack`, `message.failed`, `message.revoked`. | `Partial` | Likely enough for observability, but current app does not yet model a full delivery state machine. |
| History retrieval | Current repo persists some local messages/store state. | `/messages`, `/messages/{chatId}/history` exist. | `Partial` | Good for backfill and diagnostics. Need validation if history shape matches current assumptions, especially for media. |
| Inbound media workflows | Current repo forwards some media to N8N and may analyze ticket attachments outside WhatsApp. | History API can include media; send-media is strong. | `Partial` | Need real webhook sample validation for inbound media payloads and download strategy. |
| Private reply gateway | Current repo decides `reply`, `no_reply`, or `mute` for private chats, then sends via Baileys. | Webhook receive + send-text + contact block/unblock are available. | `Adapter` | Business logic can stay. Only channel adapter changes. |
| `/unmute` and local mute state | Current repo stores mute state internally. | No channel dependency beyond receiving a command and sending a reply. | `Adapter` | Keep as application state, not OpenWA state. |
| Slash commands in private/group chat | `/finduser`, `/resetpassword`, `/unlock`, `/getasset`, `/getbitlocker`, `/getlaps`, `/getlapsdiag`, `/setlaps`, `/technician`, license commands, etc. | OpenWA can deliver inbound messages and send replies. | `Adapter` | Commands are mostly transport-agnostic. They should survive with minimal business logic change. |
| Helpdesk `/webhook` receiver notification | Current route sends ticket messages to group/requester/technician. | OpenWA can send all required outbound message types. | `Adapter` | HTTP route can remain almost identical after replacing direct socket sends with OpenWA send calls. |
| Reaction-based ticket claim | Current flow stores outbound message id and watches reactions for first-claim logic. | OpenWA supports reactions, reaction lookup, and reaction webhook events. | `Adapter` | One of the most important validations: confirm OpenWA webhook message identifiers remain stable enough for claim-store correlation. |
| Helpdesk dispatcher notifications | Dispatcher sends direct messages based on routing decisions. | OpenWA outbound APIs are sufficient. | `Adapter` | Dispatcher should call an internal gateway abstraction, not Baileys or OpenWA directly. |
| Auto category suggestion via OpenAI | Current route calls OpenAI, then updates ServiceDesk and notifies WhatsApp. | Not a WhatsApp concern; OpenWA only needs to deliver output messages. | `Native` | No migration risk at the business layer. |
| N8N conversational automation | Current repo forwards inbound messages to N8N and relays text/media replies. | Webhook receive + send endpoints are sufficient. | `Adapter` | Need payload normalization for sender/chat/message/media fields before posting to N8N. |
| Technician directory and leave mapping | Stored in local JSON and used by dispatcher/LAPS access checks. | Not channel-dependent. | `Native` | Keep in current app storage unless deliberately redesigned. |
| SharePoint token cache / leave schedule download | Used by dispatcher, independent from WhatsApp transport. | Not channel-dependent. | `Native` | No migration impact. |
| LDAP / AD flows | `/finduser`, `/resetpassword`, `/unlock`, `/getbitlocker`, `/getlaps` stay in app logic. | Not channel-dependent. | `Native` | No migration impact beyond inbound/outbound message transport. |
| Snipe-IT license and asset flows | `/getasset`, `/licenses`, `/getlicense`, `/expiring`, `/licensereport` stay in app logic. | Not channel-dependent. | `Native` | No migration impact beyond transport. |
| IP/API-key security | Current app uses `ALLOWED_IPS`; OpenWA requires `X-API-Key` and supports API-key scoping. | API key, session scoping, IP restrictions, auth validation endpoints are available. | `Native` | Stronger than current model. Existing gateway should add OpenWA credential handling. |
| Audit logging | Current repo logs locally. | `/api/audit` provides structured audit records. | `Native` | Useful for operations and future governance docs. |
| Infra health/ready/status | Current repo relies on container logs and process checks. | Health, readiness, infra status, engine info, stats endpoints are available. | `Native` | Operationally better than raw Baileys-only troubleshooting. |
| Plugin/engine extensibility | Current repo patches Baileys manually today. | OpenWA exposes plugin and engine management APIs. | `Partial` | Promising, but not required for first migration phase. |

## What Can Stay Unchanged
These layers should remain mostly intact:
- Express HTTP routes
- command handlers and business rules
- LDAP, Snipe-IT, ServiceDesk, SharePoint, OpenAI, N8N integrations
- dispatcher decision logic
- technician contact storage
- LAPS authorization model

In other words, the migration should avoid rewriting the app from scratch.

## What Must Change
The Baileys-specific transport layer should be isolated behind an OpenWA adapter.

Recommended internal adapter surface:
- `SessionService`
  - `createSession`
  - `startSession`
  - `stopSession`
  - `getQrCode`
  - `requestPairingCode`
  - `getSessionStatus`
- `MessagingService`
  - `sendText`
  - `sendImage`
  - `sendDocument`
  - `sendAudio`
  - `sendVideo`
  - `sendBulk`
  - `reply`
  - `react`
- `DirectoryService`
  - `checkNumber`
  - `resolvePhoneFromContactId`
  - `listGroups`
  - `findGroupBySubject`
  - `listContacts`
- `EventIngestService`
  - normalize OpenWA webhook payloads into the app's internal message and reaction event shape

## Best Migration Strategy
1. Keep the current app as the orchestration layer.
2. Replace direct `sock.*` usage with an internal gateway interface.
3. Implement that gateway first with Baileys-compatible behavior, then add an OpenWA implementation.
4. Move inbound event handling from Baileys listeners to OpenWA webhooks.
5. Keep the current command, helpdesk, dispatcher, and integration code above that adapter boundary.

This approach lets us migrate channel infrastructure without forcing a full rewrite of the business layer.

## Highest-Risk Items To Validate Early
These should be tested before committing to a full migration:

1. `message.reaction` webhook payload fidelity
   - Confirm sender, chat id, message id, and reaction removal are all present and stable.

2. Inbound message payload parity
   - Confirm group/private context, mentions, quoted message metadata, and media references are available in the webhook body.

3. Message id correlation
   - Confirm outbound message ids returned by OpenWA can be matched later when reaction events arrive.

4. Group subject resolution
   - Confirm current "send by group name" UX can be preserved by caching `/groups` output or defining a stricter config-driven mapping.

5. Media download path
   - Confirm the repo can still support N8N/media workflows without depending on Baileys-only media helpers.

6. Session persistence and restart behavior
   - Validate how OpenWA sessions recover after host restart, container restart, or force-kill.

## Recommended Conclusion
The project is replicable on top of OpenWA, including helpdesk-oriented features, with one important condition:

Do not treat the migration as a rewrite of business features. Treat it as a channel-adapter replacement.

That means the next documentation stack should be derived in this order:
1. capability matrix
2. canonical feature inventory
3. target architecture with adapter boundary
4. feature specifications per domain
5. user and operator workflows
6. migration phases and cutover plan

This matrix is the baseline for those next documents.
