import assert from 'node:assert/strict'
import test from 'node:test'
import { ROUTE_HEADER, ROUTE_PREFIX } from '../lib/index.js'
import {
  createModelsRouteHandler,
  discoverProviderModels,
  normalizeProviders,
  resolveConfig,
  registerOpenAIProviderRoutes
} from '../lib/index.js'
import { isolateConfig, json, makeHost, providerConfig, startServer } from './helpers.mjs'

isolateConfig()

const KEY = 'sk-test-secret-1234'

function mockRequest(options = {}) {
  const body = options.rawBody !== undefined ? options.rawBody : JSON.stringify(options.body ?? { providerId: 'openai' })
  return {
    method: options.method ?? 'POST',
    url: options.url ?? `${ROUTE_PREFIX}/models`,
    headers: {
      'content-type': 'application/json',
      [ROUTE_HEADER]: '1',
      ...options.headers
    },
    socket: { remoteAddress: options.remoteAddress ?? '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(body)
    }
  }
}

function mockResponse() {
  const response = {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value
    },
    end(body) {
      this.body = body === undefined ? '' : String(body)
    }
  }
  return response
}

async function callRoute(options = {}) {
  const config = options.config ?? providerConfig(options.baseUrl ?? 'http://127.0.0.1:1')
  const handler = createModelsRouteHandler(options.host ?? makeHost(), options.pluginConfig ?? config, () => resolveConfig(config))
  const request = mockRequest(options.request)
  const response = mockResponse()
  await handler(request, response)
  let parsed = null
  try {
    parsed = JSON.parse(response.body)
  } catch {
    /* non-JSON body */
  }
  return { response, json: parsed }
}

test('discoverProviderModels reads the common wrappers and sorts media first', async (t) => {
  const server = await startServer(async (request, response) => {
    assert.equal(request.url, '/v1/models')
    assert.equal(request.headers.authorization, `Bearer ${KEY}`)
    json(response, 200, {
      data: [
        { id: 'gpt-4o', type: 'text' },
        { id: 'gpt-image-1' },
        { id: 'sora-2' },
        { id: 'gpt-image-1' },
        { name: 'flux-pro' }
      ]
    })
  })
  t.after(() => server.close())
  const config = resolveConfig(providerConfig(server.url))
  const result = await discoverProviderModels({
    provider: config.providers[0],
    key: KEY,
    config
  })
  assert.deepEqual(
    result.models.map((model) => model.id),
    ['flux-pro', 'gpt-image-1', 'sora-2', 'gpt-4o']
  )
  assert.equal(result.models.find((model) => model.id === 'sora-2').kind, 'video')
  assert.equal(result.models.find((model) => model.id === 'sora-2').type, undefined)
  assert.equal(result.models.find((model) => model.id === 'gpt-4o').kind, null)
  assert.equal(result.models.find((model) => model.id === 'gpt-4o').type, 'text')
})

test('discoverProviderModels classifies media from type, capabilities and endpoints', async (t) => {
  const server = await startServer(async (request, response) => {
    if (request.url !== '/v1/models') {
      response.statusCode = 404
      response.end()
      return
    }
    json(response, 200, {
      data: [
        { id: 'seedance-2.5', type: 'video', capabilities: { video: true, image_generation: false } },
        { id: 'gpt-image-1', type: 'image', capabilities: { video: false, image_generation: true } },
        { id: 'mystery-video', type: 'text', capabilities: { video: true } },
        { id: 'endpoint-video', type: 'text', endpoint: '/v1/videos/generations', supported_endpoints: ['/v1/videos/generations'] }
      ]
    })
  })
  t.after(() => server.close())
  const config = resolveConfig(providerConfig(server.url))
  const result = await discoverProviderModels({
    provider: config.providers[0],
    key: KEY,
    config
  })
  const byId = new Map(result.models.map((model) => [model.id, model]))
  assert.equal(byId.get('seedance-2.5').kind, 'video')
  assert.equal(byId.get('seedance-2.5').type, 'video')
  assert.equal(byId.get('gpt-image-1').kind, 'image')
  assert.equal(byId.get('gpt-image-1').type, 'image')
  assert.equal(byId.get('mystery-video').kind, 'video')
  assert.equal(byId.get('endpoint-video').kind, 'video')
})

test('discoverProviderModels accepts a bare array and nested models', async (t) => {
  let mode = 'array'
  const server = await startServer(async (request, response) => {
    if (mode === 'array') json(response, 200, ['gpt-image-1', { id: 'veo-3' }])
    else json(response, 200, { models: { models: [{ id: 'flux-pro' }] } })
  })
  t.after(() => server.close())
  const config = resolveConfig(providerConfig(server.url))
  const first = await discoverProviderModels({ provider: config.providers[0], key: KEY, config })
  assert.deepEqual(first.models.map((model) => model.id).sort(), ['gpt-image-1', 'veo-3'])
  mode = 'nested'
  const second = await discoverProviderModels({ provider: config.providers[0], key: KEY, config })
  assert.deepEqual(second.models.map((model) => model.id), ['flux-pro'])
})

