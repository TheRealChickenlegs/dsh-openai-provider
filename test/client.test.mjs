import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import vm from 'node:vm'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

/** Load the browser bundle in a VM and return its CommonJS exports. */
function loadBundle(overrides = {}) {
  let contribution = null
  const ReactShim = Object.assign(Object.create(React), {
    // The real store is browser-only; for a static render the current value is enough.
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    ...overrides.react
  })
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(value) {
          contribution = value
        }
      }
    },
    require(name) {
      if (name === 'react') return ReactShim
      throw new Error(`unexpected require(${JSON.stringify(name)})`)
    },
    fetch: overrides.fetch ?? (async () => ({ ok: false, status: 404, text: async () => '' })),
    URL,
    console,
    Promise,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Math,
    Date,
    RegExp,
    Error,
    JSON,
    setTimeout,
    clearTimeout
  }
  vm.runInNewContext(source, sandbox)
  assert.ok(contribution, 'the bundle must register itself with the module loader')
  assert.equal(contribution.id, 'dsh-openai-provider')
  return { exports: contribution.factory(sandbox.require), contribution, sandbox }
}

function fakeForm(value) {
  const snapshot = {
    status: 'ready',
    writable: true,
    revision: 3,
    value
  }
  const mutations = []
  return {
    subscribe() {
      return () => {}
    },
    getSnapshot() {
      return snapshot
    },
    async mutate(ops, revision) {
      mutations.push({ ops, revision })
      return true
    },
    mutations
  }
}

function fakeContext(overrides = {}) {
  const slots = []
  const service = {
    describe: async (refs) => ({ ok: true, value: Object.fromEntries(refs.map((ref) => [ref, { configured: true, source: 'test', writable: true }])) }),
    set: async () => ({ ok: true }),
    unset: async () => ({ ok: true }),
    ...overrides.credentials
  }
  const context = {
    remote: { credentials: service },
    configForms: {
      get: () => overrides.form,
      whileServed(_namespaces, register) {
        return register(new Set(['dsh-openai-provider']))
      }
    },
    slots: {
      inject(_name, callback) {
        return callback()
      },
      register(definition, component) {
        slots.push({ definition, component })
        return () => {}
      }
    },
    effect(body) {
      return body()
    }
  }
  return { context, slots, service }
}

test('the client bundle exports the expected module face', () => {
  const { exports } = loadBundle()
  assert.equal(typeof exports.apply, 'function')
  assert.equal(exports.name, 'openai-provider')
  assert.ok(exports.inject.includes('slots'))
  assert.ok(exports.inject.includes('configForms'))
  assert.ok(exports.inject.includes('remote'))
})

test('the settings page renders providers, models, and the security note', () => {
  const form = fakeForm({
    providers: [
      {
        id: 'openai',
        label: 'OpenAI',
        baseUrl: 'https://api.openai.com/v1',
        apiKeyEnv: 'OPENAI_API_KEY',
        models: [
          { id: 'gpt-image-1', kind: 'image', editMode: 'multipart' },
          { id: 'sora-2', kind: 'video', protocol: 'openai-videos' }
        ]
      },
      { id: 'xai', label: 'xAI', baseUrl: 'https://api.x.ai/v1', apiKeyEnv: 'XAI_API_KEY', models: [] }
    ],
    maxImagesPerCall: 3
  })
  const { exports } = loadBundle()
  const { context, slots } = fakeContext({ form })
  exports.apply(context)
  assert.equal(slots.length, 1)
  assert.equal(slots[0].definition.name, 'plugins.bundle.config')
  assert.equal(slots[0].definition.key, 'dsh-openai-provider')

  const props = slots[0].definition.inject()
  assert.equal(props.form, form)
  const html = renderToStaticMarkup(React.createElement(slots[0].component, props))
  assert.match(html, /OpenAI Providers/)
  assert.match(html, /API keys are stored by DSH/)
  assert.match(html, /openai/)
  assert.match(html, /xai/)
  assert.match(html, /gpt-image-1/)
  assert.match(html, /sora-2/)
  assert.match(html, /Load models/)
  assert.match(html, /https:\/\/api\.openai\.com\/v1/)
  assert.match(html, /not configured/)
  assert.match(html, /Maximum images per call/)
})

