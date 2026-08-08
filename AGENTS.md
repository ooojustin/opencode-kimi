# AGENTS.md — working notes for coding agents (and humans)

This file is the single source of truth for any AI agent (or human) modifying this repo. Read it top-to-bottom before touching code. If something you learn here contradicts what you see in the code, the **code wins** — update this file in the same commit.

User-facing install / usage documentation lives in [`README.md`](./README.md). Do **not** duplicate it here.

---

### Purpose

One plugin, one job: make `opencode` talk to Kimi's `kimi-for-coding` endpoint **exactly the way the official `kimi-cli` does**. Everything in this repo exists to minimize drift from upstream kimi-cli.

### The one rule that matters

> Moonshot's coding backend is entitlement-sensitive: the model-name string alone is not the whole story.

Every design decision here follows from that: we do device-flow OAuth to mirror official `kimi-cli`, we do not accept API keys in this plugin, and we do not let the upstream SDK attach its own Authorization header.

### Non-goals

- No support for models outside the account's `/coding/v1/models` entitlement. Whatever that endpoint returns is surfaced; anything else (other Moonshot / Baseten / Alibaba-CN / etc. entries) is opencode's job, not ours.
- No support for static API keys. Users who want that can use a different opencode provider entry.
- No custom SSE parser, tool-call normalizer, or message rewriter. `@ai-sdk/openai-compatible` already does SSE/`reasoning_content` correctly.

---

### Architecture

Each source file has one job. Do not add new files unless the existing ones genuinely can't hold a new concern.

| File               | Responsibility                                                                 |
|--------------------|--------------------------------------------------------------------------------|
| `src/constants.ts` | Pinned strings that must mirror upstream kimi-cli (version, endpoints, client id). |
| `src/headers.ts`   | The seven `X-Msh-*` / UA headers + the persistent `~/.kimi/device_id` file.    |
| `src/oauth.ts`     | Device-code start, device-code poll, refresh-token exchange, and `GET /coding/v1/models` discovery. |
| `src/auth-store.ts`| Read/write opencode's `auth.json` entries for this provider.                    |
| `src/auth-refresh.ts`| Lock-based token refresh with cross-instance coordination, `ensureFreshStoredAuth` for standalone callers. |
| `src/index.ts`     | Plugin entry (v1 `PluginModule` format). Wires `auth` (login + loader), model enumeration, and the Kimi chat hooks. |
| `src/usage.ts`     | Fetch and parse Kimi subscription usage (`/coding/v1/usages`).                 |
| `src/tui.tsx`      | TUI slash command `/kimi:usage` — renders usage in an opencode dialog.         |

Data flow on a chat request:

1. opencode asks the `@ai-sdk/openai-compatible` provider for a language model.
2. Before instantiating it, opencode calls our `auth.loader`. We return `{ apiKey, fetch }`.
3. The SDK uses our `fetch` for every HTTP call (models, chat, whatever).
4. Our `fetch` calls `ensureFresh()` → prefers the live opencode auth-store entry over stale `OPENCODE_AUTH_CONTENT` snapshots → maybe refreshes (sharing one in-flight promise in-process and a lock across plugin instances so they don't race the same refresh token) → lazily discovers `/coding/v1/models` when needed → sets Authorization + the seven `X-Msh-*` headers → on 401 refreshes once and retries.
5. Separately, opencode runs `chat.headers` and `chat.params`. `chat.headers` computes `thinking`, `reasoning_effort`, and `prompt_cache_key` from `input.model.options` plus the selected `input.message.model.variant`, then passes them to `loader.fetch` via private `x-opencode-kimi-*` headers. `loader.fetch` strips those headers and injects the wire fields into the JSON body. `chat.params` mirrors the same keys into `output.options` only as a forward-compat fallback if opencode later fixes its openai-compatible providerOptions namespace mismatch.

### Contracts to keep intact

These are the invariants that, if broken, silently route requests onto the wrong auth/backend path or produce fingerprint-based throttling. Do not "clean them up" without reading the linked upstream.

1. **`X-Msh-Version` and `User-Agent` must track `kimi-cli`.** Bumping involves exactly one line in `src/constants.ts`. See upstream `research/kimi-cli/src/kimi_cli/constant.py`. The UA prefix is `KimiCLI/` (not `KimiCodeCLI/`) — Moonshot's `kimi-for-coding` backend 403s with `access_terminated_error: only available for Coding Agents such as Kimi CLI, Claude Code, Roo Code…` on any other prefix. Likewise, `X-Msh-Device-Model` must mirror kimi-cli's `_device_model()` shape, including the Darwin/Windows special cases (`macOS <version> <arch>`, `Windows 10/11 <arch>`, Linux `"{system} {release} {machine}"`) — NOT just `{arch}` — and `X-Msh-Os-Version` is the kernel build string from `os.version()`, NOT `"{type} {release}"`. Tested live against `api.kimi.com/coding/v1` on 2026-04-17 — any of those three fields off-spec → 403.
2. **`X-Msh-Device-Id` must be stable across runs.** Never regenerate a fresh UUID at import time. `getDeviceId()` reads/writes `~/.kimi/device_id`; that path is shared with `kimi-cli` on purpose.
3. **`Authorization` header is owned by `loader.fetch`.** Anything else (opencode core, the SDK, future hooks) must be overridden. Our `loader` deletes both `authorization` and `Authorization` before setting its own. The private `x-opencode-kimi-*` transport headers are also consumed and stripped there; they must never leak upstream.
4. **Effort ↔ fields mapping** (kimi-cli `llm.py` / `kosong/chat_provider/kimi.py`):

   | Effort   | `reasoning_effort` | `thinking`            |
   |----------|--------------------|-----------------------|
   | `auto`   | *(omitted)*        | *(omitted)*           |
   | `off`    | *(omitted)*        | `{type:"disabled"}`   |
   | `low`    | `"low"`            | `{type:"enabled"}`    |
   | `medium` | `"medium"`         | `{type:"enabled"}`    |
   | `high`   | `"high"`           | `{type:"enabled"}`    |
   | `xhigh`  | `"high"` (clamped) | `{type:"enabled"}`    |
   | `max`    | `"high"` (clamped) | `{type:"enabled"}`    |

   That table is the **legacy ladder**, and it applies only to models that publish no `think_efforts` of their own (K2.7 and earlier). `auto` is the "let the server decide dynamically" variant — neither field is sent, matching kimi-cli's "nothing passed" default. `xhigh` and `max` are clamped to `"high"` because those models' backend does not support higher tiers (kimi-cli's `Kimi.with_thinking()` does the same). When no effort is set at all, the plugin still emits `thinking: {type: "enabled"}` because the model is a reasoner.

   Models that publish `think_efforts.valid_efforts` override the table entirely — see rule 7. K3 accepts `low`/`high`/`max`, so `max` must survive rather than clamp, and its `supports_thinking_type: "only"` means the `off` row is unreachable. Compute this from `input.model.options` plus `input.model.variants[input.message.model.variant]`, not from `input.provider.info.id`. The `@opencode-ai/plugin` `ProviderContext` type claims `.info.id` exists, but the runtime shape opencode passes (see `research/opencode/packages/opencode/src/session/llm.ts::stream`, ~line 168, `provider: item`) is the flat `ProviderConfig` (`.id`). `input.model.providerID` is what every first-party plugin uses (cloudflare.ts, codex.ts, github-copilot/copilot.ts) and it avoids the runtime crash "undefined is not an object (evaluating 'input.provider.info.id')". Tested live 2026-04-17.

5. **`prompt_cache_key` only for models under our provider.** The gate is `input.model.providerID === PROVIDER_ID` in the Kimi chat hooks; every model under `kimi-code` is a Kimi model by construction. The actual wire injection happens in `loader.fetch`. Never attach it to models from other providers.
6. **opencode model keys ARE wire ids.** There is no alias and nothing rewrites the body `model` field — whatever key the user selected is what Moonshot receives. Do not reintroduce a translation layer. The plugin calls `GET /coding/v1/models` at login, on first loader use, and on every token refresh (mirroring kimi-cli's `refresh_managed_models` in `research/kimi-cli/src/kimi_cli/auth/platforms.py`); `provider.models` uses that to backfill `limit.context`, display name, and media capabilities. Config-declared entries are enriched, never replaced, so an explicit `name` still wins and the provider stays usable when discovery fails. Discovery failures are non-fatal (warm cache still works; 401 retry flushes broken tokens).

   **`provider.models` cannot add models.** opencode resolves `provider/model` against the user's config *before* this hook runs, so returning an entry for an undeclared id does not make it selectable — you get `Model not found`. Verified against opencode 1.4.x on 2026-08-08. That is why `buildConfigBlock()` emits every discovered model: the paste-in block is the only way a newly entitled model (K3 on a plan that just gained it) becomes usable.
7. **Per-model effort vocabulary is authoritative.** A model that publishes `think_efforts.valid_efforts` (K3 and later) accepts exactly those values — K3 takes `max`, which kimi-cli's fixed ladder would have clamped away. `clampEffort` therefore clamps against `valid_efforts` when present and falls back to `default_effort` for anything outside it; only models publishing nothing keep kimi-cli's legacy `xhigh`/`max` → `high` cap. Likewise `supports_thinking_type: "only"` means the model always thinks: never send `thinking.type=disabled` for it, and do not offer an `off` variant that would be a dead switch.
8. **Auth store is opencode's, not kimi-cli's.** We use opencode's auth store for tokens under the `kimi-code` provider id. Do not read/write `~/.kimi/credentials/kimi-code.json`; that's kimi-cli's file and sharing it across independent apps causes token-race bugs. The plugin may live-read opencode's `auth.json` entry for this provider to bypass stale `OPENCODE_AUTH_CONTENT` workspace snapshots, but writes still go through opencode's auth store (`client.auth.set`). Also note that opencode's SDK auth schema only persists the standard oauth fields, so model discovery metadata cannot be stored there durably — it lives in plugin memory.
9. **Provider id must not collide with any id in the [models.dev](https://models.dev) catalog.** models.dev publishes `kimi-for-coding` as a separate API-key-driven integration. If we registered under that same id, `opencode auth login kimi-for-coding` would surface two methods under one entry and users could silently land on the wrong integration path. We deliberately use `kimi-code` instead; the wire model ids stay exactly what `/coding/v1/models` returned (rule 6).
10. **`src/index.ts` must have exactly one export — the default `PluginModule` object `{ id, server }`.** opencode's plugin loader (`research/opencode/packages/opencode/src/plugin/index.ts`) first tries `readV1Plugin` (detect mode) on the default export. If it finds an object with `server` (and optional `id`), it uses the v1 path directly. The older legacy path (`getLegacyPlugins`) iterates every export and throws `Plugin export is not a function` on any non-callable value — a problem that surfaced on Windows where Bun's standalone-binary dynamic imports can produce module namespace objects with unexpected non-function metadata. The v1 format bypasses `getLegacyPlugins` entirely. Keep constants in `src/constants.ts` and import them in `src/index.ts` rather than re-exporting. `test/exports.test.ts` guards this. The failure mode of a broken export is silent in the CLI (the provider just doesn't appear in `opencode auth login`); the error only surfaces in `~/.local/share/opencode/log/*.log`.
11. **The post-login config hint must not emit a partial `limit` object.** opencode's live config schema at `https://opencode.ai/config.json` requires both `limit.context` and `limit.output` whenever `limit` is present, while Kimi's `GET /coding/v1/models` only gives us `context_length`. Therefore `buildConfigBlock()` omits `limit` entirely and leaves `provider.models` to backfill `limit.context` at runtime. Do not invent `output` or set `input` heuristically; opencode's overflow logic treats `limit.input` as authoritative (`research/opencode/packages/opencode/src/session/overflow.ts`).
12. **Concurrent refreshes must collapse to one in-flight OAuth exchange, even across plugin instances.** `provider.models` and `auth.loader` can both notice an expiring token at about the same time, and separate opencode workspace/plugin instances can inherit stale auth snapshots. `refreshAuth()` in `src/index.ts` therefore shares one promise across overlapping callers, takes a provider-scoped auth-store lock before refreshing, re-reads opencode's live auth-store entry under that lock, and treats a changed on-disk token chain as authoritative. `test/plugin.test.ts` covers loader-vs-loader, provider.models-vs-loader, cross-instance lock reuse, and the `invalid_grant` self-heal path where another process already rotated the refresh token.
13. **Media-input capabilities must be backfilled from `/coding/v1/models`.** `supports_image_in` and `supports_video_in` from Kimi discovery are not cosmetic metadata: opencode's provider transform (`research/opencode/packages/opencode/src/provider/transform.ts::unsupportedParts`) rewrites every image part into local `ERROR: Cannot read ... (this model does not support image input)` text before the request reaches our loader when `capabilities.input.image` is false. Therefore `provider.models` must patch runtime model metadata for `kimi-for-coding`, and `buildConfigBlock()` must include `attachment: true` plus appropriate `modalities.input` / `modalities.output` when discovery says images/video are supported. `test/plugin.test.ts` covers both paths.

### Working on this repo

- **Code style:** see `tsconfig.json` (strict, `noUncheckedIndexedAccess`, ES2022). Prefer small pure functions, avoid `try`/`catch` except where we genuinely convert one error shape to another.
- **Comments:** match the existing density — only explain non-obvious upstream-parity reasoning. Do not narrate the obvious ("// refresh the token"); instead reference upstream files when the reasoning is "because kimi-cli does it that way".
- **Dependencies:** runtime deps are limited to `@opentui/core` and `@opentui/solid` (for the TUI slash command). The only dev/peer dep is `@opencode-ai/plugin` for types. Do not add further runtime deps.
- **Git commits:** small, logical, imperative subject ("Add oauth device flow"). Do not add a `Co-authored-by` trailer.
- **Upstream research:** the `research/` directory is a read-only git-ignored pair of shallow clones (opencode + kimi-cli) for grep. Never edit files there; re-clone if you suspect drift. When citing upstream in a comment, use the `research/…` path so the reference is resolvable.
- **Version bumps:** when kimi-cli bumps, (1) pull a fresh `research/kimi-cli`, (2) update `KIMI_CLI_VERSION` in `src/constants.ts`, (3) re-diff `_kimi_default_headers()` / `oauth.py` against `src/headers.ts` and `src/oauth.ts`, (4) smoke-test with `opencode auth login kimi-for-coding-oauth` and a one-turn chat, (5) tag release.
- **Tests:** `test/` holds one file per source file plus `test/exports.test.ts` (the rule-9 guard). Tests mock `fetch` via `test/_util/fetchMock.ts`; no real credentials or network. They use the real `~/.kimi/device_id` on purpose — it is shared with kimi-cli by design and `getDeviceId` is idempotent, so tests don't clobber state. When adding a new contract to the list above, add the matching offline check to the corresponding test file rather than creating new ones.

### What not to do

- ❌ Don't add heuristics that look at the model id outside of the Kimi chat hooks / `loader.fetch`. The auth loader is already scoped to this provider; only the chat hooks and the body rewrite need to match on `kimi-for-coding`.
- ❌ Don't rename the provider id back to `kimi-for-coding` or to anything else listed in models.dev. See rule 8.
- ❌ Don't add new header values that kimi-cli doesn't send. The fingerprint matters.
- ❌ Don't call out to other files to "share" the kimi-cli credentials. Different OAuth consumers must have independent refresh-token chains or one will invalidate the other.
- ❌ Don't introduce a build step. The plugin ships as `.ts` and opencode's bun-based loader handles it.
- ❌ Don't add tests that require real Kimi credentials and check them in. If you add offline unit tests, put them under `test/` and mock `fetch`.
- ❌ Don't add named exports to `src/index.ts` or change the default export away from the `{ id, server }` PluginModule shape. See rule 9.

### How to verify a change

Offline:

```sh
bunx tsc --noEmit                                  # type-check
bunx tsc --noEmit --project tsconfig.tests.json    # type-check tests/helpers
bun build --target=node --no-bundle src/index.ts   # syntax check
bun test                                           # offline unit tests
```

Online (requires a real Kimi-for-coding account):

1. Install the local checkout via opencode's plugin flow (`opencode plugin /path/to/this/repo --global`) or point the `plugin` array in your opencode config at the repo root, as shown in `README.md`.
2. Paste the provider block from `README.md` into your opencode config.
3. `opencode auth login kimi-for-coding-oauth` — confirm a token lands in opencode's `auth.json` with `type: "oauth"`, a JWT `access`, and `expires` ~15 min in the future.
4. Start opencode, select `kimi-for-coding-oauth/kimi-for-coding`, and ask the model to self-identify. It should claim to be `kimi-for-coding` / Kimi Code.
5. Confirm `reasoning_content` deltas render as thinking content (not assistant text).
6. In a second turn of the same session, confirm the response comes back faster (cache hit via `prompt_cache_key`).

If any of 3–6 fails, diff `research/kimi-cli` against the contracts above.

### House rules for AI agents

- Read this file first. Every time.
- Don't grow the dependency footprint to "simplify" something; this plugin's value is being small and audit-able.
- When in doubt, mirror kimi-cli exactly, then comment the upstream reference. "We used to deviate, it broke" — document it here.
- Keep `README.md` user-focused and this file contributor-focused. If you catch yourself duplicating, move content here and link from the README.
- Any new rule you add here must have a real incident or a grep-verified upstream source behind it. No speculative "best practices".
