/**
 * Video generation adapters.
 *
 * Three dialects are supported because "OpenAI-compatible video" is not settled:
 *
 * - `openai-videos` — `POST /videos`, `GET /videos/{id}`, then
 *   `GET /videos/{id}/content` (the OpenAI Sora shape; the hosted API was
 *   retired, but compatible gateways still implement it).
 * - `async-videos` — `POST /videos/generations`, then `GET /videos/{id}` until
 *   a URL appears (the shape documented by xAI Imagine and several gateways).
 * - `videos-generations` — `POST /videos/generations` that buffers the job and
 *   returns a `videos` array (`url` or `b64_video`) in the same response. This
 *   is Cheaper Inference's shape; a single request can take minutes.
 *
 * The async dialects poll; the buffered dialect returns media immediately and
 * uses the video deadline for its one long request.
 */
import { ProviderPluginError, badResponse, timedOut } from '../errors.js'
import { authHeaders, joinUrl, requestJson } from '../http.js'
import { readInputImage, toDataUri } from '../files.js'
import type { ModelConfig, ProviderConfig, ResolvedConfig, VideoProtocol } from '../types.js'
import { videoProtocolFor } from '../models.js'

export interface VideoArgs {
  /** Provider id chosen by the caller (selection happens in the runner). */
  provider?: string
  /** Model id chosen by the caller (selection happens in the runner). */
  model?: string
  /** Output location, handled by the runner. */
  output_path?: string
  prompt: string
  input_image?: string
  seconds?: string
  size?: string
  aspect_ratio?: string
  resolution?: string
  seed?: number
  extra?: Record<string, unknown>
}

export interface VideoStart {
  protocol: VideoProtocol
  /** Provider job id, when the provider assigns one immediately. */
  id?: string
  /** A URL returned synchronously (rare, but some gateways answer with a finished job). */
  url?: string
  /** Base64 MP4 returned by a buffered endpoint. */
  b64?: string
  contentType?: string
  /** Provider request id, when it is useful for support/feedback. */
  requestId?: string
  request: Record<string, unknown>
  raw: unknown
}

export interface VideoPoll {
  status: 'pending' | 'done' | 'failed'
  rawStatus: string
  progress?: number
  url?: string
  error?: string
  raw: unknown
}

const DONE_STATUSES = new Set(['completed', 'complete', 'succeeded', 'success', 'done', 'ready', 'finished'])
const FAILED_STATUSES = new Set(['failed', 'failure', 'error', 'cancelled', 'canceled', 'expired', 'rejected', 'blocked'])

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function statusOf(json: unknown): string {
  const record = recordOf(json)
  if (record === undefined) return ''
  for (const key of ['status', 'state', 'phase']) {
    const value = record[key]
    if (typeof value === 'string' && value !== '') return value.toLowerCase()
  }
  const data = recordOf(record.data)
  if (data !== undefined) {
    for (const key of ['status', 'state']) {
      const value = data[key]
      if (typeof value === 'string' && value !== '') return value.toLowerCase()
    }
  }
  return ''
}

function numberAt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  return undefined
}

/** Extract the first plausible video URL from the many response shapes in use. */
export function videoUrlFrom(json: unknown): string | undefined {
  const record = recordOf(json)
  if (record === undefined) return undefined
  const direct = [record.url, record.video_url, record.output_url, record.result_url, record.download_url]
  for (const candidate of direct) {
    if (typeof candidate === 'string' && isUrlCandidate(candidate)) return candidate
  }
  const video = record.video
  if (typeof video === 'string' && isUrlCandidate(video)) return video
  const videoRecord = recordOf(video)
  if (videoRecord !== undefined) {
    for (const key of ['url', 'video_url', 'download_url']) {
      const candidate = videoRecord[key]
      if (typeof candidate === 'string' && isUrlCandidate(candidate)) return candidate
    }
  }
  for (const key of ['data', 'output', 'result', 'videos', 'artifacts']) {
    const value = record[key]
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === 'string' && isUrlCandidate(entry)) return entry
        const found = videoUrlFrom(entry)
        if (found !== undefined) return found
      }
    } else {
      const nested = recordOf(value)
      if (nested !== undefined) {
        const found = videoUrlFrom(nested)
        if (found !== undefined) return found
      }
    }
  }
  return undefined
}

