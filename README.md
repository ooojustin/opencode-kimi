## opencode-kimi-full

An [opencode](https://opencode.ai) plugin that makes the Kimi Code path in opencode work like the official `kimi-cli`, using Kimi-specific extensions instead of just a generic OpenAI-compatible provider.

Compared with stock opencode Kimi setups, this plugin:

- uses the official Kimi device-flow OAuth against `https://auth.kimi.com`
- talks to `https://api.kimi.com/coding/v1` through `@ai-sdk/openai-compatible`
- sends the same `User-Agent` / `X-Msh-*` fingerprint headers as `kimi-cli`
- reuses `~/.kimi/device_id` for `X-Msh-Device-Id`
- adds `prompt_cache_key`, `thinking`, and `reasoning_effort` for `kimi-for-coding` requests
- surfaces every model your account is entitled to (K3 included) from `/coding/v1/models`, with per-model display name, context length, media-input capabilities, and reasoning-effort tiers
- keeps tokens in opencode's auth store while mirroring `kimi-cli`'s refresh / retry behavior
- provides a `/kimi:usage` TUI command to check subscription usage

Contributor and agent documentation lives in [`AGENTS.md`](./AGENTS.md).

---

### Quick Start

1. Install the plugin globally: `opencode plugin opencode-kimi-full --global`
2. If you are testing a local checkout instead of the published package, install the checkout path instead: `opencode plugin /absolute/path/to/opencode-kimi-full --global`
3. Run `opencode auth login -p kimi-code` and approve the device flow in your browser.
4. Paste the provider block from [Configure](#configure) into your opencode config.
5. Select `kimi-code/k3` (or any other entitled model) in opencode.

### Requirements

- `opencode` >= 1.4.6
- A Kimi account with an active **Kimi For Coding** subscription (the same plan that works with kimi-cli)

### Install

Recommended:

```sh
opencode plugin opencode-kimi-full --global
```

That installs the published package and adds the plugin to your global opencode config, so `opencode auth login -p kimi-code` works from any directory.

From a local checkout:

```sh
opencode plugin /absolute/path/to/opencode-kimi-full --global
```

That is the command you want when you are editing this repo and want opencode to load your working tree. Changing files in a checkout does nothing unless opencode is pointed at that checkout path.

If you prefer managing plugin registration manually, add the plugin to the `plugin` list in `~/.config/opencode/opencode.json` or a project-local `.opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-kimi-full"]
}
```

For a local checkout, point the `plugin` entry at the repo root instead of the npm package name:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["/absolute/path/to/opencode-kimi-full"]
}
```

If you use a project-local `.opencode/opencode.json`, the plugin only exists when you run `opencode` inside that project tree. If you want `opencode auth login` to work from anywhere, use the `--global` install above.

### Configure

After the plugin is installed and login works, paste this provider entry into `~/.config/opencode/opencode.json` or `.opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "kimi-code": {
      "name": "Kimi",
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "https://api.kimi.com/coding/v1"
      },
      "models": {
        "kimi-for-coding": {
          "name": "K2.7 Coding",
          "attachment": true,
          "reasoning": true,
          "modalities": {
            "input": ["text", "image"],
            "output": ["text"]
          },
          "options": {}
        }
      }
    }
  }
}
```

> **Important:** The `attachment` and `modalities` fields are required for image input to work. Without them, opencode strips image parts before they reach Kimi. If you previously pasted an older config block without these fields, update it.

The `models` block above is only an offline fallback. At login, on first use, and on every token refresh the plugin queries `/coding/v1/models` and surfaces **every model your account is entitled to** as its own opencode model, so a Kimi subscription that includes K3 gives you `kimi-code/k3` and `kimi-code/k3-256k` alongside `kimi-code/kimi-for-coding` without touching your config. Reasoning variants come from each model's own `think_efforts`, so K3 exposes `low`/`high`/`max` while older models get the legacy ladder.

This block does **not** register the auth provider by itself. What makes `opencode auth login -p kimi-code` work is the plugin being loaded via `opencode plugin ...` or the `plugin` array above.

- **provider id** `kimi-code` -- the plugin's `auth` and `chat.params` hooks match on it. Use it exactly as written.
- **model ids** are the wire slugs `/coding/v1/models` returns; nothing is aliased or rewritten.

> **Note.** The provider id is intentionally not `kimi-for-coding`. That id is already published by [models.dev](https://models.dev) and points at a static-API-key flow using a different SDK and auth shape. Using a distinct id keeps the two paths from colliding under a single `opencode auth login` entry.

### Log in

```sh
opencode auth login -p kimi-code
```

Then complete the device-flow approval in your browser.

During login the plugin:

- shows a verification URL and user code
- stores the OAuth token in opencode's auth store
- discovers every model slug, display name, context length, and media-input capability your account is entitled to
- prints a config hint covering all of them

Access tokens refresh automatically while you use the model.

<details>
<summary><strong>Troubleshooting: Unknown provider "kimi-code"</strong></summary>

That error means opencode did not load this plugin at all. The Kimi OAuth flow has not started yet.

The usual causes are:

- You skipped `opencode plugin opencode-kimi-full --global` or `opencode plugin /absolute/path/to/opencode-kimi-full --global`.
- You edited a local checkout, but opencode is not pointed at that checkout path.
- You put the plugin in a project-local `.opencode/opencode.json`, but ran `opencode auth login` from another directory.
- You added the `provider` block, but not the `plugin` entry or plugin install.

Fastest fix:

1. Install the plugin globally with `opencode plugin opencode-kimi-full --global`, or `opencode plugin /absolute/path/to/opencode-kimi-full --global` for a checkout.
2. Confirm your opencode config now contains the plugin entry.
3. Run `opencode auth login -p kimi-code` again.

</details>

<details>
<summary><strong>Troubleshooting: Images not working / "this model does not support image input"</strong></summary>

opencode gates image input on model metadata. If your config block is missing `attachment: true` and `modalities`, opencode strips image parts before they reach Kimi.

Fix: update your config block to match the one in [Configure](#configure) above -- specifically add `"attachment": true` and `"modalities": { "input": ["text", "image"], "output": ["text"] }` to the model entry.

The plugin also backfills these capabilities at runtime from `/coding/v1/models` discovery, but the static config must be correct for the initial request.

</details>

<details>
<summary><strong>Login and refresh details</strong></summary>

- The plugin queries `/coding/v1/models` during login so it can discover the current wire model id, context length, and media capabilities for your account.
- The plugin uses that discovery response to backfill image and video input support into opencode's runtime model metadata, so pasted or dropped images reach Kimi instead of being downgraded into local error text.
- The printed config hint intentionally omits `limit`, because opencode requires both `limit.context` and `limit.output`, while Kimi's models endpoint only exposes `context_length`.
- Model discovery runs again on every token refresh, and a fresh loader instance can re-query `/coding/v1/models` on first use if it needs the current wire model id.
- On a `401`, the loader refreshes the access token once and retries the request once.
- Refreshes are coordinated through opencode's live auth store so concurrent workspaces do not keep using an older refresh-token chain from a stale `OPENCODE_AUTH_CONTENT` snapshot.

</details>

### Use

Select `kimi-code/k3` (or any other entitled model) in opencode.

The default variant-cycle keybind is **Ctrl+T**. The variants map as follows:

- `off` -- sends `thinking: { "type": "disabled" }`
- `auto` -- omits both `thinking` and `reasoning_effort`
- `low` / `medium` / `high` -- send `thinking: { "type": "enabled" }` plus the matching `reasoning_effort`

These variants only affect Kimi's reasoning request fields. They do not switch models or auth paths. In practice:

- `off` asks the backend to disable thinking
- `auto` leaves the decision to the server
- `low` / `medium` / `high` ask for enabled thinking with the corresponding reasoning effort

Effort levels `xhigh` and `max` are clamped to `high`, matching kimi-cli's behavior (Kimi's backend does not support higher tiers).

Every `kimi-for-coding` request also gets `prompt_cache_key` set to opencode's session id. That mirrors `kimi-cli`'s cache hint so follow-up turns in the same session can reuse Kimi's prompt cache.

#### Usage command

The plugin registers a `/kimi:usage` TUI slash command that shows your Kimi Code subscription usage (weekly and rolling-window limits) in a compact dialog. Run it from the opencode command palette.

---

<details>
<summary><strong>Why this plugin exists</strong></summary>

Stock opencode can already talk to generic Moonshot and OpenAI-compatible endpoints. This plugin exists for the Kimi Code path specifically: it brings the official Kimi OAuth flow and Kimi-specific request behavior into opencode without sharing `kimi-cli`'s credential files.

**What it adds over the generic route.**

- OAuth device flow against `https://auth.kimi.com`.
- `@ai-sdk/openai-compatible` pointed at `https://api.kimi.com/coding/v1`.
- `prompt_cache_key` set to opencode's session id, for session-scoped cache reuse.
- Paired `thinking` + `reasoning_effort` fields, with effort clamping to match kimi-cli.
- The seven `X-Msh-*` headers and a kimi-cli-shaped `User-Agent`.
- `~/.kimi/device_id` shared with a locally-installed kimi-cli.
- Runtime model discovery from `/coding/v1/models`, including the server-reported wire slug, `display_name`, `context_length`, and media-input capabilities.
- Tokens stored in opencode's auth store under a dedicated provider id, so the plugin and kimi-cli keep independent refresh-token chains and do not invalidate each other.
- Live auth-store rereads plus a provider-scoped refresh lock, so concurrent opencode workspaces converge on the latest refresh-token chain instead of tripping `invalid_grant`.
- Streaming, `reasoning_content` deltas, and tool-call schemas are handled upstream by `@ai-sdk/openai-compatible` -- not reimplemented here.

