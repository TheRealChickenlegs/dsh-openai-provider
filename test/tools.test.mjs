import assert from 'node:assert/strict'
import test from 'node:test'
import {
  apply,
  createProvidersTool,
  registerTools,
  IMAGE_PARAMETERS,
  VIDEO_PARAMETERS,
  PROVIDERS_PARAMETERS,
  IMAGE_OUTPUT,
  VIDEO_OUTPUT,
  PROVIDERS_OUTPUT
} from '../lib/index.js'
import { isolateConfig, json, makeHost, providerConfig, startServer } from './helpers.mjs'

isolateConfig()

const KEY = 'sk-test-secret-1234'

const ALLOWED = new Set([
  'type',
  'oneOf',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'description',
  'title',
  'default',
  'examples'
])

function collectSchemaProblems(node, path, problems) {
  if (typeof node !== 'object' || node === null) return
  if (Array.isArray(node)) return
  for (const key of Object.keys(node)) {
    if (!ALLOWED.has(key)) problems.push(`${path}.${key} is not in the DSH JSON-schema subset`)
  }
  if (node.properties) {
    for (const [name, child] of Object.entries(node.properties)) collectSchemaProblems(child, `${path}.properties.${name}`, problems)
  }
  if (node.items) collectSchemaProblems(node.items, `${path}.items`, problems)
  if (Array.isArray(node.oneOf)) node.oneOf.forEach((child, index) => collectSchemaProblems(child, `${path}.oneOf[${index}]`, problems))
}

test('all tool schemas stay inside the enforced DSH JSON-schema subset', () => {
  const problems = []
  for (const [name, schema] of Object.entries({
    IMAGE_PARAMETERS,
    VIDEO_PARAMETERS,
    PROVIDERS_PARAMETERS,
    IMAGE_OUTPUT,
    VIDEO_OUTPUT,
    PROVIDERS_OUTPUT
  })) {
    collectSchemaProblems(schema, name, problems)
  }
  assert.deepEqual(problems, [])
})

test('registerTools registers three uniquely named tools', () => {
  const registered = []
  const registry = { register: (tool) => registered.push(tool) }
  const count = registerTools(registry, providerConfig('http://127.0.0.1:1'), makeHost())
  assert.equal(count, 3)
  assert.deepEqual(
    registered.map((tool) => tool.name),
    ['openai_providers', 'openai_generate_image', 'openai_generate_video']
  )
  assert.equal(new Set(registered.map((tool) => tool.name)).size, 3)
  for (const tool of registered) {
    assert.equal(typeof tool.execute, 'function')
    assert.equal(typeof tool.description, 'string')
    assert.equal(typeof tool.parameters, 'object')
    assert.equal(typeof tool.output.render, 'function')
  }
})

function makePluginContext() {
  const registered = []
  const routes = []
  const configured = []
  const context = {
    settings: { configure: (options, fiber) => configured.push({ options, fiber }) },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      }
    },
    get(name) {
      if (name === 'tools') return { register: (tool) => registered.push(tool) }
      if (name === 'webServer') return this.webServer
      if (name === 'settings') return this.settings
      if (name === 'credentials') return { resolve: async () => ({ value: KEY, source: 'test' }), describe: async () => ({ configured: true, source: 'test' }) }
      return undefined
    },
    reflect: {
      get(name) {
        return context.get(name)
      }
    },
    inject(services, callback) {
      callback(context)
    },
    effect(body) {
      return body()
    },
    fiber: { id: 'fiber' },
    logger: { info() {}, warn() {} }
  }
  return { context, registered, routes, configured }
}

test('apply registers the tools, disables the auto form, and mounts the route', () => {
  const { context, registered, routes, configured } = makePluginContext()
  apply(context, providerConfig('http://127.0.0.1:1'))
  assert.equal(registered.length, 3)
  assert.equal(configured.length, 1)
  assert.deepEqual(configured[0].options, { auto: false })
  assert.equal(routes.length, 1)
  assert.equal(routes[0].path, '/plugin/openai-provider/api')
})

