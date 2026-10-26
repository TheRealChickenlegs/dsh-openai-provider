import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import {
  PLUGIN_VERSION,
  deriveCredentialRef,
  guessModelKind,
  normalizeBaseUrl,
  normalizeProvider,
  normalizeProviders,
  resolveConfig,
  slugify
} from '../lib/index.js'
import { isolateConfig } from './helpers.mjs'

isolateConfig()

const PACKAGE_VERSION = JSON.parse(
  fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')
).version

test('PLUGIN_VERSION matches package.json', () => {
  assert.equal(PLUGIN_VERSION, PACKAGE_VERSION)
})

test('slugify produces provider ids', () => {
  assert.equal(slugify('OpenAI'), 'openai')
  assert.equal(slugify(' My Provider! '), 'my-provider')
  assert.equal(slugify('---'), '')
})

test('deriveCredentialRef derives an env-style reference', () => {
  assert.equal(deriveCredentialRef('openai'), 'DSH_OPENAI_OPENAI_API_KEY')
  assert.equal(deriveCredentialRef('my-gateway'), 'DSH_OPENAI_MY_GATEWAY_API_KEY')
})

test('normalizeBaseUrl accepts http(s) roots and strips trailing slashes', () => {
  assert.equal(normalizeBaseUrl('https://api.openai.com/v1/'), 'https://api.openai.com/v1')
  assert.equal(normalizeBaseUrl('http://127.0.0.1:8080'), 'http://127.0.0.1:8080')
  assert.equal(normalizeBaseUrl('https://api.x.ai/v1'), 'https://api.x.ai/v1')
})

test('normalizeBaseUrl rejects credentials, query strings, and other schemes', () => {
  assert.equal(normalizeBaseUrl('ftp://example.com'), undefined)
  assert.equal(normalizeBaseUrl('https://user:pass@example.com/v1'), undefined)
  assert.equal(normalizeBaseUrl('https://example.com/v1?x=1'), undefined)
  assert.equal(normalizeBaseUrl('not a url'), undefined)
  assert.equal(normalizeBaseUrl(''), undefined)
})

test('guessModelKind identifies common media models', () => {
  assert.equal(guessModelKind('gpt-image-1'), 'image')
  assert.equal(guessModelKind('dall-e-3'), 'image')
  assert.equal(guessModelKind('flux-pro-1.1'), 'image')
  assert.equal(guessModelKind('sora-2'), 'video')
  assert.equal(guessModelKind('grok-imagine-video-1.5'), 'video')
  assert.equal(guessModelKind('veo-3'), 'video')
  assert.equal(guessModelKind('seedance-2.5'), 'video')
  assert.equal(guessModelKind('gpt-4o'), undefined)
  assert.equal(guessModelKind('text-embedding-3-large'), undefined)
})

test('a provider is normalized with safe defaults', () => {
  const problems = []
  const provider = normalizeProvider(
    {
      id: 'My Gateway',
      baseUrl: 'https://gateway.example.com/v1/',
      models: [
        { id: 'gpt-image-1' },
        'flux-pro',
        { id: 'sora-2', kind: 'video' },
        { id: 'gpt-image-1' }
      ]
    },
    0,
    problems
  )
  assert.ok(provider)
  assert.equal(provider.id, 'my-gateway')
  assert.equal(provider.baseUrl, 'https://gateway.example.com/v1')
  assert.equal(provider.apiKeyEnv, 'DSH_OPENAI_MY_GATEWAY_API_KEY')
  assert.deepEqual(
    provider.models.map((model) => [model.id, model.kind]),
    [
      ['gpt-image-1', 'image'],
      ['flux-pro', 'image'],
      ['sora-2', 'video']
    ]
  )
  assert.equal(provider.models[0].editMode, 'multipart')
  assert.equal(provider.models[2].protocol, 'async-videos')
  assert.ok(problems.some((problem) => /normalized to "my-gateway"/.test(problem)))
})