</details>

<details>
<summary><strong>Request fields in detail</strong></summary>

| Field | Wire shape | Purpose |
|---|---|---|
| `prompt_cache_key` | top-level body, snake_case, set to opencode's `sessionID` | Opt-in, session-scoped cache key, mirroring kimi-cli. |
| `thinking` + `reasoning_effort` | `thinking: { type: "enabled" \| "disabled" }` with sibling `reasoning_effort: "low" \| "medium" \| "high"` | Sent together, matching kimi-cli. `xhigh`/`max` clamped to `high`. |
| Seven `X-Msh-*` headers + UA | `User-Agent`, `X-Msh-Platform`, `X-Msh-Version`, `X-Msh-Device-Name`, `X-Msh-Device-Model`, `X-Msh-Device-Id`, `X-Msh-Os-Version` | Matches kimi-cli's `_common_headers()` at the pinned `KIMI_CLI_VERSION`. |
| `/coding/v1/models` discovery | `id`, `display_name`, `context_length`, `supports_image_in`, `supports_video_in` | Supplies the authoritative wire model slug plus runtime model metadata. |
| `~/.kimi/device_id` | UUID persisted on disk, embedded in `X-Msh-Device-Id` | Sends the same `X-Msh-Device-Id` as a locally-installed kimi-cli. |

