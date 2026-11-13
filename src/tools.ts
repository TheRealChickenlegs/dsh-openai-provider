/**
 * The public tool contract exposed to the agent.
 *
 * Three tools:
 * - `openai_providers`      what endpoints and models are available (and a live refresh)
 * - `openai_generate_image` text-to-image and image edits
 * - `openai_generate_video` asynchronous video generation
 *
 * Two hard constraints, verified against @deepseek-ai/dsh-tools:
 *   1. `parameters` is a RAW JSON Schema, not a DSL.
 *   2. Only the enforced subset is allowed: type / oneOf / properties / required /
 *      additionalProperties / items / enum / const + annotations. Ranges, patterns
 *      and formats are written in descriptions and validated at runtime instead.
 */
import { resolveConfig } from './config.js'
import { formatError } from './errors.js'
import { logDebug } from './log.js'
import { describeApiKey, resolveApiKey, redactSecrets } from './credentials.js'
import { discoverProviderModels } from './discovery.js'
import { selectProvider } from './models.js'
import { runImageGeneration, runVideoGeneration } from './runner.js'
import type { ImageArgs } from './api/images.js'
import type { VideoArgs } from './api/videos.js'
import { describeModel } from './models.js'
import type {
  HostContextLike,
  ImageToolResult,
  ProvidersToolResult,
  ToolExecLike,
  VideoToolResult
} from './types.js'

export const PROVIDERS_TOOL_NAME = 'openai_providers'
export const IMAGE_TOOL_NAME = 'openai_generate_image'
export const VIDEO_TOOL_NAME = 'openai_generate_video'

export const PROVIDERS_DESCRIPTION =
  'List configured providers, exposed media models, and API-key status. Set refresh=true to query live /models; include_unselected=true also lists unexposed media models. No key values are returned.'

export const IMAGE_DESCRIPTION =
  'Generate or edit an image using an exposed model. Set input_image to edit (optionally mask_image); otherwise generates from prompt. Use openai_providers to find provider/model ids. Returns saved image paths.'

export const VIDEO_DESCRIPTION =
  'Generate a video using an exposed model. Use openai_providers to find provider/model ids. Optional input_image supplies a start/reference frame; result includes the saved video path. Jobs may take minutes.'

export const PROVIDERS_PARAMETERS = {
  type: 'object',
  properties: {
    provider: {
      type: 'string',
      description: 'Provider id; omit for all.'
    },
    refresh: {
      type: 'boolean',
      description: 'Query live /models (network request only).'
    },
    include_unselected: {
      type: 'boolean',
      description: 'With refresh, include unexposed media models.'
    }
  },
  required: [],
  additionalProperties: false
} as const

export const IMAGE_PARAMETERS = {
  type: 'object',
  properties: {
    prompt: {
      type: 'string',
      description: 'Text description of the image (required). For edits, describe the change.'
    },
    provider: {
      type: 'string',
      description: 'Provider id; optional when unambiguous.'
    },
    model: {
      type: 'string',
      description: 'Exposed model id; optional when unambiguous.'
    },
    input_image: {
      type: 'string',
      description:
        'Local image path for an edit. With a prompt, the call uses /images/edits instead of /images/generations.'
    },
    mask_image: {
      type: 'string',
      description: 'Optional mask for an edit (same dimensions as input_image). Requires input_image.'
    },
    size: {
      type: 'string',
      description: 'Provider-specific size string, e.g. 1024x1024, 1536x1024, 1024x1536, 1792x1024, or auto.'
    },
    quality: {
      type: 'string',
      description: 'Provider-specific quality, e.g. low / medium / high / auto / standard / hd.'
    },
    background: {
      type: 'string',
      description: 'Background mode where supported, e.g. transparent / opaque / auto.'
    },
    output_format: {
      type: 'string',
      description: 'Requested file format where supported: png, jpeg, or webp. The saved file always reflects the real bytes.'
    },
    output_compression: {
      type: 'integer',
      description: 'Provider-specific compression 0-100 for jpeg/webp, where supported.'
    },
    response_format: {
      type: 'string',
      description: 'Optional response_format for providers that require it (url or b64_json). Usually omit.'
    },
    style: {
      type: 'string',
      description: 'Model-specific style, e.g. vivid or natural for DALL-E 3.'
    },
    moderation: {
      type: 'string',
      description: 'Provider-specific moderation level, e.g. low or auto.'
    },
    n: {
      type: 'integer',
      description: 'Number of images, 1-10; capped by the plugin setting (default max 4) to bound cost.'
    },
    seed: {
      type: 'integer',
      description: 'Seed where the provider supports one; omitted otherwise.'
    },
    user: {
      type: 'string',
      description: 'Optional provider user/tenant identifier.'
    },
    output_path: {
      type: 'string',
      description: 'Output directory or single-file path; defaults to session cwd. Existing files are not overwritten.'
    },
    extra: {
      type: 'object',
      additionalProperties: true,
      description:
        'Provider-specific JSON fields merged into the request body. Use only for documented options the typed arguments do not cover.'
    }
  },
  required: ['prompt'],
  additionalProperties: false
} as const

