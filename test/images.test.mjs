import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { createImageTool, IMAGE_TOOL_NAME, resolveConfig } from '../lib/index.js'
import { PNG, isolateConfig, json, binary, makeHost, providerConfig, runTool, startServer, tempDir } from './helpers.mjs'

isolateConfig()

const KEY = 'sk-test-secret-1234'

function assertNoSecret(value) {
  assert.equal(String(value).includes(KEY), false, 'the API key leaked into output')
}

test('text-to-image: b64 response is saved, dimensions parsed, metadata written', async (t) => {
  const server = await startServer(async (request, response, entry) => {
    if (request.url === '/v1/images/generations' && request.method === 'POST') {
      assert.equal(request.headers.authorization, `Bearer ${KEY}`)
      const body = JSON.parse(entry.text)
      assert.equal(body.model, 'gpt-image-1')
      assert.equal(body.prompt, 'a red cube')
      json(response, 200, {
        created: 1,
        data: [{ b64_json: PNG.toString('base64'), revised_prompt: 'a red cube, studio light' }],
        usage: { images: 1 }
      })
      return
    }
    response.statusCode = 404
    response.end()
  })
  t.after(() => server.close())

  const cwd = tempDir()
  const config = providerConfig(server.url)
  const tool = createImageTool(config, makeHost())
  assert.equal(tool.name, IMAGE_TOOL_NAME)
  const result = await runTool(tool, { prompt: 'a red cube', model: 'gpt-image-1' }, cwd)

  assert.equal(result.files.length, 1)
  assert.ok(fs.existsSync(result.path))
  assert.ok(result.path.endsWith('.png'))
  assert.equal(result.width, 1)
  assert.equal(result.height, 1)
  assert.equal(result.mode, 'generate')
  assert.equal(result.revised_prompts[0], 'a red cube, studio light')
  assert.match(result.text, /Image: /)
  assertNoSecret(result.text)
  assertNoSecret(JSON.stringify(result))

  const metadata = JSON.parse(fs.readFileSync(result.metadata_path, 'utf8'))
  assert.equal(metadata.tool, 'openai_generate_image')
  assert.equal(metadata.provider.id, 'openai')
  assert.equal(metadata.model, 'gpt-image-1')
  assert.equal(metadata.mode, 'generate')
  assertNoSecret(JSON.stringify(metadata))
  assert.equal(fs.readFileSync(result.path).equals(PNG), true)
})

test('URL response is downloaded, with auth only to the API origin', async (t) => {
  let apiOrigin = ''
  let sentAuthToApi = false
  const server = await startServer(async (request, response, entry) => {
    if (request.url === '/v1/images/generations') {
      sentAuthToApi = request.headers.authorization === `Bearer ${KEY}`
      json(response, 200, { data: [{ url: `${apiOrigin}/files/out.png` }] })
      return
    }
    if (request.url === '/files/out.png') {
      binary(response, 200, PNG, 'image/png')
      return
    }
    response.statusCode = 404
    response.end()
  })
  t.after(() => server.close())
  apiOrigin = server.url

  const cwd = tempDir()
  const tool = createImageTool(providerConfig(server.url), makeHost())
  const result = await runTool(tool, { prompt: 'url image', model: 'gpt-image-1' }, cwd)
  assert.equal(sentAuthToApi, true)
  assert.ok(fs.existsSync(result.path))
  assert.equal(result.files.length, 1)
})

test('a media URL on another origin receives no Authorization header', async (t) => {
  const otherRequests = []
  const other = await startServer(async (request, response) => {
    otherRequests.push({ url: request.url, authorization: request.headers.authorization })
    binary(response, 200, PNG, 'image/png')
  })
  t.after(() => other.close())

  const server = await startServer(async (request, response, entry) => {
    if (request.url === '/v1/images/generations') {
      json(response, 200, { data: [{ url: `${other.url}/cdn/image.png` }] })
      return
    }
    response.statusCode = 404
    response.end()
  })
  t.after(() => server.close())

  const tool = createImageTool(providerConfig(server.url), makeHost())
  const result = await runTool(tool, { prompt: 'cross origin', model: 'gpt-image-1' }, tempDir())
  assert.ok(fs.existsSync(result.path))
  assert.equal(otherRequests.length, 1)
  assert.equal(otherRequests[0].authorization, undefined, 'the key must not cross origins')
})

