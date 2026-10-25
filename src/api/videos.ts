/**
 * Video generation adapters.
 *
 * Two dialects are supported because "OpenAI-compatible video" is not settled:
 *
 * - `openai-videos` — `POST /videos`, `GET /videos/{id}`, then
 *   `GET /videos/{id}/content` (the OpenAI Sora shape; the hosted API was
 *   retired, but compatible gateways still implement it).
 * - `async-videos` — `POST /videos/generations`, then `GET /videos/{id}` until
 *   a URL appears (the shape documented by xAI Imagine and several gateways).
 *
 * The dialing is asynchronous with polling; every request has its own timeout
 * and the whole job has the configured video deadline.
 */
import { ProviderPluginError, badResponse, timedOut } from '../errors.js'
import { authHeaders, joinUrl, requestJson } from '../http.js'
import { readInputImage, toDataUri } from '../files.js'
import type { ModelConfig, ProviderConfig, ResolvedConfig } from '../types.js'
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
  protocol: 'openai-videos' | 'async-videos'
  /** Provider job id, when the provider assigns one immediately. */
  id?: string
  /** A URL returned synchronously (rare, but some gateways answer with a finished job). */
  url?: string
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
    if (typeof candidate === 'string' && /^https?:\/\//i.test(candidate)) return candidate
  }
  const video = record.video
  if (typeof video === 'string' && /^https?:\/\//i.test(video)) return video
  const videoRecord = recordOf(video)
  if (videoRecord !== undefined) {
    for (const key of ['url', 'video_url', 'download_url']) {
      const candidate = videoRecord[key]
      if (typeof candidate === 'string' && /^https?:\/\//i.test(candidate)) return candidate
    }
  }
  for (const key of ['data', 'output', 'result', 'videos', 'artifacts']) {
    const value = record[key]
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === 'string' && /^https?:\/\//i.test(entry)) return entry
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

function requestBody(
  protocol: 'openai-videos' | 'async-videos',
  model: ModelConfig,
  args: VideoArgs,
  cwd: string
): Record<string, unknown> {
  const extra = args.extra ?? {}
  if (typeof extra !== 'object' || Array.isArray(extra)) {
    throw new ProviderPluginError('BAD_EXTRA', '`extra` must be a JSON object.')
  }
  const body: Record<string, unknown> = { ...extra, model: model.id, prompt: args.prompt }
  const reference =
    typeof args.input_image === 'string' && args.input_image.trim() !== '' ? readInputImage(args.input_image, cwd) : undefined
  const dataUri = reference !== undefined ? toDataUri(reference.buffer, reference.mime) : undefined

  if (protocol === 'openai-videos') {
    if (args.seconds !== undefined) body.seconds = args.seconds
    if (args.size !== undefined) body.size = args.size
    if (dataUri !== undefined) body.input_reference = { image_url: dataUri }
  } else {
    if (args.seconds !== undefined) {
      const numeric = Number(args.seconds)
      body.duration = Number.isFinite(numeric) ? numeric : args.seconds
    }
    if (args.aspect_ratio !== undefined) body.aspect_ratio = args.aspect_ratio
    if (args.size !== undefined) body.size = args.size
    if (args.resolution !== undefined) body.resolution = args.resolution
    if (dataUri !== undefined) body.image = { url: dataUri }
  }
  if (args.seed !== undefined) body.seed = args.seed
  return body
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
  const body = requestBody(protocol, model, args, cwd)
  const endpoint = protocol === 'openai-videos' ? 'videos' : 'videos/generations'
  const response = await requestJson<unknown>({
    url: joinUrl(provider.baseUrl, endpoint),
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', ...authHeaders(provider, key) },
    body: JSON.stringify(body),
    timeoutMs: config.requestTimeoutMs,
    signal,
    what: `Provider "${provider.id}" ${endpoint}`
  })
  const id = jobIdFrom(response.json)
  const url = videoUrlFrom(response.json)
  if (id === undefined && url === undefined) {
    throw badResponse(
      `Provider "${provider.id}" ${endpoint}`,
      'the submission returned neither a job id nor a video URL'
    )
  }
  // Keep image bytes (and full data URIs) out of result metadata and sidecars.
  const summary: Record<string, unknown> = { ...body }
  delete summary.input_reference
  delete summary.image
  if (typeof args.input_image === 'string' && args.input_image.trim() !== '') summary.input_image = args.input_image
  return {
    protocol,
    ...(id !== undefined ? { id } : {}),
    ...(url !== undefined ? { url } : {}),
    request: { endpoint, ...summary },
    raw: response.json
  }
}

/** Poll one job once. */
export async function pollVideo(options: {
  provider: ProviderConfig
  key: string
  protocol: 'openai-videos' | 'async-videos'
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
  protocol: 'openai-videos' | 'async-videos'
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
      if (poll.url !== undefined) return { url: poll.url, last }
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
