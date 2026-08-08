import type { Plugin, PluginModule } from "@opencode-ai/plugin"
import { isAuthExpiring, refreshAuthWithLock } from "./auth-refresh.ts"
import { isOAuthAuth, readAuth, type OAuthAuth } from "./auth-store.ts"
import { API_BASE_URL, PROVIDER_ID } from "./constants.ts"
import { kimiHeaders } from "./headers.ts"
import { type KimiModelInfo, listModels, pollDeviceToken, startDeviceAuth } from "./oauth.ts"

// IMPORTANT: this module must have exactly ONE export — the default
// PluginModule object. opencode's plugin loader detects the v1 format
// ({ id, server }) via readV1Plugin *before* falling back to
// getLegacyPlugins — which iterates every export and throws "Plugin export
// is not a function" on any non-callable value. The v1 path is more
// reliable on Windows where Bun standalone dynamic imports can produce
// module namespace objects with unexpected non-function metadata.
// Keep constants in constants.ts and import them here.

// Every model `/coding/v1/models` reports for this account, keyed by wire id.
// opencode model keys ARE wire ids, so no id translation happens anywhere.
type ModelDiscovery = Map<string, KimiModelInfo>

type ThinkingType = "enabled" | "disabled"

type KimiBodyFields = {
  prompt_cache_key?: string
  thinking?: { type: ThinkingType }
  reasoning_effort?: string
}

type ModelWithDiscoveryMetadata = {
  name?: string
  attachment?: boolean
  reasoning?: boolean
  options?: Record<string, unknown>
  variants?: Record<string, Record<string, unknown>>
  limit?: {
    context?: number
  }
  modalities?: {
    input?: string[]
    output?: string[]
  }
  capabilities?: {
    attachment?: boolean
    input?: {
      image?: boolean
    }
  }
}

type KimiHookInput = {
  sessionID: string
  model: {
    providerID: string
    id: string
    options?: Record<string, unknown>
    variants?: Record<string, Record<string, unknown>>
  }
  message: {
    model: {
      variant?: string
    }
  }
}

const INTERNAL_PROMPT_CACHE_KEY_HEADER = "x-opencode-kimi-prompt-cache-key"
const INTERNAL_REASONING_EFFORT_HEADER = "x-opencode-kimi-reasoning-effort"
const INTERNAL_THINKING_TYPE_HEADER = "x-opencode-kimi-thinking-type"
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  return value as Record<string, unknown>
}

function asThinking(value: unknown): KimiBodyFields["thinking"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const type = (value as { type?: unknown }).type
  if (type !== "enabled" && type !== "disabled") return
  return { type }
}

function pickEffort(options: Record<string, unknown> | undefined) {
  const effort = options?.reasoning_effort ?? options?.reasoningEffort
  return typeof effort === "string" ? effort : undefined
}

// Models that publish `think_efforts.valid_efforts` (K3 and later) define their
// own effort vocabulary, and it is the only thing their backend accepts — K3
// takes max, which the legacy ladder below would have thrown away. An
// unsupported value falls back to the model's declared default rather than
// being silently dropped, so the request still carries a valid effort.
//
// Models that publish nothing (K2.7) keep kimi-cli's fixed clamp
// (research/kimi-cli/packages/kosong/src/kosong/chat_provider/kimi.py,
// Kimi.with_thinking), which caps at "high".
function clampEffort(effort: string, info: KimiModelInfo | undefined): string {
  const valid = info?.think_efforts?.valid_efforts
  if (valid?.length) {
    if (valid.includes(effort)) return effort
    return info?.think_efforts?.default_effort ?? valid[valid.length - 1]!
  }
  if (effort === "xhigh" || effort === "max") return "high"
  return effort
}

