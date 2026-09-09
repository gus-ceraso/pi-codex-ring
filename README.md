# pi-codex-ring

A Pi package that presents multiple OpenAI Codex OAuth logins as one sticky, reset-aware failover ring. It also provides a subscription-backed `image_gen` tool and an image-generation skill.

## Requirements

- Pi `0.84.2` or newer
- Node.js `22.19` or newer
- ChatGPT/Codex accounts that you are authorized to use

The package does not create accounts, purchase credits, bypass plan rules, or require `OPENAI_API_KEY`.

## Install

From this checkout:

```bash
npm install
pi install /absolute/path/to/pi-codex-ring
```

For a one-off test:

```bash
pi -e /absolute/path/to/pi-codex-ring/src/index.ts
```

## Configure accounts

Create `~/.pi/agent/codex-ring.json` (or the corresponding directory selected by `PI_CODING_AGENT_DIR`):

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
  "unknownResetRetrySeconds": 300,
  "statusStaleSeconds": 900
}
```

If this file is absent, the extension starts with one `Primary` slot that reuses Pi's built-in `openai-codex` login.

Account IDs must match `[a-z0-9][a-z0-9_-]*`. Set `"enabled": false` to disable a slot without deleting it. At most one slot may set `useBuiltinProvider`.

The extension derives separate provider IDs for other slots:

```text
openai-codex-ring-auth-secondary
openai-codex-ring-auth-backup
```

## Log in

In Pi:

```text
/login openai-codex
/login openai-codex-ring-auth-secondary
/login openai-codex-ring-auth-backup
```

Each login occupies its own provider key in `auth.json`; logging into one slot does not replace another slot's credential.

Select the virtual provider:

```text
/model openai-codex-ring/gpt-5.4
```

The exact models mirror the built-in Codex catalog in the installed Pi version.

## Image generation

The globally available `image_gen` tool uses GPT Image 2.5 through the same ChatGPT/Codex OAuth accounts. The agent selects the image model for each call; omitting `model` uses Flare:

```json
{
  "prompt": "A watercolor red fox reading beside a rainy window"
}
```

The accepted, live-tested models are:

| Model | Use |
|---|---|
| `gpt-image-2.5-flare-2026-09-08` | Default for fast, high-quality everyday generation and editing |
| `gpt-image-2.5-sunburst-2026-09-08` | Maximum precision for polished generation and exact or multi-step edits |

A user can request either model explicitly. Otherwise, the agent uses Sunburst when precision materially matters and Flare for most work:

```json
{
  "prompt": "Preserve every product detail while replacing only the label typography",
  "model": "gpt-image-2.5-sunburst-2026-09-08",
  "referenced_image_paths": ["/absolute/path/to/product.png"]
}
```

To edit one to five local images, pass absolute paths:

```json
{
  "prompt": "Change only the scarf to deep blue",
  "referenced_image_paths": ["/absolute/path/to/fox.png"]
}
```

To edit pathless images already in the active conversation, use the smallest required count:

```json
{
  "prompt": "Keep the composition and make the scarf blue",
  "num_last_images_to_include": 1
}
```

Do not combine the two image selectors. An omitted or empty path list creates a new image. `model` is optional and strictly limited to the two IDs above. Size, quality, output format, masks, and output path are intentionally not tool arguments; they use the Codex endpoint's automatic defaults.

Generated PNGs appear inline and are saved without overwriting existing files:

```text
~/.pi/agent/image_gen/<normalized-project-root>/<session-id>/<tool-call-id>.png
```

For example, `/home/user/app` is normalized to `--home-user-app--`. When `PI_CODING_AGENT_DIR` selects another agent directory, the package uses that directory instead of `~/.pi/agent`.

The bundled `imagegen` skill teaches the model when to use raster generation, how to structure prompts and edits, and when to copy a selected image into the project. It does not include Codex's separate API-key CLI fallback.

### Image failover

Image requests stay on the ring's sticky account. The package replays an image request on another account only after an explicit image/subscription usage-limit response, a feature-entitlement rejection, or a definite authentication rejection. It does not replay network failures, timeouts, 5xx responses, generic throttling, malformed successes, or policy denials because the first request might already have consumed image quota.

Image calls run sequentially to keep account transitions deterministic. Each requested asset or variant still uses a separate tool call.

## Commands

```text
/codex-ring status
/codex-ring status --refresh
/codex-ring next
/codex-ring mode auto
/codex-ring mode force <account-id>
/codex-ring clear <account-id>
```

- `status` shows authentication, active account, cached five-hour and weekly usage, reset times, and cooldowns.
- `status --refresh` polls authenticated accounts with concurrency two.
- `next` advances the cyclic cursor for the next request.
- `mode force` disables failover for the current session.
- `clear` removes local cooldown state only; it does not alter OpenAI usage.

## Routing behavior

- Selection is sticky: Pi keeps using the current account while the server allows it.
- Windows are identified by reported duration, not by assuming `primary` or `secondary` has a fixed meaning.
- Displayed percentages are informational. A rounded `100%` alone does not trigger a switch.
- The ring advances on an explicit subscription usage failure, model entitlement failure, authentication rejection, or an explicit hard stop from the usage endpoint.
- Temporary RPM/TPM throttling, network failures, overload, and 5xx errors do not rotate accounts.
- If both the approximately five-hour and weekly windows are exhausted, the account waits for the later reset and then requires a confirming probe.
- A request is retried on another account only before meaningful text, reasoning, or tool-call output. Once output starts, the original error is surfaced so the extension cannot duplicate visible output or tool effects.

## Usage tracking

The package follows the current official Codex client's behavior:

- ChatGPT backend: `GET https://chatgpt.com/backend-api/wham/usage`
- Codex-style backend: `GET <base>/api/codex/usage`
- Codex response headers such as `x-codex-primary-used-percent`