/** Extract a job id from the usual fields. */
function jobIdFrom(json: unknown): string | undefined {
  const record = recordOf(json)
  if (record === undefined) return undefined
  for (const key of ['id', 'request_id', 'job_id', 'task_id', 'video_id', 'requestId', 'name']) {
    const value = record[key]
    if (typeof value === 'string' && value !== '') return value
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  const data = recordOf(record.data)
  if (data !== undefined) {
    for (const key of ['id', 'request_id', 'job_id', 'task_id', 'video_id']) {
      const value = data[key]
      if (typeof value === 'string' && value !== '') return value
    }
  }
  return undefined
}

function errorMessageOf(json: unknown): string | undefined {
  const record = recordOf(json)
  if (record === undefined) return undefined
  const error = record.error
  if (typeof error === 'string' && error !== '') return error
  const errorRecord = recordOf(error)
  if (errorRecord !== undefined) {
    const message = errorRecord.message ?? errorRecord.detail
    if (typeof message === 'string' && message !== '') return message
  }
  for (const key of ['failure_reason', 'failureReason', 'message', 'detail', 'reason']) {
    const value = record[key]
    if (typeof value === 'string' && value !== '') return value
  }
  const data = recordOf(record.data)
  if (data !== undefined) return errorMessageOf(data)
  return undefined
}

function resolutionFromSize(size: string | undefined): string | undefined {
  if (size === undefined) return undefined
  const match = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(size.trim())
  if (match === null) return undefined
  const width = Number(match[1])
  const height = Number(match[2])
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return undefined
  // Resolution names the shorter edge: 1280x720 and 720x1280 are both 720p.
  const shortEdge = Math.min(width, height)
  // The buffered API documents 480p/720p/1080p-style values; omit odd sizes
  // such as 1024x1024 rather than sending a resolution it may reject.
  if (![360, 480, 540, 720, 1080, 1440, 2160].includes(shortEdge)) return undefined
  return `${shortEdge}p`
}

function aspectRatioFromSize(size: string | undefined): string | undefined {
  if (size === undefined) return undefined
  const match = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(size.trim())
  if (match === null) return undefined
  let width = Number(match[1])
  let height = Number(match[2])
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return undefined
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b))
  const divisor = gcd(width, height)
  width /= divisor
  height /= divisor
  return `${width}:${height}`
}

function providerHost(provider: ProviderConfig): string {
  try {
    return new URL(provider.baseUrl).hostname.toLowerCase()
  } catch {
    return ''
  }
}

function isBufferedCheaperProvider(provider: ProviderConfig): boolean {
  return /(^|\.)cheaperinference\.com$/i.test(providerHost(provider))
}

function resolveMediaUrl(value: string, baseUrl: string): string {
  try {
    if (value.startsWith('/')) return new URL(value, new URL(baseUrl).origin).toString()
    return new URL(value, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString()
  } catch {
    return value
  }
}

function publicImageUrl(value: string): string | undefined {
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > 4096) return undefined
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
  if (parsed.username !== '' || parsed.password !== '') return undefined
  return trimmed
}

interface ResolvedVideoImage {
  url?: string
  dataUri?: string
}

/**
 * Resolve a video reference image.
 *
 * A public http(s) URL is passed through untouched. Cheaper Inference's
 * buffered video endpoint rejects data URIs and upload file ids (503), so a
 * local path is a clear preflight error there instead of a wasted request.
 * Other dialects keep the historical local-file -> data-URI behavior.
 */
function resolveVideoImage(
  args: VideoArgs,
  cwd: string,
  protocol: VideoProtocol,
  provider: ProviderConfig
): ResolvedVideoImage | undefined {
  if (typeof args.input_image !== 'string' || args.input_image.trim() === '') return undefined
  const raw = args.input_image.trim()
  const url = publicImageUrl(raw)
  if (url !== undefined) return { url }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || /^data:/i.test(raw)) {
    throw new ProviderPluginError(
      'INPUT_IMAGE_URL_INVALID',
      '`input_image` must be a local file path or a public http(s) image URL.',
      'Use an https URL that the provider can fetch; data URIs and upload file ids are not accepted by every provider.'
    )
  }
  if (protocol === 'videos-generations' && isBufferedCheaperProvider(provider)) {
    throw new ProviderPluginError(
      'PUBLIC_IMAGE_REQUIRED',
      'Cheaper Inference image-to-video requires a public https image URL.',
      'Upload the keyframe to a public URL and pass that URL as input_image. ' +
        'The /v1/uploads file id is documented for chat content and is not accepted by /videos/generations ' +
        '(both image_url and input_references with a file id return 503). A local path or data URI is rejected.'
    )
  }
  const reference = readInputImage(raw, cwd)
  return { dataUri: toDataUri(reference.buffer, reference.mime) }
}

