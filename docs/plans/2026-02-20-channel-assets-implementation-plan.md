# Channel-Agnostic Asset Handling Implementation Plan

**Date:** 2026-02-20  
**Status:** In Progress  
**Scope:** Cross-channel image/file send+receive for all agent providers in AX

## Goal

Support sending and receiving images/files independent of channel (Slack, WhatsApp, web, etc.) and independent of agent provider capabilities, while keeping the architecture simple and secure.

## Principles

1. Host owns binary handling (download, validation, storage, upload).
2. Agents get stable asset references, not channel-specific payloads.
3. Channel adapters convert between platform APIs and AX canonical types.
4. Fallback always works for text-only agent providers.

## Canonical Model

### Message Parts

- `text` part: user-visible text.
- `asset` part: reference to host-stored binary object.

### Asset Reference

- `id`: stable hash-based ID.
- `filename`, `mimeType`, `size`, `sha256`.
- `source`: provider/session/message metadata.

## Provider Surface

### Asset Provider

- `put(input)` store bytes and metadata.
- `get(id)` read metadata.
- `read(id)` read bytes.

### Channel Provider (existing + extension)

- Inbound attachments map to canonical `Attachment`.
- Attachments can include `assetId` after host normalization.
- Outbound attachments use `Attachment.content` and are uploaded by channel adapter.

## Delivery Pipeline

### Inbound

1. Channel adapter receives message event with files.
2. Adapter enforces size/type policy and downloads bytes when available.
3. Host stores bytes in asset provider.
4. Host appends attachment summary/context to routed text and preserves structured attachment metadata.

### Outbound

1. Agent writes files to workspace `.ax/outbox/`.
2. Host collects allowed files after completion.
3. Host sends text + attachments through channel provider.
4. Adapter uploads files via channel-native API.

## Execution Phases

### Phase 1 (Completed)

1. Add `asset/local` provider and wire into provider map/registry/config.
2. Extend `Attachment` with optional `assetId`.
3. Update Slack inbound to attempt file byte download.
4. Add host-side inbound normalization + asset storage.
5. Add host-side outbound `.ax/outbox/` attachment pickup.
6. Add runtime prompt instruction for agents to use `.ax/outbox/`.
7. Add asset provider tests and run focused regression suite.

### Phase 2 (Next)

1. Add IPC asset tools:
   - `asset_get` (metadata)
   - `asset_read_text` (safe text extraction/OCR pipeline)
   - `asset_put` (optional direct asset creation path)
2. Add asset-aware conversation shape in agent/LLM transport (typed parts instead of text-only augmentation).
3. Add per-channel capability negotiation (max file size, supported mime types, threading rules).
4. Add fallback policies:
   - upload inline when supported;
   - otherwise include a safe reference block in text response.
5. Add retention controls and cleanup jobs for stored assets.

### Phase 3 (Hardening)

1. MIME sniffing and extension/content mismatch checks.
2. Optional AV scanning hook before agent/tool use.
3. Signed URL/read token strategy for external access scenarios.
4. Audit events for asset lifecycle (`asset_put`, `asset_get`, outbound upload).

## Test Plan

1. Unit tests for asset provider dedupe, reads, invalid IDs.
2. Channel adapter tests for file filtering/download behavior.
3. Host tests for:
   - inbound attachment normalization and message augmentation;
   - outbound outbox pickup and channel send wiring.
4. Integration tests for end-to-end file roundtrip in at least one channel adapter.

## Rollout

1. Keep current behavior for text-only flows unchanged.
2. Enable attachment features per channel provider as implemented.
3. Add docs/examples for agent authors on `.ax/outbox/` and future IPC asset tools.

## Success Criteria

1. Any supported channel can deliver files into agent context without channel-specific logic in the agent.
2. Agents can produce files once and return them through any supported channel.
3. Text-only agent providers still function via deterministic fallback behavior.
