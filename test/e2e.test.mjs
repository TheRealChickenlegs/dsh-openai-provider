import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { createImageTool, createProvidersTool, createVideoTool } from '../lib/index.js'
import { MP4, PNG, isolateConfig, json, binary, makeHost, runTool, startServer, tempDir } from './helpers.mjs'

isolateConfig()

const ALPHA_KEY = 'alpha-key-1111'
const BETA_KEY = 'beta-key-2222'

function keysByRef() {
  return {
    resolve: async (ref) => {
      if (ref === 'ALPHA_KEY') return { value: ALPHA_KEY, source: 'test-alpha' }
      if (ref === 'BETA_KEY') return { value: BETA_KEY, source: 'test-beta' }
      return undefined
    },
    describe: async (ref) => ({ configured: ref === 'ALPHA_KEY' || ref === 'BETA_KEY', source: 'test', writable: true })
  }
}

test('two providers are routed independently with their own credentials', async (t) => {
  const alphaCalls = []
  const betaCalls = []

  const alpha = await startServer(async (request, response) => {
    alphaCalls.push({ url: request.url, auth: request.headers.authorization })
    if (request.url === '/v1/images/generations') {
      json(response, 200, { data: [{ b64_json: PNG.toString('base64') }] })
      return
    }
    response.statusCode = 404
    response.end()
  })
  t.after(() => alpha.close())

  let polls = 0
  const beta = await startServer(async (request, response) => {
    betaCalls.push({ url: request.url, auth: request.headers.authorization })
    if (request.url === '/v1/videos/generations') {
      json(response, 200, { request_id: 'b1' })
      return
    }
    if (request.url === '/v1/videos/b1') {
      polls += 1
      json(response, 200, polls > 1 ? { status: 'done', video: { url: `${beta.url}/v.mp4` } } : { status: 'pending' })
      return
    }
    if (request.url === '/v.mp4') {
      binary(response, 200, MP4, 'video/mp4')
      return
    }
    response.statusCode = 404
    response.end()
  })
  t.after(() => beta.close())

  const config = {
    providers: [
      {
        id: 'alpha',
        label: 'Alpha',
        baseUrl: `${alpha.url}/v1`,
        apiKeyEnv: 'ALPHA_KEY',
        models: [{ id: 'gpt-image-1', kind: 'image', editMode: 'multipart' }]
      },
      {
        id: 'beta',
        label: 'Beta',
        baseUrl: `${beta.url}/v1`,
        apiKeyEnv: 'BETA_KEY',
        models: [{ id: 'grok-imagine-video-1.5', kind: 'video', protocol: 'async-videos' }]
      }
    ],
    pollIntervalMs: 500,
    requestTimeoutMs: 5000,
    imageTimeoutMs: 5000,
    videoTimeoutMs: 5000,
    maxDownloadBytes: 1024 * 1024,
    maxImagesPerCall: 4,
    writeMetadata: true
  }
  const host = makeHost({ credentials: keysByRef() })
  const cwd = tempDir()

  const imageTool = createImageTool(config, host)
  const image = await runTool(imageTool, { prompt: 'alpha image' }, cwd)
  assert.equal(image.provider, 'alpha')
  assert.ok(fs.existsSync(image.path))
  assert.equal(alphaCalls[0].auth, `Bearer ${ALPHA_KEY}`)
  assert.equal(betaCalls.length, 0)

  const videoTool = createVideoTool(config, host)
  const video = await runTool(videoTool, { prompt: 'beta video' }, cwd)
  assert.equal(video.provider, 'beta')
  assert.ok(fs.existsSync(video.path))
  assert.equal(betaCalls[0].auth, `Bearer ${BETA_KEY}`)
  assert.equal(alphaCalls.length, 1, 'the alpha provider must not be called for a beta video')
  assert.equal(alphaCalls[0].auth, `Bearer ${ALPHA_KEY}`)

  const providers = await createProvidersTool(config, host).execute({}, {})
  assert.deepEqual(providers.providers.map((provider) => provider.id), ['alpha', 'beta'])
  assert.equal(JSON.stringify(providers).includes(ALPHA_KEY), false)
  assert.equal(JSON.stringify(providers).includes(BETA_KEY), false)
})

test('an explicit model picks the right provider model among several', async (t) => {
  const seen = []
  const server = await startServer(async (request, response, entry) => {
    seen.push(JSON.parse(entry.text || '{}').model)
    if (request.url === '/v1/images/generations') {
      json(response, 200, { data: [{ b64_json: PNG.toString('base64') }] })
      return
    }
    response.statusCode = 404
    response.end()
  })
  t.after(() => server.close())
  const config = {
    providers: [
      {
        id: 'p',
        baseUrl: `${server.url}/v1`,
        apiKeyEnv: 'K',
        models: [
          { id: 'gpt-image-1', kind: 'image', editMode: 'multipart' },
          { id: 'flux-pro', kind: 'image', editMode: 'multipart' }
        ]
      }
    ]
  }
  const tool = createImageTool(config, makeHost())
  const result = await runTool(tool, { prompt: 'x', model: 'flux-pro' }, tempDir())
  assert.equal(result.model, 'flux-pro')
  assert.deepEqual(seen, ['flux-pro'])
})