function resolveKimiBodyFields(input: KimiHookInput, info?: KimiModelInfo): KimiBodyFields | undefined {
  if (input.model.providerID !== PROVIDER_ID) return

  const modelOptions = asRecord(input.model.options)
  const variantOptions = input.message.model.variant
    ? asRecord(input.model.variants?.[input.message.model.variant])
    : undefined

  const fields: KimiBodyFields = { prompt_cache_key: input.sessionID }
  const thinking = asThinking(variantOptions?.thinking) ?? asThinking(modelOptions?.thinking)
  const rawEffort = pickEffort(variantOptions) ?? pickEffort(modelOptions)

  if (rawEffort === "auto") return fields
  // `supports_thinking_type: "only"` means the model always thinks; sending
  // thinking.type=disabled is rejected, so honour the model over the request.
  const canDisableThinking = info?.supports_thinking_type !== "only"
  if (rawEffort === "off") {
    if (canDisableThinking) fields.thinking = { type: "disabled" }
    return fields
  }
  if (rawEffort) fields.reasoning_effort = clampEffort(rawEffort, info)
  const requested = thinking ?? { type: "enabled" as const }
  fields.thinking = requested.type === "disabled" && !canDisableThinking ? { type: "enabled" } : requested
  return fields
}

function applyKimiBodyFields(target: Record<string, unknown>, fields: KimiBodyFields) {
  target.prompt_cache_key = fields.prompt_cache_key
  if (fields.reasoning_effort) {
    target.reasoning_effort = fields.reasoning_effort
  } else {
    delete target.reasoning_effort
  }
  delete target.reasoningEffort
  if (fields.thinking) {
    target.thinking = fields.thinking
    return
  }
  delete target.thinking
}

function consumeInternalKimiBodyFields(headers: Headers): KimiBodyFields {
  const fields: KimiBodyFields = {}
  const promptCacheKey = headers.get(INTERNAL_PROMPT_CACHE_KEY_HEADER)
  if (promptCacheKey) fields.prompt_cache_key = promptCacheKey
  const reasoningEffort = headers.get(INTERNAL_REASONING_EFFORT_HEADER)
  if (reasoningEffort) fields.reasoning_effort = reasoningEffort
  const thinkingType = headers.get(INTERNAL_THINKING_TYPE_HEADER)
  if (thinkingType === "enabled" || thinkingType === "disabled") {
    fields.thinking = { type: thinkingType }
  }
  headers.delete(INTERNAL_PROMPT_CACHE_KEY_HEADER)
  headers.delete(INTERNAL_REASONING_EFFORT_HEADER)
  headers.delete(INTERNAL_THINKING_TYPE_HEADER)
  return fields
}

function hasKimiBodyFields(fields: KimiBodyFields) {
  return Boolean(fields.prompt_cache_key || fields.reasoning_effort || fields.thinking)
}

function indexModels(models: KimiModelInfo[]): ModelDiscovery {
  return new Map(models.map((m) => [m.id, m]))
}

// kimi-cli's legacy ladder, used only for models that don't publish their own
// effort vocabulary. clampEffort caps these at "high".
const LEGACY_EFFORTS = ["low", "medium", "high"]

function variantsFor(info: KimiModelInfo): Record<string, Record<string, unknown>> {
  const efforts = info.think_efforts?.valid_efforts ?? LEGACY_EFFORTS
  const variants: Record<string, Record<string, unknown>> = {
    // "auto" sends no effort at all and lets the server pick.
    auto: { reasoning_effort: "auto" },
  }
  for (const effort of efforts) variants[effort] = { reasoning_effort: effort }
  // Offering "off" on an always-thinking model would be a dead switch.
  if (info.supports_thinking_type !== "only") variants.off = { reasoning_effort: "off" }
  return variants
}

function baseModelEntry(info: KimiModelInfo): ModelWithDiscoveryMetadata {
  return {
    reasoning: info.supports_reasoning ?? true,
    options: {},
    variants: variantsFor(info),
  }
}

function withDiscoveredContext<T extends ModelWithDiscoveryMetadata>(model: T, contextLength: number | undefined): T {
  if (!contextLength || contextLength <= 0) return model
  if ((model.limit?.context ?? 0) > 0) return model
  return {
    ...model,
    limit: {
      ...model.limit,
      context: contextLength,
    },
  }
}

// An explicit `name` in the user's config wins over the API display_name —
// discovery only fills the gap when the config left it unset.
function withDiscoveredDisplayName<T extends ModelWithDiscoveryMetadata>(model: T, displayName: string | undefined): T {
  if (!displayName || model.name) return model
  return {
    ...model,
    name: displayName,
  }
}

function sameStrings(left: string[] | undefined, right: string[] | undefined) {
  if (left === right) return true
  if (!left || !right) return false
  if (left.length !== right.length) return false
  return left.every((value, index) => value === right[index])
}

