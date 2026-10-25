/**
 * Authenticated, same-origin route used by the settings page to discover a
 * provider's live model catalogue.
 *
 * Why this exists: the browser must never hold the API key, and direct browser
 * requests to the provider would be blocked by CORS. The page sends only a
 * provider id; the host looks up the already-configured endpoint and credential.
 *
 * Security properties:
 * - The provider id must already exist in the resolved config, so this route
 *   cannot be used to send a stored key to an arbitrary URL.
 * - DSH's connection service authenticates the request exactly like /api
 *   (`requestRejection`); when that service is absent the route is loopback-only.
 * - JSON content type + a custom header make a cross-site request require a
 *   CORS preflight, which this route never grants.
 * - Request bodies are capped, responses are `no-store`, and error text is
 *   redacted before it leaves the host.
 */
import { resolveConfig } from './config.js'
import { formatError } from './errors.js'
import { getService, resolveApiKey, redactSecrets } from './credentials.js'
import { discoverProviderModels } from './discovery.js'
import { ROUTE_HEADER, ROUTE_PREFIX } from './identity.js'
import { logDebug, logWarn } from './log.js'
import type { HostContextLike, ResolvedConfig } from './types.js'

const MAX_BODY_BYTES = 16 * 1024

interface WebServerLike {
  register?: (route: { kind: 'exact' | 'prefix'; path: string; handler: (req: HttpRequestLike, res: HttpResponseLike) => unknown }) => () => void
}

interface ConnectionLike {
  requestRejection?: (request: HttpRequestLike) => number | undefined
}

interface HttpRequestLike {
  method?: string
  url?: string
  headers: Record<string, string | string[] | undefined>
  socket?: { remoteAddress?: string }
  [Symbol.asyncIterator]?: () => AsyncIterator<Buffer | string>
}

interface HttpResponseLike {
  statusCode: number
  setHeader: (name: string, value: string) => unknown
  end: (body?: string | Buffer) => unknown
  destroy?: () => unknown
}

function headerValue(request: HttpRequestLike, name: string): string | undefined {
  const value = request.headers[name]
  if (Array.isArray(value)) return value[0]
  return value
}

function sendJson(response: HttpResponseLike, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  response.setHeader('x-content-type-options', 'nosniff')
  response.setHeader('content-length', String(Buffer.byteLength(payload)))
  response.end(payload)
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1' || address.startsWith('127.')
}

async function readJsonBody(request: HttpRequestLike): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let total = 0
  if (typeof request[Symbol.asyncIterator] !== 'function') {
    throw new Error('request body is not readable')
  }
  for await (const chunk of request as AsyncIterable<Buffer | string>) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    total += buffer.length
    if (total > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  const parsed: unknown = JSON.parse(text)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('body must be a JSON object')
  return parsed as Record<string, unknown>
}

/**
 * Build the route handler. Exported separately so the discovery path can be
 * exercised without a live DSH composition.
 */