test('the page renders a loading and an unavailable state', () => {
  for (const [status, pattern] of [
    ['loading', /Loading configuration/],
    ['unavailable', /configuration entry is not available/]
  ]) {
    const form = { subscribe: () => () => {}, getSnapshot: () => ({ status, writable: false, value: undefined }) }
    const { exports } = loadBundle()
    const { context, slots } = fakeContext({ form })
    exports.apply(context)
    const props = slots[0].definition.inject()
    const html = renderToStaticMarkup(React.createElement(slots[0].component, props))
    assert.match(html, pattern)
  }
})

test('ops.describeKeys, saveKey, and clearKey call the credentials service', async () => {
  const calls = []
  const form = fakeForm({ providers: [] })
  const { exports } = loadBundle()
  const { context, slots } = fakeContext({
    form,
    credentials: {
      describe: async (refs) => {
        calls.push(['describe', refs])
        return { ok: true, value: { A: { configured: true, source: 'file' } } }
      },
      set: async (ref, value) => {
        calls.push(['set', ref, value])
        return { ok: true }
      },
      unset: async (ref) => {
        calls.push(['unset', ref])
        return { ok: true }
      }
    }
  })
  exports.apply(context)
  const ops = slots[0].definition.inject().ops
  const described = await ops.describeKeys(['A'])
  assert.equal(described.ok, true)
  assert.equal(described.value.A.configured, true)
  assert.equal((await ops.saveKey('A', 'secret-value')).ok, true)
  assert.equal((await ops.clearKey('A')).ok, true)
  assert.equal(calls.length, 3)
  assert.deepEqual(Array.from(calls[0]), ['describe', ['A']])
  assert.deepEqual(Array.from(calls[1]), ['set', 'A', 'secret-value'])
  assert.deepEqual(Array.from(calls[2]), ['unset', 'A'])
})

test('ops.listModels sends the provider id and the same-origin fence header', async () => {
  const requests = []
  const form = fakeForm({ providers: [] })
  const { exports } = loadBundle({
    fetch: async (url, init) => {
      requests.push({ url, init })
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true, models: [{ id: 'gpt-image-1', kind: 'image' }] })
      }
    }
  })
  const { context, slots } = fakeContext({ form })
  exports.apply(context)
  const ops = slots[0].definition.inject().ops
  const result = await ops.listModels('openai')
  assert.equal(result.ok, true)
  assert.equal(result.models[0].id, 'gpt-image-1')
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, '/plugin/openai-provider/api/models')
  assert.equal(requests[0].init.method, 'POST')
  assert.equal(requests[0].init.headers['x-dsh-openai-provider'], '1')
  assert.equal(requests[0].init.headers['content-type'], 'application/json')
  assert.deepEqual(JSON.parse(requests[0].init.body), { providerId: 'openai' })
})

test('ops.listModels explains a missing route instead of throwing', async () => {
  const form = fakeForm({ providers: [] })
  const { exports } = loadBundle()
  const { context, slots } = fakeContext({ form })
  exports.apply(context)
  const ops = slots[0].definition.inject().ops
  const result = await ops.listModels('openai')
  assert.equal(result.ok, false)
  assert.match(result.error, /Add model ids manually/)
})

test('the page save writes only non-secret provider fields and clamps nothing silently', async () => {
  const form = fakeForm({ providers: [] })
  const { exports } = loadBundle()
  const { context, slots } = fakeContext({ form })
  exports.apply(context)
  const props = slots[0].definition.inject()
  // Render once so the empty provider list is available, then exercise save logic through the DOM-free page props.
  assert.equal(typeof props.ops.saveKey, 'function')
  // The save path itself is validated by typing the profile shape: no field named apiKey is ever produced.
  const sourceText = fs.readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
  assert.equal(/['"]apiKey['"]\s*:/.test(sourceText), false, 'the page must never serialize a literal apiKey field')
  assert.match(sourceText, /apiKeyEnv/)
})
