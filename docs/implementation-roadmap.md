# Implementation Roadmap

## Status
- Active program: OpenWA migration foundation
- Current phase: Phase 1

## Phase 1 - Validate OpenWA Event Assumptions

### Objective
Confirm the real runtime payloads and operational semantics required before building the OpenWA adapter.

### Source documents
- `docs/openwa-compatibility-matrix.md`
- `docs/openwa-integration-contracts.md`
- `docs/feature-specifications.md`
- `docs/user-and-operator-workflows.md`
- `docs/open-questions-and-challenges.md`

### Checklist
- [ ] Capture real `message.received` webhook payload
- [ ] Capture real `message.reaction` webhook payload
- [ ] Confirm reaction removal representation
- [ ] Confirm outbound `messageId` can be matched against later reaction events
- [ ] Confirm session event payloads for `session.status`, `session.qr`, `session.authenticated`, and `session.disconnected`
- [ ] Confirm webhook signature/header behavior if secret mode is enabled
- [ ] Confirm inbound media payload structure and download strategy

### Output
- Validated OpenWA payload samples
- Updated event normalization rules
- Reduced ambiguity for adapter implementation

### Challenge / verification
- Store or summarize captured payload evidence
- Mark each assumption as confirmed or rejected in `docs/open-questions-and-challenges.md`
- Do not close this phase without real payload evidence

## Phase 2 - Introduce Channel Adapter Boundary

### Objective
Refactor the repository so business workflows depend on internal channel interfaces rather than Baileys-specific calls.

### Source documents
- `docs/openwa-target-architecture.md`
- `docs/openwa-integration-contracts.md`
- `docs/feature-specifications.md`
- `docs/dispatcher-feature-specification.md`

### Checklist
- [ ] Introduce `SessionService` abstraction
- [ ] Introduce `MessagingService` abstraction
- [ ] Introduce `DirectoryService` abstraction
- [ ] Introduce canonical internal event types
- [ ] Route current outbound sends through adapter interfaces
- [ ] Keep Baileys as the temporary underlying implementation for regression safety

### Output
- Adapter boundary exists in code
- Business logic is no longer directly coupled to raw socket calls

### Challenge / verification
- Typecheck/build passes
- Existing `/send-message`, `/send-group-message`, `/webhook`, and command replies still behave the same
- No user-visible behavior regressions for Baileys-backed runtime

## Phase 3 - Implement OpenWA Outbound Integration

### Objective
Implement OpenWA as a working outbound transport behind the new adapter boundary.

### Source documents
- `docs/openwa-integration-contracts.md`
- `docs/openwa-target-architecture.md`
- `docs/feature-specifications.md`

### Checklist
- [ ] Implement OpenWA API client with `X-API-Key`
- [ ] Implement session lifecycle methods
- [ ] Implement outbound send methods for text, image, document, audio, video, reply, bulk, and react
- [ ] Implement contact and group lookup methods
- [ ] Add provider-level error translation into app-level error categories

### Output
- Outbound transport can use OpenWA for the supported operations

### Challenge / verification
- Verify send-text, send-document, and send-bulk against a real OpenWA session
- Confirm number lookup and group lookup work for the current operational needs
- Record mismatches in `docs/open-questions-and-challenges.md`

## Phase 4 - Implement OpenWA Webhook Ingestion

### Objective
Replace Baileys-driven inbound event handling with canonical events produced from OpenWA webhooks.

### Source documents
- `docs/openwa-integration-contracts.md`
- `docs/user-and-operator-workflows.md`
- `docs/feature-specifications.md`

### Checklist
- [ ] Register and manage OpenWA session webhooks
- [ ] Implement webhook ingress endpoint in this repository
- [ ] Normalize inbound message events into canonical format
- [ ] Normalize reaction events into canonical format
- [ ] Normalize session state events into canonical format
- [ ] Route normalized events into existing business workflows

### Output
- Inbound workflow path no longer depends on Baileys listeners

### Challenge / verification
- Slash commands still work in private and group contexts
- Conversational automation still reaches N8N correctly
- Session UI still receives usable status and QR signals

## Phase 5 - Preserve Helpdesk Claim and Dispatcher Workflows

### Objective
Prove that the most sensitive operational workflows still work correctly on the new transport.

### Source documents
- `docs/feature-specifications.md`
- `docs/dispatcher-feature-specification.md`
- `docs/user-and-operator-workflows.md`
- `docs/openwa-integration-contracts.md`

### Checklist
- [ ] Verify new ticket notification still stores claimable outbound message ids
- [ ] Verify first-reaction claim still works
- [ ] Verify unclaim by reaction removal still works
- [ ] Verify dispatcher notifications still send correctly through the adapter
- [ ] Verify group/name lookup behavior remains acceptable

### Output
- Helpdesk and dispatcher workflows are preserved on OpenWA

### Challenge / verification
- Capture pre-fix vs post-migration evidence for claim/unclaim workflow
- Validate dispatcher direct notifications and digest behavior
- Record any remaining gaps explicitly

## Phase 6 - Cut Over and Retire Baileys-Coupled Runtime

### Objective
Complete the migration and remove transport-specific operational debt that is no longer needed.

### Source documents
- `docs/openwa-target-architecture.md`
- `docs/deployment-and-environment.md`
- `docs/operational-runbook.md`
- `docs/open-questions-and-challenges.md`

### Checklist
- [ ] Switch the active production flow to OpenWA-backed adapter
- [ ] Update deployment docs and runbook
- [ ] Remove or isolate obsolete Baileys-specific operational steps
- [ ] Revisit MACOS patch dependency and QR troubleshooting guidance
- [ ] Close resolved open questions

### Output
- OpenWA becomes the primary transport
- Operational docs reflect the new steady state

### Challenge / verification
- End-to-end operator workflow works from session auth to ticket claim
- Build/typecheck passes
- Runbook is updated to match production reality

## Notes
- A phase is not complete just because code exists.
- A phase completes only when its verification evidence is captured and related docs are synchronized.