export function createModelsRouteHandler(
  ctx: HostContextLike,
  pluginConfig: unknown,
  resolver: (config?: unknown) => ResolvedConfig = (value) => resolveConfig(value)
) {
  return async function handleModels(request: HttpRequestLike, response: HttpResponseLike): Promise<void> {
    const pathname = new URL(request.url ?? '/', 'http://dsh.invalid').pathname
    if (pathname !== `${ROUTE_PREFIX}/models`) {
      sendJson(response, 404, { ok: false, code: 'NOT_FOUND', error: 'not found' })
      return
    }
    if (request.method !== 'POST') {
      response.setHeader('allow', 'POST')
      sendJson(response, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', error: 'use POST' })
      return
    }
    // Owner authentication. Without the connection service (unusual composition)
    // fall back to a loopback-only check rather than exposing the route.
    const connection = getService<ConnectionLike>(ctx, 'connection')
    if (connection?.requestRejection !== undefined) {
      let rejection: number | undefined
      try {
        rejection = connection.requestRejection(request)
      } catch {
        rejection = 401
      }
      if (rejection !== undefined) {
        sendJson(response, rejection, { ok: false, code: 'UNAUTHORIZED', error: 'authentication required' })
        return
      }
    } else if (!isLoopbackAddress(request.socket?.remoteAddress)) {
      sendJson(response, 403, { ok: false, code: 'FORBIDDEN', error: 'this route is loopback-only without the connection service' })
      return
    }
    // CSRF fence: JSON + a custom header can only be produced by the same-origin page.
    const contentType = (headerValue(request, 'content-type') ?? '').toLowerCase()
    if (!contentType.startsWith('application/json')) {
      sendJson(response, 415, { ok: false, code: 'UNSUPPORTED_MEDIA_TYPE', error: 'content-type must be application/json' })
      return
    }
    if (headerValue(request, ROUTE_HEADER) !== '1') {
      sendJson(response, 403, { ok: false, code: 'FORBIDDEN', error: `missing ${ROUTE_HEADER}: 1 header` })
      return
    }

    let body: Record<string, unknown>
    try {
      body = await readJsonBody(request)
    } catch (error) {
      sendJson(response, 400, {
        ok: false,
        code: 'BAD_REQUEST',
        error: error instanceof Error ? error.message : 'invalid request body'
      })
      return
    }
    const providerId = typeof body.providerId === 'string' ? body.providerId.trim() : ''
    if (providerId === '') {
      sendJson(response, 400, { ok: false, code: 'BAD_REQUEST', error: 'providerId is required' })
      return
    }

    let config: ResolvedConfig
    try {
      config = resolver(pluginConfig)
    } catch (error) {
      sendJson(response, 500, { ok: false, code: 'CONFIG_ERROR', error: formatError(error) })
      return
    }
    const provider = config.providers.find((entry) => entry.id === providerId)
    if (provider === undefined) {
      sendJson(response, 404, {
        ok: false,
        code: 'UNKNOWN_PROVIDER',
        error: `provider "${providerId}" is not configured; save the provider first`
      })
      return
    }

    let keyValue: string | undefined
    try {
      const key = await resolveApiKey(ctx, provider)
      keyValue = key.value
      logDebug('route: listing models', { provider: provider.id })
      const discovered = await discoverProviderModels({ provider, key: key.value, config })
      sendJson(response, 200, {
        ok: true,
        provider: { id: provider.id, baseUrl: provider.baseUrl },
        models: discovered.models,
        truncated: discovered.truncated
      })
    } catch (error) {
      const message = redactSecrets(formatError(error), [keyValue])
      const status = (error as { status?: number }).status
      sendJson(response, status !== undefined && status >= 400 && status < 600 ? status : 502, {
        ok: false,
        code: (error as { code?: string }).code ?? 'DISCOVERY_FAILED',
        error: message
      })
    }
  }
}

/**
 * Register the discovery route when the composition mounts a web server.
 * Returns false when no injection is possible; the plugin still works without
 * the route (models can be added manually on the settings page).
 */
export function registerOpenAIProviderRoutes(ctx: HostContextLike, pluginConfig: unknown): boolean {
  if (typeof ctx.inject !== 'function') return false
  try {
    ctx.inject(['webServer'], (webCtx) => {
      const server = getService<WebServerLike>(webCtx, 'webServer')
      if (server?.register === undefined) return
      const handler = createModelsRouteHandler(webCtx, pluginConfig)
      try {
        const effect = webCtx.effect
        if (typeof effect === 'function') {
          effect(
            () =>
              server.register!({
                kind: 'prefix',
                path: ROUTE_PREFIX,
                handler: (request, response) => handler(request, response)
              }),
            'openai-provider: model discovery route'
          )
        } else {
          server.register({
            kind: 'prefix',
            path: ROUTE_PREFIX,
            handler: (request, response) => handler(request, response)
          })
        }
        logDebug('Registered model discovery route', { path: `${ROUTE_PREFIX}/models` })
      } catch (error) {
        logWarn(`Could not register the model discovery route: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
    return true
  } catch (error) {
    logWarn(`Could not inject the web server: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}
