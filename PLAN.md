# Codex Account Ring Extension — Implementation Plan

**Status:** v0.2 implemented and validated; pending commit, push, and global package replacement
**Target:** Pi `0.84.2`, Node.js `>=22.19`  
**Package name:** `pi-codex-ring`

## v0.2 image-generation addendum

The package now also owns:

- a global `image_gen` tool matching Codex's prompt, local-path edit, and recent-conversation-image edit modes;
- the subscription endpoints `/backend-api/codex/images/generations` and `/images/edits` with fixed `gpt-image-2` auto defaults;
- narrow, non-replaying failover through the existing ring;
- exclusive PNG persistence at `<agent-dir>/image_gen/<normalized-cwd>/<session-id>/<tool-call-id>.png`;
- an adapted `imagegen` Pi skill for raster-versus-code-native selection, prompt shaping, edit invariants, iteration, and project-asset handling.

The adapted skill deliberately omits Codex's API-key CLI fallback. Image quota stops remain resource-specific under `modelBlocks.image_gen`; ambiguous failures never trigger another image POST. Automated tests use mock responses. Live validation completed with one generation and one recent-conversation-image edit; both returned inline PNGs and saved distinct artifacts in the required directory. Commit, push, and replacement of the globally installed Git revision follow validation.

## 1. Goal

Build a Pi custom-provider extension that exposes one virtual provider, `openai-codex-ring`, backed by an ordered ring of independently authenticated ChatGPT/Codex accounts.

The extension will:

- keep one account active while it remains usable;
- track the server-reported short and weekly usage windows for every account;
- advance cyclically to the next eligible account after an authoritative usage-limit failure;
- keep exhausted accounts unavailable until all exhausted windows have reset;
- transparently retry the same model request only when the failed account produced no user-visible model output;
- preserve Pi's normal Codex protocol, tools, reasoning, prompt caching, and OAuth refresh behavior;
- provide status and manual routing commands without storing duplicate credentials.

This is a **sticky cyclic failover ring**, not per-request round-robin load balancing. The cursor advances only when an account becomes unavailable or the user advances it manually. This protects prompt-cache and WebSocket continuity.

## Review checkpoints

The main proposed decisions to approve or change are:

1. Reuse the existing built-in `openai-codex` login as the first slot; register auth-only aliases for additional accounts.
2. Stay sticky on one account and advance only on exhaustion/manual `next`, rather than round-robin every request.
3. Track percentages continuously, but rotate only on an actual usage-limit failure or explicit endpoint hard stop—not merely at displayed 100%.
4. Poll the official client's `/wham/usage` endpoint because Pi does not expose raw WebSocket quota events to custom stream wrappers.
5. If multiple windows are exhausted, wait for the latest reset and then confirm recovery with a probe.
6. Retry the same logical turn only before meaningful streamed output; never risk duplicate visible output or tool effects.
7. Persist redacted quota/cooldown state globally, while keeping the active cursor and forced-account mode session-local.

## 2. Proposed user experience

### Configuration

Create `${PI_CODING_AGENT_DIR:-~/.pi/agent}/codex-ring.json`:

```json
{
  "version": 1,
  "providerId": "openai-codex-ring",
  "accounts": [
    {
      "id": "primary",
      "label": "Primary",
      "useBuiltinProvider": true
    },
    {
      "id": "secondary",
      "label": "Secondary"
    },
    {
      "id": "backup",
      "label": "Backup"
    }
  ],
  "usagePollTtlSeconds": 60,
  "usagePollTimeoutSeconds": 10,
  "unknownResetRetrySeconds": 300
}
```

Rules:

- Exactly one optional slot may set `useBuiltinProvider: true`; it reuses the existing `openai-codex` login.
- Other slots get derived auth-only provider IDs such as `openai-codex-ring-auth-secondary`.
- Account IDs must match `[a-z0-9][a-z0-9_-]*` and be unique.
- `enabled` is optional and defaults to `true`.
- Labels are display-only and contain no credentials.

### Login and model selection

```text
/login openai-codex
/login openai-codex-ring-auth-secondary
/login openai-codex-ring-auth-backup
/model openai-codex-ring/<codex-model>
```

The extra auth providers will have no models, so they appear in `/login` but do not duplicate the Codex catalog in `/model`.