function uniqueStrings(values: string[]) {
  return [...new Set(values)]
}

function withDiscoveredMediaInput<T extends ModelWithDiscoveryMetadata>(
  model: T,
  supportsImageIn: boolean | undefined,
  supportsVideoIn: boolean | undefined,
): T {
  if (supportsImageIn === undefined && supportsVideoIn === undefined) return model

  let changed = false
  let nextAttachment = model.attachment
  let nextModalities = model.modalities
  let nextCapabilities = model.capabilities

  if (supportsImageIn && model.attachment !== true) {
    nextAttachment = true
    changed = true
  }

  const currentInputModalities = model.modalities?.input
  const currentOutputModalities = model.modalities?.output
  const shouldPatchModalities =
    supportsImageIn || supportsVideoIn ||
    currentInputModalities?.includes("image") === true ||
    currentInputModalities?.includes("video") === true
  if (shouldPatchModalities) {
    const nextInputModalities = uniqueStrings([
      "text",
      ...(currentInputModalities ?? []),
      ...(supportsImageIn ? ["image"] : []),
      ...(supportsVideoIn ? ["video"] : []),
    ])
      .filter((value) => value !== "image" || supportsImageIn)
      .filter((value) => value !== "video" || supportsVideoIn)
    const nextOutputModalities = uniqueStrings(["text", ...(currentOutputModalities ?? [])])
    if (
      !sameStrings(currentInputModalities, nextInputModalities) ||
      !sameStrings(currentOutputModalities, nextOutputModalities)
    ) {
      nextModalities = {
        ...model.modalities,
        input: nextInputModalities,
        output: nextOutputModalities,
      }
      changed = true
    }
  }

  const currentCapabilityImage = model.capabilities?.input?.image
  const currentCapabilityAttachment = model.capabilities?.attachment
  if (currentCapabilityImage !== undefined && currentCapabilityImage !== supportsImageIn) {
    nextCapabilities = {
      ...nextCapabilities,
      input: {
        ...nextCapabilities?.input,
        image: supportsImageIn,
      },
    }
    changed = true
  }
  if (supportsImageIn && currentCapabilityAttachment !== undefined && currentCapabilityAttachment !== true) {
    nextCapabilities = {
      ...nextCapabilities,
      attachment: true,
    }
    changed = true
  }

  if (!changed) return model
  return {
    ...model,
    ...(nextAttachment === undefined ? {} : { attachment: nextAttachment }),
    ...(nextModalities ? { modalities: nextModalities } : {}),
    ...(nextCapabilities ? { capabilities: nextCapabilities } : {}),
  }
}

/**
 * Enriches each model with what `/coding/v1/models` reports for it, keyed by
 * wire id. Config-declared entries are kept and enriched rather than replaced,
 * so an explicit `name` or `limit` in opencode.json still wins.
 *
 * Entries for models the config does NOT declare are included too, but note
 * that opencode resolves `provider/model` against the config before this hook
 * runs — an undeclared model still fails with "Model not found". Verified
 * against opencode 1.4.x on 2026-08-08. So this makes discovered models
 * complete, not selectable; the config must declare the ids it wants, and
 * `buildConfigBlock()` prints exactly that block after login.
 */
function applyDiscoveryToModels<T extends Record<string, ModelWithDiscoveryMetadata>>(models: T, discovery: ModelDiscovery): T {
  if (discovery.size === 0) return models
  const next: Record<string, ModelWithDiscoveryMetadata> = { ...models }
  for (const [id, info] of discovery) {
    const configured = models[id]
    const base = configured ? { ...baseModelEntry(info), ...configured } : baseModelEntry(info)
    next[id] = withDiscoveredMediaInput(
      withDiscoveredContext(withDiscoveredDisplayName(base, info.display_name), info.context_length),
      info.supports_image_in,
      info.supports_video_in,
    )
  }
  return next as T
}