The usage endpoint is an authenticated product endpoint, not a promised stable public API. Parsing is isolated and tolerant, and failed polling never proves that an account is exhausted. Actual provider responses remain authoritative.

`HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` are honored, including provider-scoped environment values.

## State and security

OAuth credentials remain exclusively in Pi's `auth.json`. The package writes only redacted quota metadata to:

```text
~/.pi/agent/codex-ring-state.json
```

The config and state files are restricted to mode `0600`. State writes are atomic and protected by a cross-process lock. Persisted fields include quota windows, reset times, configured slot IDs, and truncated SHA-256 account fingerprints—never bearer tokens, refresh tokens, raw JWTs, email addresses, or raw ChatGPT account/user IDs.

Pi `0.84.2` scopes Codex WebSocket continuation state by authenticated account. The extension additionally tags successful messages with a hashed account diagnostic and strips account-bound response/reasoning IDs before replaying history through another account.

Generated PNG bytes are stored only in Pi's session/tool result and the documented image artifact path. Base64 image payloads are not copied into ring state, logs, or tool-result details.

## Troubleshooting

### The pool model is missing

Confirm Pi is at least `0.84.2`, the package dependencies are installed, and the extension is enabled:

```bash
pi list
pi --list-models | grep openai-codex-ring
```

### An account says `not logged in`

Run the exact `/login` provider shown by `/codex-ring status`.

### An account remains blocked after reset

Run:

```text
/codex-ring status --refresh
```

If the server reports availability but stale local state remains, use `/codex-ring clear <id>`. This permits a probe; it does not grant additional usage.

### Two slots are marked duplicate

Both provider aliases resolved to the same authenticated user/workspace fingerprint. Log one alias into a different authorized account.

### `image_gen` is unavailable

Confirm the package resource is enabled and restart or `/reload` Pi after installation. `pi list` should show the package, and `/skill:imagegen` should load the bundled skill when skill commands are enabled.

### An image was displayed but not saved

The endpoint succeeded, but local persistence failed. The tool result reports the save error and does not regenerate the image. Check permissions and destination collisions below `~/.pi/agent/image_gen/`.

## Development

```bash
npm run verify
```

Automated tests use fake OAuth tokens, local responses, and deterministic streams. They do not require live OpenAI credentials or consume subscription quota.

See [`PLAN.md`](PLAN.md) for architecture, research, failure policy, risks, and pinned source references.
