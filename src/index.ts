/**
 * Plugin entry point (host side).
 *
 * Mounting: after loading this package the DSH Loader calls `apply(ctx, config)`.
 * `inject = ['tools']` guarantees `ctx.reflect.get('tools')` can obtain the tool
 * registry. No `@deepseek-ai/*` host package is imported at runtime: under a
 * link install Node resolves modules from the plugin's physical path, where
 * host packages do not exist. `tools.register()` accepts a plain object, so
 * structural types are enough.
 */
import { resolveConfig } from './config.js'
import { PLUGIN_DISPLAY_NAME, PLUGIN_ID, PLUGIN_VERSION } from './identity.js'
import { logInfo, logWarn } from './log.js'
import type { HostContextLike } from './types.js'
import { registerTools } from './tools.js'
import { registerOpenAIProviderRoutes } from './web-route.js'

/** Plugin name (also the default loader entry id). */
export const name = PLUGIN_ID

/** The tool registry service this plugin depends on. */
export const inject = ['tools']

interface ToolRegistryLike {
  register: (definition: unknown) => unknown
}

/** Get the tool registry; returns undefined when unavailable (never take DSH down). */
function getToolRegistry(ctx: HostContextLike): ToolRegistryLike | undefined {
  const candidates: unknown[] = []
  try {
    if (typeof ctx.reflect?.get === 'function') {
      candidates.push(ctx.reflect.get('tools', false))
      candidates.push(ctx.reflect.get('tools'))
    }
  } catch {
    /* registry may not be active yet; the inject guarantee normally covers this */
  }
  try {
    if (typeof ctx.get === 'function') candidates.push(ctx.get('tools'))
  } catch {
    /* same */
  }
  for (const candidate of candidates) {
    if (candidate !== null && typeof candidate === 'object' && typeof (candidate as ToolRegistryLike).register === 'function') {
      return candidate as ToolRegistryLike
    }
  }
  return undefined
}

/**
 * Plugin body.
 *
 * @param ctx    Host context
 * @param config Plugin config (the contents of `config:` in the profile, may be empty)
 */
export function apply(ctx: HostContextLike, config?: unknown): void {
  const tools = getToolRegistry(ctx)
  if (tools === undefined) {
    logWarn('Cannot obtain the tools service; the OpenAI provider tools were not registered (check the plugin dependencies in the profile).')
    return
  }

  registerTools(tools, config, ctx)

  // The plugin page is custom, so tell DSH's settings service not to add an
  // auto-generated form for this entry. The child is optional: tools keep
  // working on hosts that do not compose the settings service.
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['settings'], (settingsCtx) => {
        try {
          const settings = (settingsCtx as { settings?: { configure?: (options: { auto: boolean }, fiber: unknown) => void } }).settings
          settings?.configure?.({ auto: false }, ctx.fiber)
        } catch {
          /* an older settings service may not support the policy; the page still works */
        }
      })
    } catch {
      /* optional service */
    }
  }

  // Same-origin model discovery for the settings page. Best effort: a headless
  // composition without a web server simply falls back to manual model ids.
  registerOpenAIProviderRoutes(ctx, config)

  // One summary line at startup. No network request here: startup stays fast and
  // a provider being down must not delay DSH.
  const resolved = resolveConfig(config)
  const modelCount = resolved.providers.reduce((total, provider) => total + provider.models.length, 0)
  logInfo(
    `${PLUGIN_DISPLAY_NAME} v${PLUGIN_VERSION} ready: ${resolved.providers.length} provider(s), ${modelCount} exposed model(s). ` +
      'Tools: openai_providers, openai_generate_image, openai_generate_video.'
  )
  for (const problem of resolved.problems) logWarn(problem)
  if (resolved.providers.length === 0) {
    logInfo('No providers configured yet. Add one at DSH → Plugins → Plugins → OpenAI Providers.')
  }
}

/* ─────────────── Re-exports for local tests (unit-testable without starting DSH) ─────────────── */
export { Config } from './config-schema.js'
export {
  CREDENTIAL_REF_PATTERN,
  DEFAULTS,
  PROVIDER_ID_PATTERN,
  configFilePath,
  configFromEnv,
  deriveCredentialRef,
  guessModelKind,
  isCredentialRefName,
  normalizeBaseUrl,
  normalizeProvider,
  normalizeProviders,
  readConfigFile,
  resolveConfig,
  slugify,
  unwrapVolatile
} from './config.js'
export { PLUGIN_DISPLAY_NAME, PLUGIN_ID, PLUGIN_VERSION, ROUTE_HEADER, ROUTE_PREFIX } from './identity.js'
export { ProviderPluginError, formatError } from './errors.js'
export { describeApiKey, getService, redactDeep, redactSecrets, resolveApiKey } from './credentials.js'
export { discoverProviderModels, probeProvider } from './discovery.js'
export {
  editModeFor,
  modelLabel,
  modelsOfKind,
  selectModel,
  selectProvider,
  selectProviderForKind,
  supportsKind,
  videoProtocolFor
} from './models.js'
export { authHeaders, extractApiError, httpError, joinUrl, parseBaseUrl, requestJson } from './http.js'
export {
  IMAGE_EXTENSIONS,
  VIDEO_EXTENSIONS,
  imageDimensions,
  parseDimensions,
  resolveCwd,
  resolveOutputTarget,
  resolveSessionCwd,
  sanitizeComponent,
  sniffImageExtension,
  sniffVideoExtension,
  uniquePath
} from './files.js'
export { imageItemsFrom, callImageApi } from './api/images.js'
export { pollVideo, startVideo, videoUrlFrom, waitForVideo } from './api/videos.js'
export { downloadMedia, writeBase64Image, writeBase64Video, writeBuffer } from './api/media.js'
export { runImageGeneration, runVideoGeneration } from './runner.js'
export {
  IMAGE_DESCRIPTION,
  IMAGE_OUTPUT,
  IMAGE_PARAMETERS,
  IMAGE_TOOL_NAME,
  PROVIDERS_DESCRIPTION,
  PROVIDERS_OUTPUT,
  PROVIDERS_PARAMETERS,
  PROVIDERS_TOOL_NAME,
  VIDEO_DESCRIPTION,
  VIDEO_OUTPUT,
  VIDEO_PARAMETERS,
  VIDEO_TOOL_NAME,
  createImageTool,
  createProvidersTool,
  createVideoTool,
  registerTools
} from './tools.js'
export { createModelsRouteHandler, registerOpenAIProviderRoutes } from './web-route.js'
export type {
  ImageToolResult,
  ModelConfig,
  ModelKind,
  PluginConfigInput,
  ProviderConfig,
  ProvidersToolResult,
  ResolvedConfig,
  VideoToolResult
} from './types.js'
