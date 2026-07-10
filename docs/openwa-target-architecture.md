# OpenWA Target Architecture

## Purpose
This document describes the recommended target architecture for migrating the current Baileys-based repository to OpenWA while preserving the current business features.

It is intentionally migration-oriented:
- keep the business layer stable
- isolate transport-specific behavior
- reduce rewrite risk

## Architecture Goal
Replace Baileys as the WhatsApp transport implementation without rewriting:
- command logic
- helpdesk workflows
- dispatcher automation
- LDAP, Snipe-IT, SharePoint, N8N, and OpenAI integrations

## Design Principle
The current repository should become an orchestration layer above a channel adapter.

That means:
- WhatsApp transport is an implementation detail
- business workflows must not depend directly on `sock.sendMessage()`, Baileys stores, or Baileys event shapes

## Current vs Target

### Current shape
- `src/features/whatsapp/start.ts` owns:
  - session lifecycle
  - inbound event handling
  - direct outbound sends
  - command routing
  - reaction handling
- HTTP routes and helpdesk code call Baileys socket methods directly or indirectly

### Target shape
- OpenWA becomes the WhatsApp engine
- this repository becomes:
  - API facade
  - workflow orchestrator
  - business rules host
  - integration hub

## Target Runtime Components

### 1. Channel Gateway Interface
Introduce an internal interface layer that represents channel capabilities without exposing engine-specific details.

Recommended services:

#### `SessionService`
Responsibilities:
- create session
- start session
- stop session
- query session status
- fetch QR code
- request pairing code

OpenWA mapping:
- `/api/sessions`
- `/api/sessions/{id}/start`
- `/api/sessions/{id}/stop`
- `/api/sessions/{id}/qr`
- `/api/sessions/{id}/pairing-code`

#### `MessagingService`
Responsibilities:
- send text
- send image
- send document
- send audio
- send video
- send bulk
- reply to message
- react to message

OpenWA mapping:
- `/messages/send-text`
- `/messages/send-image`
- `/messages/send-document`
- `/messages/send-audio`
- `/messages/send-video`
- `/messages/send-bulk`
- `/messages/reply`
- `/messages/react`

#### `DirectoryService`
Responsibilities:
- check if number exists
- resolve contact id to phone number
- list contacts
- list groups
- resolve group by subject or configured alias

OpenWA mapping:
- `/contacts/check/{number}`
- `/contacts/{contactId}/phone`
- `/contacts`
- `/groups`

#### `EventIngestService`
Responsibilities:
- receive OpenWA webhooks
- normalize webhook payloads into internal events
- publish canonical events for:
  - inbound messages
  - reactions
  - session state changes

OpenWA mapping:
- session-scoped webhooks under `/api/sessions/{sessionId}/webhooks`

## Canonical Internal Event Model
The business layer should only depend on canonical events, not OpenWA payload shapes.

Recommended internal event types:

### `InboundMessageEvent`
Fields:
- `sessionId`
- `chatId`
- `senderId`
- `senderPhone`
- `isGroup`
- `groupId`
- `messageId`
- `text`
- `mentions`
- `quotedMessageId`
- `hasMedia`
- `mediaMeta`
- `receivedAt`

Used by:
- command router
- N8N bridge
- reply gateway

### `ReactionEvent`
Fields:
- `sessionId`
- `chatId`
- `messageId`
- `senderId`
- `senderPhone`
- `emoji`
- `removed`
- `receivedAt`

Used by:
- ticket claim flow

### `SessionStatusEvent`
Fields:
- `sessionId`
- `status`
- `reason`
- `qrAvailable`
- `occurredAt`

Used by:
- web UI
- operator visibility
- recovery logic

## Business Layer Boundaries

### Layer A: Channel Adapter Layer
Owns:
- OpenWA HTTP calls
- OpenWA API key handling
- OpenWA-specific retries
- webhook subscription management
- payload normalization

Should not own:
- LDAP logic
- ServiceDesk logic
- command authorization rules
- dispatcher decisions

### Layer B: Application Workflow Layer
Owns:
- command routing
- helpdesk notification flow
- ticket claim flow
- reply gateway logic
- N8N forwarding