test('discoverProviderModels surfaces auth failures', async (t) => {
  const server = await startServer(async (request, response) => {
    json(response, 401, { error: { message: `bad ${KEY}` } })
  })
  t.after(() => server.close())
  const config = resolveConfig(providerConfig(server.url))
  await assert.rejects(
    () => discoverProviderModels({ provider: config.providers[0], key: KEY, config }),
    (error) => {
      assert.match(error.message, /rejected the credential/)
      assert.equal(error.message.includes(KEY), false)
      return true
    }
  )
})

test('route: success returns ids only, never the key, and is not cacheable', async (t) => {
  const server = await startServer(async (request, response) => {
    json(response, 200, { data: [{ id: 'gpt-image-1' }, { id: 'gpt-4o' }] })
  })
  t.after(() => server.close())
  const { response, json: body } = await callRoute({ baseUrl: server.url })
  assert.equal(response.statusCode, 200)
  assert.equal(body.ok, true)
  assert.deepEqual(body.models.map((model) => model.id), ['gpt-image-1', 'gpt-4o'])
  assert.equal(JSON.stringify(body).includes(KEY), false)
  assert.equal(response.headers['cache-control'], 'no-store')
  assert.match(response.headers['content-type'], /application\/json/)
})

test('route: rejects a method, content type, missing CSRF header, and unknown provider', async () => {
  const method = await callRoute({ request: { method: 'GET' } })
  assert.equal(method.response.statusCode, 405)
  assert.equal(method.response.headers.allow, 'POST')

  const contentType = await callRoute({ request: { headers: { 'content-type': 'text/plain' } } })
  assert.equal(contentType.response.statusCode, 415)

  const csrf = await callRoute({ request: { headers: { [ROUTE_HEADER]: undefined } } })
  assert.equal(csrf.response.statusCode, 403)

  const unknown = await callRoute({ request: { body: { providerId: 'nope' } } })
  assert.equal(unknown.response.statusCode, 404)
  assert.match(unknown.json.error, /not configured/)
})

test('route: unauthenticated requests are refused by the connection service', async () => {
  const host = makeHost({ rejection: 401 })
  const { response } = await callRoute({ host })
  assert.equal(response.statusCode, 401)
})

test('route: without the connection service it is loopback-only', async () => {
  const host = makeHost()
  host.get = () => undefined
  host.reflect.get = () => undefined
  const denied = await callRoute({ host, request: { remoteAddress: '10.0.0.5' } })
  assert.equal(denied.response.statusCode, 403)
  const allowed = await callRoute({ host, request: { remoteAddress: '127.0.0.1' } })
  // It gets past the fence and fails later on the unreachable test endpoint.
  assert.notEqual(allowed.response.statusCode, 403)
})

test('route: an oversized body is rejected', async () => {
  const huge = JSON.stringify({ providerId: 'openai', padding: 'x'.repeat(20 * 1024) })
  const { response } = await callRoute({ request: { rawBody: huge } })
  assert.equal(response.statusCode, 400)
})

test('route: a provider failure is returned as a redacted error', async (t) => {
  const server = await startServer(async (request, response) => {
    json(response, 403, { error: { message: `blocked key ${KEY}` } })
  })
  t.after(() => server.close())
  const { response, json: body } = await callRoute({ baseUrl: server.url })
  assert.equal(response.statusCode, 403)
  assert.equal(body.ok, false)
  assert.equal(body.error.includes(KEY), false)
  assert.match(body.error, /\[redacted\]/)
})

test('registerOpenAIProviderRoutes installs one prefix route', () => {
  const registered = []
  const host = makeHost({
    services: {
      webServer: {
        register(route) {
          registered.push(route)
          return () => {}
        }
      }
    }
  })
  const ok = registerOpenAIProviderRoutes(host, providerConfig('http://127.0.0.1:1'))
  assert.equal(ok, true)
  assert.equal(registered.length, 1)
  assert.equal(registered[0].kind, 'prefix')
  assert.equal(registered[0].path, ROUTE_PREFIX)
})

test('provider normalization keeps the route limited to configured endpoints', () => {
  const problems = []
  const providers = normalizeProviders(
    [{ id: 'a', baseUrl: 'https://a.example/v1' }],
    problems
  )
  assert.equal(providers.length, 1)
  assert.deepEqual(problems, [])
})
