import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { createVideoTool, VIDEO_TOOL_NAME, waitForVideo } from '../lib/index.js'
import { MP4, PNG, isolateConfig, json, binary, makeHost, providerConfig, runTool, startServer, tempDir } from './helpers.mjs'

isolateConfig()

const KEY = 'sk-test-secret-1234'

test('openai-videos: submit, poll, download content with auth, parse size and duration', async (t) => {
  let polls = 0
  let contentAuth = null
  const server = await startServer(async (request, response, entry) => {
    if (request.url === '/v1/videos' && request.method === 'POST') {
      assert.equal(request.headers.authorization, `Bearer ${KEY}`)
      const body = JSON.parse(entry.text || '{}')
      assert.equal(body.model, 'sora-2')
      json(response, 200, { id: 'vid1', object: 'video', status: 'queued' })
      return
    }
    if (request.url === '/v1/videos/vid1') {
      polls += 1
      if (polls === 1) {
        json(response, 200, { id: 'vid1', status: 'in_progress', progress: 40 })
      } else {
        json(response, 200, { id: 'vid1', status: 'completed', size: '1280x720', seconds: '8' })
      }
      return
    }
    if (request.url === '/v1/videos/vid1/content') {
      contentAuth = request.headers.authorization
      binary(response, 200, MP4, 'video/mp4')
      return
    }
    response.statusCode = 404
    response.end()
  })
  t.after(() => server.close())

  const cwd = tempDir()
  const tool = createVideoTool(providerConfig(server.url), makeHost())
  assert.equal(tool.name, VIDEO_TOOL_NAME)
  const result = await runTool(tool, { prompt: 'a cat playing piano', model: 'sora-2' }, cwd)
  assert.ok(fs.existsSync(result.path))
  assert.match(result.path, /\.mp4$/)
  assert.equal(result.width, 1280)
  assert.equal(result.height, 720)
  assert.equal(result.duration_seconds, 8)
  assert.equal(contentAuth, `Bearer ${KEY}`)
  assert.equal(result.job_id, 'vid1')
  assert.match(result.text, /Video: /)
  assert.equal(result.text.includes(KEY), false)
  const metadata = JSON.parse(fs.readFileSync(result.metadata_path, 'utf8'))
  assert.equal(metadata.protocol, 'openai-videos')
  assert.equal(metadata.job_id, 'vid1')
  assert.equal(JSON.stringify(metadata).includes(KEY), false)
})

test('openai-videos submit body carries seconds, size, and a reference image URL', async (t) => {
  let submit = null
  const server = await startServer(async (request, response, entry) => {
    if (request.url === '/v1/videos' && request.method === 'POST') {
      submit = JSON.parse(entry.text || '{}')
      json(response, 200, { id: 'v2', status: 'queued' })
      return
    }
    if (request.url === '/v1/videos/v2') {
      json(response, 200, { status: 'completed', size: '720x1280', seconds: '4' })
      return
    }
    if (request.url === '/v1/videos/v2/content') {
      binary(response, 200, MP4, 'video/mp4')
      return
    }
    response.statusCode = 404
    response.end()
  })
  t.after(() => server.close())

  const cwd = tempDir()
  const image = path.join(cwd, 'frame.png')
  fs.writeFileSync(image, PNG)
  const tool = createVideoTool(providerConfig(server.url), makeHost())
  const result = await runTool(
    tool,
    { prompt: 'animate', model: 'sora-2', seconds: '4', size: '1280x720', input_image: image },
    cwd
  )
  assert.equal(submit.model, 'sora-2')
  assert.equal(submit.seconds, '4')
  assert.equal(submit.size, '1280x720')
  assert.ok(submit.input_reference.image_url.startsWith('data:image/png;base64,'))
  const metadata = JSON.parse(fs.readFileSync(result.metadata_path, 'utf8'))
  assert.equal(JSON.stringify(metadata).includes('data:image/png;base64'), false, 'metadata must not embed image bytes')
})