### Commands

```text
/codex-ring status [--refresh]
/codex-ring next
/codex-ring mode auto
/codex-ring mode force <account-id>
/codex-ring clear <account-id>
```

- `status`: show auth state, active account, 5-hour and weekly percentages, reset times, hard-stop reason, and freshness.
- `status --refresh`: poll all authenticated accounts with bounded concurrency.
- `next`: advance the session cursor once and remain in automatic mode.
- `mode auto`: restore normal ring behavior.
- `mode force <id>`: pin this session to one account and do not fail over.
- `clear <id>`: clear only the extension's local cooldown; it does not reset OpenAI usage.

### Footer and notifications

The footer status will be explicit about direction:

```text
Codex Primary · 5h 64% left · 7d 21% left
```

Stale snapshots will use a marker such as `~64% left`. On a switch:

```text
Codex Primary reached its 5h limit (resets 14:03); switched to Secondary.
```

No access token, raw account ID, email address, or full JWT claim will be displayed or logged.

## 3. Research findings and resulting design constraints

### 3.1 Pi authentication and extension APIs

- Pi's credential contract stores **one credential per provider ID**. Multiple accounts therefore need distinct provider IDs rather than an array under `openai-codex`.
- Pi maintainers closed the native multi-login request in favor of custom OAuth providers through extensions.
- A custom provider can wrap an existing `streamSimple` using `createAssistantMessageEventStream`; this exact API has been discussed for multi-account quota failover.
- Pi `0.84.2` already scopes cached Codex WebSockets and continuation state by both session and authenticated account. Older Pi versions must not be considered supported without forcing SSE.

**Decision:** reuse Pi's built-in Codex OAuth implementation under auth-only alias providers. Pi remains responsible for login persistence, token refresh, refresh locking, and `auth.json` permissions.

### 3.2 OpenAI usage windows

OpenAI's public pricing documentation says Codex local/cloud usage shares a five-hour window and that additional weekly limits may apply. It also says usage varies with model, context, reasoning, tools, retrieval, and caching.

**Decision:** do not estimate subscription usage from Pi token counts. Only server-reported usage is authoritative.

The current official Codex client understands three structured sources:

1. `x-codex-*-used-percent`, `*-window-minutes`, and `*-reset-at` response headers;
2. `codex.rate_limits` streaming events, particularly for WebSockets;
3. an authenticated usage endpoint:
   - ChatGPT backend style: `GET https://chatgpt.com/backend-api/wham/usage`
   - Codex API style: `GET <base>/api/codex/usage`

The usage payload includes:

- `rate_limit.allowed` and `rate_limit.limit_reached`;
- `primary_window` and optional `secondary_window`;
- `used_percent`, `limit_window_seconds`, `reset_after_seconds`, and `reset_at`;
- `rate_limit_reached_type`;
- credits and workspace spend-control state;
- optional `additional_rate_limits` for separate model/feature buckets.

### 3.3 Do not assume primary means 5 hours

The official Codex client has generalized its labels, and live payloads may contain only one window or put a non-five-hour duration in `primary`.

**Decision:** classify windows by duration, not object position:

- approximately `300` minutes (within 5%) → five-hour window;
- approximately `10080` minutes (within 5%) → weekly window;
- everything else → preserved as a generic/other window.

`used_percent` means **used**, not remaining. UI computes `remaining = clamp(100 - used, 0, 100)` and labels it explicitly.

### 3.4 A displayed 100% is not sufficient to block

A percentage can be rounded, stale, associated with a different metered feature, or still usable through credits. The usage endpoint also has explicit `allowed`, `limit_reached`, spend-control, and hard-stop fields.

**Decision:**

- percentages are for status and reset planning;
- preemptive switching at a percentage threshold is out of scope for v1;
- an actual `usage_limit_reached` response is authoritative;
- an endpoint hard stop (`allowed: false`, `limit_reached: true`, or a relevant `rate_limit_reached_type`) may also mark an account unavailable;
- if telemetry says 100% but the server still allows requests, continue using the account.

### 3.5 WebSocket telemetry is not exposed by Pi's assistant stream

Pi's Codex adapter currently passes `codex.rate_limits` through its raw protocol layer, but the shared assistant-message processor ignores that event. Custom provider wrappers see Pi assistant events, not raw Codex events.