Effort-to-field mapping used by the plugin:

| user effort | `reasoning_effort` | `thinking` |
|---|---|---|
| `auto` | *(omitted)* | *(omitted)* -- server picks dynamically |
| `off` | *(omitted)* | `{ type: "disabled" }` |
| `low` / `medium` / `high` | same string | `{ type: "enabled" }` |
| `xhigh` / `max` | `"high"` (clamped) | `{ type: "enabled" }` |

</details>

<details>
<summary><strong>Files the plugin touches</strong></summary>

| Path | Purpose |
|---|---|
| `~/.kimi/device_id` | Stable UUID used in `X-Msh-Device-Id`. Shared with kimi-cli. |
| opencode auth store (`auth.json` in opencode's XDG data dir; on Linux typically `~/.local/share/opencode/auth.json`) | Token storage, managed by opencode through `client.auth.*`; the plugin also live-reads this entry to avoid stale workspace auth snapshots during refresh. |

No other state is persisted. Credentials are never written to `~/.kimi/credentials/`; that path belongs to kimi-cli, and sharing it would cause refresh-token races between the two clients.

</details>

<details>
<summary><strong>Architecture at a glance</strong></summary>

```
                      opencode core
 ──────────────────────────────────────────────────
  auth.login ──> plugin.auth.authorize()     device-code flow, poll
                   └──> oauth.ts

  chat ────────> plugin.loader()             custom fetch that:
                   ├──> ensureFresh()          proactive refresh
                   └──> kimiHeaders()          7 X-Msh-* headers
                                               /models slug discovery
                                               401 -> force-refresh + retry

  chat.params ─> plugin "chat.params"        thinking / reasoning_effort /
                                              prompt_cache_key

  /kimi:usage ─> tui.tsx                     subscription usage dialog
                   └──> usage.ts
```

A full description of the invariants that keep this working is in [`AGENTS.md`](./AGENTS.md), under "Architecture" and "Contracts to keep intact".

</details>

### License

MIT.