function buildConfigBlock(models: KimiModelInfo[]) {
  // Model keys are wire ids, so what gets pasted here is exactly what goes on
  // the wire — no translation layer to keep in sync.
  //
  // Intentionally omit `limit`: opencode's config schema requires
  // `limit.output` whenever a `limit` object is present, but Kimi's
  // `/coding/v1/models` discovery only tells us `context_length`. The
  // provider.models hook backfills `limit.context` at runtime.
  const modelConfigs: Record<string, unknown> = {}
  for (const info of models) {
    const modelConfig: Record<string, unknown> = {
      name: info.display_name ?? info.id,
      reasoning: info.supports_reasoning ?? true,
      options: {},
      variants: variantsFor(info),
    }
    if (info.supports_image_in) {
      // opencode's provider transform gates image parts on model metadata
      // before the request reaches our loader. Mirror Kimi's discovered
      // capability here so pasted images survive into the upstream SDK.
      modelConfig.attachment = true
      const inputModalities = ["text", "image"]
      if (info.supports_video_in) inputModalities.push("video")
      modelConfig.modalities = {
        input: inputModalities,
        output: ["text"],
      }
    }
    modelConfigs[info.id] = modelConfig
  }

  return JSON.stringify(
    {
      provider: {
        [PROVIDER_ID]: {
          npm: "@ai-sdk/openai-compatible",
          name: "Kimi",
          options: { baseURL: API_BASE_URL },
          models: modelConfigs,
        },
      },
    },
    null,
    2,
  )
}

/**
 * Plugin entry point.
 *
 * Responsibilities, in order of execution:
 *   1. `auth`    — register device-flow OAuth login under the
 *                  `kimi-code` provider id. opencode persists the returned tokens in its
 *                  own auth.json; the plugin also live-reads that file so
 *                  workspace auth snapshots do not strand stale refresh
 *                  tokens.
 *   2. `loader`  — runs every time opencode instantiates the provider. Returns
 *                  a custom `fetch` that (a) refreshes the access token when
 *                  it is about to expire, (b) injects the seven X-Msh-* / UA
 *                  headers on every upstream call (models list, chat, etc.),
 *                  (c) lazily discovers the current wire model id from
 *                  `GET /coding/v1/models`, and (d) retries once with a forced
 *                  refresh on 401.
 *   3. `provider.models` — discovers `context_length` / `display_name` early
 *                  enough to patch opencode's runtime model metadata when the
 *                  user's config still has the default placeholder values.
 *   4. `chat.headers` — computes the Kimi-specific request body fields the
 *                  model actually needs (`thinking.type`,
 *                  `reasoning_effort`, `prompt_cache_key`) and passes them to
 *                  `loader.fetch` via private headers.
 *   5. `chat.params` — mirrors the same fields into `output.options` for
 *                  forward-compat if opencode fixes its current
 *                  openai-compatible providerOptions namespace mismatch.
 */