**Decision:**

- parse headers opportunistically for SSE requests;
- use `/wham/usage` as the transport-independent source for both SSE and WebSocket sessions;
- preserve the user's configured Pi transport rather than forcing SSE;
- keep usage polling coalesced and rate-limited.

## 4. Package and file layout

```text
package.json
README.md
src/
  index.ts                 # extension factory and lifecycle
  config.ts                # config path, schema, validation
  providers.ts             # auth aliases and virtual pool provider
  router.ts                # ring selection and stream composition
  quota.ts                 # headers, usage endpoint, window classification
  account.ts               # JWT identity extraction and fingerprints
  state.ts                 # in-memory state, persistence, locking, merging
  context.ts               # provider remapping and cross-account replay safety
  commands.ts              # /codex-ring and footer status
  errors.ts                # structured failure classification/redaction
  types.ts
test/
  config.test.ts
  quota.test.ts
  ring.test.ts
  stream.test.ts
  context.test.ts
  state.test.ts
```

`package.json` will:

- expose `src/index.ts` through the `pi.extensions` manifest;
- list Pi packages as `peerDependencies: { "*" }`, per Pi package guidance;
- use `undici` as a runtime dependency for an abortable environment-proxy-aware usage client;
- use `proper-lockfile` as a runtime dependency for cross-process state updates;
- use Vitest and TypeScript tooling only as development dependencies.

## 5. Provider architecture

### 5.1 Built-in provider template

Create one template with:

```ts
openaiCodexProvider()
```

from `@earendil-works/pi-ai/providers/openai-codex`.

Use it as the source of:

- built-in Codex OAuth behavior;
- base URL;
- current model definitions and compatibility metadata;
- native `stream` and `streamSimple` implementations.

### 5.2 Auth-only account providers

For every non-built-in account slot, register a complete native provider with:

- its own provider ID;
- a display name containing the configured label;
- the built-in Codex OAuth auth object;
- an empty model list;
- the built-in Codex API implementation, although it should never be selected directly.

This gives every account an independent `auth.json` entry and independent OAuth refresh lock without copying tokens into extension state.

### 5.3 Virtual ring provider

Register `openai-codex-ring` with:

- cloned built-in Codex models, changing only `model.provider`;
- an always-resolvable non-secret placeholder auth method so the virtual catalog is selectable;
- wrapped `stream` and `streamSimple` implementations;
- no custom endpoint or protocol reimplementation.

If no account is authenticated, requests return a concise setup error listing the `/login` provider IDs.

### 5.4 Runtime binding

The extension factory registers providers before startup completes so `--list-models` and startup model selection work.

On `session_start`, capture the current `ctx.modelRegistry`, initialize session-local cursor/mode state, and start no unbounded background work. On `session_shutdown`, abort pending usage polls and clear footer state.

## 6. Account identity and duplicate detection

For each request candidate:

1. Resolve auth through `ctx.modelRegistry.getProviderAuth(authProviderId)`; this lets Pi refresh an expiring OAuth token under its normal credential lock.
2. Parse the already-trusted JWT payload locally to obtain optional:
   - `chatgpt_account_id`;
   - `chatgpt_user_id` (falling back to the standard JWT `sub` claim);
   - plan type.
3. Compute a truncated SHA-256 account fingerprint from user/sub ID plus account ID.
4. Never persist the bearer token or raw identity claims outside Pi's `auth.json`.

The user ID is preferred because multiple workspace members can share a ChatGPT account/workspace ID while having separate usage buckets.

If two configured slots resolve to the same fingerprint, keep the first slot, mark later slots as duplicates, and warn in `/codex-ring status`. This prevents a false impression of additional capacity.

## 7. Quota acquisition and tracking

### 7.1 Usage endpoint client

For first-party ChatGPT Codex auth, call:

```http
GET https://chatgpt.com/backend-api/wham/usage
Authorization: Bearer <access token>
ChatGPT-Account-Id: <JWT account id>
Accept: application/json
User-Agent: pi-codex-ring/<version>
```

Requirements:

- use a per-call timeout and the active/session abort signal;
- honor `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY`;
- never include response bodies or request headers in normal logs;
- tolerate unknown fields and unknown plan types;
- treat endpoint failure as stale telemetry, not proof that the account is exhausted.

### 7.2 Poll policy

- Poll lazily; do not block every request on a usage GET.
- Coalesce polls per account so at most one is in flight.
- Normal TTL: 60 seconds.
- After a successful model turn, schedule at most one coalesced refresh for the active account.
- On a usage-limit failure, synchronously poll that account with a short timeout before rotating so both five-hour and weekly reset timestamps can be captured.
- `status --refresh` polls all accounts with concurrency limited to two.
- Mark UI data stale after 15 minutes.

### 7.3 Header observation

Wrap `options.fetch ?? globalThis.fetch` for HTTP/SSE Codex calls. Clone non-success responses before the built-in adapter consumes them and capture:

- exact error `type`/`code`;
- `resets_at`;
- `x-codex-active-limit`;
- `x-codex-rate-limit-reached-type`;
- all recognized usage-window headers.

Compose rather than replace caller-provided `fetch`, `onPayload`, and `onResponse` hooks.

This path is supplemental; WebSocket routing must continue to work without it.

## 8. Quota state model

Each account state will contain:

```ts
interface AccountQuotaState {
  accountFingerprint?: string;
  fiveHour?: UsageWindow;
  weekly?: UsageWindow;
  otherWindows: Record<string, UsageWindow[]>;
  credits?: CreditsState;
  planType?: string;
  hardStop?: HardStop;
  authError?: SanitizedError;
  lastObservedAt?: number;
  lastPollAt?: number;
  lastSuccessfulRequestAt?: number;
}
```

A `UsageWindow` stores used percent, duration, absolute reset time, observation time, source, and whether an actual request identified it as exhausted.

Observation precedence:

1. actual request failure;
2. fresh usage endpoint result;
3. response headers;
4. persisted older state.

Merges must reject stale observations and must not let an older successful poll erase a newer hard stop.

### Recovery rules

- Keep every window known to have caused exhaustion.
- If both five-hour and weekly windows are exhausted, recovery eligibility is:

```text
now >= max(reset time of every exhausted window)
```

- Do not reactivate at the earlier five-hour reset while the weekly window remains exhausted.
- Once all known reset times pass, mark the account `probe-needed` rather than immediately `healthy`.
- A fresh usage poll can clear the stop when the endpoint reports availability.
- If the endpoint is unavailable, allow one real model request as the recovery probe.
- If no reset time is available, retry eligibility begins after `unknownResetRetrySeconds`; the account remains probe-needed until the server confirms it.
- Workspace credit depletion/spend-cap stops with no reset stay blocked until a newer poll clears them or the user runs `clear`.

## 9. Ring selection algorithm

Session-local state:

```ts
interface RingSessionState {
  cursor: number;
  mode: "auto" | { forceAccountId: string };
  activeAccountId?: string;
}
```

Automatic selection:

1. Start at the current cursor.
2. Visit each configured account at most once.
3. Skip disabled, unauthenticated, duplicate, auth-invalid, or currently blocked accounts.
4. If an expired cooldown needs a probe, poll or allow one bounded real probe.
5. Select the first eligible account and keep it active.
6. Advance the cursor only after that account becomes unavailable or `/codex-ring next` is used.
7. Never cycle back to an account during the same logical model request.

State persisted by one Pi process is re-read before candidate selection so other Pi processes learn about newly exhausted accounts. Persistence cannot prevent simultaneous in-flight requests from consuming the same account, but it prevents repeated avoidable attempts after a hard stop is known.

When no account is eligible, return one non-retryable assistant error containing a redacted per-account summary and the earliest possible next probe/reset time.

## 10. Failure classification and routing policy

| Failure | Rotate? | Local state |
|---|---:|---|
| Explicit `usage_limit_reached` | Yes, before output | Record exhausted windows and resets |
| Endpoint `allowed: false` / `limit_reached: true` | Skip candidate | Record hard stop |
| Workspace credits depleted or spend cap reached | Yes | Block until newer poll/manual clear |
| `usage_not_included` for selected model | Yes | Mark account+model unavailable |
| Missing/invalid auth, 401, or 403 | Yes, before output | Mark auth-invalid; instruct re-login |
| Transient `rate_limit_exceeded`, RPM/TPM 429 | No | Let Pi retry/back off normally |
| Model capacity / overloaded | No | Let Pi retry or surface normally |
| Network failure or 5xx | No | Let Pi retry or surface normally |
| Abort | No | Stop immediately |
| Any error after meaningful streamed output | No | Surface original error; next turn may use another account |

