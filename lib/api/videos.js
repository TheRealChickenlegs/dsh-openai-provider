/**
 * Video generation adapters.
 *
 * Three dialects are supported because "OpenAI-compatible video" is not settled:
 *
 * - `openai-videos` — `POST /videos`, `GET /videos/{id}`, then
 *   `GET /videos/{id}/content` (the OpenAI Sora shape; the hosted API was
 *   retired, but compatible gateways still implement it).
 * - `async-videos` — `POST /videos/generations`, then `GET /videos/{id}` until
 *   a URL appears (the shape documented by xAI Imagine and several gateways).
 * - `videos-generations` — `POST /videos/generations` that buffers the job and
 *   returns a `videos` array (`url` or `b64_video`) in the same response. This
 *   is Cheaper Inference's shape; a single request can take minutes.
 *
 * The async dialects poll; the buffered dialect returns media immediately and
 * uses the video deadline for its one long request.
 */
import { ProviderPluginError, badResponse, timedOut } from '../errors.js';
import { authHeaders, joinUrl, requestJson } from '../http.js';
import { readInputImage, toDataUri } from '../files.js';
import { videoProtocolFor } from '../models.js';
const DONE_STATUSES = new Set(['completed', 'complete', 'succeeded', 'success', 'done', 'ready', 'finished']);
const FAILED_STATUSES = new Set(['failed', 'failure', 'error', 'cancelled', 'canceled', 'expired', 'rejected', 'blocked']);
function recordOf(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value
        : undefined;
}
function statusOf(json) {
    const record = recordOf(json);
    if (record === undefined)
        return '';
    for (const key of ['status', 'state', 'phase']) {
        const value = record[key];
        if (typeof value === 'string' && value !== '')
            return value.toLowerCase();
    }
    const data = recordOf(record.data);
    if (data !== undefined) {
        for (const key of ['status', 'state']) {
            const value = data[key];
            if (typeof value === 'string' && value !== '')
                return value.toLowerCase();
        }
    }
    return '';
}
function numberAt(value) {
    if (typeof value === 'number' && Number.isFinite(value))
        return value;
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)))
        return Number(value);
    return undefined;
}
/** Extract the first plausible video URL from the many response shapes in use. */
export function videoUrlFrom(json) {
    const record = recordOf(json);
    if (record === undefined)
        return undefined;
    const direct = [record.url, record.video_url, record.output_url, record.result_url, record.download_url];
    for (const candidate of direct) {
        if (typeof candidate === 'string' && /^https?:\/\//i.test(candidate))
            return candidate;
    }
    const video = record.video;
    if (typeof video === 'string' && /^https?:\/\//i.test(video))
        return video;
    const videoRecord = recordOf(video);
    if (videoRecord !== undefined) {
        for (const key of ['url', 'video_url', 'download_url']) {
            const candidate = videoRecord[key];
            if (typeof candidate === 'string' && /^https?:\/\//i.test(candidate))
                return candidate;
        }
    }
    for (const key of ['data', 'output', 'result', 'videos', 'artifacts']) {
        const value = record[key];
        if (Array.isArray(value)) {
            for (const entry of value) {
                if (typeof entry === 'string' && /^https?:\/\//i.test(entry))
                    return entry;
                const found = videoUrlFrom(entry);
                if (found !== undefined)
                    return found;
            }
        }
        else {
            const nested = recordOf(value);
            if (nested !== undefined) {
                const found = videoUrlFrom(nested);
                if (found !== undefined)
                    return found;
            }
        }
    }
    return undefined;
}
/** Extract a job id from the usual fields. */
function jobIdFrom(json) {
    const record = recordOf(json);
    if (record === undefined)
        return undefined;
    for (const key of ['id', 'request_id', 'job_id', 'task_id', 'video_id', 'requestId', 'name']) {
        const value = record[key];
        if (typeof value === 'string' && value !== '')
            return value;
        if (typeof value === 'number' && Number.isFinite(value))
            return String(value);
    }
    const data = recordOf(record.data);
    if (data !== undefined) {
        for (const key of ['id', 'request_id', 'job_id', 'task_id', 'video_id']) {
            const value = data[key];
            if (typeof value === 'string' && value !== '')
                return value;
        }
    }
    return undefined;
}
function errorMessageOf(json) {
    const record = recordOf(json);
    if (record === undefined)
        return undefined;
    const error = record.error;
    if (typeof error === 'string' && error !== '')
        return error;
    const errorRecord = recordOf(error);
    if (errorRecord !== undefined) {
        const message = errorRecord.message ?? errorRecord.detail;
        if (typeof message === 'string' && message !== '')
            return message;
    }
    for (const key of ['failure_reason', 'failureReason', 'message', 'detail', 'reason']) {
        const value = record[key];
        if (typeof value === 'string' && value !== '')
            return value;
    }
    const data = recordOf(record.data);
    if (data !== undefined)
        return errorMessageOf(data);
    return undefined;
}
function resolutionFromSize(size) {
    if (size === undefined)
        return undefined;
    const match = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(size.trim());
    if (match === null)
        return undefined;
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0)
        return undefined;
    // Resolution names the shorter edge: 1280x720 and 720x1280 are both 720p.
    const shortEdge = Math.min(width, height);
    // The buffered API documents 480p/720p/1080p-style values; omit odd sizes
    // such as 1024x1024 rather than sending a resolution it may reject.
    if (![360, 480, 540, 720, 1080, 1440, 2160].includes(shortEdge))
        return undefined;
    return `${shortEdge}p`;
}
function aspectRatioFromSize(size) {
    if (size === undefined)
        return undefined;
    const match = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(size.trim());
    if (match === null)
        return undefined;
    let width = Number(match[1]);
    let height = Number(match[2]);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0)
        return undefined;
    const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));
    const divisor = gcd(width, height);
    width /= divisor;
    height /= divisor;
    return `${width}:${height}`;
}
function requestBody(protocol, model, args, cwd) {
    const extra = args.extra ?? {};
    if (typeof extra !== 'object' || Array.isArray(extra)) {
        throw new ProviderPluginError('BAD_EXTRA', '`extra` must be a JSON object.');
    }
    const body = { ...extra, model: model.id, prompt: args.prompt };
    const reference = typeof args.input_image === 'string' && args.input_image.trim() !== '' ? readInputImage(args.input_image, cwd) : undefined;
    const dataUri = reference !== undefined ? toDataUri(reference.buffer, reference.mime) : undefined;
    if (protocol === 'openai-videos') {
        if (args.seconds !== undefined)
            body.seconds = args.seconds;
        if (args.size !== undefined)
            body.size = args.size;
        if (dataUri !== undefined)
            body.input_reference = { image_url: dataUri };
    }
    else if (protocol === 'videos-generations') {
        // Cheaper Inference requires one of duration_seconds/duration; default to 5s
        // when neither the caller nor the model supplied a duration.
        const requested = args.seconds ?? model.seconds ?? '5';
        const numeric = Number(requested);
        body.duration_seconds = Number.isFinite(numeric) ? numeric : requested;
        const resolution = args.resolution ?? resolutionFromSize(args.size);
        if (resolution !== undefined)
            body.resolution = resolution;
        const aspectRatio = args.aspect_ratio ?? aspectRatioFromSize(args.size);
        if (aspectRatio !== undefined)
            body.aspect_ratio = aspectRatio;
        if (dataUri !== undefined)
            body.image_url = dataUri;
    }
    else {
        if (args.seconds !== undefined) {
            const numeric = Number(args.seconds);
            body.duration = Number.isFinite(numeric) ? numeric : args.seconds;
        }
        if (args.aspect_ratio !== undefined)
            body.aspect_ratio = args.aspect_ratio;
        if (args.size !== undefined)
            body.size = args.size;
        if (args.resolution !== undefined)
            body.resolution = args.resolution;
        if (dataUri !== undefined)
            body.image = { url: dataUri };
    }
    if (args.seed !== undefined)
        body.seed = args.seed;
    return body;
}
function dataUriPayload(value) {
    const match = /^data:([^;,]+);base64,([\s\S]+)$/i.exec(value);
    if (match === null)
        return undefined;
    return { b64: match[2].replace(/\s+/g, ''), contentType: match[1] };
}
function base64Payload(value, minimumLength = 64) {
    const compact = value.replace(/\s+/g, '');
    if (compact.length < minimumLength)
        return undefined;
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact))
        return undefined;
    return compact;
}
function videoPayloadFromItem(value) {
    if (typeof value === 'string') {
        if (/^https?:\/\//i.test(value))
            return { url: value };
        const dataUri = dataUriPayload(value);
        if (dataUri !== undefined)
            return { b64: dataUri.b64, ...(dataUri.contentType !== undefined ? { contentType: dataUri.contentType } : {}) };
        const raw = base64Payload(value);
        return raw !== undefined ? { b64: raw } : undefined;
    }
    const record = recordOf(value);
    if (record === undefined)
        return undefined;
    for (const key of ['url', 'video_url', 'download_url', 'file_url']) {
        const candidate = record[key];
        if (typeof candidate === 'string' && /^https?:\/\//i.test(candidate)) {
            return { url: candidate, ...durationFields(record) };
        }
    }
    const video = record.video;
    if (typeof video === 'string') {
        if (/^https?:\/\//i.test(video))
            return { url: video, ...durationFields(record) };
        const fromDataUri = dataUriPayload(video);
        if (fromDataUri !== undefined) {
            return { b64: fromDataUri.b64, ...(fromDataUri.contentType !== undefined ? { contentType: fromDataUri.contentType } : {}), ...durationFields(record) };
        }
        const raw = base64Payload(video);
        if (raw !== undefined)
            return { b64: raw, ...durationFields(record) };
    }
    const videoRecord = recordOf(video);
    if (videoRecord !== undefined) {
        const nested = videoPayloadFromItem(videoRecord);
        if (nested !== undefined)
            return { ...nested, ...durationFields(record) };
    }
    for (const key of ['b64_video', 'b64_json', 'b64', 'video_base64', 'base64']) {
        const candidate = record[key];
        if (typeof candidate !== 'string')
            continue;
        const raw = base64Payload(candidate, 16) ?? dataUriPayload(candidate)?.b64;
        if (raw !== undefined) {
            const type = typeof record.content_type === 'string'
                ? record.content_type
                : typeof record.mime_type === 'string'
                    ? record.mime_type
                    : undefined;
            return { b64: raw, ...(type !== undefined ? { contentType: type } : {}), ...durationFields(record) };
        }
    }
    const data = record.data;
    if (typeof data === 'string') {
        const fromDataUri = dataUriPayload(data);
        if (fromDataUri !== undefined) {
            return { b64: fromDataUri.b64, ...(fromDataUri.contentType !== undefined ? { contentType: fromDataUri.contentType } : {}), ...durationFields(record) };
        }
        const raw = base64Payload(data);
        if (raw !== undefined)
            return { b64: raw, ...durationFields(record) };
    }
    return undefined;
}
function durationFields(record) {
    for (const key of ['duration_seconds', 'duration', 'seconds']) {
        const value = numberAt(record[key]);
        if (value !== undefined)
            return { durationSeconds: value };
    }
    return {};
}
/**
 * Pull the first video from a buffered response. Cheaper Inference returns
 * `{ videos: [{ url } | { b64_video }] }`; the older OpenAI-shaped arrays and a
 * few gateway variants are accepted too.
 */
export function videoPayloadFrom(json) {
    const record = recordOf(json);
    if (record !== undefined) {
        const direct = videoPayloadFromItem(record);
        if (direct !== undefined)
            return direct;
        for (const key of ['videos', 'data', 'output', 'result', 'artifacts']) {
            const value = record[key];
            if (Array.isArray(value)) {
                for (const entry of value) {
                    const found = videoPayloadFromItem(entry);
                    if (found !== undefined)
                        return found;
                }
            }
            else if (value !== undefined) {
                const found = videoPayloadFromItem(value);
                if (found !== undefined)
                    return found;
            }
        }
    }
    return videoPayloadFromItem(json);
}
/** Submit a video job. */
export async function startVideo(options) {
    const { provider, model, key, args, config, cwd, signal } = options;
    const protocol = videoProtocolFor(model);
    const body = requestBody(protocol, model, args, cwd);
    const endpoint = protocol === 'openai-videos' ? 'videos' : 'videos/generations';
    const buffered = protocol === 'videos-generations';
    const response = await requestJson({
        url: joinUrl(provider.baseUrl, endpoint),
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', ...authHeaders(provider, key) },
        body: JSON.stringify(body),
        // The buffered endpoint holds the request for the whole render, so it gets
        // the video deadline and a response-size cap large enough for base64 MP4.
        timeoutMs: buffered ? config.videoTimeoutMs : config.requestTimeoutMs,
        ...(buffered ? { maxBytes: config.maxDownloadBytes } : {}),
        signal,
        what: `Provider "${provider.id}" ${endpoint}`
    });
    const id = jobIdFrom(response.json);
    const requestId = response.headers.get('x-ci-request-id') ??
        response.headers.get('x-cheaper-inference-request-id') ??
        recordOf(response.json)?.request_id;
    // Keep image bytes (and full data URIs) out of result metadata and sidecars.
    const summary = { ...body };
    delete summary.input_reference;
    delete summary.image;
    delete summary.image_url;
    if (typeof args.input_image === 'string' && args.input_image.trim() !== '')
        summary.input_image = args.input_image;
    const request = { endpoint, ...summary };
    if (buffered) {
        const payload = videoPayloadFrom(response.json);
        if (payload !== undefined) {
            return {
                protocol,
                ...(id !== undefined ? { id } : {}),
                ...(requestId !== undefined ? { requestId } : {}),
                ...(payload.url !== undefined ? { url: payload.url } : {}),
                ...(payload.b64 !== undefined ? { b64: payload.b64 } : {}),
                ...(payload.contentType !== undefined ? { contentType: payload.contentType } : {}),
                request,
                raw: response.json
            };
        }
        // If a gateway answers the buffered path with a job object, fall back to
        // polling the standard status path rather than failing on an empty array.
        if (id !== undefined && !DONE_STATUSES.has(statusOf(response.json))) {
            return {
                protocol,
                id,
                ...(requestId !== undefined ? { requestId } : {}),
                request,
                raw: response.json
            };
        }
        throw badResponse(`Provider "${provider.id}" ${endpoint}`, 'the buffered response carried no videos[].url or videos[].b64_video');
    }
    const url = videoUrlFrom(response.json);
    if (id === undefined && url === undefined) {
        throw badResponse(`Provider "${provider.id}" ${endpoint}`, 'the submission returned neither a job id nor a video URL');
    }
    return {
        protocol,
        ...(id !== undefined ? { id } : {}),
        ...(requestId !== undefined ? { requestId } : {}),
        ...(url !== undefined ? { url } : {}),
        request,
        raw: response.json
    };
}
/** Poll one job once. */
export async function pollVideo(options) {
    const { provider, key, protocol, id, config, signal } = options;
    const path = protocol === 'openai-videos' ? `videos/${encodeURIComponent(id)}` : `videos/${encodeURIComponent(id)}`;
    const response = await requestJson({
        url: joinUrl(provider.baseUrl, path),
        method: 'GET',
        headers: { accept: 'application/json', ...authHeaders(provider, key) },
        timeoutMs: config.requestTimeoutMs,
        signal,
        what: `Provider "${provider.id}" video status`,
        retries: 1
    });
    const rawStatus = statusOf(response.json);
    const progress = numberAt(recordOf(response.json)?.progress);
    const url = videoUrlFrom(response.json);
    const poll = {
        status: 'pending',
        rawStatus,
        raw: response.json,
        ...(progress !== undefined ? { progress } : {}),
        ...(url !== undefined ? { url } : {})
    };
    if (DONE_STATUSES.has(rawStatus) || (rawStatus === '' && url !== undefined)) {
        poll.status = 'done';
        return poll;
    }
    if (FAILED_STATUSES.has(rawStatus)) {
        poll.status = 'failed';
        const message = errorMessageOf(response.json);
        if (message !== undefined)
            poll.error = message;
        return poll;
    }
    return poll;
}
/** Sleep while remaining cancellable. */
function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
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
}
/**
 * Poll until the job finishes, fails, or the configured deadline passes.
 * Returns the media URL or, for the OpenAI shape, the authenticated content URL.
 */
export async function waitForVideo(options) {
    const { provider, key, protocol, id, config, signal, onProgress } = options;
    const deadline = Date.now() + config.videoTimeoutMs;
    let last;
    for (;;) {
        if (signal?.aborted) {
            throw new ProviderPluginError('CANCELLED', 'Video generation was cancelled.');
        }
        const poll = await pollVideo({ provider, key, protocol, id, config, signal });
        last = poll;
        onProgress?.(poll);
        if (poll.status === 'done') {
            if (poll.url !== undefined)
                return { url: poll.url, last };
            if (protocol === 'openai-videos') {
                return { contentPath: `videos/${encodeURIComponent(id)}/content`, last };
            }
            throw new ProviderPluginError('VIDEO_URL_MISSING', `Video job ${id} completed but the provider returned no video URL.`, 'Check the provider dashboard for this job, or configure the model with the other video protocol.');
        }
        if (poll.status === 'failed') {
            throw new ProviderPluginError('VIDEO_FAILED', `Video generation failed (status "${poll.rawStatus || 'failed'}"): ${poll.error ?? 'the provider gave no reason'}`, 'Adjust the prompt or parameters, or check the provider account/quota.');
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0)
            throw timedOut(`Video job ${id}`, config.videoTimeoutMs);
        await sleep(Math.min(config.pollIntervalMs, remaining), signal);
    }
}