function requestBody(
  protocol: VideoProtocol,
  model: ModelConfig,
  args: VideoArgs,
  cwd: string,
  provider: ProviderConfig
): Record<string, unknown> {
  const extra = args.extra ?? {}
  if (typeof extra !== 'object' || Array.isArray(extra)) {
    throw new ProviderPluginError('BAD_EXTRA', '`extra` must be a JSON object.')
  }
  const body: Record<string, unknown> = { ...extra, model: model.id, prompt: args.prompt }
  const image = resolveVideoImage(args, cwd, protocol, provider)
  const imageValue = image?.url ?? image?.dataUri

  if (protocol === 'openai-videos') {
    if (args.seconds !== undefined) body.seconds = args.seconds
    if (args.size !== undefined) body.size = args.size
    if (imageValue !== undefined) body.input_reference = { image_url: imageValue }
  } else if (protocol === 'videos-generations') {
    // Cheaper Inference requires one of duration_seconds/duration; default to 5s
    // when neither the caller nor the model supplied a duration.
    const requested = args.seconds ?? model.seconds ?? '5'
    const numeric = Number(requested)
    body.duration_seconds = Number.isFinite(numeric) ? numeric : requested
    const resolution = args.resolution ?? resolutionFromSize(args.size)
    if (resolution !== undefined) body.resolution = resolution
    const aspectRatio = args.aspect_ratio ?? aspectRatioFromSize(args.size)
    if (aspectRatio !== undefined) body.aspect_ratio = aspectRatio
    if (imageValue !== undefined) body.image_url = imageValue
  } else {
    if (args.seconds !== undefined) {
      const numeric = Number(args.seconds)
      body.duration = Number.isFinite(numeric) ? numeric : args.seconds
    }
    if (args.aspect_ratio !== undefined) body.aspect_ratio = args.aspect_ratio
    if (args.size !== undefined) body.size = args.size
    if (args.resolution !== undefined) body.resolution = args.resolution
    if (imageValue !== undefined) body.image = { url: imageValue }
  }
  if (args.seed !== undefined) body.seed = args.seed
  return body
}

interface VideoPayload {
  url?: string
  b64?: string
  contentType?: string
  durationSeconds?: number
}

function dataUriPayload(value: string): { b64: string; contentType?: string } | undefined {
  const match = /^data:([^;,]+);base64,([\s\S]+)$/i.exec(value)
  if (match === null) return undefined
  return { b64: match[2].replace(/\s+/g, ''), contentType: match[1] }
}

function isUrlCandidate(value: string): boolean {
  if (/^https?:\/\//i.test(value)) return true
  if (value.length >= 2048 || /\s/.test(value)) return false
  if (value.startsWith('/') && value.length > 1) return true
  return /^[\w.-]+\/[\w./?=&%:-]+$/.test(value)
}

function base64Payload(value: string, minimumLength = 64): string | undefined {
  const compact = value.replace(/\s+/g, '')
  if (compact.length < minimumLength) return undefined
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) return undefined
  return compact
}

function videoPayloadFromItem(value: unknown): VideoPayload | undefined {
  if (typeof value === 'string') {
    if (isUrlCandidate(value)) return { url: value }
    const dataUri = dataUriPayload(value)
    if (dataUri !== undefined) return { b64: dataUri.b64, ...(dataUri.contentType !== undefined ? { contentType: dataUri.contentType } : {}) }
    const raw = base64Payload(value)
    return raw !== undefined ? { b64: raw } : undefined
  }
  const record = recordOf(value)
  if (record === undefined) return undefined
  for (const key of ['url', 'video_url', 'download_url', 'file_url']) {
    const candidate = record[key]
    if (typeof candidate === 'string' && isUrlCandidate(candidate)) {
      return { url: candidate, ...durationFields(record) }
    }
  }
  const video = record.video
  if (typeof video === 'string') {
    if (isUrlCandidate(video)) return { url: video, ...durationFields(record) }
    const fromDataUri = dataUriPayload(video)
    if (fromDataUri !== undefined) {
      return { b64: fromDataUri.b64, ...(fromDataUri.contentType !== undefined ? { contentType: fromDataUri.contentType } : {}), ...durationFields(record) }
    }
    const raw = base64Payload(video)
    if (raw !== undefined) return { b64: raw, ...durationFields(record) }
  }
  const videoRecord = recordOf(video)
  if (videoRecord !== undefined) {
    const nested = videoPayloadFromItem(videoRecord)
    if (nested !== undefined) return { ...nested, ...durationFields(record) }
  }
  for (const key of ['b64_video', 'b64_json', 'b64', 'video_base64', 'base64']) {
    const candidate = record[key]
    if (typeof candidate !== 'string') continue
    const raw = base64Payload(candidate, 16) ?? dataUriPayload(candidate)?.b64
    if (raw !== undefined) {
      const type =
        typeof record.content_type === 'string'
          ? record.content_type
          : typeof record.mime_type === 'string'
            ? record.mime_type
            : undefined
      return { b64: raw, ...(type !== undefined ? { contentType: type } : {}), ...durationFields(record) }
    }
  }
  const data = record.data
  if (typeof data === 'string') {
    const fromDataUri = dataUriPayload(data)
    if (fromDataUri !== undefined) {
      return { b64: fromDataUri.b64, ...(fromDataUri.contentType !== undefined ? { contentType: fromDataUri.contentType } : {}), ...durationFields(record) }
    }
    const raw = base64Payload(data)
    if (raw !== undefined) return { b64: raw, ...durationFields(record) }
  }
  return undefined
}

