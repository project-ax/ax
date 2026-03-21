# Chat UI

Journal entries for the chat UI implementation.

## [2026-03-21 12:40] — Credential modal for SSE credential_required events

**Task:** Implement a modal in the chat UI that appears when the server emits a `credential_required` SSE event, allowing users to enter missing credentials.
**What I did:**
- Modified `ax-chat-transport.ts` to detect named SSE events (`event: credential_required` + `data:` lines) and invoke a callback
- Created `credential-modal.tsx` — glassmorphism modal with password input, eye toggle, Cancel/Provide buttons
- Updated `useAxChatRuntime.tsx` to accept and forward `onCredentialRequired` callback via a ref
- Updated `App.tsx` to wire credential state from transport → modal → auto-send "continue" message via `aui.composer()`
- Modal POSTs to `/v1/credentials/provide` with envName, value, sessionId
- On submit, auto-sends "Credentials provided, please continue." via the thread composer
**Files touched:** `ui/chat/src/lib/ax-chat-transport.ts`, `ui/chat/src/lib/useAxChatRuntime.tsx`, `ui/chat/src/App.tsx`, `ui/chat/src/components/credential-modal.tsx` (new)
**Outcome:** Success — visually verified with Playwright MCP (Tier 0 dev loop)
**Notes:** Pre-existing TextDecoderStream TS error in chat UI unrelated to these changes. Backdrop click and Escape key both dismiss the modal.