test('a literal API key in apiKeyEnv is rejected, not stored', () => {
  const problems = []
  const provider = normalizeProvider(
    { id: 'openai', baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'sk-proj-abcdefghijklmnopqrstuvwxyz' },
    0,
    problems
  )
  assert.ok(provider)
  assert.equal(provider.apiKeyEnv, 'DSH_OPENAI_OPENAI_API_KEY')
  assert.ok(problems.some((problem) => /literal API key/.test(problem)))
})

test('unsafe headers and control characters are dropped', () => {
  const problems = []
  const provider = normalizeProvider(
    {
      id: 'p',
      baseUrl: 'https://example.com/v1',
      apiKeyHeader: 'Content-Type',
      apiKeyPrefix: 'Bearer \r\nInjected: 1',
      headers: { 'X-OK': 'yes', 'X-API-Key': 'secret', Authorization: 'secret', 'Bad Header': 'x' }
    },
    0,
    problems
  )
  assert.ok(provider)
  assert.equal(provider.apiKeyHeader, undefined)
  assert.equal(provider.apiKeyPrefix, undefined)
  assert.deepEqual(provider.headers, { 'X-OK': 'yes' })
  assert.ok(problems.length >= 2)
})

test('normalizeProviders drops duplicates and bad entries', () => {
  const problems = []
  const providers = normalizeProviders(
    [
      { id: 'a', baseUrl: 'https://a.example/v1' },
      { id: 'a', baseUrl: 'https://a2.example/v1' },
      { id: 'b', baseUrl: 'ftp://nope' },
      'nonsense',
      { id: 'c', baseUrl: 'https://c.example/v1', models: [{ id: 'img', kind: 'video' }] }
    ],
    problems
  )
  assert.deepEqual(providers.map((provider) => provider.id), ['a', 'c'])
  assert.ok(problems.some((problem) => /Duplicate provider id/.test(problem)))
  assert.ok(problems.some((problem) => /no usable http\(s\) baseUrl/.test(problem)))
})

test('resolveConfig reads plugin config and applies defaults', () => {
  const config = resolveConfig({
    providers: [{ id: 'openai', baseUrl: 'https://api.openai.com/v1', models: [{ id: 'gpt-image-1', kind: 'image' }] }],
    maxImagesPerCall: 2
  })
  assert.equal(config.providers.length, 1)
  assert.equal(config.providers[0].models[0].kind, 'image')
  assert.equal(config.maxImagesPerCall, 2)
  assert.equal(config.requestTimeoutMs, 60_000)
  assert.equal(config.writeMetadata, true)
})

test('resolveConfig clamps out-of-range numbers and records provider problems', () => {
  const config = resolveConfig({
    providers: [{ id: 'x', baseUrl: 'nope' }],
    maxImagesPerCall: 999,
    requestTimeoutMs: 5
  })
  assert.equal(config.providers.length, 0)
  assert.ok(config.problems.length > 0)
  assert.equal(config.maxImagesPerCall, 4)
  assert.equal(config.requestTimeoutMs, 60_000)
})

test('provider list comes from the environment when plugin config has none', () => {
  isolateConfig({
    DSH_OPENAI_PROVIDER_PROVIDERS: JSON.stringify([
      { id: 'envp', baseUrl: 'https://env.example/v1', models: ['gpt-image-1'] }
    ])
  })
  const config = resolveConfig({})
  assert.equal(config.providers.length, 1)
  assert.equal(config.providers[0].id, 'envp')
})

test('volatile wrappers are unwrapped', () => {
  const wrapper = (value) => ({ get: () => value })
  const config = resolveConfig({
    providers: wrapper([{ id: 'v', baseUrl: 'https://v.example/v1', models: wrapper(['gpt-image-1']) }])
  })
  assert.equal(config.providers.length, 1)
  assert.equal(config.providers[0].models[0].id, 'gpt-image-1')
})

