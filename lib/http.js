/**
 * Small, deliberately conservative HTTP layer.
 *
 * Safety properties:
 * - API calls never follow redirects (`redirect: 'error'`), so an Authorization
 *   header cannot be bounced to another host.
 * - Media downloads follow at most three redirects, only over http(s), and only
 *   send the provider's auth header when the target shares the API origin.
 * - Every response body is read with a hard byte cap, including streamed media.
 * - Error messages carry the provider's own message (truncated) but never
 *   request headers or the key.
 */
import { createWriteStream, promises as fs } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ProviderPluginError, badEndpoint, responseTooLarge, timedOut, unreachable } from './errors.js';
/** JSON responses above this size are treated as a broken/malicious endpoint. */
export const DEFAULT_JSON_LIMIT = 8 * 1024 * 1024;
/** Maximum redirect hops followed for a media URL. */
const MAX_DOWNLOAD_REDIRECTS = 3;
/** Combine an optional caller signal with a deadline. */
export function withTimeout(signal, ms) {
    const controller = new AbortController();
    let fired = false;
    const onAbort = () => {
        controller.abort(signal?.reason);
    };
    if (signal !== undefined) {
        if (signal.aborted)
            controller.abort(signal.reason);
        else
            signal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(() => {
        fired = true;
        controller.abort(new Error('timeout'));
    }, ms);
    if (typeof timer.unref === 'function')
        timer.unref();
    return {
        signal: controller.signal,
        timedOut: () => fired,
        clear: () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
        }
    };
}
/** Join an API root and a path without doubling or dropping the slash. */
export function joinUrl(baseUrl, path) {
    return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}
