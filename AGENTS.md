# Project guidance

## Architecture

- This Pi package exposes the `openai-codex-ring` provider, account commands, the `image_gen` tool, and the `imagegen` skill.
- Pi's model registry owns OAuth credentials and refresh. Never read or write `auth.json` directly.
- `RingRouter` owns sticky account selection and failover state. Account-bound operations must go through it rather than resolving credentials independently.
- Persist only redacted quota metadata in `codex-ring-state.json`; never persist bearer tokens or raw account/user IDs.
- Image generation uses the Codex subscription image endpoints and only the live-tested GPT Image 2.5 snapshots. Flare is the default; the agent selects Sunburst when maximum precision matters. Image generation does not support API keys or silently replay ambiguous failures.
- Generated images belong under `<agent-dir>/image_gen/<normalized-cwd>/<session-id>/<tool-call-id>.png` and must not overwrite existing files.

## Invariants

- Rotate accounts only after authoritative quota, entitlement, or authentication rejection.
- Never retry a streamed request after meaningful output or an image POST after an ambiguous failure. Never fall back from one image model to another after a failed POST.
- Keep image-specific quota blocks under `modelBlocks.image_gen`; do not turn them into account-wide stops.
- Resolve fresh account auth for each logical operation.
- Keep base64 image payloads out of logs, persisted ring state, and result details.

## Commands

```bash
npm run check
npm test
npm run verify
```

Tests use fake OAuth tokens and mock HTTP responses. Run live image tests only with explicit user approval.

## Context map

There are no nested `AGENTS.md` files.