function durationFields(record: Record<string, unknown>): { durationSeconds?: number } {
  for (const key of ['duration_seconds', 'duration', 'seconds']) {
    const value = numberAt(record[key])
    if (value !== undefined) return { durationSeconds: value }
  }
  return {}
}

/**
 * Pull the first video from a buffered response. Cheaper Inference returns
 * `{ videos: [{ url } | { b64_video }] }`; the older OpenAI-shaped arrays and a
 * few gateway variants are accepted too.
 */
export function videoPayloadFrom(json: unknown): VideoPayload | undefined {
  const record = recordOf(json)
  if (record !== undefined) {
    const direct = videoPayloadFromItem(record)
    if (direct !== undefined) return direct
    for (const key of ['videos', 'data', 'output', 'result', 'artifacts']) {
      const value = record[key]
      if (Array.isArray(value)) {
        for (const entry of value) {
          const found = videoPayloadFromItem(entry)
          if (found !== undefined) return found
        }
      } else if (value !== undefined) {
        const found = videoPayloadFromItem(value)
        if (found !== undefined) return found
      }
    }
  }
  return videoPayloadFromItem(json)
}

/** Submit a video job. */
export async function startVideo(options: {
  provider: ProviderConfig
  model: ModelConfig
  key: string
  args: VideoArgs
  config: ResolvedConfig
  cwd: string
  signal?: AbortSignal
}): Promise<VideoStart> {
  const { provider, model, key, args, config, cwd, signal } = options
  const protocol = videoProtocolFor(model)
  const body = requestBody(protocol, model, args, cwd, provider)
  const endpoint = protocol === 'openai-videos' ? 'videos' : 'videos/generations'
  const buffered = protocol === 'videos-generations'
  const response = await requestJson<unknown>({
    url: joinUrl(provider.baseUrl, endpoint),
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', ...authHeaders(provider, key) },
    body: JSON.stringify(body),
    // The buffered endpoint holds the request for the whole render, so it gets
    // the video deadline and a response-size cap large enough for base64 MP4.
    timeoutMs: buffered ? config.videoTimeoutMs : config.requestTimeoutMs,
    ...(buffered ? { maxBytes: config.maxDownloadBytes } : {}),
    signal,
    what: `Provider "${provider.id}" ${endpoint}`
  })
  const id = jobIdFrom(response.json)
  const requestId =
    response.headers.get('x-ci-request-id') ??
    response.headers.get('x-cheaper-inference-request-id') ??
    (recordOf(response.json)?.request_id as string | undefined)
  // Keep image bytes (and full data URIs) out of result metadata and sidecars.
  const summary: Record<string, unknown> = { ...body }
  delete summary.input_reference
  delete summary.image
  delete summary.image_url
  if (typeof args.input_image === 'string' && args.input_image.trim() !== '') summary.input_image = args.input_image
  const request = { endpoint, ...summary }

  if (buffered) {
    const payload = videoPayloadFrom(response.json)
    if (payload !== undefined) {
      const mediaUrl = payload.url !== undefined ? resolveMediaUrl(payload.url, provider.baseUrl) : undefined
      return {
        protocol,
        ...(id !== undefined ? { id } : {}),
        ...(requestId !== undefined ? { requestId } : {}),
        ...(mediaUrl !== undefined ? { url: mediaUrl } : {}),
        ...(payload.b64 !== undefined ? { b64: payload.b64 } : {}),
        ...(payload.contentType !== undefined ? { contentType: payload.contentType } : {}),
        request,
        raw: response.json
      }
    }
    // Cheaper Inference's buffered endpoint has no /videos/{id} status route.
    // Never fall back to polling here: that turns a malformed/short response
    // into a misleading "No such job" download error.
    throw badResponse(
      `Provider "${provider.id}" ${endpoint}`,
      'the buffered response carried no videos[].url or videos[].b64_video'
    )
  }

  const rawUrl = videoUrlFrom(response.json)
  const url = rawUrl !== undefined ? resolveMediaUrl(rawUrl, provider.baseUrl) : undefined
  if (id === undefined && url === undefined) {
    throw badResponse(
      `Provider "${provider.id}" ${endpoint}`,
      'the submission returned neither a job id nor a video URL'
    )
  }
  return {
    protocol,
    ...(id !== undefined ? { id } : {}),
    ...(requestId !== undefined ? { requestId } : {}),
    ...(url !== undefined ? { url } : {}),
    request,
    raw: response.json
  }
}