export const VIDEO_PARAMETERS = {
  type: 'object',
  properties: {
    prompt: { type: 'string', description: 'Text description of the video (required).' },
    provider: {
      type: 'string',
      description: 'Provider id; optional when unambiguous.'
    },
    model: {
      type: 'string',
      description: 'Exposed model id; optional when unambiguous.'
    },
    input_image: {
      type: 'string',
      description: 'Optional start/reference frame: a local path or a public http(s) URL. Cheaper Inference image-to-video requires a public https URL; local paths and /v1/uploads file ids are rejected.'
    },
    seconds: {
      type: 'string',
      description: 'Clip duration the provider accepts, e.g. "4", "8", "12", or "15".'
    },
    size: {
      type: 'string',
      description: 'Output size as widthxheight, where the provider supports it (720x1280, 1280x720, ...).'
    },
    aspect_ratio: {
      type: 'string',
      description: 'Aspect ratio for the async dialect, e.g. 16:9, 9:16, 1:1.'
    },
    resolution: {
      type: 'string',
      description: 'Named resolution for the async dialect where supported, e.g. 720p, 1080p.'
    },
    seed: { type: 'integer', description: 'Seed where the provider supports one.' },
    output_path: {
      type: 'string',
      description: 'Output directory or file path; defaults to session cwd. Existing files are not overwritten.'
    },
    extra: {
      type: 'object',
      additionalProperties: true,
      description: 'Provider-specific JSON fields merged into the submit body.'
    }
  },
  required: ['prompt'],
  additionalProperties: false
} as const

export const PROVIDERS_OUTPUT = {
  type: 'object',
  properties: {
    text: { type: 'string', description: 'Human/model-facing summary' },
    providers: {
      type: 'array',
      description: 'Configured providers',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          label: { type: 'string' },
          baseUrl: { type: 'string' },
          keyConfigured: { type: 'boolean' },
          keySource: { type: 'string' },
          models: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                kind: { type: 'string' },
                label: { type: 'string' }
              },
              required: ['id', 'kind', 'label'],
              additionalProperties: false
            }
          },
          liveModels: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                kind: { type: 'string' }
              },
              required: ['id', 'kind'],
              additionalProperties: false
            }
          },
          error: { type: 'string' }
        },
        required: ['id', 'label', 'baseUrl', 'keyConfigured', 'keySource', 'models'],
        additionalProperties: false
      }
    },
    notes: { type: 'array', items: { type: 'string' } }
  },
  required: ['text', 'providers', 'notes'],
  additionalProperties: false
} as const

export const IMAGE_OUTPUT = {
  type: 'object',
  properties: {
    text: { type: 'string', description: 'Complete result description with Image paths' },
    path: { type: 'string', description: 'First produced image (absolute path)' },
    files: { type: 'array', items: { type: 'string' }, description: 'All produced files' },
    provider: { type: 'string' },
    model: { type: 'string' },
    mode: { type: 'string', description: 'generate or edit' },
    revised_prompts: { type: 'array', items: { type: 'string' } },
    width: { type: 'integer', description: 'Pixel width, 0 when unknown' },
    height: { type: 'integer', description: 'Pixel height, 0 when unknown' },
    duration_ms: { type: 'integer' },
    metadata_path: { type: 'string' },
    notes: { type: 'array', items: { type: 'string' } }
  },
  required: [
    'text',
    'path',
    'files',
    'provider',
    'model',
    'mode',
    'revised_prompts',
    'width',
    'height',
    'duration_ms',
    'notes'
  ],
  additionalProperties: false
} as const

