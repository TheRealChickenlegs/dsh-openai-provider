/**
 * Live model discovery against an OpenAI-compatible `/models` endpoint.
 *
 * Only ids and a best-effort capability guess come back; the user decides what
 * to expose. `/models` is not part of every compatible gateway, so callers must
 * treat a failure as "add the model manually", not as a fatal plugin error.
 */
import { ProviderPluginError, badResponse } from './errors.js';
import { authHeaders, joinUrl, requestJson } from './http.js';
import { guessModelKind } from './config.js';
import { redactSecrets } from './credentials.js';
/** Read a usable model id out of one record in the various shapes gateways return. */
function modelIdOf(record) {
    if (typeof record === 'string')
        return record.trim() === '' ? undefined : record.trim();
    if (typeof record !== 'object' || record === null)
        return undefined;
    const value = record;
    for (const key of ['id', 'name', 'model', 'slug']) {
        const candidate = value[key];
        if (typeof candidate === 'string' && candidate.trim() !== '')
            return candidate.trim();
    }
    return undefined;
}
/** Read capability hints some providers attach to a model record. */
function catalogueTypeOf(record) {
    if (typeof record !== 'object' || record === null || Array.isArray(record))
        return undefined;
    const value = record;
    if (typeof value.type === 'string' && value.type.trim() !== '')
        return value.type.toLowerCase().slice(0, 32);
    return undefined;
}
function kindOf(record, id) {
    if (typeof record === 'object' && record !== null) {
        const value = record;
        const rawType = typeof value.type === 'string' ? value.type.toLowerCase() : '';
        if (rawType.includes('video'))
            return 'video';
        if (rawType === 'image' || rawType.includes('image_generation'))
            return 'image';
        const capabilities = value.capabilities;
        if (typeof capabilities === 'object' && capabilities !== null && !Array.isArray(capabilities)) {
            const caps = capabilities;
            if (caps.video === true)
                return 'video';
            if (caps.image === true || caps.image_generation === true)
                return 'image';
        }
        const modalities = value.modalities ?? value.output_modalities;
        if (Array.isArray(modalities)) {
            const set = new Set(modalities.map((entry) => String(entry).toLowerCase()));
            if (set.has('video'))
                return 'video';
            if (set.has('image'))
                return 'image';
        }
        const endpoints = [
            typeof value.endpoint === 'string' ? value.endpoint : '',
            ...(Array.isArray(value.supported_endpoints)
                ? value.supported_endpoints.map((entry) => (typeof entry === 'string' ? entry : ''))
                : [])
        ].join(' ');
        if (/\/videos\b|videos\/generations/i.test(endpoints))
            return 'video';
        if (/\/images\b|images\/generations/i.test(endpoints))
            return 'image';
        if (typeof value.capability === 'string') {
            const lower = value.capability.toLowerCase();
            if (lower.includes('video'))
                return 'video';
            if (lower.includes('image'))
                return 'image';
        }
    }
    return guessModelKind(id) ?? null;
}
/** Extract the list from the shapes OpenAI-compatible endpoints use. */
function listOf(json) {
    if (Array.isArray(json))
        return json;
    if (typeof json !== 'object' || json === null)
        return undefined;
    const record = json;
    for (const key of ['data', 'models', 'items', 'result']) {
        const value = record[key];
        if (Array.isArray(value))
            return value;
        if (typeof value === 'object' && value !== null) {
            const nested = value.models;
            if (Array.isArray(nested))
                return nested;
        }
    }
    return undefined;
}
/** Fetch and normalize the provider's model catalogue. */
export async function discoverProviderModels(options) {
    const { provider, key, config, signal } = options;
    const limit = Math.max(1, Math.min(options.limit ?? 500, 2000));
    const url = joinUrl(provider.baseUrl, 'models');
    let response;
    try {
        response = await requestJson({
            url,
            method: 'GET',
            headers: { accept: 'application/json', ...authHeaders(provider, key) },
            timeoutMs: config.requestTimeoutMs,
            signal,
            what: `Provider "${provider.id}" /models`,
            retries: 1
        });
    }
    catch (error) {
        // A gateway may echo the key in its error text; never let it travel further.
        if (error instanceof ProviderPluginError) {
            throw new ProviderPluginError(error.code, redactSecrets(error.message, [key]), error.hint, error.status);
        }
        throw error;
    }
    const list = listOf(response.json);
    if (list === undefined) {
        throw badResponse(`Provider "${provider.id}" /models`, 'expected an array under data/models/items');
    }
    const seen = new Set();
    const models = [];
    let truncated = false;
    for (const record of list) {
        const id = modelIdOf(record);
        if (id === undefined || seen.has(id))
            continue;
        seen.add(id);
        if (models.length >= limit) {
            truncated = true;
            break;
        }
        const kind = kindOf(record, id);
        const type = catalogueTypeOf(record);
        models.push({ id, kind, ...(type !== undefined ? { type } : {}) });
    }
    // Media-looking models first; the settings page still lets the user reveal everything.
    models.sort((left, right) => {
        const leftScore = left.kind === null ? 2 : 0;
        const rightScore = right.kind === null ? 2 : 0;
        return leftScore - rightScore || left.id.localeCompare(right.id);
    });
    return { models, truncated };
}
/** Verify a key without generating anything; used by the settings page and diagnostics. */
export async function probeProvider(provider, key, config, signal) {
    try {
        const result = await discoverProviderModels({ provider, key, config, signal });
        return { ok: true, modelCount: result.models.length };
    }
    catch (error) {
        const message = error instanceof ProviderPluginError ? error.message : error instanceof Error ? error.message : String(error);
        return { ok: false, error: redactSecrets(message, [key]) };
    }
}
