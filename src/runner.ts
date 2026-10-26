/**
 * Generation orchestration: pick provider/model, resolve the credential, call
 * the provider, materialize files, write a metadata sidecar, and build the
 * human/model-facing summary.
 *
 * Every failure leaves through `redactSecrets`, so a key that a provider or a
 * proxy echoes back can never reach the transcript, a sidecar, or a log.
 */
import fs from 'node:fs'
import { formatError } from './errors.js'
import type {
  ImageToolResult,
  ResolvedConfig,
  VideoToolResult,
  HostContextLike,
  ToolExecLike
} from './types.js'
import { resolveApiKey, redactDeep, redactSecrets } from './credentials.js'
import { selectModel, selectProviderForKind, modelLabel } from './models.js'
import { callImageApi, type ImageArgs } from './api/images.js'
import { startVideo, waitForVideo, type VideoArgs } from './api/videos.js'
import { downloadMedia, writeBase64Image, writeBase64Video, type MaterializedFile } from './api/media.js'
import {
  IMAGE_EXTENSIONS,
  VIDEO_EXTENSIONS,
  imageDimensions,
  parseDimensions,
  resolveCwd,
  resolveOutputTarget,
  sanitizeComponent,
  resolveSessionCwd,
  timestampSlug,
  uniquePath,
  writeJsonSidecar
} from './files.js'
import { authHeaders, joinUrl } from './http.js'
import { logDebug } from './log.js'

export interface RunOptions {
  host?: HostContextLike
  config: ResolvedConfig
  exec?: ToolExecLike
}

function originOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).origin
  } catch {
    return baseUrl
  }
}

/** Preferred extension for the requested output format. */
function imageExtension(outputFormat: string | undefined): string {
  switch ((outputFormat ?? '').toLowerCase()) {
    case 'jpeg':
    case 'jpg':
      return '.jpg'
    case 'webp':
      return '.webp'
    case 'gif':
      return '.gif'
    default:
      return '.png'
  }
}

function readHead(filePath: string, maxBytes = 512 * 1024): Buffer {
  try {
    const handle = fs.openSync(filePath, 'r')
    try {
      const size = fs.fstatSync(handle).size
      const buffer = Buffer.alloc(Math.min(size, maxBytes))
      fs.readSync(handle, buffer, 0, buffer.length, 0)
      return buffer
    } finally {
      fs.closeSync(handle)
    }
  } catch {
    return Buffer.alloc(0)
  }
}

function dimensionNote(file: MaterializedFile): { width: number | null; height: number | null } {
  const size = imageDimensions(readHead(file.path))
  return { width: size?.width ?? null, height: size?.height ?? null }
}

