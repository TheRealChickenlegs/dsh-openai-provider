# Configuration

There are three non-secret layers, plus the DSH credential store for values.

## Precedence

| Layer | Where | Good for |
| --- | --- | --- |
| 1. Plugin config | `config:` of the `dsh-openai-provider` entry in the profile (`cordis.patch.yml`), written by the plugin page | Normal use; versionable non-secret config |
| 2. Config file | `~/.dsh-openai-provider/config.json` (or `$DSH_OPENAI_PROVIDER_CONFIG`) | Headless hosts, CI, keeping providers out of the profile |
| 3. Environment | `DSH_OPENAI_PROVIDER_*` + `DSH_OPENAI_PROVIDER_PROVIDERS` | Containers and one-off overrides |
| 4. Defaults | Built into the plugin | Sensible starting values |

For **providers**, the highest layer with a non-empty `providers` array wins wholesale. Provider
lists are not deep-merged; a profile list cannot accidentally inherit half of a file list. If every
layer has an empty (or absent) provider list, there are no providers.

An API key value is **never** read from any of these layers — only the credential reference name.

## Profile config

```yaml
- id: dsh-openai-provider
  name: dsh-openai-provider
  config:
    providers:
      - id: openai
        label: OpenAI
        baseUrl: https://api.openai.com/v1
        apiKeyEnv: OPENAI_API_KEY
        models:
          - id: gpt-image-1
            kind: image
            size: 1024x1024
            quality: high
      - id: xai
        label: xAI
        baseUrl: https://api.x.ai/v1
        apiKeyEnv: XAI_API_KEY
        models:
          - id: grok-imagine-video-1.5
            kind: video
            protocol: async-videos
            seconds: '8'
            aspectRatio: '16:9'
    outputDir: ./generated
    maxImagesPerCall: 3
    writeMetadata: true
```

The plugin page writes this structure with the settings service; hand-editing is fine too.

## Config file

```json
{
  "providers": [
    {
      "id": "gateway",
      "label": "Internal gateway",
      "baseUrl": "https://gateway.internal/v1",
      "apiKeyEnv": "GATEWAY_API_KEY",
      "models": [
        { "id": "flux-pro", "kind": "image", "editMode": "multipart" },
        { "id": "veo-3", "kind": "video", "protocol": "async-videos" }
      ]
    }
  ],
  "outputDir": "/var/lib/dsh-generated",
  "videoTimeoutMs": 1200000
}
```

The file is read on every tool call, so a change takes effect without restarting DSH. A missing or
broken file is ignored with a warning; it never prevents the plugin from loading.

## Environment variables

| Variable | Meaning |
| --- | --- |
| `DSH_OPENAI_PROVIDER_CONFIG` | Override the config-file path |
| `DSH_OPENAI_PROVIDER_PROVIDERS` | Inline JSON array of providers (same shape as above) |
| `DSH_OPENAI_PROVIDER_OUTPUT_DIR` | Default output directory |
| `DSH_OPENAI_PROVIDER_MAX_IMAGES` | Default `maxImagesPerCall` (1–10) |
| `DSH_OPENAI_PROVIDER_REQUEST_TIMEOUT_MS` | Metadata/status request timeout |
| `DSH_OPENAI_PROVIDER_IMAGE_TIMEOUT_MS` | One image request timeout |
| `DSH_OPENAI_PROVIDER_VIDEO_TIMEOUT_MS` | Whole video-job deadline |
| `DSH_OPENAI_PROVIDER_POLL_INTERVAL_MS` | Video poll interval |
| `DSH_OPENAI_PROVIDER_MAX_DOWNLOAD_BYTES` | Media download cap |
| `DSH_OPENAI_PROVIDER_WRITE_METADATA` | `true` / `false` |
| `DSH_OPENAI_PROVIDER_DEBUG` | `1` for request-level debug logs (never includes keys) |

Credential values are supplied by DSH, not by this plugin. Either save them on the plugin page, or
export the reference in the launching environment (for example `OPENAI_API_KEY`).

## Provider fields

| Field | Required | Default | Notes |
| --- | --- | --- | --- |
| `id` | yes | — | Lowercase slug, `a-z0-9-`, 1–64 chars; the tool-visible provider id |
| `label` | no | `id` | Display name |
| `baseUrl` | yes | — | http(s) API root **including** any prefix (`/v1`); no query, fragment or embedded credentials |
| `apiKeyEnv` | no | `DSH_OPENAI_<ID>_API_KEY` | Credential **reference**, never a value |
| `apiKeyHeader` | no | `Authorization` | Custom auth header where required |
| `apiKeyPrefix` | no | `Bearer ` | Prefix before the key; `""` sends the raw key |
| `organization` | no | — | Sends `OpenAI-Organization` |
| `project` | no | — | Sends `OpenAI-Project` |
| `headers` | no | — | Extra non-secret headers. `Authorization`, `Cookie`, `Host`, `Content-*`, and secret-bearing names (`api-key`, `token`, `secret`, …) are refused; use `apiKeyHeader` for authentication |
| `models` | no | `[]` | Models exposed to the session; an empty list means the provider is visible but unusable until models are added |

## Model fields

| Field | Required | Default | Notes |
| --- | --- | --- | --- |
| `id` | yes | — | Exact id sent to the provider |
| `kind` | no | guessed from the name | `image` or `video` |
| `label` | no | `id` | Display name |
| `protocol` | video only | `openai-videos` for `sora` ids, otherwise `async-videos` | Video dialect |
| `editMode` | image only | `json` for `grok*` ids, otherwise `multipart` | Shape of `/images/edits` |
| `size` | no | provider default | Default size, e.g. `1024x1024` |
| `quality` | no | provider default | Default quality, e.g. `high` |
| `seconds` | video only | provider default | Default clip duration |
| `aspectRatio` | video only | provider default | Default aspect ratio for `async-videos` |

Per-model defaults are applied only when the tool call does not pass the corresponding argument.

## Scalar settings

| Key | Default | Range |
| --- | --- | --- |
| `outputDir` | session working directory | any directory |
| `maxImagesPerCall` | `4` | 1–10 |
| `requestTimeoutMs` | `60000` | 1000–600000 |
| `imageTimeoutMs` | `180000` | 10000–1800000 |
| `videoTimeoutMs` | `900000` | 10000–3600000 |
| `pollIntervalMs` | `5000` | 500–60000 |
| `maxDownloadBytes` | `536870912` (512 MiB) | 1 MiB–2 GiB |
| `writeMetadata` | `true` | boolean |

Out-of-range numbers fall back to the default; invalid providers are dropped and reported by
`openai_providers` and in the startup log.

## Generated files

- Image names: `openai-image-<provider>-<model>-<YYYYMMDD-HHMMSS>.<ext>`
- Video names: `openai-video-<provider>-<model>-<YYYYMMDD-HHMMSS>.<ext>`
- A collision appends `-1`, `-2`, …; an existing file is never overwritten.
- With `writeMetadata`, a `<stem>-metadata.json` sidecar records provider, model, prompt, request
  summary, usage and timing. It never contains a key or image bytes.
- The real format is sniffed from the bytes (PNG/JPEG/WebP/GIF, MP4/WebM/MOV), so a provider that
  ignores the requested format still produces a correctly named file.
