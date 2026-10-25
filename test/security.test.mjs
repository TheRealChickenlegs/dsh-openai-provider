import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import {
  Config,
  apply,
  authHeaders,
  createImageTool,
  downloadMedia,
  redactSecrets,
  requestJson
} from '../lib/index.js'
import { PNG, isolateConfig, json, binary, makeHost, providerConfig, runTool, startServer, tempDir } from './helpers.mjs'

isolateConfig()

const KEY = 'sk-super-secret-key-9876'

test('redactSecrets removes values and common header echoes', () => {
  const text = `failed: ${KEY}; Authorization: Bearer ${KEY}; x-api-key: ${KEY}`
  const redacted = redactSecrets(text, [KEY])
  assert.equal(redacted.includes(KEY), false)
  assert.match(redacted, /\[redacted\]/)
  assert.equal(redactedSecretsSafe(redacted), true)
})

function redactedSecretsSafe(value) {
  return !value.includes(KEY)
}

test('the Config schema has no field that could hold a literal key', () => {
  const json = Config.toJSON()
  const text = JSON.stringify(json)
  assert.equal(text.includes('"apiKey"'), false, 'no apiKey field may exist')
  for (const field of ['apiKeyEnv', 'apiKeyHeader', 'apiKeyPrefix']) {
    assert.ok(text.includes(`"${field}"`), `${field} must be editable`)
  }
})

test('authHeaders prefixes the key and never adds it elsewhere', () => {
  const headers = authHeaders(
    {
      id: 'p',
      baseUrl: 'https://example.com/v1',
      apiKeyEnv: 'P_KEY',
      organization: 'org-1',
      project: 'proj-1',
      models: []
    },
    KEY
  )
  assert.equal(headers.Authorization, `Bearer ${KEY}`)
  assert.equal(headers['OpenAI-Organization'], 'org-1')
  assert.equal(headers['OpenAI-Project'], 'proj-1')
  assert.equal(Object.keys(headers).filter((name) => headers[name] === KEY).length, 0)
})

test('API requests never follow redirects', async (t) => {
  let targetCalls = 0
  const target = await startServer(async (request, response) => {
    targetCalls += 1
    json(response, 200, { data: [] })
  })
  t.after(() => target.close())
  const server = await startServer(async (request, response) => {
    response.statusCode = 302
    response.setHeader('location', `${target.url}/steal`)
    response.end()
  })
  t.after(() => server.close())

  await assert.rejects(
    () =>
      requestJson({
        url: `${server.url}/v1/models`,
        headers: { authorization: `Bearer ${KEY}` },
        timeoutMs: 2000,
        what: 'test'
      }),
    (error) => {
      assert.match(error.message, /redirect/)
      return true
    }
  )
  assert.equal(targetCalls, 0)
})

test('downloads enforce a declared content-length cap and clean up the temp file', async (t) => {
  const server = await startServer(async (request, response) => {
    response.statusCode = 200
    response.setHeader('content-type', 'image/png')
    response.setHeader('content-length', String(10 * 1024))
    response.end(Buffer.alloc(10 * 1024))
  })
  t.after(() => server.close())
  const dir = tempDir()
  const target = path.join(dir, 'image.png')
  await assert.rejects(
    () =>
      downloadMedia(
        `${server.url}/big.png`,
        {
          directory: dir,
          stem: 'image',
          preferredExtension: '.png',
          timeoutMs: 2000,
          maxBytes: 1024,
          what: 'download'
        },
        'image'
      ),
    /exceeded/
  )
  assert.equal(fs.existsSync(target), false)
  assert.deepEqual(fs.readdirSync(dir), [])
})

test('downloads enforce the cap for a chunked body too', async (t) => {
  const server = await startServer(async (request, response) => {
    response.statusCode = 200
    response.setHeader('content-type', 'image/png')
    response.write(Buffer.alloc(700))
    response.write(Buffer.alloc(700))
    response.end()
  })
  t.after(() => server.close())
  await assert.rejects(
    () =>
      downloadMedia(
        `${server.url}/chunked.png`,
        {
          directory: tempDir(),
          stem: 'chunked',
          preferredExtension: '.png',
          timeoutMs: 2000,
          maxBytes: 1024,
          what: 'download'
        },
        'image'
      ),
    /exceeded/
  )
})

