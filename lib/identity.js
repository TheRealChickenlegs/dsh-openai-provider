/**
 * Stable plugin identity.
 *
 * Dependency-free on purpose: config, logging, HTTP and tools all import this
 * module, and none of them should create an import cycle through it.
 */
/** Package id / loader entry id. Keep in sync with package.json `name`. */
export const PLUGIN_ID = 'dsh-openai-provider';
/** Human-readable name shown in the plugin list and documentation. */
export const PLUGIN_DISPLAY_NAME = 'OpenAI Providers';
/** Plugin version reported in the startup line. Keep in sync with package.json `version`. */
export const PLUGIN_VERSION = '0.1.5';
/** Prefix for this plugin's environment variables. */
export const ENV_PREFIX = 'DSH_OPENAI_PROVIDER';
/** Override the non-secret config file location. */
export const ENV_CONFIG = `${ENV_PREFIX}_CONFIG`;
/** Inline JSON provider list, useful for containers and CI. Never contains key values. */
export const ENV_PROVIDERS = `${ENV_PREFIX}_PROVIDERS`;
/** Verbose logging switch. */
export const ENV_DEBUG = `${ENV_PREFIX}_DEBUG`;
/** Same-origin model-discovery route served by DSH's web server, when mounted. */
export const ROUTE_PREFIX = '/plugin/openai-provider/api';
/** Header the settings page sends; it also makes cross-site requests fail the browser preflight. */
export const ROUTE_HEADER = 'x-dsh-openai-provider';
/** Prefix for credential references derived from a provider id. */
export const CREDENTIAL_PREFIX = 'DSH_OPENAI_';
/** Global cap on configured providers, so one profile cannot fan out without bound. */
export const MAX_PROVIDERS = 20;
/** Global cap on selected models per provider. */
export const MAX_MODELS_PER_PROVIDER = 200;
