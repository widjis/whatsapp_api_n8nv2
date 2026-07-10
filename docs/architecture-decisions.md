# Architecture Decisions

## Purpose
This document captures the current runtime architecture and the main engineering decisions behind this repository.

It complements:
- `README.md` for project onboarding
- `docs/helpdesk_dispatcher.md` for dispatcher-specific design
- `docs/deployment-and-environment.md` for deployment and configuration
- `docs/operational-runbook.md` for day-2 operations

## System Overview
This repository is a WhatsApp automation gateway built around three primary capabilities:

1. WhatsApp connectivity through Baileys
2. HTTP endpoints for outbound messaging and external webhooks
3. Back-office integrations for helpdesk, LDAP/Active Directory, Snipe-IT, N8N, and SharePoint

The project can run as:
- a single combined gateway process from `src/index.ts`
- a dispatcher-focused process from `src/dispatcher.ts`
- multiple independent Docker services, one per WhatsApp number

## Main Runtime Components

### 1. Express + Socket.IO server
Entrypoint: `src/index.ts`

Responsibilities:
- load environment variables
- resolve `DATA_DIR` and storage paths
- serve the simple web UI from `index.html`
- expose HTTP routes from `src/features/http/routes/messages.ts`
- serve uploaded files from `/uploads`
- start the WhatsApp client
- start the optional helpdesk dispatcher
- start the optional SharePoint leave schedule download scheduler

### 2. WhatsApp client
Entrypoint: `src/features/whatsapp/start.ts`

Responsibilities:
- create and maintain the Baileys socket
- persist auth state under `auth_info_baileys`
- emit QR / status updates to the web UI through Socket.IO
- receive inbound WhatsApp messages
- route slash commands to internal integrations
- forward non-command chats to N8N when enabled

### 3. HTTP routes
Implementation: `src/features/http/routes/messages.ts`

Responsibilities:
- `POST /send-message`
- `POST /send-bulk-message`
- `POST /webhook`
- request validation and outbound send orchestration

### 4. Helpdesk dispatcher
Implementation: `src/features/dispatcher/helpdeskDispatcher.ts`

Responsibilities:
- scan ServiceDesk tickets on a schedule
- assign group / ICT technician
- notify WhatsApp recipients through the local HTTP gateway
- produce structured logs and heartbeat output

The dispatcher is logically separate from the gateway, even when both run in the same process.

## Storage Model
The runtime depends on a writable `DATA_DIR`.

Important files under `DATA_DIR`:
- `auth_info_baileys/` for WhatsApp auth state
- `baileys_store.json` for in-memory store persistence
- `uploads/` for uploaded files and generated media
- `sharepoint_token_cache.json` or the configured `SHAREPOINT_TOKEN_CACHE_PATH`
- `technicianContacts.json`
- leave schedule XLSX files

Design decision:
- Each WhatsApp instance must have its own `DATA_DIR`
- No two live instances should share the same `auth_info_baileys`

## Multi-Instance Model
Multi-number deployment is implemented as multiple services from the same codebase.

Current example:
- `whatsapp-api-8192`
- `whatsapp-api-8193`

Design decisions:
- same image, different environment overrides
- same code, different `PORT`
- same code, different host volume
- one WhatsApp number per service

This keeps operational behavior predictable while avoiding duplicated codebases.

## Integration Boundaries

### LDAP / Active Directory
Implementation: `src/features/integrations/ldap.ts`

Used for:
- `/resetpassword`
- `/unlock`
- `/finduser`
- `/getbitlocker`
- `/getlaps`
- `/getlapsdiag`

Decision:
- authorization is enforced in the WhatsApp layer before privileged actions execute
- LDAP lookups remain in a dedicated integration module

### N8N
Implementation: `src/features/integrations/n8n.ts`

Used for:
- AI / automation chat forwarding
- external workflow response handling

Decision:
- N8N handling is optional and fully env-gated
- normal chat automation should be separable from command-only deployments

### Snipe-IT
Implementation: `src/features/integrations/snipeIt.ts`

Used for:
- asset lookup
- license lookup
- license reports and expiry commands

### ServiceDesk
Implementation:
- `src/features/integrations/ticketHandle.ts`
- `src/features/dispatcher/helpdeskDispatcher.ts`
- webhook routes in `src/features/http/routes/messages.ts`

Used for:
- ticket lookup and mutation
- dispatcher-driven assignment
- webhook-triggered WhatsApp notifications

### SharePoint / Microsoft Graph
Implementation: `src/sharepointDownloadLeaveSchedule.ts`

Used for:
- leave schedule XLSX download
- dispatcher leave filtering support

## WhatsApp Connection Decisions

### Socket lifecycle
The gateway treats WhatsApp connection state as a first-class operational concern.

Important behavior:
- status updates are emitted to the web UI
- reconnect attempts are bounded and use backoff
- certain disconnect scenarios are treated as requiring re-auth

### Auth persistence
Baileys multi-file auth state is stored under:
- `<DATA_DIR>/auth_info_baileys`

Decision:
- session reset is performed by deleting that folder only
- other runtime files under `DATA_DIR` should remain intact unless a full cleanup is intended

### Baileys MACOS platform patch
Repository script:
- `scripts/patch-baileys-macos.mjs`

Decision:
- the repository applies a `postinstall` patch to Baileys validate-connection behavior so QR generation remains available on current protocol behavior
- this patch is part of the runtime contract and must remain active after fresh installs and Docker builds

## Operational Separation Pattern
This repository supports a practical split into two app roles:

### AI chatbot instance
Typical traits:
- N8N enabled
- reply gateway enabled
- dispatcher disabled
- isolated WhatsApp number

### Operations / notification instance
Typical traits:
- command handling enabled
- dispatcher enabled as needed
- AI features disabled or limited
- isolated WhatsApp number

Decision:
- separation is achieved by configuration, not by maintaining two repos

## Security and Access Model Summary
Current access control relies mainly on:
- `ALLOWED_IPS` for HTTP routes
- `ALLOWED_PHONE_NUMBERS` for selected admin commands
- `LAPS_ADMIN_PHONE_NUMBERS` plus technician flags for LAPS actions
- environment-provided credentials for LDAP, Snipe-IT, ServiceDesk, and Microsoft Graph

This repo currently uses environment-based secret management and container/runtime isolation rather than a centralized secret manager.

## Known Architecture Constraints
- Baileys connectivity can be sensitive to WhatsApp protocol changes and server environment characteristics
- one WhatsApp number cannot be shared by two active instances
- dispatcher availability does not imply WhatsApp connectivity; the dispatcher can keep running while message delivery fails
- many integrations are env-driven and fail at runtime if credentials are missing or invalid

## Recommended Future Documents
If the repository grows further, the next useful source-of-truth documents would be:
- `docs/security-and-access-model.md`
- `docs/integration-contracts.md`
- `docs/testing-strategy.md`