/** Run one image generation/edit call. */
export async function runImageGeneration(options: RunOptions, args: ImageArgs): Promise<ImageToolResult> {
  const { host, config, exec } = options
  const secrets: string[] = []
  const started = Date.now()
  try {
    const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
    if (prompt === '') throw new Error('A non-empty `prompt` is required for image generation.')
    const cwd = await resolveSessionCwd(host, exec)
    const provider = selectProviderForKind(config, args.provider, 'image')
    const model = selectModel(provider, 'image', args.model)
    const requestedCount = Number.isFinite(args.n) ? Math.round(args.n as number) : 1
    const count = Math.max(1, Math.min(requestedCount, config.maxImagesPerCall, 10))
    const key = await resolveApiKey(host, provider)
    secrets.push(key.value)

    const effective: ImageArgs = {
      ...args,
      prompt,
      n: count,
      ...(args.size === undefined && model.size !== undefined ? { size: model.size } : {}),
      ...(args.quality === undefined && model.quality !== undefined ? { quality: model.quality } : {})
    }
    const response = await callImageApi({
      provider,
      model,
      key: key.value,
      args: effective,
      config,
      cwd,
      ...(exec?.signal ? { signal: exec.signal } : {})
    })

    const target = resolveOutputTarget({
      requested: args.output_path,
      cwd,
      ...(config.outputDir !== undefined ? { defaultDir: config.outputDir } : {}),
      basename: `openai-image-${sanitizeComponent(provider.id)}-${sanitizeComponent(model.id)}-${timestampSlug()}`,
      fileExtensions: IMAGE_EXTENSIONS,
      count: response.items.length
    })
    const preferredExtension = imageExtension(args.output_format)
    const files: MaterializedFile[] = []
    const notes: string[] = []
    if (requestedCount > count) {
      notes.push(`Requested ${requestedCount} images; capped at ${count} per call by the plugin setting.`)
    }
    for (let index = 0; index < response.items.length; index += 1) {
      const item = response.items[index]!
      const stem = response.items.length > 1 ? `${target.stem}-${index + 1}` : target.stem
      const requestedExtension = target.exactFile ? target.requestedExtension : undefined
      if (item.b64 !== undefined) {
        const file = writeBase64Image(item.b64, {
          directory: target.directory,
          stem,
          preferredExtension,
          contentType: undefined,
          requestedExtension
        })
        files.push(file)
      } else if (item.url !== undefined) {
        const file = await downloadMedia(
          item.url,
          {
            directory: target.directory,
            stem,
            preferredExtension,
            requestedExtension,
            timeoutMs: config.imageTimeoutMs,
            maxBytes: config.maxDownloadBytes,
            ...(exec?.signal ? { signal: exec.signal } : {}),
            what: `Provider "${provider.id}" image download`,
            authHeaders: authHeaders(provider, key.value),
            authOrigin: originOf(provider.baseUrl)
          },
          'image'
        )
        files.push(file)
      }
    }
    if (files.length === 0) throw new Error('The provider returned no usable image payload.')
    if (target.exactFile && target.requestedExtension !== undefined) {
      const actual = files[0]!.path.slice(files[0]!.path.lastIndexOf('.'))
      if (actual.toLowerCase() !== target.requestedExtension.toLowerCase()) {
        notes.push(`The provider returned ${actual}; the output kept the real format instead of ${target.requestedExtension}.`)
      }
    }
    const first = files[0]!
    const dimensions = dimensionNote(first)
    const duration = Date.now() - started
    let metadataPath: string | undefined
    if (config.writeMetadata) {
      metadataPath = uniquePath(target.directory, `${target.stem}-metadata`, '.json')
      const metadata = {
        tool: 'openai_generate_image',
        created_at: new Date().toISOString(),
        provider: { id: provider.id, label: provider.label, baseUrl: provider.baseUrl },
        model: model.id,
        mode: response.mode,
        prompt,
        input_image: args.input_image ?? null,
        mask_image: args.mask_image ?? null,
        request: response.request,
        response: {
          created: response.created,
          usage: response.usage,
          revised_prompts: response.items.map((item) => item.revisedPrompt ?? null)
        },
        files: files.map((file) => ({ path: file.path, bytes: file.bytes, contentType: file.contentType })),
        duration_ms: duration,
        notes
      }
      // Defence in depth: a provider could echo a credential inside revised_prompt or usage.
      writeJsonSidecar(metadataPath, redactDeep(metadata, secrets))
    }
    const lines = [
      `Generated ${files.length} image${files.length === 1 ? '' : 's'} with provider "${provider.id}" and model "${modelLabel(model)}" in ${(duration / 1000).toFixed(1)}s.`,
      `Prompt: ${prompt}`
    ]
    for (const file of files) lines.push(`Image: ${file.path}`)
    if (dimensions.width !== null && dimensions.height !== null) {
      lines.push(`Dimensions: ${dimensions.width}x${dimensions.height}`)
    }
    const revised = response.items
      .map((item) => item.revisedPrompt)
      .filter((value): value is string => typeof value === 'string' && value !== '')
      .map((value) => redactSecrets(value, secrets))
    if (revised.length > 0) lines.push(`Revised prompt: ${revised[0]}`)
    if (response.usage !== null && response.usage !== undefined) {
      lines.push(`Usage: ${JSON.stringify(response.usage)}`)
    }
    if (metadataPath !== undefined) lines.push(`Metadata: ${metadataPath}`)
    if (notes.length > 0) lines.push(`Notes: ${notes.join(' ')}`)
    lines.push('Cite the Image path(s) above to the user; the files already exist on disk.')
    return {
      text: redactSecrets(lines.join('\n'), secrets),
      path: first.path,
      files: files.map((file) => file.path),
      provider: provider.id,
      model: model.id,
      mode: response.mode,
      revised_prompts: revised,
      width: dimensions.width ?? 0,
      height: dimensions.height ?? 0,
      duration_ms: duration,
      ...(metadataPath !== undefined ? { metadata_path: metadataPath } : {}),
      notes
    }
  } catch (error) {
    const safe = redactSecrets(formatError(error), secrets)
    logDebug('image generation failed', safe)
    throw new Error(safe)
  }
}

