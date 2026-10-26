/**
 * Configuration resolution.
 *
 * Priority (higher wins):
 *   1. Plugin config — the `config:` of the profile entry, written by the plugin page
 *   2. Config file   — `~/.dsh-openai-provider/config.json` (or $DSH_OPENAI_PROVIDER_CONFIG)
 *   3. Environment   — scalars and an optional JSON provider list
 *   4. Built-in defaults
 *
 * SECURITY: this module never reads, writes, or echoes an API key value. A
 * provider carries `apiKeyEnv`, a credential reference resolved at call time by
 * `credentials.ts`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CREDENTIAL_PREFIX, ENV_CONFIG, ENV_PREFIX, ENV_PROVIDERS, MAX_MODELS_PER_PROVIDER, MAX_PROVIDERS, PLUGIN_ID } from './identity.js';
import { logDebug, logWarn } from './log.js';
/** Credential reference grammar shared with DSH's credentials service. */
export const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Provider id grammar. */
export const PROVIDER_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
/** Built-in defaults. */
export const DEFAULTS = {
    requestTimeoutMs: 60_000,
    imageTimeoutMs: 180_000,
    videoTimeoutMs: 900_000,
    pollIntervalMs: 5_000,
    maxDownloadBytes: 512 * 1024 * 1024,
    maxImagesPerCall: 4,
    writeMetadata: true
};
/** Environment variable name → config key for scalar settings. */
const ENV_SCALARS = {
    [`${ENV_PREFIX}_OUTPUT_DIR`]: 'outputDir',
    [`${ENV_PREFIX}_REQUEST_TIMEOUT_MS`]: 'requestTimeoutMs',
    [`${ENV_PREFIX}_IMAGE_TIMEOUT_MS`]: 'imageTimeoutMs',
    [`${ENV_PREFIX}_VIDEO_TIMEOUT_MS`]: 'videoTimeoutMs',
    [`${ENV_PREFIX}_POLL_INTERVAL_MS`]: 'pollIntervalMs',
    [`${ENV_PREFIX}_MAX_DOWNLOAD_BYTES`]: 'maxDownloadBytes',
    [`${ENV_PREFIX}_MAX_IMAGES`]: 'maxImagesPerCall',
    [`${ENV_PREFIX}_WRITE_METADATA`]: 'writeMetadata'
};
/** Resolve the non-secret config file location. */
export function configFilePath(env = process.env) {
    const override = env[ENV_CONFIG];
    if (override !== undefined && override.trim() !== '')
        return path.resolve(expandHome(override.trim()));
    return path.join(os.homedir(), `.${PLUGIN_ID}`, 'config.json');
}
function expandHome(value) {
    if (value === '~')
        return os.homedir();
    if (value.startsWith('~/'))
        return path.join(os.homedir(), value.slice(2));
    return value;
}
function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** Unwrap Schemastery volatile references so plugin config reads as plain values. */
export function unwrapVolatile(value) {
    if (isPlainObject(value) && typeof value.get === 'function') {
        return unwrapVolatile(value.get());
    }
    if (Array.isArray(value))
        return value.map(unwrapVolatile);
    if (isPlainObject(value)) {
        return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, unwrapVolatile(child)]));
    }
    return value;
}
/** Read the config file; a broken file counts as absent and never takes the plugin down. */
export function readConfigFile(env = process.env) {
    const file = configFilePath(env);
    try {
        if (!fs.existsSync(file))
            return {};
        const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
        const parsed = JSON.parse(raw);
        if (!isPlainObject(parsed)) {
            logWarn(`Config file ${file} is not a JSON object; ignoring it.`);
            return {};
        }
        return parsed;
    }
    catch (error) {
        logWarn(`Cannot read config file ${file}; ignoring it (${error instanceof Error ? error.message : String(error)}).`);
        return {};
    }
}
/** Read the `DSH_OPENAI_PROVIDER_PROVIDERS` JSON list. */
function providersFromEnv(env) {
    const raw = env[ENV_PROVIDERS];
    if (raw === undefined || raw.trim() === '')
        return undefined;
    try {
        return JSON.parse(raw);
    }
    catch {
        logWarn(`${ENV_PROVIDERS} is not valid JSON; ignoring it.`);
        return undefined;
    }
}
/** Extract scalar config from environment variables. */
export function configFromEnv(env = process.env) {
    const out = {};
    for (const [envKey, configKey] of Object.entries(ENV_SCALARS)) {
        const value = env[envKey];
        if (value !== undefined && value !== '')
            out[configKey] = value;
    }
    return out;
}
function pickString(...candidates) {
    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim() !== '')
            return candidate.trim();
    }
    return undefined;
}
function pickNumber(min, max, ...candidates) {
    for (const candidate of candidates) {
        const value = typeof candidate === 'string' ? Number(candidate) : candidate;
        if (typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max) {
            return value;
        }
    }
    return undefined;
}
function pickBoolean(...candidates) {
    for (const candidate of candidates) {
        if (typeof candidate === 'boolean')
            return candidate;
        if (typeof candidate === 'string') {
            if (candidate === '1' || candidate.toLowerCase() === 'true')
                return true;
            if (candidate === '0' || candidate.toLowerCase() === 'false')
                return false;
        }
    }
    return undefined;
}
/** Convert arbitrary text to a provider slug. */
export function slugify(value) {
    const slug = value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 63)
        .replace(/-+$/g, '');
    return slug;
}
/** The default credential reference for a provider id, e.g. `openai` → DSH_OPENAI_OPENAI_API_KEY. */
export function deriveCredentialRef(providerId) {
    const segment = providerId.replace(/-/g, '_').toUpperCase().replace(/[^A-Z0-9_]/g, '_');
    return `${CREDENTIAL_PREFIX}${segment}_API_KEY`;
}
/** Whether a value could be a credential reference (an environment-variable-style name). */
export function isCredentialRefName(value) {
    return CREDENTIAL_REF_PATTERN.test(value);
}
/** Cheaper Inference serves a buffered `POST /videos/generations`, not a pollable job. */
export function isCheaperInferenceHost(hostname) {
    return hostname !== undefined && /(^|\.)cheaperinference\.com$/i.test(hostname);
}
/**
 * Pick the default video dialect for a provider. Third-party gateways are
 * overwhelmingly async `/videos/generations`; OpenAI's own endpoint uses its
 * `/videos` shape; Cheaper Inference is the buffered variant of that same path.
 */