/** Validate and normalize a user-supplied API root. Throws a helpful error. */
export function parseBaseUrl(value) {
    if (typeof value !== 'string' || value.trim() === '')
        throw badEndpoint();
    let url;
    try {
        url = new URL(value.trim());
    }
    catch {
        throw badEndpoint();
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
        throw badEndpoint();
    if (url.username !== '' || url.password !== '')
        throw badEndpoint();
    if (url.search !== '' || url.hash !== '')
        throw badEndpoint();
    return url;
}
/** Headers that authenticate one provider. Never logged. */
export function authHeaders(provider, key) {
    const headers = {};
    const name = provider.apiKeyHeader ?? 'Authorization';
    const prefix = provider.apiKeyPrefix ?? 'Bearer ';
    headers[name] = `${prefix}${key}`;
    if (provider.organization !== undefined)
        headers['OpenAI-Organization'] = provider.organization;
    if (provider.project !== undefined)
        headers['OpenAI-Project'] = provider.project;
    if (provider.headers !== undefined)
        Object.assign(headers, provider.headers);
    return headers;
}
/** Short, safe description of a provider failure body. */
export function extractApiError(body) {
    const text = body.trim();
    if (text === '')
        return 'the provider returned an empty error body';
    try {
        const parsed = JSON.parse(text);
        if (typeof parsed === 'object' && parsed !== null) {
            const record = parsed;
            const error = record.error;
            if (typeof error === 'string')
                return truncate(stripHtml(error));
            if (typeof error === 'object' && error !== null) {
                const message = error.message;
                if (typeof message === 'string' && message.trim() !== '')
                    return truncate(stripHtml(message));
            }
            for (const key of ['message', 'detail', 'error_description']) {
                const value = record[key];
                if (typeof value === 'string' && value.trim() !== '')
                    return truncate(stripHtml(value));
            }
        }
    }
    catch {
        /* not JSON; fall through to text */
    }
    return truncate(stripHtml(text));
}
function stripHtml(value) {
    return value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}
function truncate(value, max = 600) {
    return value.length > max ? `${value.slice(0, max)}…` : value;
}
/** Map an HTTP failure to the plugin's error vocabulary. */
export function httpError(status, body, what) {
    const detail = extractApiError(body);
    if (status === 401 || status === 403) {
        return new ProviderPluginError('HTTP_AUTH', `${what} rejected the credential (HTTP ${status}): ${detail}`, 'Check the API key on the OpenAI Providers plugin page. Remove "+ Save key" again if the key was rotated.', status);
    }
    if (status === 404) {
        return new ProviderPluginError('HTTP_NOT_FOUND', `${what} was not found (HTTP 404): ${detail}`, 'Confirm the base URL points at the API root including any prefix such as /v1, and that the model id exists.', status);
    }
    if (status === 429) {
        return new ProviderPluginError('HTTP_RATE_LIMIT', `${what} is rate limited or out of quota (HTTP 429): ${detail}`, 'Wait and retry, or check the provider account quota/billing.', status);
    }
    if (status >= 500) {
        return new ProviderPluginError('HTTP_PROVIDER_ERROR', `${what} failed on the provider side (HTTP ${status}): ${detail}`, 'Retry later; if it persists, check the provider status page.', status);
    }
    return new ProviderPluginError(`HTTP_${status}`, `${what} was refused (HTTP ${status}): ${detail}`, undefined, status);
}
/** Read a response body with a hard cap. */
async function readCapped(response, maxBytes, what) {
    const declared = Number(response.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > maxBytes) {
        throw responseTooLarge(what, maxBytes);
    }
    if (response.body === null)
        return Buffer.alloc(0);
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done)
                break;
            if (value === undefined)
                continue;
            total += value.byteLength;
            if (total > maxBytes) {
                await reader.cancel().catch(() => { });
                throw responseTooLarge(what, maxBytes);
            }
            chunks.push(Buffer.from(value));
        }
    }
    finally {
        reader.releaseLock();
    }
    return Buffer.concat(chunks);
}
const sleep = (ms, signal) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
    }, ms);
    const onAbort = () => {
        clearTimeout(timer);
        reject(signal?.reason ?? new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
});
/** Perform one JSON request, mapping transport failures to actionable errors. */
export async function requestJson(options) {
    const { url, method = 'GET', headers = {}, body, timeoutMs, signal, what, retries = 0 } = options;
    const maxBytes = options.maxBytes ?? DEFAULT_JSON_LIMIT;
    let attempt = 0;
    for (;;) {
        const timeout = withTimeout(signal, timeoutMs);
        let response;
        let text;
        try {
            try {
                response = await fetch(url, {
                    method,
                    headers,
                    body,
                    redirect: 'error',
                    signal: timeout.signal
                });
            }
            catch (error) {
                if (timeout.timedOut())
                    throw timedOut(what, timeoutMs);
                if (signal?.aborted) {
                    throw new ProviderPluginError('CANCELLED', `${what} was cancelled.`);
                }
                const cause = error instanceof Error
                    ? `${error.message} ${error.cause instanceof Error ? error.cause.message : String(error.cause ?? '')}`
                    : String(error);
                if (/redirect/i.test(cause)) {
                    throw new ProviderPluginError('UNEXPECTED_REDIRECT', `${what} returned an unexpected redirect.`, 'Use the final API base URL directly (for example https://api.openai.com/v1); this plugin never forwards credentials across redirects.');
                }
                throw unreachable(new URL(url).origin, error);
            }
            try {
                text = await readCapped(response, maxBytes, what);
            }
            catch (error) {
                if (timeout.timedOut())
                    throw timedOut(what, timeoutMs);
                throw error;
            }
        }
        finally {
            timeout.clear();
        }
        const decoded = text.toString('utf8');
        if (!response.ok) {
            if ((response.status === 429 || response.status >= 500) && attempt < retries) {
                attempt += 1;
                const retryAfter = Number(response.headers.get('retry-after') ?? '');
                await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 10_000) : 1000 * attempt, signal);
                continue;
            }
            throw httpError(response.status, decoded, what);
        }
        if (decoded.trim() === '') {
            return { status: response.status, json: {}, headers: response.headers };
        }
        try {
            return { status: response.status, json: JSON.parse(decoded), headers: response.headers };
        }
        catch {
            throw new ProviderPluginError('BAD_JSON', `${what} returned a non-JSON response (${decoded.slice(0, 120).replace(/\s+/g, ' ')}).`, 'Confirm the endpoint is OpenAI-compatible and the base URL includes the right API prefix (often /v1).');
        }
    }
}
/** Download a media URL to disk, enforcing redirect, origin, and size limits. */
export async function downloadFile(options) {
    const { destination, timeoutMs, maxBytes, signal, what } = options;
    const rejectTypes = options.rejectContentTypes ?? ['text/html', 'application/json', 'text/plain'];
    const timeout = withTimeout(signal, timeoutMs);
    let current = options.url;
    try {
        for (let hop = 0; hop <= MAX_DOWNLOAD_REDIRECTS; hop += 1) {
            let parsed;
            try {
                parsed = new URL(current);
            }
            catch {
                throw new ProviderPluginError('BAD_MEDIA_URL', `${what} returned an unusable media URL.`);
            }
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
                throw new ProviderPluginError('BAD_MEDIA_URL', `${what} returned a media URL with an unsupported scheme (${parsed.protocol}).`, 'Only http(s) media URLs are downloaded.');
            }
            const sameOrigin = options.authOrigin !== undefined && parsed.origin === options.authOrigin;
            const headers = sameOrigin && options.headers !== undefined ? { ...options.headers } : {};
            let response;
            try {
                response = await fetch(parsed, { method: 'GET', headers, redirect: 'manual', signal: timeout.signal });
            }
            catch (error) {
                if (timeout.timedOut())
                    throw timedOut(what, timeoutMs);
                if (signal?.aborted)
                    throw new ProviderPluginError('CANCELLED', `${what} was cancelled.`);
                throw unreachable(parsed.origin, error);
            }
            if (response.status >= 300 && response.status < 400) {
                const location = response.headers.get('location');
                if (location === null || location === '') {
                    throw new ProviderPluginError('BAD_MEDIA_URL', `${what} returned a redirect without a Location header.`);
                }
                current = new URL(location, parsed).toString();
                await response.body?.cancel().catch(() => { });
                continue;
            }
            if (!response.ok) {
                const body = await readCapped(response, 256 * 1024, what).catch(() => Buffer.alloc(0));
                throw httpError(response.status, body.toString('utf8'), `${what} download`);
            }
            const contentType = (response.headers.get('content-type') ?? 'application/octet-stream').split(';', 1)[0].trim().toLowerCase();
            if (rejectTypes.some((type) => contentType === type)) {
                const body = await readCapped(response, 256 * 1024, what).catch(() => Buffer.alloc(0));
                throw new ProviderPluginError('BAD_MEDIA_RESPONSE', `${what} returned ${contentType} instead of media: ${extractApiError(body.toString('utf8'))}`, 'The provider returned an error page or a JSON body where a file was expected. Check the model and endpoint.');
            }
            if (response.body === null) {
                throw new ProviderPluginError('BAD_MEDIA_RESPONSE', `${what} returned an empty body.`);
            }
            const declared = Number(response.headers.get('content-length') ?? '');
            if (Number.isFinite(declared) && declared > maxBytes)
                throw responseTooLarge(what, maxBytes);
            let total = 0;
            const limiter = new Transform({
                transform(chunk, _encoding, callback) {
                    total += chunk.byteLength;
                    if (total > maxBytes) {
                        callback(responseTooLarge(what, maxBytes));
                        return;
                    }
                    callback(null, chunk);
                }
            });
            try {
                await pipeline(Readable.fromWeb(response.body), limiter, createWriteStream(destination, { mode: 0o644 }));
            }
            catch (error) {
                await fs.rm(destination, { force: true }).catch(() => { });
                if (error instanceof ProviderPluginError)
                    throw error;
                if (timeout.timedOut())
                    throw timedOut(what, timeoutMs);
                if (signal?.aborted)
                    throw new ProviderPluginError('CANCELLED', `${what} was cancelled.`);
                throw new ProviderPluginError('DOWNLOAD_FAILED', `${what} could not be saved: ${error instanceof Error ? error.message : String(error)}`);
            }
            return { path: destination, bytes: total, contentType };
        }
        throw new ProviderPluginError('TOO_MANY_REDIRECTS', `${what} redirected more than ${MAX_DOWNLOAD_REDIRECTS} times.`, 'Use a stable direct media URL from the provider.');
    }
    finally {
        timeout.clear();
    }
}