export const VIDEO_OUTPUT = {
  type: 'object',
  properties: {
    text: { type: 'string', description: 'Complete result description with the Video path' },
    path: { type: 'string', description: 'Produced video (absolute path)' },
    files: { type: 'array', items: { type: 'string' } },
    provider: { type: 'string' },
    model: { type: 'string' },
    job_id: { type: 'string' },
    duration_seconds: { type: 'number', description: 'Clip duration, 0 when unknown' },
    width: { type: 'integer', description: 'Pixel width, 0 when unknown' },
    height: { type: 'integer', description: 'Pixel height, 0 when unknown' },
    duration_ms: { type: 'integer' },
    metadata_path: { type: 'string' },
    notes: { type: 'array', items: { type: 'string' } }
  },
  required: [
    'text',
    'path',
    'files',
    'provider',
    'model',
    'job_id',
    'duration_seconds',
    'width',
    'height',
    'duration_ms',
    'notes'
  ],
  additionalProperties: false
} as const

/** Minimal tool registry surface; no host package import. */
interface ToolRegistryLike {
  register: (definition: unknown) => unknown
}

function textOf(value: unknown): string {
  const record = value as { text?: unknown } | undefined
  return typeof record?.text === 'string' ? record.text : ''
}

/** Build the provider discovery tool. */
export function createProvidersTool(pluginConfig?: unknown, host?: HostContextLike): Record<string, unknown> {
  return {
    name: PROVIDERS_TOOL_NAME,
    description: PROVIDERS_DESCRIPTION,
    parameters: PROVIDERS_PARAMETERS,
    output: {
      schema: PROVIDERS_OUTPUT,
      render: (_args: unknown, value: unknown): unknown[] => [{ type: 'text', text: textOf(value) }],
      presentationMeta: (_args: unknown, value: unknown): Record<string, unknown> => ({
        kind: 'openai-providers',
        providers: Array.isArray((value as ProvidersToolResult | undefined)?.providers)
          ? (value as ProvidersToolResult).providers.length
          : 0
      })
    },
    async execute(args: unknown, exec?: ToolExecLike): Promise<ProvidersToolResult> {
      const config = resolveConfig(pluginConfig)
      const input = (args ?? {}) as { provider?: string; refresh?: boolean; include_unselected?: boolean }
      const selected =
        typeof input.provider === 'string' && input.provider.trim() !== ''
          ? [selectProvider(config, input.provider)]
          : config.providers
      const notes: string[] = [...config.problems]
      const providers: ProvidersToolResult['providers'] = []
      const detailsById = new Map<string, Map<string, string>>()
      for (const provider of selected) {
        const keyInfo = await describeApiKey(host, provider)
        const entry: ProvidersToolResult['providers'][number] = {
          id: provider.id,
          label: provider.label ?? provider.id,
          baseUrl: provider.baseUrl,
          keyConfigured: keyInfo.configured,
          keySource: keyInfo.source ?? '',
          models: provider.models.map((model) => ({ id: model.id, kind: model.kind, label: model.label ?? model.id }))
        }
        if (input.refresh === true) {
          let keyValue: string | undefined
          try {
            const key = await resolveApiKey(host, provider)
            keyValue = key.value
            const live = await discoverProviderModels({
              provider,
              key: key.value,
              config,
              ...(exec?.signal ? { signal: exec.signal } : {})
            })
            const exposed = new Set(provider.models.map((model) => model.id))
            entry.liveModels = live.models
              .filter((model) => input.include_unselected === true || exposed.has(model.id))
              .map((model) => ({ id: model.id, kind: model.kind ?? '' }))
            if (live.truncated) notes.push(`Provider "${provider.id}" model list was truncated.`)
            if (live.models.length === 0) notes.push(`Provider "${provider.id}" returned no models.`)
          } catch (error) {
            entry.error = redactSecrets(formatError(error), [keyValue])
            notes.push(`Could not refresh "${provider.id}" models: ${entry.error}`)
          }
        }
        detailsById.set(provider.id, new Map(provider.models.map((model) => [model.id, describeModel(model)])))
        providers.push(entry)
      }

      const lines: string[] = []
      if (providers.length === 0) {
        lines.push('No OpenAI-compatible providers are configured yet.')
        lines.push(
          'Tell the user to open DSH → Plugins → Plugins → OpenAI Providers, add an endpoint and API key, click "Load models", tick the models to expose, and save.'
        )
      } else {
        lines.push(
          `${providers.length} provider${providers.length === 1 ? '' : 's'} configured. Model generation tools only accept the exposed ids below.`
        )
      }
      for (const entry of providers) {
        lines.push('')
        lines.push(`Provider: ${entry.id}${entry.label !== entry.id ? ` (${entry.label})` : ''}`)
        lines.push(`  Endpoint: ${entry.baseUrl}`)
        lines.push(
          `  API key: ${entry.keyConfigured ? `configured (${entry.keySource})` : 'NOT configured — save it on the plugin page or export the reference'}`
        )
        if (entry.models.length === 0) {
          lines.push('  Exposed models: none yet — load models and tick a few on the plugin page.')
        } else {
          lines.push('  Exposed models:')
          const details = detailsById.get(entry.id)
          for (const model of entry.models) lines.push(`    - ${details?.get(model.id) ?? `${model.id} [${model.kind}]`}`)
        }
        if (entry.liveModels !== undefined) {
          if (entry.liveModels.length > 0) {
            lines.push(
              `  Live /models (${entry.liveModels.length}${input.include_unselected === true ? '' : ', exposed only'}):`
            )
            for (const model of entry.liveModels.slice(0, 80)) {
              lines.push(`    - ${model.id}${model.kind !== '' ? ` [${model.kind}]` : ''}`)
            }
            if (entry.liveModels.length > 80) lines.push('    … (list truncated in the summary)')
          } else if (entry.error === undefined) {
            lines.push('  Live /models: no matching models')
          }
        }
        if (entry.error !== undefined) lines.push(`  Live /models error: ${entry.error}`)
      }
      if (notes.length > 0) {
        lines.push('')
        lines.push('Notes:')
        for (const note of notes) lines.push(`  - ${note}`)
      }
      return { text: lines.join('\n'), providers, notes }
    }
  }
}