const plugin: Plugin = async ({ client }) => {
  // --- helpers ---------------------------------------------------------------

  let cachedDiscovery: ModelDiscovery = new Map()
  let refreshPromise: Promise<OAuthAuth> | undefined

  const syncProcessAuthContent = (auth: OAuthAuth) => {
    if (!process.env.OPENCODE_AUTH_CONTENT) return
    try {
      const parsed = JSON.parse(process.env.OPENCODE_AUTH_CONTENT) as Record<string, unknown>
      delete parsed[`${PROVIDER_ID}/`]
      parsed[PROVIDER_ID] = auth
      process.env.OPENCODE_AUTH_CONTENT = JSON.stringify(parsed)
    } catch {}
  }

  const persistAuth = async (auth: OAuthAuth) => {
    await client.auth.set({ path: { id: PROVIDER_ID }, body: auth })
    syncProcessAuthContent(auth)
  }

  const rememberDiscovery = (discovery: ModelDiscovery) => {
    if (discovery.size > 0) cachedDiscovery = discovery
    return cachedDiscovery
  }

  const readLiveAuth = async () => {
    const auth = await readAuth()
    if (auth) syncProcessAuthContent(auth)
    return auth
  }

  const readCurrentAuth = async (readAuth?: () => Promise<unknown>) => {
    const live = await readLiveAuth()
    if (live) return live
    if (!readAuth) return
    const current = await readAuth()
    if (!isOAuthAuth(current)) return
    syncProcessAuthContent(current)
    return current
  }

  const refreshAuth = async (auth: OAuthAuth, force = false) => {
    // opencode can ask both `provider.models` and `loader.fetch` to refresh
    // around the same time, including from separate workspace processes that
    // only inherited a stale `OPENCODE_AUTH_CONTENT` snapshot. Serialize
    // refreshes through a lock and re-read opencode's live auth store before
    // spending the refresh token.
    if (refreshPromise) return refreshPromise
    refreshPromise = (async () => {
      try {
        return await refreshAuthWithLock(auth, {
          force,
          readLatest: readLiveAuth,
          persist: persistAuth,
        })
      } finally {
        refreshPromise = undefined
      }
    })()
    return refreshPromise
  }

  // --- return hooks ----------------------------------------------------------

  return {
    provider: {
      id: PROVIDER_ID,
      models: async (provider, ctx) => {
        if (!isOAuthAuth(ctx.auth)) return provider.models

        const discover = async (auth: OAuthAuth) =>
          applyDiscoveryToModels(provider.models, rememberDiscovery(indexModels(await listModels(auth.access))))

        const current = (await readCurrentAuth()) ?? ctx.auth
        let auth = current
        try {
          if (isAuthExpiring(auth)) auth = await refreshAuth(auth)
          return await discover(auth)
        } catch (error) {
          if (auth !== current || (error as { status?: number }).status !== 401) return provider.models
        }

        try {
          return await discover(await refreshAuth(current, true))
        } catch {
          return provider.models
        }
      },
    },
    auth: {
      provider: PROVIDER_ID,

      /**
       * Called every time opencode creates an `@ai-sdk/openai-compatible`
       * instance for this provider. We inject a `fetch` that owns all auth
       * and header concerns so no other hook has to worry about them.
       *
       * `readAuth` comes from opencode: it returns the currently persisted
       * credentials for this provider id. opencode workspace processes may
       * hydrate that from a stale `OPENCODE_AUTH_CONTENT` snapshot, so the
       * loader prefers the live auth.json entry on disk and only falls back to
       * `readAuth` when the file is absent. Writes still go through
       * `client.auth.set`.
       */
      loader: async (readAuth) => {
        const ensureFresh = async (force = false): Promise<OAuthAuth> => {
          const current = await readCurrentAuth(readAuth)
          if (!current || current.type !== "oauth")
            throw new Error(
              "kimi-code: not logged in — run `opencode auth login kimi-code`",
            )
          if (!force && !isAuthExpiring(current)) {
            // Warm the model cache on first use. chat.headers reads it to
            // learn each model's effort vocabulary, and provider.models has
            // not necessarily run in this process.
            if (cachedDiscovery.size === 0) {
              try {
                rememberDiscovery(indexModels(await listModels(current.access)))
              } catch {
                /* discovery is best-effort; conservative defaults apply */
              }
            }
            return current
          }
          const next = await refreshAuth(current, force)
          // kimi-cli re-runs `refresh_managed_models` on every successful
          // refresh — we mirror that so entitlement changes (a new model on
          // the plan) are picked up without a full re-login. Failures here
          // must not block the refresh: the warm cache still serves the
          // common case, and the request-path 401 retry flushes a broken
          // access token.
          try {
            rememberDiscovery(indexModels(await listModels(next.access)))
          } catch {
            /* keep previous discovery */
          }
          return next
        }

        return {
          // We own the Authorization header entirely, but opencode still
          // requires a truthy apiKey to wire things up; use a sentinel.
          apiKey: "kimi-code",
          fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
            const doRequest = async (auth: OAuthAuth) => {
              const headers = new Headers(input instanceof Request ? input.headers : undefined)
              new Headers(init?.headers).forEach((value, key) => {
                headers.set(key, value)
              })
              // opencode currently namespaces providerOptions for
              // @ai-sdk/openai-compatible under the provider id, while the SDK
              // reads them back under the human provider name. Carry Kimi-only
              // body fields through private headers instead so the wire request
              // stays correct regardless of that upstream mismatch.
              const kimiBodyFields = consumeInternalKimiBodyFields(headers)
              // Strip anything the upstream SDK put on. Our values win.
              headers.delete("authorization")
              headers.delete("Authorization")
              for (const [k, v] of Object.entries(kimiHeaders())) headers.set(k, v)
              headers.set("Authorization", `Bearer ${auth.access}`)

              // opencode model keys are wire ids, so the `model` field already
              // on the body is exactly what Moonshot expects — only the
              // Kimi-only fields need splicing in.
              let newInit = init
              const originalBody =
                typeof init?.body === "string"
                  ? init.body
                  : input instanceof Request && init?.body === undefined
                    ? await input
                        .clone()
                        .text()
                        .catch(() => undefined)
                    : undefined
              if (hasKimiBodyFields(kimiBodyFields) && originalBody) {
                try {
                  const parsed = JSON.parse(originalBody)
                  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                    applyKimiBodyFields(parsed as Record<string, unknown>, kimiBodyFields)
                    newInit = { ...init, body: JSON.stringify(parsed) }
                  }
                } catch {
                  /* non-JSON body, e.g. multipart — leave alone */
                }
              }

              return fetch(input, { ...newInit, headers })
            }

            let auth = await ensureFresh()
            let res = await doRequest(auth)
            if (res.status === 401) {
              // Token might have been invalidated server-side before its
              // nominal expiry. Force a refresh and retry exactly once.
              auth = await ensureFresh(true)
              res = await doRequest(auth)
            }
            return res
          },
        }
      },

      methods: [
        {
          type: "oauth",
          label: "Kimi Code (device flow)",
          authorize: async () => {
            const device = await startDeviceAuth()
            const url = device.verification_uri_complete ?? device.verification_uri
            return {
              url,
              instructions: `Open the URL above and approve code ${device.user_code}. This window will continue automatically.`,
              method: "auto",
              callback: async () => {
                try {
                  const tokens = await pollDeviceToken(device)
                  // Discover the account's real model entitlement right
                  // after approval (mirrors kimi-cli's login flow).
                  // Failures here degrade gracefully — the plugin still
                  // works; users just don't see the config-block hint, and
                  // the provider.models hook rediscovers on next start.
                  try {
                    const discovered = await listModels(tokens.access_token)
                    if (discovered.length) {
                      // Print a ready-to-paste config block. opencode shows
                      // this next to the "Authorized" message.
                      const block = buildConfigBlock(discovered)
                      console.log(
                        `\n✓ Authorized for Kimi (${discovered.length} model${discovered.length === 1 ? "" : "s"}: ${discovered
                          .map((m) => m.id)
                          .join(", ")})\n\nAdd this to your opencode config (~/.config/opencode/opencode.json) if you haven't already:\n\n${block}\n`,
                      )
                    }
                  } catch {
                    /* non-fatal */
                  }
                  return {
                    type: "success",
                    refresh: tokens.refresh_token,
                    access: tokens.access_token,
                    expires: Date.now() + tokens.expires_in * 1000,
                  }
                } catch {
                  return { type: "failed" }
                }
              },
            }
          },
        },
      ],
    },

    "chat.headers": async (input, output) => {
      const hook = input as KimiHookInput
      const fields = resolveKimiBodyFields(hook, cachedDiscovery.get(hook.model.id))
      if (!fields) return
      if (fields.prompt_cache_key) {
        output.headers[INTERNAL_PROMPT_CACHE_KEY_HEADER] = fields.prompt_cache_key
      }
      if (fields.reasoning_effort) {
        output.headers[INTERNAL_REASONING_EFFORT_HEADER] = fields.reasoning_effort
      }
      if (fields.thinking) {
        output.headers[INTERNAL_THINKING_TYPE_HEADER] = fields.thinking.type
      }
    },

    /**
     * Mirror Kimi-specific body fields into providerOptions when possible.
     *
     * The real load-bearing path is `chat.headers` → `loader.fetch`, because
     * current opencode/openai-compatible builds disagree on the providerOptions
     * namespace. We still normalize `output.options` so the plugin keeps
     * working if upstream aligns those keys later.
     */
    "chat.params": async (input, output) => {
      const hook = input as KimiHookInput
      const fields = resolveKimiBodyFields(hook, cachedDiscovery.get(hook.model.id))
      if (!fields) return
      applyKimiBodyFields(output.options, fields)
    },
  }
}

// v1 PluginModule format — bypasses getLegacyPlugins entirely.
// For npm-sourced plugins, id is optional (falls back to package.json name),
// but we set it explicitly for clarity.
export default {
  id: "opencode-kimi-full",
  server: plugin,
} satisfies PluginModule
