/**
 * OpenAI-compatible image generation and editing.
 *
 * Supported shapes:
 * - `POST {base}/images/generations` with JSON
 * - `POST {base}/images/edits` with multipart (OpenAI) or JSON (xAI Imagine and similar)
 *
 * Responses accepted: `data[].b64_json`, `data[].url`, `images[]`, top-level
 * `url`, and Responses-style `output[]` image calls. This tolerance is
 * deliberate — "OpenAI-compatible" providers disagree on the wrapper.
 */
import { ProviderPluginError, badResponse } from '../errors.js';
import { authHeaders, joinUrl, requestJson } from '../http.js';
import { readInputImage, toDataUri } from '../files.js';
import { editModeFor } from '../models.js';
function pickBody(args) {
    const body = {};
    if (args.size !== undefined)
        body.size = args.size;
    if (args.quality !== undefined)
        body.quality = args.quality;
    if (args.background !== undefined)
        body.background = args.background;
    if (args.output_format !== undefined)
        body.output_format = args.output_format;
    if (args.output_compression !== undefined)
        body.output_compression = args.output_compression;
    if (args.response_format !== undefined)
        body.response_format = args.response_format;
    if (args.style !== undefined)
        body.style = args.style;
    if (args.moderation !== undefined)
        body.moderation = args.moderation;
    if (args.n !== undefined)
        body.n = args.n;
    if (args.seed !== undefined)
        body.seed = args.seed;
    if (args.user !== undefined)
        body.user = args.user;
    return body;
}
function itemOf(value) {
    if (typeof value === 'string') {
        if (value.startsWith('data:image/'))
            return { b64: value };
        if (/^https?:\/\//i.test(value))
            return { url: value };
        return undefined;
    }
    if (typeof value !== 'object' || value === null)
        return undefined;
    const record = value;
    const item = {};
    for (const key of ['b64_json', 'b64', 'base64', 'image_base64']) {
        const candidate = record[key];
        if (typeof candidate === 'string' && candidate !== '') {
            item.b64 = candidate;
            break;
        }
    }
    // Responses-style image_generation_call carries base64 under `result`.
    if (item.b64 === undefined && typeof record.result === 'string' && record.result !== '')
        item.b64 = record.result;
    for (const key of ['url', 'image_url']) {
        const candidate = record[key];
        if (typeof candidate === 'string' && candidate !== '') {
            item.url = candidate;
            break;
        }
    }
    if (item.url === undefined && typeof record.image === 'object' && record.image !== null) {
        const nested = record.image.url;
        if (typeof nested === 'string' && nested !== '')
            item.url = nested;
    }
    for (const key of ['revised_prompt', 'revisedPrompt']) {
        const candidate = record[key];
        if (typeof candidate === 'string' && candidate !== '') {
            item.revisedPrompt = candidate;
            break;
        }
    }
    if (item.b64 === undefined && item.url === undefined)
        return undefined;
    return item;
}
/** Pull image items out of the common response wrappers. */
export function imageItemsFrom(json) {
    if (json === undefined || json === null)
        return [];
    if (Array.isArray(json)) {
        return json.map(itemOf).filter((item) => item !== undefined);
    }
    if (typeof json !== 'object')
        return [];
    const record = json;
    for (const key of ['data', 'images', 'output', 'artifacts', 'result']) {
        const value = record[key];
        if (Array.isArray(value)) {
            const items = value.map(itemOf).filter((item) => item !== undefined);
            if (items.length > 0)
                return items;
            // Responses output mixes text and image calls; look one level deeper.
            const nested = value
                .map((entry) => (typeof entry === 'object' && entry !== null ? entry.result : undefined))
                .map(itemOf)
                .filter((item) => item !== undefined);
            if (nested.length > 0)
                return nested;
        }
    }
    const single = itemOf(record);
    return single !== undefined ? [single] : [];
}
/** Perform one image generation or edit request. */
export async function callImageApi(options) {
    const { provider, model, key, args, config, cwd, signal } = options;
    const editing = typeof args.input_image === 'string' && args.input_image.trim() !== '';
    const mode = editing ? 'edit' : 'generate';
    if (!editing && args.mask_image !== undefined) {
        throw new ProviderPluginError('MASK_WITHOUT_IMAGE', 'A mask was provided without an input image.', 'Pass input_image together with mask_image, or omit the mask for a text-to-image generation.');
    }
    const extra = args.extra ?? {};
    if (typeof extra !== 'object' || Array.isArray(extra)) {
        throw new ProviderPluginError('BAD_EXTRA', '`extra` must be a JSON object.');
    }
    const headers = { accept: 'application/json', ...authHeaders(provider, key) };
    const endpoint = editing ? 'images/edits' : 'images/generations';
    const url = joinUrl(provider.baseUrl, endpoint);
    const requestSummary = { endpoint, model: model.id, prompt: args.prompt, ...pickBody(args) };
    let body;
    const jsonHeaders = { ...headers, 'content-type': 'application/json' };
    const input = editing ? readInputImage(args.input_image, cwd) : undefined;
    const mask = typeof args.mask_image === 'string' && args.mask_image.trim() !== '' ? readInputImage(args.mask_image, cwd) : undefined;
    if (editing && mask !== undefined)
        requestSummary.mask = mask.name;
    if (editing && editModeFor(model) === 'multipart') {
        const form = new FormData();
        form.append('model', model.id);
        form.append('prompt', args.prompt);
        for (const [keyName, value] of Object.entries(pickBody(args))) {
            if (value !== undefined)
                form.append(keyName, String(value));
        }
        for (const [keyName, value] of Object.entries(extra)) {
            if (value === null || value === undefined)
                continue;
            form.append(keyName, typeof value === 'object' ? JSON.stringify(value) : String(value));
        }
        // Buffer is a Uint8Array at runtime; the cast only bridges Node's SharedArrayBuffer-typed buffer.
        form.append('image', new Blob([input.buffer], { type: input.mime }), input.name);
        if (mask !== undefined)
            form.append('mask', new Blob([mask.buffer], { type: mask.mime }), mask.name);
        body = form;
        requestSummary.transport = 'multipart';
    }
    else if (editing) {
        const payload = {
            ...extra,
            model: model.id,
            prompt: args.prompt,
            image: { url: toDataUri(input.buffer, input.mime), type: 'image_url' },
            ...pickBody(args)
        };
        if (mask !== undefined)
            payload.mask = { url: toDataUri(mask.buffer, mask.mime), type: 'image_url' };
        body = JSON.stringify(payload);
        requestSummary.transport = 'json';
    }
    else {
        body = JSON.stringify({ ...extra, model: model.id, prompt: args.prompt, ...pickBody(args) });
        requestSummary.transport = 'json';
    }
    const response = await requestJson({
        url,
        method: 'POST',
        headers: editing && requestSummary.transport === 'multipart' ? headers : jsonHeaders,
        body,
        timeoutMs: config.imageTimeoutMs,
        signal,
        what: `Provider "${provider.id}" ${endpoint}`
    });
    const items = imageItemsFrom(response.json);
    if (items.length === 0) {
        throw badResponse(`Provider "${provider.id}" ${endpoint}`, 'no image data was found (expected data[].b64_json, data[].url, or an output image)');
    }
    const record = response.json;
    const createdValue = record.created;
    const created = typeof createdValue === 'number' && Number.isFinite(createdValue) ? createdValue : null;
    return {
        created,
        items,
        usage: record.usage ?? null,
        mode,
        request: requestSummary
    };
}