/** Build the image generation tool. */
export function createImageTool(pluginConfig?: unknown, host?: HostContextLike): Record<string, unknown> {
  return {
    name: IMAGE_TOOL_NAME,
    description: IMAGE_DESCRIPTION,
    parameters: IMAGE_PARAMETERS,
    output: {
      schema: IMAGE_OUTPUT,
      render: (_args: unknown, value: unknown): unknown[] => [{ type: 'text', text: textOf(value) }],
      presentationMeta: (_args: unknown, value: unknown): Record<string, unknown> => {
        const result = value as ImageToolResult | undefined
        return {
          kind: 'image-generation',
          path: result?.path ?? '',
          files: result?.files ?? [],
          model: result?.model ?? '',
          provider: result?.provider ?? ''
        }
      }
    },
    async execute(args: unknown, exec?: ToolExecLike): Promise<ImageToolResult> {
      logDebug('openai image execute', { provider: (args as { provider?: string } | undefined)?.provider })
      const config = resolveConfig(pluginConfig)
      return runImageGeneration(
        {
          ...(host !== undefined ? { host } : {}),
          config,
          ...(exec !== undefined ? { exec } : {})
        },
        (args ?? {}) as ImageArgs
      )
    }
  }
}

/** Build the video generation tool. */
export function createVideoTool(pluginConfig?: unknown, host?: HostContextLike): Record<string, unknown> {
  return {
    name: VIDEO_TOOL_NAME,
    description: VIDEO_DESCRIPTION,
    parameters: VIDEO_PARAMETERS,
    output: {
      schema: VIDEO_OUTPUT,
      render: (_args: unknown, value: unknown): unknown[] => [{ type: 'text', text: textOf(value) }],
      presentationMeta: (_args: unknown, value: unknown): Record<string, unknown> => {
        const result = value as VideoToolResult | undefined
        return {
          kind: 'video-generation',
          path: result?.path ?? '',
          files: result?.files ?? [],
          model: result?.model ?? '',
          provider: result?.provider ?? ''
        }
      }
    },
    async execute(args: unknown, exec?: ToolExecLike): Promise<VideoToolResult> {
      logDebug('openai video execute', { provider: (args as { provider?: string } | undefined)?.provider })
      const config = resolveConfig(pluginConfig)
      return runVideoGeneration(
        {
          ...(host !== undefined ? { host } : {}),
          config,
          ...(exec !== undefined ? { exec } : {})
        },
        (args ?? {}) as VideoArgs
      )
    }
  }
}

/** Register every tool against a registry; returns the number registered. */
export function registerTools(
  registry: ToolRegistryLike,
  pluginConfig: unknown,
  host: HostContextLike | undefined
): number {
  registry.register(createProvidersTool(pluginConfig, host))
  registry.register(createImageTool(pluginConfig, host))
  registry.register(createVideoTool(pluginConfig, host))
  return 3
}