Do not classify every 429 as subscription exhaustion. Pi's current friendly error text can collapse several 429 variants, so use the captured raw response or a confirming usage poll whenever possible. A WebSocket error is switchable only when it includes an explicit usage-limit code or the subsequent usage poll reports a hard stop.

Additional/model-specific limits will be retained separately. If an active limit can be mapped safely to the selected model, block only that account/model pair; otherwise v1 will conservatively block the account and explain that the limit scope was unknown.

## 11. Transparent stream failover

The virtual provider returns an outer `AssistantMessageEventStream`.

For each selected account:

1. Resolve its fresh OAuth bearer token.
2. Build an internal request model using provider `openai-codex` so the built-in Codex serializer uses its native tool/reasoning behavior.
3. Adapt the virtual conversation context for the candidate account.
4. Call the built-in Codex `stream`/`streamSimple` with the account token and original request options.
5. Buffer only pre-output events such as `start` and empty block starts.
6. If the attempt succeeds, rewrite provider metadata to `openai-codex-ring`, flush buffered events, and finish normally.
7. If it fails with a switchable error before meaningful output, discard that attempt's buffered events, update quota state, and try the next account.
8. If any meaningful text, thinking, or tool-call content was emitted, flush and surface the original terminal error without retrying.

At most `N` physical attempts are made for `N` accounts. The abort signal is checked between attempts.

A failed pre-output attempt contributes no assistant message or tool result to Pi's logical conversation. Successful usage/cost accounting comes only from the account that produced the final response.

## 12. Cross-account context and continuation safety

Pi `0.84.2` already isolates Codex WebSocket connection/continuation caches by account ID. The extension still needs to protect replayed server-owned item IDs when a conversation moves between accounts.

For every successful virtual-provider assistant message, append a diagnostic containing only:

- extension diagnostic type;
- account fingerprint;
- configured slot ID;
- switch attempt count.

Before delegating a later request:

- messages produced by the same account fingerprint are remapped to provider `openai-codex` and retain their native signatures;
- messages produced by another or unknown account are cloned and sanitized:
  - remove account-bound response IDs;
  - remove server-owned reasoning item IDs while retaining encrypted replay content where valid;
  - remove text item signatures so stable local IDs are regenerated;
  - let Pi's foreign-provider tool-call normalization regenerate safe item IDs;
- the original persisted Pi session messages remain unchanged.

This behavior needs focused serialization tests. If current Codex rejects sanitized cross-account reasoning replay, the safe fallback is to convert that foreign reasoning block to plain text or omit it while preserving visible assistant text and tool history.

Minimum supported Pi version will initially be `0.84.2`, the installed version that contains account-scoped Codex WebSocket continuation handling. The minimum can be relaxed only after verification against earlier releases.

## 13. Persistent state and concurrency

State path, resolved through Pi's `getAgentDir()`:

```text
${PI_CODING_AGENT_DIR:-~/.pi/agent}/codex-ring-state.json
```

Properties:

- schema-versioned;
- mode `0600`;
- contains labels/fingerprints/quota metadata only, never credentials;
- written through temp-file + rename;
- guarded by a cross-process lock;
- merge-by-observation-time under lock;
- corrupt state is quarantined with a warning rather than blocking all Codex use.

The active/forced cursor is session-local. Quota hard stops and snapshots are global so concurrent Pi sessions share what they learn.

## 14. Commands and non-interactive behavior

- Register `/codex-ring` during extension load.
- Use plain status/notification APIs for v1; do not build a complex custom TUI.
- Guard UI calls with `ctx.hasUI`/`ctx.mode`.
- Routing must work identically in TUI, print, JSON, and RPC modes.
- In non-interactive modes, switch information goes to diagnostics/stderr-compatible extension logging, never stdout protocol output.
- Clear footer state and abort usage requests during `session_shutdown`.

## 15. Tests

### Unit tests