/** Run one video generation call, including the polling wait and download. */
export async function runVideoGeneration(options: RunOptions, args: VideoArgs): Promise<VideoToolResult> {
  const { host, config, exec } = options
  const secrets: string[] = []
  const started = Date.now()
  try {
    const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
    if (prompt === '') throw new Error('A non-empty `prompt` is required for video generation.')
    const cwd = await resolveSessionCwd(host, exec)
    const provider = selectProviderForKind(config, args.provider, 'video')
    const model = selectModel(provider, 'video', args.model)
    const key = await resolveApiKey(host, provider)
    secrets.push(key.value)

    const effective: VideoArgs = {
      ...args,
      prompt,
      ...(args.seconds === undefined && model.seconds !== undefined ? { seconds: model.seconds } : {}),
      ...(args.size === undefined && model.size !== undefined ? { size: model.size } : {}),
      ...(args.aspect_ratio === undefined && model.aspectRatio !== undefined ? { aspect_ratio: model.aspectRatio } : {})
    }
    const start = await startVideo({
      provider,
      model,
      key: key.value,
      args: effective,
      config,
      cwd,
      ...(exec?.signal ? { signal: exec.signal } : {})
    })

    let mediaUrl = start.url
    let contentPath: string | undefined
    let last
    if (start.b64 === undefined && mediaUrl === undefined && start.id !== undefined) {
      const waited = await waitForVideo({
        provider,
        key: key.value,
        protocol: start.protocol,
        id: start.id,
        config,
        ...(exec?.signal ? { signal: exec.signal } : {}),
        onProgress: (poll) => logDebug('video progress', { id: start.id, status: poll.rawStatus, progress: poll.progress })
      })
      mediaUrl = waited.url
      contentPath = waited.contentPath
      last = waited.last
    }
    if (start.b64 === undefined && mediaUrl === undefined && contentPath !== undefined) {
      mediaUrl = joinUrl(provider.baseUrl, contentPath)
    }
    if (start.b64 === undefined && mediaUrl === undefined) {
      throw new Error('The provider finished without returning a downloadable video.')
    }

    const target = resolveOutputTarget({
      requested: args.output_path,
      cwd,
      ...(config.outputDir !== undefined ? { defaultDir: config.outputDir } : {}),
      basename: `openai-video-${sanitizeComponent(provider.id)}-${sanitizeComponent(model.id)}-${timestampSlug()}`,
      fileExtensions: VIDEO_EXTENSIONS,
      count: 1
    })
    const file =
      start.b64 !== undefined
        ? writeBase64Video(start.b64, {
            directory: target.directory,
            stem: target.stem,
            preferredExtension: '.mp4',
            requestedExtension: target.exactFile ? target.requestedExtension : undefined,
            ...(start.contentType !== undefined ? { contentType: start.contentType } : {})
          })
        : await downloadMedia(
            mediaUrl as string,
            {
              directory: target.directory,
              stem: target.stem,
              preferredExtension: '.mp4',
              requestedExtension: target.exactFile ? target.requestedExtension : undefined,
              timeoutMs: config.videoTimeoutMs,
              maxBytes: config.maxDownloadBytes,
              ...(exec?.signal ? { signal: exec.signal } : {}),
              what: `Provider "${provider.id}" video`,
              // Content endpoints need the key; pre-signed CDN URLs are cross-origin and get no header.
              authHeaders: authHeaders(provider, key.value),
              authOrigin: originOf(provider.baseUrl)
            },
            'video'
          )
    const duration = Date.now() - started
    const raw = (last?.raw ?? start.raw) as Record<string, unknown> | undefined
    const rawVideo = Array.isArray(raw?.videos) ? (raw.videos[0] as Record<string, unknown> | undefined) : undefined
    const rawSeconds = raw?.duration_seconds ?? rawVideo?.duration_seconds ?? raw?.seconds ?? raw?.duration
    const seconds =
      typeof rawSeconds === 'number'
        ? rawSeconds
        : typeof rawSeconds === 'string' && Number.isFinite(Number(rawSeconds))
          ? Number(rawSeconds)
          : effective.seconds !== undefined && Number.isFinite(Number(effective.seconds))
            ? Number(effective.seconds)
            : null
    const size = parseDimensions(
      typeof raw?.size === 'string' ? raw.size : typeof effective.size === 'string' ? effective.size : undefined
    )
    const jobId = start.id ?? start.requestId ?? (start.b64 !== undefined || start.url !== undefined ? 'buffered' : 'immediate')
    let metadataPath: string | undefined
    if (config.writeMetadata) {
      metadataPath = uniquePath(target.directory, `${target.stem}-metadata`, '.json')
      const metadata = {
        tool: 'openai_generate_video',
        created_at: new Date().toISOString(),
        provider: { id: provider.id, label: provider.label, baseUrl: provider.baseUrl },
        model: model.id,
        protocol: start.protocol,
        job_id: jobId,
        prompt,
        input_image: args.input_image ?? null,
        request: start.request,
        job: last !== undefined ? { status: last.rawStatus, progress: last.progress ?? null } : null,
        file: { path: file.path, bytes: file.bytes, contentType: file.contentType },
        duration_ms: duration
      }
      writeJsonSidecar(metadataPath, redactDeep(metadata, secrets))
    }
    const lines = [
      `Generated a video with provider "${provider.id}" and model "${modelLabel(model)}" in ${(duration / 1000).toFixed(1)}s.`,
      `Prompt: ${prompt}`,
      `Video: ${file.path}`,
      `Job: ${jobId} (${start.protocol})`
    ]
    if (size !== undefined) lines.push(`Dimensions: ${size.width}x${size.height}`)
    if (seconds !== null) lines.push(`Duration: ${seconds}s`)
    if (metadataPath !== undefined) lines.push(`Metadata: ${metadataPath}`)
    lines.push('Cite the Video path above to the user; the file already exists on disk.')
    return {
      text: redactSecrets(lines.join('\n'), secrets),
      path: file.path,
      files: [file.path],
      provider: provider.id,
      model: model.id,
      job_id: jobId,
      duration_seconds: seconds ?? 0,
      width: size?.width ?? 0,
      height: size?.height ?? 0,
      duration_ms: duration,
      ...(metadataPath !== undefined ? { metadata_path: metadataPath } : {}),
      notes: []
    }
  } catch (error) {
    const safe = redactSecrets(formatError(error), secrets)
    logDebug('video generation failed', safe)
    throw new Error(safe)
  }
}
