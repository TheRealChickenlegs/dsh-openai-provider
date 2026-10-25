/**
 * This plugin's error type.
 *
 * DSH shows the thrown `message` to the model, so every message must answer
 * "what failed" and, through `hint`, "what to do next". Provider bodies are
 * truncated and never include request headers.
 */
/** Base class for every error this plugin throws on purpose. */
export class ProviderPluginError extends Error {
    /** Machine-routable code, useful in tests and structured output. */
    code;
    /** A next-step suggestion for the user/model. */
    hint;
    /** HTTP status, when the failure came from a provider response. */
    status;
    constructor(code, message, hint, status) {
        super(message);
        this.name = 'ProviderPluginError';
        this.code = code;
        this.hint = hint;
        if (status !== undefined)
            this.status = status;
    }
}
/** Compose a complete error: main message + optional next-step suggestion. */
export function formatError(error) {
    if (error instanceof ProviderPluginError) {
        return error.hint ? `${error.message}\nNext step: ${error.hint}` : error.message;
    }
    if (error instanceof Error)
        return error.message;
    return String(error);
}
/** The plugin is not configured with any provider yet. */
export function notConfigured() {
    return new ProviderPluginError('NO_PROVIDERS', 'No OpenAI-compatible providers are configured.', 'Open DSH → Plugins → Plugins → OpenAI Providers, add a provider (endpoint + API key) and click "Load models" to choose what to expose.');
}
/** The requested provider id does not exist. */
export function unknownProvider(requested, available) {
    return new ProviderPluginError('UNKNOWN_PROVIDER', `Unknown provider "${requested}". Configured providers: ${available.length > 0 ? available.join(', ') : '(none)'}.`, 'Call openai_providers to see the configured provider ids, or omit `provider` when only one is configured.');
}
/** A provider is needed because several are configured. */
export function ambiguousProvider(available) {
    return new ProviderPluginError('AMBIGUOUS_PROVIDER', `Several providers are configured (${available.join(', ')}); pass the \`provider\` argument to choose one.`, 'Call openai_providers to see each provider and its exposed models.');
}
/** Providers exist, but none exposes a model of the requested capability. */
export function noProviderForKind(kind, available) {
    return new ProviderPluginError('NO_PROVIDER_FOR_KIND', `None of the configured providers (${available.join(', ')}) exposes a model of kind ${kind}.`, `Open the OpenAI Providers plugin page, load models for a provider that supports ${kind}, tick at least one ${kind} model and save.`);
}
/** No model was selected for the requested capability. */
export function noModels(provider, kind) {
    return new ProviderPluginError('NO_MODELS', `Provider "${provider}" has no ${kind} models selected.`, `Open the OpenAI Providers plugin page, click "Load models" for "${provider}", tick a ${kind} model and save.`);
}
/** A model is needed because several candidates exist or none is obvious. */
export function modelRequired(provider, kind, models) {
    return new ProviderPluginError('MODEL_REQUIRED', `Provider "${provider}" exposes several ${kind} models (${models.join(', ')}); pass the \`model\` argument.`, 'Call openai_providers to see the exact model ids.');
}
/** The requested model is not among the ones the user exposed. */
export function modelNotExposed(provider, model, available) {
    return new ProviderPluginError('MODEL_NOT_EXPOSED', `Model "${model}" is not exposed for provider "${provider}". Exposed models: ${available.join(', ') || '(none)'}.`, 'Pick one of the exposed ids, or add it on the OpenAI Providers plugin page. The plugin only uses models you selected.');
}
/** The provider's credential reference is not set anywhere. */
export function missingApiKey(ref, provider) {
    return new ProviderPluginError('MISSING_API_KEY', `No API key is stored for provider "${provider}" (credential reference ${ref}).`, `On the OpenAI Providers plugin page, paste the key into the provider's key field and click "Save key". ` +
        `Alternatively export ${ref} in the environment that launches DSH. The key is stored by DSH's credentials service and never in this profile.`);
}
/** The endpoint is not an http(s) URL. */
export function badEndpoint() {
    return new ProviderPluginError('BAD_ENDPOINT', 'The provider endpoint is not a usable http(s) URL.', 'Use the API root, for example https://api.openai.com/v1 — no query string, no fragment, and no username/password in the URL.');
}
/** Network failure (DNS, refused connection, TLS). */
export function unreachable(baseUrl, cause) {
    const detail = cause instanceof Error && cause.message ? ` (${cause.message})` : '';
    return new ProviderPluginError('UNREACHABLE', `Cannot reach the provider at ${baseUrl}${detail}`, 'Check the base URL and that this machine can reach the endpoint; a local gateway must be running.');
}
/** Timeout. */
export function timedOut(what, ms) {
    return new ProviderPluginError('TIMEOUT', `${what} timed out after ${Math.round(ms / 1000)}s.`, 'Increase the timeout in the plugin settings if the provider is slow, or try a smaller/faster model.');
}
/** Response exceeded the configured safety cap. */
export function responseTooLarge(what, limit) {
    return new ProviderPluginError('RESPONSE_TOO_LARGE', `${what} exceeded the ${Math.round(limit / (1024 * 1024))} MiB safety limit.`, 'Raise maxDownloadBytes in the plugin settings only if you trust the endpoint and expect large files.');
}
/** Response was not the JSON shape expected. */
export function badResponse(what, detail) {
    return new ProviderPluginError('BAD_RESPONSE', `${what} returned an unexpected response: ${detail}`, 'Confirm the endpoint is OpenAI-compatible and that the base URL includes the right API prefix (often /v1).');
}
