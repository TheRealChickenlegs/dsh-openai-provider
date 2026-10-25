/**
 * Shared test fixtures: a throwaway fake OpenAI-compatible server, a host
 * context with a credentials mock, and small filesystem helpers.
 */
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

process.setMaxListeners(0)

/** 1x1 transparent PNG. */
export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

/** Minimal MP4 header (ftyp/mp42) enough for sniffing and saving. */
export const MP4 = Buffer.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32, 0x00, 0x00, 0x00, 0x00, 0x6d, 0x70, 0x34,
  0x32, 0x6d, 0x70, 0x34, 0x31
])

/** Point config resolution at a path that does not exist, so a developer's own config cannot leak into tests. */
export function isolateConfig(extra = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-openai-provider-test-'))
  process.env.DSH_OPENAI_PROVIDER_CONFIG = path.join(dir, 'does-not-exist.json')
  delete process.env.DSH_OPENAI_PROVIDER_PROVIDERS
  for (const key of [
    'DSH_OPENAI_PROVIDER_OUTPUT_DIR',
    'DSH_OPENAI_PROVIDER_REQUEST_TIMEOUT_MS',
    'DSH_OPENAI_PROVIDER_IMAGE_TIMEOUT_MS',
    'DSH_OPENAI_PROVIDER_VIDEO_TIMEOUT_MS',
    'DSH_OPENAI_PROVIDER_POLL_INTERVAL_MS',
    'DSH_OPENAI_PROVIDER_MAX_DOWNLOAD_BYTES',
    'DSH_OPENAI_PROVIDER_MAX_IMAGES',
    'DSH_OPENAI_PROVIDER_WRITE_METADATA'
  ]) {
    delete process.env[key]
  }
  for (const [key, value] of Object.entries(extra)) process.env[key] = value
  return dir
}

/** Temporary directory removed at process exit. */
export function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-openai-provider-out-'))
  process.on('exit', () => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  })
  return dir
}

/** Start a plain HTTP server; returns its base URL and request log. */
export async function startServer(handler) {
  const requests = []
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = Buffer.concat(chunks)
    const entry = {
      method: request.method,
      url: request.url,
      headers: request.headers,
      body,
      text: body.toString('utf8')
    }
    requests.push(entry)
    try {
      await handler(request, response, entry)
    } catch (error) {
      response.statusCode = 500
      response.end(String(error && error.stack ? error.stack : error))
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.()
        server.close(resolve)
      })
  }
}

/** JSON response helper. */
export function json(response, status, value) {
  const text = JSON.stringify(value)
  response.statusCode = status
  response.setHeader('content-type', 'application/json')
  response.setHeader('content-length', String(Buffer.byteLength(text)))
  response.end(text)
}

/** Binary response helper. */
export function binary(response, status, buffer, contentType) {
  response.statusCode = status
  response.setHeader('content-type', contentType)
  response.setHeader('content-length', String(buffer.length))
  response.end(buffer)
}

/**
 * Host stub. `credentials.resolve` returns a known value; `connection` accepts
 * every request unless overridden.
 */
export function makeHost(options = {}) {
  const resolved = Object.prototype.hasOwnProperty.call(options, 'key')
    ? options.key
    : { value: 'sk-test-secret-1234', source: 'test' }
  const credentials = {
    resolve: async () => resolved,
    describe: async () => ({ configured: true, source: 'test', writable: true }),
    set: async () => undefined,
    unset: async () => undefined,
    ...options.credentials
  }
  const connection = {
    requestRejection: () => options.rejection,
    ...options.connection
  }
  const services = {
    credentials,
    connection,
    ...options.services
  }
  return {
    get(name) {
      return services[name]
    },
    reflect: {
      get(name) {
        return services[name]
      }
    },
    inject(servicesList, callback) {
      callback(this)
    },
    effect(body) {
      return body()
    },
    fiber: {},
    logger: { info() {}, warn() {} }
  }
}

/** Build a plain provider config for a fake server. */
export function providerConfig(baseUrl, overrides = {}) {
  return {
    providers: [
      {
        id: 'openai',
        label: 'OpenAI',
        baseUrl: `${baseUrl}/v1`,
        apiKeyEnv: 'TEST_OPENAI_API_KEY',
        models: [
          { id: 'gpt-image-1', kind: 'image', editMode: 'multipart' },
          { id: 'grok-imagine-image-2.0', kind: 'image', editMode: 'json' },
          { id: 'sora-2', kind: 'video', protocol: 'openai-videos' },
          { id: 'grok-imagine-video-1.5', kind: 'video', protocol: 'async-videos' }
        ],
        ...overrides.provider
      }
    ],
    writeMetadata: true,
    pollIntervalMs: 500,
    requestTimeoutMs: 5000,
    imageTimeoutMs: 5000,
    videoTimeoutMs: 5000,
    maxDownloadBytes: 10 * 1024 * 1024,
    maxImagesPerCall: 4,
    ...overrides
  }
}

/** Execute a tool with a cwd. */
export async function runTool(tool, args, cwd) {
  return tool.execute(args, { agent: { cwd } })
}

/** Collect console output while running a function. */
export async function captureConsole(fn) {
  const lines = []
  const original = { log: console.log, warn: console.warn, error: console.error }
  console.log = (...parts) => lines.push(parts.map(String).join(' '))
  console.warn = (...parts) => lines.push(parts.map(String).join(' '))
  console.error = (...parts) => lines.push(parts.map(String).join(' '))
  try {
    const value = await fn()
    return { value, lines }
  } finally {
    console.log = original.log
    console.warn = original.warn
    console.error = original.error
  }
}
