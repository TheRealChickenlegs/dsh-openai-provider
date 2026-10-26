# Changelog

All notable changes to this project are documented here.

## 0.1.3 — 2026-10-26

### Added

- **`videos-generations` buffered video adapter.** `POST /videos/generations` on
  Cheaper Inference waits for the render and returns `videos[]` with a URL or
  `b64_video`; it is not a pollable async job. The adapter submits once with the
  video timeout, reads the media from that response, and (for base64) writes the
  MP4 directly without a download.
- Host-aware video dialect defaults: `cheaperinference.com` → buffered
  `videos-generations`, `api.openai.com` + `sora` → `openai-videos`, everything
  else → `async-videos`.
- The model editor shows `sync /videos/generations` and pins it for Cheaper
  Inference video models; discovery classifies video models from catalogue
  `type`/`capabilities`/endpoint metadata, including `seedance` ids.
- Buffered requests map `size` (for example `1280x720`) to
  `resolution: "720p"` and `aspect_ratio: "16:9"`, and default to
  `duration_seconds: 5` when no duration was supplied.

### Fixed

- Sora-named models on third-party gateways no longer default to OpenAI's
  `/videos` shape; only `api.openai.com` uses it.
- An async protocol saved for Cheaper Inference before this adapter existed is
  corrected to the buffered sync dialect.

### Tests

- Buffered URL and base64 MP4 responses, no-polling and no-download guarantees,
  host-aware defaults, catalogue classification, and the settings-page sync
  option. 88 tests total.

## 0.1.2 — 2026-10-26

### Fixed

- Adding or removing a model no longer blanks the provider form. The card's
  model mutations now go through the updater-aware state path instead of
  storing a function as the provider (which produced
  `Provider 1: id must be lowercase letters, digits and hyphens`).
- Discovery results survive the save that runs before **Load models**: each
  provider card keeps a stable key across the configuration mirror round-trip.

### Added

- Discovered models can be **multi-selected with checkboxes** and added with
  **Add selected (N)**. **Select all shown** covers the current filter, and all
  added models remain editable (kind and API dialect) in the exposed list.

### Tests

- A jsdom flow test now covers Add provider → discover → select two →
  Add selected → Save and asserts that every provider field survived.

## 0.1.1 — 2026-10-26

### Fixed

- **Adding a provider no longer blanks the plugin page.** The client bundle now
  declares `remote.credentials` in its `inject` list; without it, Cordis throws on
  the first card's credential-status effect and DSH's slot boundary abdicates the
  whole configuration section. Credential and discovery calls are also guarded,
  and page/card error boundaries keep a failure visible instead of removing the page.
- Added jsdom interaction coverage for Add provider with and without a working
  credentials namespace, plus a check that the bundle declares the namespace.

## 0.1.0 — 2026-10-26

Initial release.

### Added

- Multiple OpenAI-compatible providers with per-provider endpoint, label and credential reference.
- Provider page with API-key saving through DSH's credentials service, live `/models` discovery, and
  explicit image/video model selection.
- `openai_providers` discovery and diagnostics tool.
- `openai_generate_image` tool: text-to-image, edits via multipart or JSON, multiple outputs,
  b64/URL response handling, collision-free file output, metadata sidecars.
- `openai_generate_video` tool: asynchronous submit/poll/download for the `openai-videos` and
  `async-videos` dialects, reference images, per-job timeouts.
- Authenticated same-origin model-discovery route, limited to configured provider ids.
- Per-model defaults (size, quality, seconds, aspect ratio) and capability-aware provider
  auto-selection.
- Secret redaction across errors, results, sidecars and logs; redirect/origin/size controls for
  media downloads.
- Tag-driven GitHub Release and npm publishing workflows with provenance, version/tag and
  already-published guards, plus CI that verifies the committed `lib/` matches `src/`.
- 80 tests using Node's test runner and fake OpenAI-compatible servers, including client render
  tests and a package/plugin version consistency check.

### Notes

- OpenAI's hosted Sora 2 Videos API was retired on 2026-09-24. The `openai-videos` dialect remains
  available for gateways implementing that shape; `async-videos` is the default for non-`sora`
  model ids.
