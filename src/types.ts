/**
 * Shared types.
 *
 * These are intentionally local interfaces rather than imports from
 * `@deepseek-ai/dsh-*`: under a link install, Node resolves host packages from
 * the plugin's physical path, where they do not exist. The runtime accepts plain
 * objects, so structural types are enough.
 */

/** What a model can produce. */
export type ModelKind = 'image' | 'video'

/** How image edits are sent. OpenAI takes multipart; some compatible providers take JSON. */
export type ImageEditMode = 'multipart' | 'json'

/** Accepted image endpoint dialect. Kept open for future adapters. */
export type ImageProtocol = 'openai-images'

/**
 * Video endpoint dialect.
 *
 * - `openai-videos`: `POST /videos`, `GET /videos/{id}`, `GET /videos/{id}/content`.
 * - `async-videos`:  `POST /videos/generations`, then `GET /videos/{id}` until a URL appears.
 *   This is the shape used by xAI Imagine and by many OpenAI-compatible gateways.
 * - `videos-generations`: `POST /videos/generations` that buffers the job and returns a
 *   `videos` array (`url` or `b64_video`) in the same response. This is the Cheaper
 *   Inference shape; it can take minutes per request.
 */
export type VideoProtocol = 'openai-videos' | 'async-videos' | 'videos-generations'

/** One selected model inside a provider. */
export interface ModelConfig {
  /** Model id as sent to the provider. */
  id: string
  /** What this model generates. */
  kind: ModelKind
  /** Optional display override. */
  label?: string
  /** Optional endpoint dialect override. */
  protocol?: string
  /** Optional image edit mode override. */
  editMode?: ImageEditMode
  /** Optional default size, e.g. `1024x1024`. */
  size?: string
  /** Optional default quality, e.g. `high`. */
  quality?: string
  /** Optional default duration for video, in seconds, as a string the provider accepts. */
  seconds?: string
  /** Optional default aspect ratio for video, e.g. `16:9`. */
  aspectRatio?: string
}

/** One configured OpenAI-compatible provider. Contains no secret, only a reference. */
export interface ProviderConfig {
  /** Stable slug used by tools. */
  id: string
  /** Display label. */
  label?: string
  /** API root, e.g. `https://api.openai.com/v1`. */
  baseUrl: string
  /** Name of the credential that holds the key. Never the key itself. */
  apiKeyEnv: string
  /** Header carrying the key; default `Authorization`. */
  apiKeyHeader?: string
  /** Value prefix, default `Bearer `. An empty string sends the raw key. */
  apiKeyPrefix?: string
  /** Optional `OpenAI-Organization` header. */
  organization?: string
  /** Optional `OpenAI-Project` header. */
  project?: string
  /** Extra non-secret headers. */
  headers?: Record<string, string>
  /** Models the user selected for this provider. */
  models: ModelConfig[]
}

/** Raw config object accepted by `apply` / read from disk. All fields optional. */
export interface PluginConfigInput {
  providers?: unknown
  outputDir?: unknown
  requestTimeoutMs?: unknown
  imageTimeoutMs?: unknown
  videoTimeoutMs?: unknown
  pollIntervalMs?: unknown
  maxDownloadBytes?: unknown
  maxImagesPerCall?: unknown
  writeMetadata?: unknown
  debug?: unknown
}

/** Fully resolved config used by tools. */
export interface ResolvedConfig {
  providers: ProviderConfig[]
  /** Problems found while normalizing configuration; reported, never thrown at load time. */
  problems: string[]
  outputDir?: string
  requestTimeoutMs: number
  imageTimeoutMs: number
  videoTimeoutMs: number
  pollIntervalMs: number
  maxDownloadBytes: number
  maxImagesPerCall: number
  writeMetadata: boolean
}

/** A resolved credential, never logged or returned to the browser. */
export interface ApiKey {
  value: string
  source: string
}

/** Host context surface used by this plugin. */
export interface HostContextLike {
  reflect?: { get?: (key: string, strict?: boolean) => unknown }
  get?: (key: string) => unknown
  inject?: (services: string[], callback: (context: HostContextLike) => void) => void
  effect?: (body: () => unknown, label?: string) => unknown
  fiber?: unknown
  logger?: { info?: (message: string) => void; warn?: (message: string) => void }
}

/** Minimal execution context passed to tool execute. */
export interface ToolExecLike {
  signal?: AbortSignal
  agent?: unknown
}

/** One generated file plus the facts worth putting in the tool result. */
export interface GeneratedFile {
  path: string
  bytes: number
  contentType: string
  revisedPrompt?: string
}

/** Result returned by the image tool. */
export interface ImageToolResult {
  text: string
  path: string
  files: string[]
  provider: string
  model: string
  mode: 'generate' | 'edit'
  revised_prompts: string[]
  width: number
  height: number
  duration_ms: number
  metadata_path?: string
  notes: string[]
}

/** Result returned by the video tool. */
export interface VideoToolResult {
  text: string
  path: string
  files: string[]
  provider: string
  model: string
  job_id: string
  duration_seconds: number
  width: number
  height: number
  duration_ms: number
  metadata_path?: string
  notes: string[]
}

/** Result of the provider discovery tool. */
export interface ProvidersToolResult {
  text: string
  providers: Array<{
    id: string
    label: string
    baseUrl: string
    keyConfigured: boolean
    keySource: string | null
    models: Array<{ id: string; kind: string; label: string }>
    liveModels?: Array<{ id: string; kind: string | null }>
    error?: string
  }>
  notes: string[]
}