test('model protocol defaults are host-aware', () => {
  const problems = []
  const thirdParty = normalizeProvider(
    {
      id: 'p',
      baseUrl: 'https://example.com/v1',
      models: [
        { id: 'sora-2', kind: 'video' },
        { id: 'grok-imagine-video-1.5', kind: 'video' },
        { id: 'grok-imagine-image-2.0', kind: 'image' },
        { id: 'gpt-image-1', kind: 'image' }
      ]
    },
    0,
    problems
  )
  assert.ok(thirdParty)
  // A third-party gateway with a Sora-named model still uses the generic async
  // /videos/generations shape; only api.openai.com speaks the /videos shape.
  assert.equal(thirdParty.models[0].protocol, 'async-videos')
  assert.equal(thirdParty.models[1].protocol, 'async-videos')
  assert.equal(thirdParty.models[2].editMode, 'json')
  assert.equal(thirdParty.models[3].editMode, 'multipart')

  const openai = normalizeProvider(
    {
      id: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      models: [{ id: 'sora-2', kind: 'video' }]
    },
    0,
    problems
  )
  assert.ok(openai)
  assert.equal(openai.models[0].protocol, 'openai-videos')

  const cheaperProblems = []
  const cheaper = normalizeProvider(
    {
      id: 'cheaper-inference',
      baseUrl: 'https://api.cheaperinference.com/v1',
      models: [
        { id: 'seedance-2.5', kind: 'video' },
        { id: 'some-video', kind: 'video', protocol: 'async-videos' }
      ]
    },
    0,
    cheaperProblems
  )
  assert.ok(cheaper)
  assert.equal(cheaper.models[0].protocol, 'videos-generations')
  // An async protocol saved before the buffered adapter existed is corrected.
  assert.equal(cheaper.models[1].protocol, 'videos-generations')
  assert.match(cheaperProblems.join(' '), /buffered sync endpoint/)
})

test('the config file layer is read when the profile has no providers', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-openai-provider-file-'))
  const file = path.join(dir, 'config.json')
  fs.writeFileSync(
    file,
    JSON.stringify({
      providers: [
        {
          id: 'from-file',
          baseUrl: 'https://file.example/v1',
          apiKeyEnv: 'FILE_KEY',
          models: [{ id: 'flux-pro', kind: 'image' }]
        }
      ],
      maxImagesPerCall: 2,
      writeMetadata: false
    })
  )
  process.env.DSH_OPENAI_PROVIDER_CONFIG = file
  try {
    const fromFile = resolveConfig({})
    assert.equal(fromFile.providers[0].id, 'from-file')
    assert.equal(fromFile.providers[0].apiKeyEnv, 'FILE_KEY')
    assert.equal(fromFile.maxImagesPerCall, 2)
    assert.equal(fromFile.writeMetadata, false)

    const fromProfile = resolveConfig({
      providers: [{ id: 'profile', baseUrl: 'https://profile.example/v1', models: ['gpt-image-1'] }],
      maxImagesPerCall: 3
    })
    assert.equal(fromProfile.providers[0].id, 'profile')
    assert.equal(fromProfile.maxImagesPerCall, 3)
  } finally {
    delete process.env.DSH_OPENAI_PROVIDER_CONFIG
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a secret-looking apiKeyEnv in the config file is neutralized', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-openai-provider-file-'))
  const file = path.join(dir, 'config.json')
  fs.writeFileSync(
    file,
    JSON.stringify({
      providers: [{ id: 'leaky', baseUrl: 'https://leak.example/v1', apiKeyEnv: 'sk-live-abcdefghijklmnop' }]
    })
  )
  process.env.DSH_OPENAI_PROVIDER_CONFIG = file
  try {
    const config = resolveConfig({})
    assert.equal(config.providers[0].apiKeyEnv, 'DSH_OPENAI_LEAKY_API_KEY')
    assert.equal(JSON.stringify(config.providers).includes('sk-live-abcdefghijklmnop'), false)
    assert.ok(config.problems.some((problem) => /literal API key/.test(problem)))
  } finally {
    delete process.env.DSH_OPENAI_PROVIDER_CONFIG
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
