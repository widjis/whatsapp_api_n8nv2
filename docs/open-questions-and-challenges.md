# Open Questions and Challenges

## Purpose
This document records unresolved ambiguity, validation gaps, and risks that should not be silently assumed away during the OpenWA migration.

## Current Open Questions

### OQ-01 Real payload shape for `message.received`
Status:
- Open

Why it matters:
- command routing
- private vs group detection
- mentions
- quoted message handling
- N8N payload normalization

What is still unknown:
- exact field names for sender, chat, text, quoted message, and media metadata

Evidence needed:
- real webhook payload sample captured from OpenWA

### OQ-02 Real payload shape for `message.reaction`
Status:
- Open

Why it matters:
- reaction-based ticket claim
- reaction-based unclaim
- actor identification
- dedupe key generation

What is still unknown:
- exact field names for target `messageId`
- exact field names for target `chatId`
- whether sender identity is always directly available

Evidence needed:
- real webhook payload samples for both claim and unclaim scenarios

### OQ-03 Reaction removal semantics
Status:
- Open

Why it matters:
- the current repo distinguishes claim vs unclaim by reaction text presence/removal

What is still unknown:
- whether OpenWA represents removed reactions as empty string, null, missing field, or a distinct event shape

Evidence needed:
- captured removal payload from real session

### OQ-04 Outbound `messageId` correlation stability
Status:
- Open

Why it matters:
- new ticket notification must store a message identifier that can later be matched to a reaction event

What is still unknown:
- whether OpenWA outbound send response `messageId` matches the identifier later returned by `message.reaction`

Evidence needed:
- send a real notification through OpenWA
- react to the exact notification
- compare stored outbound id vs inbound reaction target id

### OQ-05 Inbound media delivery model
Status:
- Open

Why it matters:
- conversational automation
- future media workflows
- parity with current attachment-aware handling

What is still unknown:
- whether webhook payloads include direct media URLs, IDs, metadata only, or require additional history fetches

Evidence needed:
- real inbound image/video/audio/document webhook samples

### OQ-06 Session event payload detail
Status:
- Open

Why it matters:
- operator UI
- QR visibility
- status handling
- disconnect diagnostics

What is still unknown:
- which fields are present on `session.status`, `session.qr`, `session.authenticated`, and `session.disconnected`
- whether QR event includes enough data to drive current UI directly or whether the app must call `GET /sessions/{id}/qr`

Evidence needed:
- real captured session webhook events

### OQ-07 Webhook secret/signature format
Status:
- Open

Why it matters:
- inbound webhook authenticity verification

What is still unknown:
- exact signature header names
- exact signing algorithm and payload canonicalization rules

Evidence needed:
- real OpenWA webhook with secret enabled
- provider documentation or observed headers

### OQ-08 Group subject resolution robustness
Status:
- Open

Why it matters:
- current repo supports sending to groups by subject name
- operational workflows rely on stable group targeting

What is still unknown:
- whether group subject matching from cached `/groups` data is sufficient for current operator expectations
- whether explicit alias mapping is required for production reliability

Evidence needed:
- validate real group list data and naming consistency

### OQ-09 Multi-session operating model
Status:
- Open

Why it matters:
- the current repo operationally uses one container per number
- OpenWA introduces first-class sessions

What is still unknown:
- whether current operational responsibilities should remain one-app-per-role or move to a more centralized multi-session model

Evidence needed:
- decide after validating session isolation, auth recovery, and operational complexity

## Current Challenges

### CH-01 Helpdesk claim flow is migration-critical
Severity:
- High

Risk:
- if claim/unclaim cannot be preserved, one of the most valuable operational workflows regresses

Current posture:
- do not declare the migration safe until reaction correlation is proven

### CH-02 Published spec is not enough for event migration
Severity:
- High

Risk:
- the OpenAPI spec confirms event names and endpoints, but not the exact webhook payload fields required by this repository

Current posture:
- event ingestion implementation must be gated by real payload evidence

### CH-03 Avoid mixing business logic rewrite with transport migration
Severity:
- High

Risk:
- rewriting command/helpdesk/dispatcher logic during transport change increases regression surface dramatically

Current posture:
- preserve business workflows and isolate transport behind adapter boundary

### CH-04 Operator workflow must remain simple
Severity:
- Medium

Risk:
- a technically correct migration may still fail operationally if QR/auth/session workflows become harder to operate

Current posture:
- preserve operator-oriented readiness, QR visibility, and troubleshooting clarity

## Resolution Tracking

When an item is resolved:
- change `Status` from `Open` to `Resolved`
- add the confirming evidence source
- update the affected docs such as:
  - `docs/openwa-integration-contracts.md`
  - `docs/feature-specifications.md`
  - `docs/user-and-operator-workflows.md`
  - `docs/implementation-roadmap.md`
