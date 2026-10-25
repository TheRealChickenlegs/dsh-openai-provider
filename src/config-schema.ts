/**
 * Editable Cordis config schema for the plugin page.
 *
 * Every field is optional and volatile:
 * - optional, so an unset field falls through to the config file and defaults;
 * - volatile, so the Settings form can write it into the active profile and DSH
 *   can update the running plugin without a remount.
 *
 * No defaults live here on purpose: a schema default would become a plugin
 * config value and silently override the config file layer.
 *
 * SECURITY: there is no `apiKey` field. `apiKeyEnv` is the *name* of a
 * credential; values live in the DSH credentials store and never in the profile.
 */
import Schema from '@deepseek-ai/schemastery'

const Model = Schema.object({
  id: Schema.string(),
  kind: Schema.string(),
  label: Schema.string(),
  protocol: Schema.string(),
  editMode: Schema.string(),
  size: Schema.string(),
  quality: Schema.string(),
  seconds: Schema.string(),
  aspectRatio: Schema.string()
})

const Provider = Schema.object({
  id: Schema.string(),
  label: Schema.string(),
  baseUrl: Schema.string(),
  apiKeyEnv: Schema.string(),
  apiKeyHeader: Schema.string(),
  apiKeyPrefix: Schema.string(),
  organization: Schema.string(),
  project: Schema.string(),
  headers: Schema.dict(Schema.string()),
  models: Schema.array(Model)
})

export const Config = Schema.object({
  providers: Schema.array(Provider).volatile(),
  outputDir: Schema.string().volatile(),
  requestTimeoutMs: Schema.number().volatile(),
  imageTimeoutMs: Schema.number().volatile(),
  videoTimeoutMs: Schema.number().volatile(),
  pollIntervalMs: Schema.number().volatile(),
  maxDownloadBytes: Schema.number().volatile(),
  maxImagesPerCall: Schema.number().volatile(),
  writeMetadata: Schema.boolean().volatile()
})