/** Poll one job once. */
export async function pollVideo(options: {
  provider: ProviderConfig
  key: string
  protocol: VideoProtocol
  id: string
  config: ResolvedConfig
  signal?: AbortSignal
}): Promise<VideoPoll> {
  const { provider, key, protocol, id, config, signal } = options
  const path = protocol === 'openai-videos' ? `videos/${encodeURIComponent(id)}` : `videos/${encodeURIComponent(id)}`
  const response = await requestJson<unknown>({
    url: joinUrl(provider.baseUrl, path),
    method: 'GET',
    headers: { accept: 'application/json', ...authHeaders(provider, key) },
    timeoutMs: config.requestTimeoutMs,
    signal,
    what: `Provider "${provider.id}" video status`,
    retries: 1
  })
  const rawStatus = statusOf(response.json)
  const progress = numberAt(recordOf(response.json)?.progress)
  const url = videoUrlFrom(response.json)
  const poll: VideoPoll = {
    status: 'pending',
    rawStatus,
    raw: response.json,
    ...(progress !== undefined ? { progress } : {}),
    ...(url !== undefined ? { url } : {})
  }
  if (DONE_STATUSES.has(rawStatus) || (rawStatus === '' && url !== undefined)) {
    poll.status = 'done'
    return poll
  }
  if (FAILED_STATUSES.has(rawStatus)) {
    poll.status = 'failed'
    const message = errorMessageOf(response.json)
    if (message !== undefined) poll.error = message
    return poll
  }
  return poll
}

/** Sleep while remaining cancellable. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason ?? new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Poll until the job finishes, fails, or the configured deadline passes.
 * Returns the media URL or, for the OpenAI shape, the authenticated content URL.
 */
export async function waitForVideo(options: {
  provider: ProviderConfig
  key: string
  protocol: VideoProtocol
  id: string
  config: ResolvedConfig
  signal?: AbortSignal
  onProgress?: (poll: VideoPoll) => void
}): Promise<{ url?: string; contentPath?: string; last: VideoPoll | undefined }> {
  const { provider, key, protocol, id, config, signal, onProgress } = options
  const deadline = Date.now() + config.videoTimeoutMs
  let last: VideoPoll | undefined
  for (;;) {
    if (signal?.aborted) {
      throw new ProviderPluginError('CANCELLED', 'Video generation was cancelled.')
    }
    const poll = await pollVideo({ provider, key, protocol, id, config, signal })
    last = poll
    onProgress?.(poll)
    if (poll.status === 'done') {
      if (poll.url !== undefined) return { url: resolveMediaUrl(poll.url, provider.baseUrl), last }
      if (protocol === 'openai-videos') {
        return { contentPath: `videos/${encodeURIComponent(id)}/content`, last }
      }
      throw new ProviderPluginError(
        'VIDEO_URL_MISSING',
        `Video job ${id} completed but the provider returned no video URL.`,
        'Check the provider dashboard for this job, or configure the model with the other video protocol.'
      )
    }
    if (poll.status === 'failed') {
      throw new ProviderPluginError(
        'VIDEO_FAILED',
        `Video generation failed (status "${poll.rawStatus || 'failed'}"): ${poll.error ?? 'the provider gave no reason'}`,
        'Adjust the prompt or parameters, or check the provider account/quota.'
      )
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw timedOut(`Video job ${id}`, config.videoTimeoutMs)
    await sleep(Math.min(config.pollIntervalMs, remaining), signal)
  }
}