test('multipart edit sends the file and prompt as multipart/form-data', async (t) => {
  let contentType = ''
  let bodyText = ''
  const server = await startServer(async (request, response, entry) => {
    if (request.url === '/v1/images/edits' && request.method === 'POST') {
      contentType = String(request.headers['content-type'] ?? '')
      bodyText = entry.text
      json(response, 200, { data: [{ b64_json: PNG.toString('base64') }] })
      return
    }
    response.statusCode = 404
    response.end()
  })
  t.after(() => server.close())

  const cwd = tempDir()
  const input = path.join(cwd, 'input.png')
  fs.writeFileSync(input, PNG)

  const tool = createImageTool(providerConfig(server.url), makeHost())
  const result = await runTool(tool, { prompt: 'make it blue', input_image: input, model: 'gpt-image-1' }, cwd)
  assert.equal(result.mode, 'edit')
  assert.match(contentType, /^multipart\/form-data; boundary=/)
  assert.match(bodyText, /name="image"/)
  assert.match(bodyText, /name="prompt"/)
  assert.match(bodyText, /make it blue/)
  assert.ok(fs.existsSync(result.path))
})

test('JSON edit (xAI-style model) sends a data URI and no multipart', async (t) => {
  let received = null
  const server = await startServer(async (request, response, entry) => {
    if (request.url === '/v1/images/edits') {
      received = JSON.parse(entry.text)
      json(response, 200, { data: [{ url: `${new URL(server.url).origin}/files/edited.png` }] })
      return
    }
    if (request.url === '/files/edited.png') {
      binary(response, 200, PNG, 'image/png')
      return
    }
    response.statusCode = 404
    response.end()
  })
  t.after(() => server.close())

  const cwd = tempDir()
  const input = path.join(cwd, 'input.png')
  fs.writeFileSync(input, PNG)
  const tool = createImageTool(providerConfig(server.url), makeHost())
  const result = await runTool(
    tool,
    { prompt: 'pencil sketch', input_image: input, model: 'grok-imagine-image-2.0' },
    cwd
  )
  assert.equal(result.model, 'grok-imagine-image-2.0')
  assert.equal(received.model, 'grok-imagine-image-2.0')
  assert.equal(received.prompt, 'pencil sketch')
  assert.ok(received.image.url.startsWith('data:image/png;base64,'))
  assert.equal(received.image.type, 'image_url')
  assert.ok(fs.existsSync(result.path))
})

test('n is capped by maxImagesPerCall and every image is saved', async (t) => {
  const server = await startServer(async (request, response, entry) => {
    if (request.url === '/v1/images/generations') {
      const body = JSON.parse(entry.text)
      assert.equal(body.n, 2)
      json(response, 200, {
        data: [
          { b64_json: PNG.toString('base64') },
          { b64_json: PNG.toString('base64') }
        ]
      })
      return
    }
    response.statusCode = 404
    response.end()
  })
  t.after(() => server.close())
  const tool = createImageTool(providerConfig(server.url, { maxImagesPerCall: 2 }), makeHost())
  const result = await runTool(tool, { prompt: 'two images', n: 9, model: 'gpt-image-1' }, tempDir())
  assert.equal(result.files.length, 2)
  assert.equal(result.notes.some((note) => /capped at 2/.test(note)), true)
  assert.notEqual(result.files[0], result.files[1])
})

test('missing credential produces actionable guidance and no generation request', async (t) => {
  let calls = 0
  const server = await startServer(async (request, response) => {
    calls += 1
    response.statusCode = 500
    response.end()
  })
  t.after(() => server.close())
  delete process.env.TEST_OPENAI_API_KEY
  const host = makeHost({ key: null, credentials: { resolve: async () => undefined, describe: async () => ({ configured: false }) } })
  // An explicit empty environment for the reference must not silently find the runner's own env.
  const tool = createImageTool(providerConfig(server.url), host)
  await assert.rejects(
    () => runTool(tool, { prompt: 'x', model: 'gpt-image-1' }, tempDir()),
    (error) => {
      assert.match(error.message, /No API key is stored/)
      assert.match(error.message, /Save key/)
      assert.equal(calls, 0)
      return true
    }
  )
})

test('provider HTTP errors are mapped and the key is redacted', async (t) => {
  const server = await startServer(async (request, response) => {
    json(response, 401, { error: { message: `bad key ${KEY}`, type: 'auth' } })
  })
  t.after(() => server.close())
  const tool = createImageTool(providerConfig(server.url), makeHost())
  await assert.rejects(
    () => runTool(tool, { prompt: 'x', model: 'gpt-image-1' }, tempDir()),
    (error) => {
      assert.match(error.message, /rejected the credential/)
      assertNoteNoSecret(error.message)
      return true
    }
  )
})

function assertNoteNoSecret(value) {
  assert.equal(String(value).includes(KEY), false)
}