test('async-videos: xAI-style submit and polling to a CDN URL', async (t) => {
  let polls = 0
  let submit = null
  const server = await startServer(async (request, response, entry) => {
    if (request.url === '/v1/videos/generations' && request.method === 'POST') {
      submit = JSON.parse(entry.text || '{}')
      json(response, 200, { request_id: 'req1', status: 'pending' })
      return
    }
    if (request.url === '/v1/videos/req1') {
      polls += 1
      if (polls < 2) {
        json(response, 200, { request_id: 'req1', status: 'pending' })
      } else {
        json(response, 200, { request_id: 'req1', status: 'done', video: { url: `${server.url}/cdn/out.mp4` } })
      }
      return
    }
    if (request.url === '/cdn/out.mp4') {
      binary(response, 200, MP4, 'video/mp4')
      return
    }
    response.statusCode = 404
    response.end()
  })
  t.after(() => server.close())

  const cwd = tempDir()
  const tool = createVideoTool(providerConfig(server.url), makeHost())
  const result = await runTool(
    tool,
    { prompt: 'waves', model: 'grok-imagine-video-1.5', seconds: '12', aspect_ratio: '16:9' },
    cwd
  )
  assert.equal(submit.model, 'grok-imagine-video-1.5')
  assert.equal(submit.duration, 12)
  assert.equal(submit.aspect_ratio, '16:9')
  assert.equal(polls >= 2, true)
  assert.ok(fs.existsSync(result.path))
  assert.match(result.path, /\.mp4$/)
  assert.equal(result.provider, 'openai')
})

test('per-model default seconds and aspect ratio are applied for the async dialect', async (t) => {
  let submit = null
  const server = await startServer(async (request, response, entry) => {
    if (request.url === '/v1/videos/generations') {
      submit = JSON.parse(entry.text)
      json(response, 200, { request_id: 'd1' })
      return
    }
    if (request.url === '/v1/videos/d1') {
      json(response, 200, { status: 'done', video: { url: `${server.url}/d.mp4` } })
      return
    }
    if (request.url === '/d.mp4') {
      binary(response, 200, MP4, 'video/mp4')
      return
    }
    response.statusCode = 404
    response.end()
  })
  t.after(() => server.close())
  const config = providerConfig(server.url)
  config.providers[0].models = [
    { id: 'grok-imagine-video-1.5', kind: 'video', protocol: 'async-videos', seconds: '12', aspectRatio: '16:9' }
  ]
  const tool = createVideoTool(config, makeHost())
  const result = await runTool(tool, { prompt: 'defaults' }, tempDir())
  assert.equal(submit.duration, 12)
  assert.equal(submit.aspect_ratio, '16:9')
  assert.equal(result.duration_seconds, 12)
})

test('a failed video job reports the provider reason', async (t) => {
  const server = await startServer(async (request, response) => {
    if (request.url === '/v1/videos/generations') {
      json(response, 200, { request_id: 'bad' })
      return
    }
    if (request.url === '/v1/videos/bad') {
      json(response, 200, { status: 'failed', error: { message: 'content policy' } })
      return
    }
    response.statusCode = 404
    response.end()
  })
  t.after(() => server.close())
  const tool = createVideoTool(providerConfig(server.url), makeHost())
  await assert.rejects(
    () => runTool(tool, { prompt: 'x', model: 'grok-imagine-video-1.5' }, tempDir()),
    (error) => {
      assert.match(error.message, /Video generation failed/)
      assert.match(error.message, /content policy/)
      return true
    }
  )
})

test('the video deadline is enforced', async (t) => {
  const server = await startServer(async (request, response) => {
    if (request.url === '/v1/videos/slow') {
      json(response, 200, { status: 'running' })
      return
    }
    response.statusCode = 404
    response.end()
  })
  t.after(() => server.close())
  await assert.rejects(
    () =>
      waitForVideo({
        provider: { id: 'p', baseUrl: `${server.url}/v1`, apiKeyEnv: 'K', models: [] },
        key: KEY,
        protocol: 'async-videos',
        id: 'slow',
        config: {
          providers: [],
          problems: [],
          requestTimeoutMs: 1000,
          imageTimeoutMs: 1000,
          videoTimeoutMs: 150,
          pollIntervalMs: 10,
          maxDownloadBytes: 1024 * 1024,
          maxImagesPerCall: 1,
          writeMetadata: false
        }
      }),
    /timed out/
  )
})

test('a completed async job with no URL fails with guidance', async (t) => {
  const server = await startServer(async (request, response) => {
    if (request.url === '/v1/videos/generations') {
      json(response, 200, { request_id: 'nourl' })
      return
    }
    if (request.url === '/v1/videos/nourl') {
      json(response, 200, { status: 'completed' })
      return
    }
    response.statusCode = 404
    response.end()
  })
  t.after(() => server.close())
  const tool = createVideoTool(providerConfig(server.url), makeHost())
  await assert.rejects(
    () => runTool(tool, { prompt: 'x', model: 'grok-imagine-video-1.5' }, tempDir()),
    /no video URL/
  )
})

