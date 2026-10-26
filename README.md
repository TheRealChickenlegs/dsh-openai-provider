[![npm](https://img.shields.io/npm/v/dsh-openai-provider.svg)](https://www.npmjs.com/package/dsh-openai-provider)

# OpenAI Providers for DeepSeek Harness

Connect **multiple OpenAI-compatible endpoints** to a DSH session, pick which of their image and
video models to expose, and let the main DSH model generate media through them.

```
OpenAI Providers (this plugin)
├─ provider "openai"   https://api.openai.com/v1   → gpt-image-1
├─ provider "xai"      https://api.x.ai/v1         → grok-imagine-image-2.0, grok-imagine-video-1.5
└─ provider "gateway"  https://gateway.internal/v1 → flux-pro, veo-3
             │
             ├─ openai_providers        what is configured / what is exposed
             ├─ openai_generate_image   text-to-image and image edits
             └─ openai_generate_video   asynchronous video generation
```

- 🔐 **API keys never enter the profile.** Keys are stored by DSH's credentials service
  (owner-only file, `0600`); the plugin config stores only the *reference name*.
- 🎛️ **You choose the surface.** Only models you tick on the plugin page are callable by the agent.
- 🖼️ **One tool per capability**, with images and videos saved to disk and reported by absolute path.
- 🧩 **No runtime dependencies on DSH internals**; the tools work on any DSH host that provides `tools`.

## Requirements

- DSH `>= 0.2.0-rc.1` (desktop, web or CLI profile)
- Node `>= 20` (the bundled DSH runtime is fine)

## Install

### From the plugin manager

1. Open **DSH → Plugins → Plugins**.
2. Install `dsh-openai-provider` (registry, tarball or local path).
3. Enable the **OpenAI Providers** bundle.
4. Open its settings page, add a provider, save, load models, tick what to expose.

### From a checkout (development / local use)

```bash
cd /path/to/dsh-openai-provider
npm install
npm run build

# Add the package to the active profile as a link
dsh plugin --profile desktop add link:/path/to/dsh-openai-provider
```

The `dsh` CLI adds the bundle to `dsh.profile.bundles` automatically; if it does not, add the
package name there (or toggle it in the plugin manager) and restart DSH. On the macOS desktop app
the CLI lives at `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`. The bundle's `cordis.patch.yml` mounts the
plugin entry. The desktop bundle list lives at `~/.dsh/profiles/desktop/package.json`.

> The profile's own `cordis.patch.yml` is the right place for non-secret overrides such as the
> default output directory or a headless provider list. See [docs/CONFIG.md](docs/CONFIG.md).

## Configure

The plugin page has three jobs: **providers**, **keys**, **model selection**.

1. **Add provider** — a slug (`openai`, `xai`, `my-gateway`), an API base URL including its prefix
   (`https://api.openai.com/v1`), and optionally a display label.
2. **Save key** — paste the key into the provider's key field. It is written through
   `ctx.remote.credentials.set` to the DSH credentials store. The field is never prefilled and the
   page never reads the value back. Leaving the *Credential reference* blank uses
   `DSH_OPENAI_<PROVIDER>_API_KEY`.
3. **Save**, then **Load models** — the page asks the host to call the provider's `GET /models`
   using the stored key. Nothing secret crosses to the browser: the page sends only the provider id,
   and the host looks up the already-configured endpoint and credential. Use the **type filter**
   (All media / Images / Videos / All types) and the search box to narrow a large catalogue; each
   row shows the catalogue's own type (`image`, `video`, `text`, `embedding`, …).
4. Tick the models you want and click **Add selected** (or add an id manually if the endpoint has no
   `/models`). Toggle their kind (`image`/`video`) and — only if the provider deviates — their API
   dialect.
5. **Save** again. The agent can now use those exact ids.

Reusable keys: point a provider at an existing reference such as `OPENAI_API_KEY` or `XAI_API_KEY`
and skip the key field if that variable is already exported in the launching environment.

## Tools exposed to the session

### `openai_providers`

Discovery and diagnostics. Returns configured provider ids, endpoints, whether each key is present
(and its source), the exposed models, and optionally a live `/models` refresh.

```json
{ "refresh": true, "include_unselected": true }
```

No generation cost. Never returns a key.

### `openai_generate_image`

Text-to-image and image editing through `images/generations` / `images/edits`:

```json
{
  "prompt": "Editorial photo of a red ceramic teapot on a linen table, soft morning light",
  "provider": "openai",
  "model": "gpt-image-1",
  "size": "1536x1024",
  "quality": "high"
}
```

Edits add `input_image` (and optionally `mask_image`). Multipart is used for OpenAI-style endpoints;
JSON data-URI edits are used for models configured as `edits: JSON` (the xAI Imagine style).
`output_path` may be a directory or one explicit file. Existing files are never overwritten.

### `openai_generate_video`

The adapter follows each model's video dialect: buffered sync, async submit/poll, or OpenAI `/videos`:

```json
{
  "prompt": "Slow aerial push over a winter forest at dawn, volumetric mist",
  "provider": "xai",
  "model": "grok-imagine-video-1.5",
  "seconds": "12",
  "aspect_ratio": "16:9"
}
```

Three dialects are supported per model:

| Dialect              | Submit                     | Completion                          | Media                                  |
| -------------------- | -------------------------- | ----------------------------------- | -------------------------------------- |
| `openai-videos`      | `POST /videos`             | `GET /videos/{id}`                  | `GET /videos/{id}/content`             |
| `async-videos`       | `POST /videos/generations` | `GET /videos/{id}` → URL            | the returned URL (often a CDN)         |
| `videos-generations` | `POST /videos/generations` | buffered in the same response       | `videos[].url` or `videos[].b64_video` |

OpenAI's hosted Sora 2 Videos API was [retired on 2026-09-24][sora-retired]; the `openai-videos`
dialect is kept for compatible gateways that still implement that shape. Most third-party providers
use the `async-videos` shape. **Cheaper Inference** uses `videos-generations`: the request waits for
the render (up to the provider's limit) and returns a `videos` array, so there is no job to poll.
The defaults are host-aware:

- `*.cheaperinference.com` → `videos-generations`
- `api.openai.com` with a `sora` model id → `openai-videos`
- everything else → `async-videos`

The model editor exposes the matching dialect; for Cheaper Inference it pins the buffered
`sync /videos/generations` option so a model cannot accidentally be saved as pollable.

[sora-retired]: https://developers.openai.com/api/docs/deprecations#2026-03-24-sora-2-video-generation-models-and-videos-api

## Security model

The full threat model and guarantees are in [docs/SECURITY.md](docs/SECURITY.md). The short version:

- Keys live in `$DSH_HOME/.credentials.yaml` (or the OS-specific credentials provider DSH mounts),
  created/checked as owner-only. The plugin config and YAML contain **only references**.
- A pasted value in `apiKeyEnv` that looks like a key (`sk-…`) is refused with a warning and never
  stored or printed.
- Keys cross from the page to DSH's credential store once, are resolved per call, and are sent only
  to the configured endpoint origin; API calls never follow redirects (`redirect: 'error'`).
- Media downloads allow at most three http(s) redirects, drop the `Authorization` header when the
  target origin differs from the API origin, reject HTML/JSON error pages, and enforce a hard byte
  cap (default 512 MiB).
- Error text, tool results, metadata sidecars and logs are scrubbed of the resolved key.
- The model-discovery route is same-origin, authenticated by DSH's connection service, requires a
  JSON body plus a custom header (blocking cross-site requests), accepts only a provider **id**, and
  can never be asked to send a key to a different host. Without the connection service it is
  loopback-only.
- Only models you explicitly exposed can be called; `n` is capped and every operation has a timeout,
  so one chat turn cannot fan out unbounded.

## Configuration reference

- [docs/CONFIG.md](docs/CONFIG.md) — profile config, config file, environment variables, per-model
  defaults, precedence
- [docs/SECURITY.md](docs/SECURITY.md) — threat model and storage details

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `HTTP 404` on every request | The base URL usually needs its API prefix, e.g. `https://api.openai.com/v1`. Do not include `/images/generations`. |
| "Load models" says discovery is not routed | The host did not mount a web server (for example `file://` Electron or a headless CLI profile). Add model ids manually; generation still works. |
| `No API key is stored` | Save the key on the plugin page, or export the credential reference in the environment that launches DSH. |
| Key status shows `environment` | The reference is supplied by the environment, not the managed store. Saving a key gives the managed store priority. |
| `Several providers are configured` | Pass `provider` in the tool call. Providers are auto-selected only when exactly one exposes the requested capability. |
| `HTTP 401/403` | The provider rejected the key. Rotate it and save again; check the account/project scope. |
| Video times out | Raise **Video job timeout** or pick a faster model; the default is 15 minutes. |
| Video completes with no URL | The gateway uses a different response shape. Try the other video dialect for that model, or check its docs. |

## Development

```bash
npm install
npm run build       # tsc + copies the browser bundle
npm run typecheck
npm test            # 89 tests: config, HTTP, images, videos, route, tools, settings DOM, security
```

`lib/` is build output but is **committed on purpose**, so the package can be installed from Git without a
TypeScript build. CI rebuilds it and fails if the committed output drifts from `src/`; run `npm run build`
after changing `src/`.

Releases are tag-driven: pushing a `vX.Y.Z` tag creates a GitHub Release and publishes to npm. See
[docs/RELEASING.md](docs/RELEASING.md) for the one-time `NPM_TOKEN` setup and the release checklist.

Layout:

```
src/
  index.ts          plugin entry (apply, tools, settings auto-form off, route)
  config.ts         multi-layer config + provider normalization
  config-schema.ts  volatile Cordis schema for the plugin page
  credentials.ts    ctx.credentials resolution + redaction
  http.ts           capped JSON/download transport, redirect + origin policy
  discovery.ts      GET /models parsing
  models.ts         provider/model selection by capability
  api/images.ts     images/generations + edits (multipart and JSON)
  api/videos.ts     openai-videos, async-videos and videos-generations dialects
  runner.ts         orchestration, file output, metadata, redaction
  tools.ts          tool contracts (JSON Schema subset)
  web-route.ts      authenticated model-discovery route
  client.js         no-bundler React settings page
test/               node:test suites with a fake OpenAI-compatible server
```

## License

MIT. See [LICENSE](LICENSE).