test('apply survives a missing tools service', () => {
  const warnings = []
  const original = console.warn
  console.warn = (line) => warnings.push(String(line))
  try {
    apply({ get: () => undefined, reflect: { get: () => undefined } }, {})
  } finally {
    console.warn = original
  }
  assert.ok(warnings.some((line) => /Cannot obtain the tools service/.test(line)))
})

test('openai_providers reports configuration, key presence, and never the key', async () => {
  const config = {
    providers: [
      {
        id: 'alpha',
        label: 'Alpha',
        baseUrl: 'https://alpha.example/v1',
        apiKeyEnv: 'ALPHA_KEY',
        models: [{ id: 'gpt-image-1', kind: 'image', editMode: 'multipart' }]
      },
      {
        id: 'beta',
        label: 'Beta',
        baseUrl: 'https://beta.example/v1',
        apiKeyEnv: 'BETA_KEY',
        models: [{ id: 'veo-3', kind: 'video', protocol: 'async-videos' }]
      }
    ],
    requestTimeoutMs: 5000
  }
  const tool = createProvidersTool(config, makeHost())
  const result = await tool.execute({}, { agent: { cwd: process.cwd() } })
  assert.equal(result.providers.length, 2)
  assert.deepEqual(result.providers.map((provider) => provider.id), ['alpha', 'beta'])
  assert.equal(result.providers[0].keyConfigured, true)
  assert.match(result.text, /alpha/)
  assert.match(result.text, /gpt-image-1 \[image/)
  assert.equal(JSON.stringify(result).includes(KEY), false)

  const one = await tool.execute({ provider: 'beta' }, {})
  assert.equal(one.providers.length, 1)
  assert.equal(one.providers[0].id, 'beta')
})

test('openai_providers refresh lists live models and isolates provider failures', async (t) => {
  const server = await startServer(async (request, response) => {
    json(response, 200, { data: [{ id: 'gpt-image-1' }, { id: 'sora-2' }, { id: 'gpt-4o', type: 'text' }] })
  })
  t.after(() => server.close())
  const config = {
    providers: [
      {
        id: 'live',
        baseUrl: `${server.url}/v1`,
        apiKeyEnv: 'LIVE_KEY',
        models: [{ id: 'gpt-image-1', kind: 'image' }]
      },
      {
        id: 'broken',
        baseUrl: 'http://127.0.0.1:1/v1',
        apiKeyEnv: 'BROKEN_KEY',
        models: []
      }
    ],
    requestTimeoutMs: 1000
  }
  const tool = createProvidersTool(config, makeHost())
  const result = await tool.execute({ refresh: true }, {})
  const live = result.providers.find((provider) => provider.id === 'live')
  assert.deepEqual(live.liveModels.map((model) => model.id), ['gpt-image-1'])
  assert.equal(live.liveModels.some((model) => model.id === 'gpt-4o'), false, 'unselected by default')
  const full = await tool.execute({ refresh: true, include_unselected: true }, {})
  assert.ok(full.providers.find((provider) => provider.id === 'live').liveModels.some((model) => model.id === 'gpt-4o'))
  const broken = result.providers.find((provider) => provider.id === 'broken')
  assert.ok(broken.error)
  assert.equal(broken.error.includes(KEY), false)
})

test('no providers produces setup guidance rather than an exception', async () => {
  const tool = createProvidersTool({}, makeHost())
  const result = await tool.execute({}, {})
  assert.equal(result.providers.length, 0)
  assert.match(result.text, /No OpenAI-compatible providers/)
  assert.match(result.text, /Load models/)
})

test('ambiguous provider selection is explained', async (t) => {
  const server = await startServer(async (request, response) => {
    response.statusCode = 500
    response.end()
  })
  t.after(() => server.close())
  const config = {
    providers: [
      { id: 'a', baseUrl: `${server.url}/a/v1`, apiKeyEnv: 'A', models: [{ id: 'gpt-image-1', kind: 'image' }] },
      { id: 'b', baseUrl: `${server.url}/b/v1`, apiKeyEnv: 'B', models: [{ id: 'gpt-image-1', kind: 'image' }] }
    ]
  }
  const { createImageTool } = await import('../lib/index.js')
  const tool = createImageTool(config, makeHost())
  await assert.rejects(
    () => tool.execute({ prompt: 'x' }, {}),
    /Several providers are configured \(a, b\)/
  )
})