Should depend only on canonical interfaces and canonical events.

### Layer C: Integration Layer
Owns:
- LDAP / AD
- Snipe-IT
- ServiceDesk
- SharePoint / Graph
- OpenAI / Gemini
- N8N upstream/downstream contract

This layer should remain unchanged as much as possible.

## Recommended HTTP Shape for This Repository
The current repository can keep its existing external API, while internally calling OpenWA.

Example:
- current `POST /send-message`
  - stays as-is externally
  - internally calls `MessagingService.sendText()` or `sendImage()`
- current `POST /webhook`
  - stays as ServiceDesk ingress
  - internally calls channel adapter for outbound notifications

Recommended new internal/admin routes:
- `POST /channel/sessions/:id/start`
- `POST /channel/sessions/:id/stop`
- `GET /channel/sessions/:id/qr`
- `GET /channel/sessions/:id/status`
- `POST /channel/webhooks/openwa`

These routes do not have to be public-facing, but they help separate operator flows from business flows.

## Group and Contact Resolution Strategy
The current app supports sending to groups by subject name. That behavior should not depend on live search every time.

Recommended strategy:
1. maintain a cached group directory per session
2. allow explicit config-based aliases for critical groups
3. use subject matching only as fallback

Why:
- group subjects can change
- transport APIs may differ in matching behavior
- helpdesk and dispatcher flows need predictable routing

## State and Persistence Strategy

### Keep
- `technicianContacts.json`
- SharePoint token cache
- leave schedule XLSX
- ticket claim store and webhook state storage
- Redis-based locking and state where already useful

### De-emphasize or remove
- Baileys auth folder ownership as a business concern
- Baileys local message store as the primary truth for channel state

### Add
- session-to-OpenWA mapping metadata if needed
- webhook subscription registry if not fully delegated to OpenWA
- optional cached group/contact snapshots per session

## Security Model
Recommended target security split:

### Between this app and OpenWA
- use `X-API-Key`
- scope API keys to required sessions only
- optionally restrict by IP at OpenWA level too

### For this app's existing APIs
- keep existing `ALLOWED_IPS` middleware for inbound HTTP routes
- keep phone-based command authorization
- keep LAPS-specific authorization model

## Observability Model
Recommended sources of truth:
- application logs from this repository for workflow decisions
- OpenWA audit and session status for channel-level evidence

Recommended additions:
- attach `sessionId` to every outbound and inbound workflow log
- log canonical event ids
- log OpenWA message id after every outbound send used by claimable helpdesk messages

## Migration Sequence

### Phase 1: Introduce adapter boundary
- create `SessionService`, `MessagingService`, `DirectoryService`, `EventIngestService`
- keep Baileys implementation underneath temporarily

### Phase 2: Route outbound flows through the adapter
- `/send-message`
- `/send-bulk-message`
- `/send-group-message`
- helpdesk `/webhook`
- dispatcher notification sender
- command replies

### Phase 3: Route inbound flows through canonical events
- command handling
- N8N forwarding
- reply gateway
- session/web UI updates

### Phase 4: Migrate reaction workflows
- ticket notification id storage
- claim/unclaim logic
- reaction event normalization

### Phase 5: Remove Baileys-coupled runtime pieces
- direct socket lifecycle ownership
- Baileys-specific store dependence
- MACOS patch operational dependency

## Early Acceptance Criteria
The target architecture is ready only when all of the following are true:

1. A ticket notification sent via the app can still be claimed by reaction.
2. Slash commands behave the same in private and group contexts.
3. N8N receives stable inbound payloads with sender/chat/message identity preserved.
4. Operators can authenticate a session using QR without touching Baileys internals.
5. Dispatcher and helpdesk flows can send notifications without direct socket access.

## Final Recommendation
The cleanest target is not:
"rewrite the app around OpenWA."

The cleanest target is:
"keep the app, replace the transport, formalize the boundary."

That architecture gives the project:
- lower migration risk
- easier testing
- better multi-session operations
- less coupling to a single WhatsApp engine
