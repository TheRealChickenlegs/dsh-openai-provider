# Changelog

All notable changes to this project are documented here.

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
