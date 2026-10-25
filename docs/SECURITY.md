# Security model

This plugin holds credentials for third-party services and sends generated content over the network.
The design assumes the provider may be buggy, the endpoint may be untrusted, and the model may be
prompted into trying to exfiltrate a key.

## 1. Credential storage

- API keys are stored through DSH's credential seam (`ctx.credentials`), normally
  `@deepseek-ai/dsh-credentials-local`, which owns `$DSH_HOME/.credentials.yaml`.
- That provider writes atomically, creates/replaces the file with owner-only permission bits, and
  **refuses to load** a file readable by group or others (`chmod 600` is the remedy).
- The plugin config, profile YAML, config file and metadata sidecars contain only the reference
  name (`apiKeyEnv`), never the value.
- `apiKeyEnv` is validated against `[A-Za-z_][A-Za-z0-9_]*`. A value that looks like a key
  (`sk-…`, or an 80+ character blob) is discarded with a warning and replaced by the derived
  reference `DSH_OPENAI_<ID>_API_KEY`. The offending value is not copied into any log or file.
- The browser page never receives a key. It sends a new key **to** `credentials.set` over the
  same-origin connection, and only reads `credentials.describe` (configured/source/writable).

Fallback order at call time: `ctx.credentials.resolve(ref)` → `process.env[ref]`. The credentials
provider itself already layers the managed store over the launch environment and `.env` files.

## 2. Key egress

- The key goes into the header configured for **that provider** (`Authorization: Bearer …` by
  default) and nowhere else.
- API requests use `redirect: 'error'`. A 3xx is reported as an error instead of replaying the
  request (and its credential) to another host.
- Media downloads follow at most three http(s) redirects and attach the provider's auth header only
  while the target **origin** equals the configured API origin. A CDN URL gets no credential.
- Media URLs are restricted to `http:`/`https:`; `file:`, `data:` and other schemes are refused.
- Response bodies are capped. HTML/JSON error pages are rejected instead of being written with a
  media extension.

## 3. Untrusted provider output

- Provider error messages are truncated, stripped of HTML, and passed through
  `redactSecrets(text, [resolvedKey])`. The redactor removes the exact secret and also scrubs
  `Authorization: …` / `api[-_]key: …` shapes.
- The same redaction is applied to tool result text, `revised_prompt` values, and every string in
  the JSON metadata sidecar (including `usage`). A provider that echoes the caller's key cannot put
  it in the transcript or on disk.
- Logs contain provider ids, endpoints (which are already in config), status codes and timings.
  They never contain headers or response bodies at info level; the debug switch is name-only too.
- Generated files are written with `0644` (not executable). Sidecars use `0644`.

## 4. Discovery route

`POST /plugin/openai-provider/api/models` exists only when DSH mounts a web server.

- **Authentication**: it calls `ctx.connection.requestRejection(req)`, the same check `/api` uses.
  If the connection service is absent it refuses non-loopback callers.
- **Same-origin / CSRF**: the request must carry `content-type: application/json` and
  `x-dsh-openai-provider: 1`. A cross-site HTML form cannot set either; a cross-origin `fetch`
  would need a CORS preflight, which the route never grants. DSH's trust check also rejects
  `Sec-Fetch-Site: cross-site` and mismatched `Origin`.
- **No arbitrary target**: the body carries only `providerId`. The host looks up the endpoint and
  credential reference in its own resolved config. There is no parameter for a URL, header or
  credential reference, so a compromised page cannot ask the host to send a stored key to an
  attacker-controlled host.
- **Bounded**: 16 KiB JSON request body cap, `no-store`, `nosniff`, and a response containing ids
  only. Provider error bodies are truncated and redacted.
- **Failure**: errors return the redacted message and a code; they never return headers.

## 5. Cost and load

- Only models explicitly exposed by the user are callable. There is no "try any model id" path.
- `n` is clamped by `maxImagesPerCall` (default 4, hard ceiling 10).
- Every request has a timeout; video jobs have a total deadline; polling has a fixed interval and
  retries only idempotent GETs.
- Provider selection is automatic only when exactly one provider exposes the requested capability;
  otherwise the call fails and asks for an explicit `provider`.
- Nothing contacts a provider at plugin startup; the first network request happens on a tool call or
  an explicit "Load models".

## 6. What this plugin does not protect against

- A compromised DSH host process (any plugin can read the credential file if it is running as the
  same user).
- A malicious provider you deliberately configure and whose endpoint you control: it receives the
  key you give it.
- Plain-HTTP endpoints on a hostile network. Use HTTPS; localhost HTTP is the usual exception.
- Secrets pasted into chat. The tools refuse an `api_key` argument, but the user can still type one
  into the conversation. The plugin page's key field is the only supported entry point.

## Reporting

Open a private security advisory on the repository rather than a public issue when the report could
expose a credential or a bypass. Do not include real keys in a report.