export function defaultVideoProtocol(id, hostname) {
    if (isCheaperInferenceHost(hostname))
        return 'videos-generations';
    if (hostname === 'api.openai.com' && /sora/i.test(id))
        return 'openai-videos';
    return 'async-videos';
}
/** Heuristic used for display and for keeping an old provider useful without manual edits. */
export function guessModelKind(id) {
    const name = id.toLowerCase();
    if (/(^|[^a-z0-9])(video|sora|veo|kling|hailuo|pika|runway|luma|wan[.-]?2|t2v|i2v|imagine-video|moviegen|seedance)([^a-z0-9]|$)/.test(name) ||
        /video/.test(name)) {
        return 'video';
    }
    if (/(image|dall-?e|flux|sdxl|sd3|stable-diffusion|imagen|ideogram|recraft|midjourney|nano-banana|grok-imagine-image)/.test(name)) {
        return 'image';
    }
    return undefined;
}
/** Normalize a URL to an API root; returns undefined for anything unusable. */
export function normalizeBaseUrl(value) {
    if (typeof value !== 'string' || value.trim() === '')
        return undefined;
    let url;
    try {
        url = new URL(value.trim());
    }
    catch {
        return undefined;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
        return undefined;
    if (url.username !== '' || url.password !== '')
        return undefined;
    if (url.search !== '' || url.hash !== '')
        return undefined;
    const pathname = url.pathname.replace(/\/+$/, '');
    return `${url.origin}${pathname}`;
}
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const FORBIDDEN_HEADERS = new Set([
    'authorization',
    'proxy-authorization',
    'cookie',
    'host',
    'content-length',
    'content-type',
    // Not HTTP headers at all, and dangerous as object keys.
    '__proto__',
    'constructor',
    'prototype'
]);
/** Extra headers are for routing/tenant metadata only; a secret belongs in the credential store. */
const SENSITIVE_HEADER_NAME = /(^|[-_])(auth|authorization|api[-_]?key|apikey|token|secret|password|cookie)($|[-_])/i;
function isAllowedExtraHeader(name) {
    return HEADER_NAME_PATTERN.test(name) && !FORBIDDEN_HEADERS.has(name.toLowerCase()) && !SENSITIVE_HEADER_NAME.test(name);
}
function sanitizeHeaderValue(value) {
    if (/[\r\n\0]/.test(value))
        return undefined;
    return value.trim();
}
/** Normalize one selected model; returns undefined when the id is unusable. */
function normalizeModel(raw, kindHint, problems, providerHost) {
    let record;
    if (typeof raw === 'string')
        record = { id: raw };
    else if (isPlainObject(raw))
        record = raw;
    else
        return undefined;
    const id = pickString(record.id);
    if (id === undefined || id.length > 300 || /[\r\n\0]/.test(id)) {
        problems.push('Dropped a model with a missing or unusable id.');
        return undefined;
    }
    const rawKind = pickString(record.kind)?.toLowerCase();
    const kind = rawKind === 'image' || rawKind === 'video'
        ? rawKind
        : (kindHint ?? guessModelKind(id) ?? 'image');
    if (rawKind !== undefined && rawKind !== 'image' && rawKind !== 'video' && rawKind !== 'auto') {
        problems.push(`Model "${id}" had unknown kind "${rawKind}"; guessed "${kind}".`);
    }
    const model = { id, kind };
    const label = pickString(record.label);
    if (label !== undefined)
        model.label = label.slice(0, 120);
    const size = pickString(record.size);
    if (size !== undefined)
        model.size = size.slice(0, 32);
    const quality = pickString(record.quality);
    if (quality !== undefined)
        model.quality = quality.slice(0, 32);
    const seconds = typeof record.seconds === 'number' && Number.isFinite(record.seconds)
        ? String(record.seconds)
        : pickString(record.seconds);
    if (seconds !== undefined)
        model.seconds = seconds.slice(0, 16);
    const aspectRatio = pickString(record.aspectRatio);
    if (aspectRatio !== undefined)
        model.aspectRatio = aspectRatio.slice(0, 16);
    const protocol = pickString(record.protocol);
    if (kind === 'video') {
        const fallback = defaultVideoProtocol(id, providerHost);
        if (protocol === 'openai-videos' || protocol === 'async-videos' || protocol === 'videos-generations') {
            model.protocol = protocol;
        }
        else {
            model.protocol = fallback;
            if (protocol !== undefined) {
                problems.push(`Model "${id}" had unknown video protocol "${protocol}"; using "${fallback}".`);
            }
        }
        // Cheaper Inference's /videos/generations is buffered; an async or /videos
        // choice saved before this adapter existed would never complete.
        if (isCheaperInferenceHost(providerHost)) {
            if (model.protocol !== 'videos-generations') {
                problems.push(`Model "${id}": Cheaper Inference's /videos/generations is a buffered sync endpoint; using the sync video protocol.`);
                model.protocol = 'videos-generations';
            }
        }
    }
    else if (protocol !== undefined && protocol !== 'openai-images') {
        problems.push(`Model "${id}" had unknown image protocol "${protocol}"; using the default.`);
    }
    const editMode = pickString(record.editMode);
    if (kind === 'image') {
        // OpenAI takes multipart for /images/edits; xAI's Imagine endpoint documents JSON.
        const fallback = /(^|[-_/])grok/i.test(id) ? 'json' : 'multipart';
        if (editMode === 'multipart' || editMode === 'json')
            model.editMode = editMode;
        else {
            model.editMode = fallback;
            if (editMode !== undefined) {
                problems.push(`Model "${id}" had unknown edit mode "${editMode}"; using "${fallback}".`);
            }
        }
    }
    return model;
}
/** Normalize one provider. Returns undefined when the entry cannot work at all. */
export function normalizeProvider(raw, index, problems) {
    if (!isPlainObject(raw)) {
        problems.push(`Provider entry ${index + 1} is not an object; dropped.`);
        return undefined;
    }
    const label = pickString(raw.label);
    const idSource = pickString(raw.id) ?? label;
    const baseUrl = normalizeBaseUrl(raw.baseUrl);
    if (baseUrl === undefined) {
        problems.push(`Provider ${idSource ? `"${idSource}"` : `entry ${index + 1}`} has no usable http(s) baseUrl; dropped.`);
        return undefined;
    }
    let hostname = '';
    try {
        hostname = new URL(baseUrl).hostname.toLowerCase();
    }
    catch {
        /* normalizeBaseUrl already validated it */
    }
    let id = slugify(idSource ?? hostname ?? `provider-${index + 1}`);
    if (id === '' || !PROVIDER_ID_PATTERN.test(id))
        id = `provider-${index + 1}`;
    if (raw.id !== undefined && String(raw.id).trim() !== id) {
        problems.push(`Provider id "${String(raw.id)}" was normalized to "${id}".`);
    }
    const rawRef = pickString(raw.apiKeyEnv);
    let apiKeyEnv = deriveCredentialRef(id);
    if (rawRef !== undefined) {
        if (isCredentialRefName(rawRef)) {
            apiKeyEnv = rawRef;
        }
        else if (/^sk[-_]/i.test(rawRef) || rawRef.length > 80) {
            problems.push(`Provider "${id}" has a value in apiKeyEnv that looks like a literal API key; it was ignored. ` +
                `apiKeyEnv must name a credential (for example ${deriveCredentialRef(id)}), never contain the key.`);
        }
        else {
            problems.push(`Provider "${id}" has an invalid apiKeyEnv; using ${deriveCredentialRef(id)}. The reference must look like OPENAI_API_KEY.`);
        }
    }
    const provider = {
        id,
        label: (label ?? id).slice(0, 80),
        baseUrl,
        apiKeyEnv,
        models: []
    };
    const header = pickString(raw.apiKeyHeader);
    if (header !== undefined) {
        if (HEADER_NAME_PATTERN.test(header) && !FORBIDDEN_HEADERS.has(header.toLowerCase()))
            provider.apiKeyHeader = header;
        else
            problems.push(`Provider "${id}" has an unusable apiKeyHeader; using Authorization.`);
    }
    if (typeof raw.apiKeyPrefix === 'string') {
        const prefix = sanitizeHeaderValue(raw.apiKeyPrefix);
        if (prefix !== undefined)
            provider.apiKeyPrefix = prefix;
        else
            problems.push(`Provider "${id}" has an unusable apiKeyPrefix; using "Bearer ".`);
    }
    const organization = pickString(raw.organization);
    if (organization !== undefined) {
        const clean = sanitizeHeaderValue(organization);
        if (clean !== undefined)
            provider.organization = clean;
    }
    const project = pickString(raw.project);
    if (project !== undefined) {
        const clean = sanitizeHeaderValue(project);
        if (clean !== undefined)
            provider.project = clean;
    }
    if (raw.headers !== undefined) {
        if (isPlainObject(raw.headers)) {
            const headers = {};
            for (const [name, value] of Object.entries(raw.headers)) {
                if (!isAllowedExtraHeader(name)) {
                    problems.push(`Provider "${id}" header "${name}" is not allowed (secret-bearing header names belong in the credential reference); ignored.`);
                    continue;
                }
                if (typeof value !== 'string')
                    continue;
                const clean = sanitizeHeaderValue(value);
                if (clean === undefined) {
                    problems.push(`Provider "${id}" header "${name}" contains control characters; ignored.`);
                    continue;
                }
                headers[name] = clean;
                if (Object.keys(headers).length >= 20)
                    break;
            }
            if (Object.keys(headers).length > 0)
                provider.headers = headers;
        }
        else {
            problems.push(`Provider "${id}" headers must be an object of strings; ignored.`);
        }
    }
    const modelsValue = raw.models;
    if (modelsValue !== undefined && !Array.isArray(modelsValue)) {
        problems.push(`Provider "${id}" models must be an array; ignored.`);
    }
    else if (Array.isArray(modelsValue)) {
        const seen = new Set();
        for (const entry of modelsValue) {
            if (provider.models.length >= MAX_MODELS_PER_PROVIDER) {
                problems.push(`Provider "${id}" has more than ${MAX_MODELS_PER_PROVIDER} models; extra entries dropped.`);
                break;
            }
            const model = normalizeModel(entry, undefined, problems, hostname);
            if (model === undefined || seen.has(model.id))
                continue;
            seen.add(model.id);
            provider.models.push(model);
        }
    }
    return provider;
}
/** Normalize a raw providers list, dropping bad entries with explanatory problems. */
export function normalizeProviders(raw, problems) {
    if (!Array.isArray(raw)) {
        if (raw !== undefined && raw !== null)
            problems.push('providers must be an array; ignored.');
        return [];
    }
    const providers = [];
    const seen = new Set();
    for (let index = 0; index < raw.length; index += 1) {
        if (providers.length >= MAX_PROVIDERS) {
            problems.push(`At most ${MAX_PROVIDERS} providers are supported; extra entries dropped.`);
            break;
        }
        const provider = normalizeProvider(raw[index], index, problems);
        if (provider === undefined)
            continue;
        if (seen.has(provider.id)) {
            problems.push(`Duplicate provider id "${provider.id}"; the later entry was dropped.`);
            continue;
        }
        seen.add(provider.id);
        providers.push(provider);
    }
    return providers;
}
/** Choose the provider source: plugin config wins, then file, then env. */
function pickProviderSource(fromPlugin, fromFile, env) {
    if (Array.isArray(fromPlugin.providers) && fromPlugin.providers.length > 0)
        return fromPlugin.providers;
    if (Array.isArray(fromFile.providers) && fromFile.providers.length > 0)
        return fromFile.providers;
    return providersFromEnv(env);
}
/**
 * Resolve the four config layers into a ready-to-use config.
 * Invalid values are replaced with defaults and recorded in `problems`; the
 * plugin never fails to load because of a bad config file.
 */
export function resolveConfig(pluginConfig, env = process.env) {
    const plain = unwrapVolatile(pluginConfig);
    const fromPlugin = isPlainObject(plain) ? plain : {};
    const fromFile = readConfigFile(env);
    const fromEnv = configFromEnv(env);
    if (pluginConfig !== undefined && !isPlainObject(plain)) {
        logWarn('Plugin config is not an object; ignoring it (only a JSON object is accepted).');
    }
    const s = (...keys) => [
        ...keys.map((key) => fromPlugin[key]),
        ...keys.map((key) => fromFile[key]),
        ...keys.map((key) => fromEnv[key])
    ];
    const problems = [];
    const providers = normalizeProviders(pickProviderSource(fromPlugin, fromFile, env), problems);
    const resolved = {
        providers,
        problems,
        requestTimeoutMs: Math.round(pickNumber(1_000, 600_000, ...s('requestTimeoutMs')) ?? DEFAULTS.requestTimeoutMs),
        imageTimeoutMs: Math.round(pickNumber(10_000, 1_800_000, ...s('imageTimeoutMs')) ?? DEFAULTS.imageTimeoutMs),
        videoTimeoutMs: Math.round(pickNumber(10_000, 3_600_000, ...s('videoTimeoutMs')) ?? DEFAULTS.videoTimeoutMs),
        pollIntervalMs: Math.round(pickNumber(500, 60_000, ...s('pollIntervalMs')) ?? DEFAULTS.pollIntervalMs),
        maxDownloadBytes: Math.round(pickNumber(1_048_576, 2 * 1024 * 1024 * 1024, ...s('maxDownloadBytes')) ?? DEFAULTS.maxDownloadBytes),
        maxImagesPerCall: Math.round(pickNumber(1, 10, ...s('maxImagesPerCall')) ?? DEFAULTS.maxImagesPerCall),
        writeMetadata: pickBoolean(...s('writeMetadata')) ?? DEFAULTS.writeMetadata
    };
    const outputDir = pickString(...s('outputDir'));
    if (outputDir !== undefined)
        resolved.outputDir = outputDir;
    logDebug('Config resolved', {
        configFile: configFilePath(env),
        providers: resolved.providers.map((provider) => ({
            id: provider.id,
            baseUrl: provider.baseUrl,
            keyRef: provider.apiKeyEnv,
            models: provider.models.length
        })),
        problems: resolved.problems.length
    });
    return resolved;
}