**Configuration**

- valid and invalid account IDs;
- duplicate IDs/provider IDs;
- exactly one built-in slot;
- safe defaults and unknown-field handling.

**Quota parsing**

- response header primary/secondary windows;
- `/wham/usage` payload with five-hour and weekly windows;
- primary and secondary reversed;
- only a weekly window present;
- `299`/`300` and `10079`/`10080` minute classification;
- malformed, missing, negative, and out-of-range values;
- credits, spend controls, additional model limits, and unknown plan types;
- explicit `allowed`/`limit_reached` precedence over percentages.

**State and recovery**

- five-hour exhaustion only;
- weekly exhaustion only;
- both exhausted, using the later reset;
- unknown reset cooldown;
- stale poll cannot clear newer hard stop;
- reset elapsed → probe-needed → healthy/blocked;
- atomic merge across simulated processes.

**Ring selection**

- sticky selection;
- cyclic wraparound;
- disabled, unauthenticated, duplicate, and blocked slots;
- manual `next` and forced mode;
- all-accounts-exhausted summary;
- recovered account re-enters at its normal ring position.

**Stream composition**

- account A succeeds;
- A returns pre-output `usage_limit_reached`, B succeeds;
- A transiently rate-limits and does not rotate;
- A emits partial content and then errors, so B is not attempted;
- abort during A prevents B;
- all candidates are attempted at most once;
- exactly one external `start` and one terminal event on successful failover;
- provider metadata and usage are rewritten correctly;
- caller `fetch`, `onPayload`, and `onResponse` hooks remain composed.

**Context safety**

- same-account replay retains native signatures;
- cross-account replay strips server-owned IDs;
- pre-extension/untagged session history follows the safe path;
- A → B → A WebSocket continuation does not share connection state;
- malformed thinking signatures fail safely without corrupting the session.

**Security**

- tokens and raw JWTs never appear in state, diagnostics, status, or errors;
- HTTP errors are redacted;
- state/config file permissions are enforced.

### Integration tests

Use fake OAuth providers, fake JWTs, a local `/wham/usage` server, and a deterministic fake Codex stream. No CI test should require live OpenAI credentials or intentionally consume quota.

### Manual verification

1. One account: behavior matches built-in `openai-codex` for SSE and WebSocket.
2. Two accounts: `/codex-ring next` changes the JWT account fingerprint and requests continue in the same Pi session.
3. Restart: persisted quota status reloads and fresh polling reconciles it.
4. Simulated quota response through a local fixture causes transparent A → B failover.
5. Real exhausted account, if naturally available during testing, records both five-hour and weekly reset state without deliberately burning usage.

## 16. Implementation phases

### Phase 1 — package skeleton and auth aliases

- Add package manifest, config loader, and tests.
- Register built-in/account alias providers and virtual model catalog.
- Implement setup errors and README login instructions.

### Phase 2 — quota model and usage client

- Implement JWT identity/fingerprint handling.
- Implement header and `/wham/usage` parsers.
- Add polling, timeout, proxy support, state persistence, and merge tests.
- Add `/codex-ring status --refresh`.

### Phase 3 — ring router and stream wrapper

- Implement sticky selection and bounded cyclic failover.
- Implement raw SSE failure capture and WebSocket confirmation polling.
- Implement event buffering and no-retry-after-output rule.
- Add failure-policy and stream tests.

### Phase 4 — context continuity and UI

- Add account diagnostics and cross-account context sanitization.
- Add footer status, switch notifications, `next`, `mode`, and `clear`.
- Verify compaction, tools, deferred tool schemas, SSE, and WebSocket behavior.

### Phase 5 — hardening and documentation

- Cross-process tests, token-redaction audit, corrupted-state recovery.
- Print/JSON/RPC verification.
- Installation, upgrade, troubleshooting, and terms/authorization notes.
- Pin a tested minimum Pi version and document upstream protocol assumptions.

## 17. Acceptance criteria

The implementation is complete when:

