# Changelog

All notable changes to this project are documented here.

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
- The settings page declares its credentials namespace and contains errors in page/card boundaries,
  so adding a provider can never blank or abdicate the plugin page.
- Secret redaction across errors, results, sidecars and logs; redirect/origin/size controls for
  media downloads.
- Tag-driven GitHub Release and npm publishing workflows with provenance, version/tag and
  already-published guards, plus CI that verifies the committed `lib/` matches `src/`.
- 83 tests using Node's test runner and fake OpenAI-compatible servers, including client render and
  DOM interaction tests, plus a package/plugin version consistency check.

### Notes

- OpenAI's hosted Sora 2 Videos API was retired on 2026-09-24. The `openai-videos` dialect remains
  available for gateways implementing that shape; `async-videos` is the default for non-`sora`
  model ids.