test('an HTML error page is never saved as media', async (t) => {
  const server = await startServer(async (request, response) => {
    response.statusCode = 200
    response.setHeader('content-type', 'text/html')
    response.end('<html>bad gateway</html>')
  })
  t.after(() => server.close())
  await assert.rejects(
    () =>
      downloadMedia(
        `${server.url}/error.png`,
        {
          directory: tempDir(),
          stem: 'error',
          preferredExtension: '.png',
          timeoutMs: 2000,
          maxBytes: 1024 * 1024,
          what: 'download'
        },
        'image'
      ),
    /instead of media/
  )
})

test('non-http media URLs are refused', async () => {
  await assert.rejects(
    () =>
      downloadMedia(
        'file:///etc/passwd',
        {
          directory: tempDir(),
          stem: 'bad',
          preferredExtension: '.png',
          timeoutMs: 1000,
          maxBytes: 1024,
          what: 'download'
        },
        'image'
      ),
    /unsupported scheme/
  )
})

test('a provider that echoes the key cannot leak it into a result or a sidecar', async (t) => {
  const server = await startServer(async (request, response) => {
    if (request.url === '/v1/images/generations') {
      json(response, 200, {
        data: [{ b64_json: PNG.toString('base64'), revised_prompt: `echo ${KEY}` }],
        usage: { note: KEY }
      })
      return
    }
    response.statusCode = 404
    response.end()
  })
  t.after(() => server.close())
  const tool = createImageTool(providerConfig(server.url), makeHost({ key: { value: KEY, source: 'test' } }))
  const result = await runTool(tool, { prompt: 'echo', model: 'gpt-image-1' }, tempDir())
  assert.equal(result.text.includes(KEY), false)
  assert.equal(JSON.stringify(result).includes(KEY), false)
  const sidecar = fs.readFileSync(result.metadata_path, 'utf8')
  assert.equal(sidecar.includes(KEY), false)
  assert.match(sidecar, /\[redacted\]/)
})

test('debug logging never includes a provider-echoed key', async (t) => {
  const server = await startServer(async (request, response) => {
    json(response, 401, { error: { message: `invalid ${KEY}` } })
  })
  t.after(() => server.close())
  const lines = []
  const original = { log: console.log, warn: console.warn }
  console.log = (...parts) => lines.push(parts.join(' '))
  console.warn = (...parts) => lines.push(parts.join(' '))
  process.env.DSH_OPENAI_PROVIDER_DEBUG = '1'
  try {
    const tool = createImageTool(providerConfig(server.url), makeHost({ key: { value: KEY, source: 'test' } }))
    await assert.rejects(() => runTool(tool, { prompt: 'x', model: 'gpt-image-1' }, tempDir()))
  } finally {
    delete process.env.DSH_OPENAI_PROVIDER_DEBUG
    console.log = original.log
    console.warn = original.warn
  }
  const text = lines.join('\n')
  assert.ok(text.length > 0, 'debug logging should be active')
  assert.equal(text.includes(KEY), false, 'the key leaked into debug logs')
})

test('startup logging never includes configured secrets', async () => {
  const lines = []
  const original = { log: console.log, warn: console.warn }
  console.log = (...parts) => lines.push(parts.join(' '))
  console.warn = (...parts) => lines.push(parts.join(' '))
  try {
    const registered = []
    const host = makeHost({
      services: {
        tools: { register: (tool) => registered.push(tool) },
        webServer: { register: () => () => {} }
      }
    })
    apply(host, {
      providers: [
        {
          id: 'p',
          baseUrl: 'https://example.com/v1',
          // Even a mistake here must not print a value: normalization drops it with a warning.
          apiKeyEnv: KEY,
          models: [{ id: 'gpt-image-1', kind: 'image' }]
        }
      ]
    })
  } finally {
    console.log = original.log
    console.warn = original.warn
  }
  assert.equal(lines.join('\n').includes(KEY), false, 'the key must not be logged')
  assert.ok(lines.some((line) => /literal API key/.test(line)))
})

test('the host applies the credential reference, not a secret, to headers', () => {
  const provider = {
    id: 'p',
    baseUrl: 'https://example.com/v1',
    apiKeyEnv: 'SOME_REF',
    models: []
  }
  const headers = authHeaders(provider, 'resolved-at-call-time')
  assert.equal(JSON.stringify(provider).includes('resolved-at-call-time'), false)
  assert.equal(headers.Authorization, 'Bearer resolved-at-call-time')
})