test('cross-origin video downloads do not carry the Authorization header', async (t) => {
  const seen = []
  const cdn = await startServer(async (request, response) => {
    seen.push(request.headers.authorization)
    binary(response, 200, MP4, 'video/mp4')
  })
  t.after(() => cdn.close())

  const server = await startServer(async (request, response) => {
    if (request.url === '/v1/videos/generations') {
      json(response, 200, { request_id: 'cdn' })
      return
    }
    if (request.url === '/v1/videos/cdn') {
      json(response, 200, { status: 'done', video: { url: `${cdn.url}/v.mp4` } })
      return
    }
    response.statusCode = 404
    response.end()
  })
  t.after(() => server.close())

  const tool = createVideoTool(providerConfig(server.url), makeHost())
  const result = await runTool(tool, { prompt: 'waves', model: 'grok-imagine-video-1.5' }, tempDir())
  assert.ok(fs.existsSync(result.path))
  assert.deepEqual(seen, [undefined])
})

test('videos-generations: buffered sync response with a video URL, no polling', async (t) => {
  let submit = null
  let statusPolls = 0
  const server = await startServer(async (request, response, entry) => {
    if (request.url === '/v1/videos/generations' && request.method === 'POST') {
      submit = JSON.parse(entry.text || '{}')
      json(response, 200, {
        id: 'sync1',
        status: 'completed',
        duration_seconds: 5,
        videos: [{ url: `${server.url}/cdn/sync.mp4`, duration_seconds: 5 }]
      })
      return
    }
    if (request.url === '/v1/videos/sync1') {
      statusPolls += 1
      json(response, 200, { status: 'completed' })
      return
    }
    if (request.url === '/cdn/sync.mp4') {
      binary(response, 200, MP4, 'video/mp4')
      return
    }
    response.statusCode = 404
    response.end()
  })
  t.after(() => server.close())

  const cwd = tempDir()
  const image = path.join(cwd, 'first-frame.png')
  fs.writeFileSync(image, PNG)
  const config = providerConfig(server.url)
  config.providers[0].models = [{ id: 'seedance-2.5', kind: 'video', protocol: 'videos-generations' }]
  const tool = createVideoTool(config, makeHost())
  const result = await runTool(
    tool,
    { prompt: 'ocean at dawn', model: 'seedance-2.5', seconds: '5', size: '1280x720', input_image: image },
    cwd
  )

  assert.ok(fs.existsSync(result.path))
  assert.match(result.path, /\.mp4$/)
  assert.equal(statusPolls, 0, 'a buffered 200 response must not be polled')
  assert.equal(submit.model, 'seedance-2.5')
  assert.equal(submit.duration_seconds, 5)
  assert.equal(submit.duration, undefined)
  assert.equal(submit.resolution, '720p')
  assert.equal(submit.aspect_ratio, '16:9')
  assert.equal(submit.size, undefined)
  assert.ok(submit.image_url.startsWith('data:image/png;base64,'))
  assert.equal(result.duration_seconds, 5)
  assert.equal(result.job_id, 'sync1')
  const metadata = JSON.parse(fs.readFileSync(result.metadata_path, 'utf8'))
  assert.equal(metadata.protocol, 'videos-generations')
  assert.equal(JSON.stringify(metadata).includes('data:image/png;base64'), false)
  assert.equal(result.text.includes(KEY), false)
})

test('videos-generations: buffered base64 MP4 is written without a download request', async (t) => {
  let submit = null
  let downloads = 0
  const server = await startServer(async (request, response, entry) => {
    if (request.url === '/v1/videos/generations' && request.method === 'POST') {
      submit = JSON.parse(entry.text || '{}')
      json(response, 200, {
        id: 'sync2',
        status: 'succeeded',
        videos: [{ b64_video: MP4.toString('base64'), duration_seconds: '4' }]
      })
      return
    }
    downloads += 1
    response.statusCode = 200
    response.end()
  })
  t.after(() => server.close())

  const config = providerConfig(server.url)
  config.providers[0].models = [{ id: 'seedance-2.5', kind: 'video', protocol: 'videos-generations' }]
  const tool = createVideoTool(config, makeHost())
  const result = await runTool(tool, { prompt: 'base64 test', model: 'seedance-2.5' }, tempDir())

  assert.ok(fs.existsSync(result.path))
  assert.equal(downloads, 0, 'base64 media must not trigger a download')
  assert.equal(submit.duration_seconds, 5, 'buffered requests default to a 5s duration')
  assert.equal(result.duration_seconds, 4)
  assert.equal(result.job_id, 'sync2')
  const metadata = JSON.parse(fs.readFileSync(result.metadata_path, 'utf8'))
  assert.equal(metadata.protocol, 'videos-generations')
  assert.equal(JSON.stringify(metadata).includes(MP4.toString('base64')), false)
})