test('an explicit output file keeps its name but adopts the real format', async (t) => {
  const server = await startServer(async (request, response, entry) => {
    if (request.url === '/v1/images/generations') {
      json(response, 200, { data: [{ b64_json: PNG.toString('base64') }] })
      return
    }
    response.statusCode = 404
    response.end()
  })
  t.after(() => server.close())
  const cwd = tempDir()
  const requested = path.join(cwd, 'poster.jpg')
  const tool = createImageTool(providerConfig(server.url), makeHost())
  const result = await runTool(tool, { prompt: 'poster', model: 'gpt-image-1', output_path: requested }, cwd)
  assert.equal(result.path, path.join(cwd, 'poster.png'))
  assert.ok(fs.existsSync(result.path))
  assert.equal(result.notes.some((note) => /real format/.test(note)), true)
})

test('an existing output is never overwritten', async (t) => {
  const server = await startServer(async (request, response, entry) => {
    if (request.url === '/v1/images/generations') {
      json(response, 200, { data: [{ b64_json: PNG.toString('base64') }] })
      return
    }
    response.statusCode = 404
    response.end()
  })
  t.after(() => server.close())
  const cwd = tempDir()
  fs.writeFileSync(path.join(cwd, 'shot.png'), 'keep me')
  const tool = createImageTool(providerConfig(server.url), makeHost())
  const result = await runTool(tool, { prompt: 'shot', model: 'gpt-image-1', output_path: path.join(cwd, 'shot.png') }, cwd)
  assert.equal(result.path, path.join(cwd, 'shot-1.png'))
  assert.equal(fs.readFileSync(path.join(cwd, 'shot.png'), 'utf8'), 'keep me')
})

test('a model that is not exposed is refused with the exposed list', async (t) => {
  const server = await startServer(async (request, response) => {
    response.statusCode = 500
    response.end()
  })
  t.after(() => server.close())
  const tool = createImageTool(providerConfig(server.url), makeHost())
  await assert.rejects(
    () => runTool(tool, { prompt: 'x', model: 'some-unselected-model' }, tempDir()),
    (error) => {
      assert.match(error.message, /is not exposed/)
      assert.match(error.message, /gpt-image-1/)
      return true
    }
  )
})

test('the image tool rejects an empty prompt', async (t) => {
  const server = await startServer(async (request, response) => {
    response.statusCode = 500
    response.end()
  })
  t.after(() => server.close())
  const tool = createImageTool(providerConfig(server.url), makeHost())
  await assert.rejects(() => runTool(tool, { prompt: '   ' }, tempDir()), /non-empty `prompt`/)
})

test('the session working directory from the host service is used by default', async (t) => {
  const server = await startServer(async (request, response) => {
    if (request.url === '/v1/images/generations') {
      json(response, 200, { data: [{ b64_json: PNG.toString('base64') }] })
      return
    }
    response.statusCode = 404
    response.end()
  })
  t.after(() => server.close())
  const sessionDir = tempDir()
  const host = makeHost({
    services: {
      workingDirectory: { ensure: async () => sessionDir }
    }
  })
  const tool = createImageTool(providerConfig(server.url), host)
  // The exec cwd points somewhere else; the host service must win.
  const result = await runTool(tool, { prompt: 'cwd', model: 'gpt-image-1' }, tempDir())
  assert.equal(path.dirname(result.path), sessionDir)
  assert.equal(fs.existsSync(result.path), true)
})

test('per-model default size and quality are applied when the call omits them', async (t) => {
  let received = null
  const server = await startServer(async (request, response, entry) => {
    if (request.url === '/v1/images/generations') {
      received = JSON.parse(entry.text)
      json(response, 200, { data: [{ b64_json: PNG.toString('base64') }] })
      return
    }
    response.statusCode = 404
    response.end()
  })
  t.after(() => server.close())
  const config = providerConfig(server.url)
  config.providers[0].models[0] = {
    id: 'gpt-image-1',
    kind: 'image',
    editMode: 'multipart',
    size: '1792x1024',
    quality: 'hd'
  }
  const tool = createImageTool(config, makeHost())
  await runTool(tool, { prompt: 'defaults', model: 'gpt-image-1' }, tempDir())
  assert.equal(received.size, '1792x1024')
  assert.equal(received.quality, 'hd')

  await runTool(tool, { prompt: 'explicit wins', model: 'gpt-image-1', size: '1024x1024', quality: 'low' }, tempDir())
  assert.equal(received.size, '1024x1024')
  assert.equal(received.quality, 'low')
})

test('resolveConfig for these fixtures exposes four models', () => {
  const config = resolveConfig(providerConfig('http://127.0.0.1:1'))
  assert.equal(config.providers[0].models.length, 4)
})