- three or more Codex OAuth accounts can coexist without credential copying;
- the built-in `openai-codex` credential can serve as the first ring slot;
- `/model` exposes one virtual Codex catalog without alias-provider duplicates;
- status tracks both approximately five-hour and weekly server windows independently;
- an authoritative pre-output quota failure advances to the next eligible account and completes the same logical Pi turn;
- both exhausted windows keep an account blocked until the later reset and a confirming probe;
- transient throttling, overload, network errors, aborts, and post-output errors do not rotate accounts incorrectly;
- all-account exhaustion produces a bounded, actionable error rather than an infinite retry loop;
- no credential or raw account identity is written outside Pi's credential store;
- mocked tests cover routing, reset recovery, event semantics, context replay, persistence, and redaction.

## 18. Explicit non-goals for v1

- Per-request round-robin or quota-weighted load balancing.
- Predicting usage from token counts.
- Purchasing credits, enabling auto top-up, or redeeming rate-limit reset credits.
- Managing ChatGPT subscriptions or creating accounts.
- Cloud-task routing; this extension covers Pi's local Codex Responses provider.
- Modifying Pi core or changing `auth.json` to a multi-credential schema.
- Automatically switching merely because a displayed percentage reaches 100 when the server still accepts requests.
- Supporting accounts the user is not authorized to use or bypassing OpenAI's applicable terms.

## 19. Risks and mitigations

| Risk | Mitigation |
|---|---|
| `/wham/usage` is an authenticated product endpoint rather than a stable public API | Isolate and contract-test the client/parser, tolerate schema drift, version endpoint derivation, and fall back to actual request results |
| WebSocket quota events are hidden by Pi's current assistant stream | Poll usage endpoint; parse SSE headers when available |
| Primary/secondary window ordering changes | Map by duration, never position |
| 100% telemetry is rounded/stale but requests still work | Treat actual request failure or explicit endpoint hard stop as authoritative |
| Account switch replays account-bound response item IDs | Account-tag messages and sanitize cross-account context |
| Multiple Pi processes race | Shared locked state, monotonic observation merging, bounded real probes |
| A usage endpoint outage marks every account dead | Fail open with stale status; do not infer exhaustion from poll failure |
| Pi/OpenAI protocol changes | Minimum-version check, contract tests, small isolated adapter modules |
| Automatic failover duplicates visible output or side effects | Retry only before meaningful stream output; at most one attempt per account |

## 20. Sources consulted

Accessed 2026-08-15.

### Pi

- Installed Pi docs: `docs/custom-provider.md`, `docs/extensions.md`, `docs/providers.md`, `docs/packages.md`, and `docs/tui.md` from Pi `0.84.2`.
- [Pi issue #1391 — Support multiple OAuth logins per provider](https://github.com/earendil-works/pi/issues/1391)
- [Pi issue #3262 — wrapping `streamSimple`, including multi-account quota failover](https://github.com/earendil-works/pi/issues/3262)
- [Pi PR #7364 — account-scoped Codex WebSocket sessions](https://github.com/earendil-works/pi/pull/7364)
- [Pi credential-store contract: one credential per provider](https://github.com/earendil-works/pi/blob/086c32e74530564922d011ade23ff582c9d63116/packages/ai/src/auth/types.ts)
- [Pi custom-provider documentation](https://github.com/earendil-works/pi/blob/086c32e74530564922d011ade23ff582c9d63116/packages/coding-agent/docs/custom-provider.md)

### OpenAI Codex

- [Official Codex pricing and usage limits](https://developers.openai.com/codex/pricing)
- [Using Codex with a ChatGPT plan](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan)
- [Official rate-limit header and `codex.rate_limits` event parser](https://github.com/openai/codex/blob/899d1715c87a504ce4c9ec85c2fd7753e33a7be4/codex-rs/codex-api/src/rate_limits.rs)
- [Official `/wham/usage` and `/api/codex/usage` endpoint selection](https://github.com/openai/codex/blob/899d1715c87a504ce4c9ec85c2fd7753e33a7be4/codex-rs/backend-client/src/client/rate_limit_resets.rs)
- [Official usage-payload mapping, including additional limits and hard-stop types](https://github.com/openai/codex/blob/899d1715c87a504ce4c9ec85c2fd7753e33a7be4/codex-rs/backend-client/src/client.rs)
- [Official usage-limit error structure](https://github.com/openai/codex/blob/899d1715c87a504ce4c9ec85c2fd7753e33a7be4/codex-rs/protocol/src/error.rs)
