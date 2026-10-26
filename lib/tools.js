/**
 * The public tool contract exposed to the agent.
 *
 * Three tools:
 * - `openai_providers`      what endpoints and models are available (and a live refresh)
 * - `openai_generate_image` text-to-image and image edits
 * - `openai_generate_video` asynchronous video generation
 *
 * Two hard constraints, verified against @deepseek-ai/dsh-tools:
 *   1. `parameters` is a RAW JSON Schema, not a DSL.
 *   2. Only the enforced subset is allowed: type / oneOf / properties / required /
 *      additionalProperties / items / enum / const + annotations. Ranges, patterns
 *      and formats are written in descriptions and validated at runtime instead.
 */
import { resolveConfig } from './config.js';
import { formatError } from './errors.js';
import { logDebug } from './log.js';
import { describeApiKey, resolveApiKey, redactSecrets } from './credentials.js';
import { discoverProviderModels } from './discovery.js';
import { selectProvider } from './models.js';
import { runImageGeneration, runVideoGeneration } from './runner.js';
import { describeModel } from './models.js';
export const PROVIDERS_TOOL_NAME = 'openai_providers';
export const IMAGE_TOOL_NAME = 'openai_generate_image';
export const VIDEO_TOOL_NAME = 'openai_generate_video';
export const PROVIDERS_DESCRIPTION = [
    'List the OpenAI-compatible providers and the image/video models this session can use.',
    '',
    'The user configures providers (endpoint + API key) and ticks which models to expose on the',
    '"OpenAI Providers" plugin page. This tool reports exactly that selection, whether each key is',
    'present, and — with refresh=true — the live /models catalogue of each endpoint.',
    '',
    'Call this first when you need to choose a provider or model for openai_generate_image or',
    'openai_generate_video, or when a generation call says the selection is ambiguous. It never',
    'returns an API key: only whether the credential is configured and where it comes from.',
    '',
    'Arguments:',
    '  provider           limit the report to one provider id',
    '  refresh            also query each provider\'s /models endpoint live (network, no generation cost)',
    '  include_unselected with refresh, also list media-looking models that are not exposed yet'
].join('\n');
export const IMAGE_DESCRIPTION = [
    'Generate or edit images through one of the user\'s configured OpenAI-compatible providers.',
    '',
    'Modes (inferred from the arguments):',
    '  text2img  prompt only',
    '  edit      prompt + input_image (and optional mask_image)',
    '',
    'The user exposes specific image models on the OpenAI Providers plugin page; this tool only',
    'uses those. When only one provider / one image model is exposed, provider and model may be',
    'omitted. Call openai_providers if you are unsure which ids exist.',
    '',
    'Supported request shapes: OpenAI /images/generations with JSON, and /images/edits with',
    'multipart (OpenAI) or JSON (xAI Imagine-style endpoints). Responses may carry b64_json or a',
    'URL; both are saved to disk. The result text contains one "Image: <absolute path>" line per',
    'file — cite those paths to the user.',
    '',
    'Notes:',
    '  - The prompt is required. Sizes/qualities are provider-specific strings passed through',
    '    (for example 1024x1024, 1536x1024, auto; quality low/medium/high/auto or standard/hd).',
    '  - n is capped by the plugin setting (default 4) to bound cost.',
    '  - output_path may be a directory or one explicit file; existing files are never overwritten',
    '    (a -1/-2 suffix is added). The default is the session working directory.',
    '  - API keys are never accepted as tool arguments and must never be pasted into chat. If a key',
    '    is missing, tell the user to save it on the OpenAI Providers plugin page.',
    '  - Generation costs money on most providers; prefer one image to explore, then scale up.'
].join('\n');
export const VIDEO_DESCRIPTION = [
    'Generate a video through one of the user\'s configured OpenAI-compatible providers.',
    '',
    'The adapter depends on the model\'s video API dialect. Three dialects are supported:',
    '  openai-videos        POST /videos, GET /videos/{id}, GET /videos/{id}/content',
    '  async-videos         POST /videos/generations, GET /videos/{id} until a URL appears (xAI-style)',
    '  videos-generations   POST /videos/generations that buffers the render and returns',
    '                       videos[] with URLs or base64 MP4 (Cheaper Inference-style)',
    '',
    'The buffered videos-generations request can take minutes; the plugin uses the configured',
    'video timeout for it and does not poll. The other dialects submit then poll until the',
    'video timeout is reached, then download the file.',
    'Only image/video models that the user exposed on the OpenAI Providers plugin page are',
    'accepted. When only one provider / one video model is exposed, provider and model may be',
    'omitted. Call openai_providers first if unsure.',
    '',
    'Arguments:',
    '  prompt        required text description',
    '  input_image   optional start/reference frame: a local path or a public http(s) URL.',
    '                Cheaper Inference image-to-video requires a public https URL; local',
    '                paths and /v1/uploads file ids are rejected by its video endpoint.',
    '  seconds       clip duration the provider accepts (often 4/8/12, or up to 15)',
    '  size          widthxheight when the provider takes a size (720x1280, 1280x720, ...)',
    '  aspect_ratio  e.g. 16:9 — used by the async and buffered dialects',
    '  resolution    e.g. 720p — used by the buffered dialect when the provider accepts it',
    '  output_path   directory or one explicit .mp4 path; never overwritten',
    '',
    'Video jobs can take minutes; the result text contains one "Video: <absolute path>" line.',
    'Video generation usually costs more than image generation — confirm the user wants it.'
].join('\n');
export const PROVIDERS_PARAMETERS = {
    type: 'object',
    properties: {
        provider: {
            type: 'string',
            description: 'Limit the report to one configured provider id. Omit for every provider.'
        },
        refresh: {
            type: 'boolean',
            description: 'Also query each provider\'s /models endpoint live. This performs network requests but does not generate anything or cost money.'
        },
        include_unselected: {
            type: 'boolean',
            description: 'With refresh, also list media-looking models from /models that the user has not exposed.'
        }
    },
    required: [],
    additionalProperties: false
};
export const IMAGE_PARAMETERS = {
    type: 'object',
    properties: {
        prompt: {
            type: 'string',
            description: 'Text description of the image (required). For edits, describe the change.'
        },
        provider: {
            type: 'string',
            description: 'Provider id. Optional when only one provider is configured; call openai_providers to list ids.'
        },
        model: {
            type: 'string',
            description: 'Exposed image model id. Optional when the provider exposes exactly one image model.'
        },
        input_image: {
            type: 'string',
            description: 'Local image path for an edit. With a prompt, the call uses /images/edits instead of /images/generations.'
        },
        mask_image: {
            type: 'string',
            description: 'Optional mask for an edit (same dimensions as input_image). Requires input_image.'
        },
        size: {
            type: 'string',
            description: 'Provider-specific size string, e.g. 1024x1024, 1536x1024, 1024x1536, 1792x1024, or auto.'
        },
        quality: {
            type: 'string',
            description: 'Provider-specific quality, e.g. low / medium / high / auto / standard / hd.'
        },
        background: {
            type: 'string',
            description: 'Background mode where supported, e.g. transparent / opaque / auto.'
        },
        output_format: {
            type: 'string',
            description: 'Requested file format where supported: png, jpeg, or webp. The saved file always reflects the real bytes.'
        },
        output_compression: {
            type: 'integer',
            description: 'Provider-specific compression 0-100 for jpeg/webp, where supported.'
        },
        response_format: {
            type: 'string',
            description: 'Optional response_format for providers that require it (url or b64_json). Usually omit.'
        },
        style: {
            type: 'string',
            description: 'Model-specific style, e.g. vivid or natural for DALL-E 3.'
        },
        moderation: {
            type: 'string',
            description: 'Provider-specific moderation level, e.g. low or auto.'
        },
        n: {
            type: 'integer',
            description: 'Number of images, 1-10; capped by the plugin setting (default max 4) to bound cost.'
        },
        seed: {
            type: 'integer',
            description: 'Seed where the provider supports one; omitted otherwise.'
        },
        user: {
            type: 'string',
            description: 'Optional provider user/tenant identifier.'
        },
        output_path: {
            type: 'string',
            description: 'Directory, or one explicit image file path for a single result. Relative paths resolve from the session working directory. Defaults to that directory. Existing files are never overwritten.'
        },
        extra: {
            type: 'object',
            additionalProperties: true,
            description: 'Provider-specific JSON fields merged into the request body. Use only for documented options the typed arguments do not cover.'
        }
    },
    required: ['prompt'],
    additionalProperties: false
};
export const VIDEO_PARAMETERS = {
    type: 'object',
    properties: {
        prompt: { type: 'string', description: 'Text description of the video (required).' },
        provider: {
            type: 'string',
            description: 'Provider id. Optional when only one provider is configured.'
        },
        model: {
            type: 'string',
            description: 'Exposed video model id. Optional when the provider exposes exactly one video model.'
        },
        input_image: {
            type: 'string',
            description: 'Optional start/reference frame: a local path or a public http(s) URL. Cheaper Inference image-to-video requires a public https URL; local paths and /v1/uploads file ids are rejected.'
        },
        seconds: {
            type: 'string',
            description: 'Clip duration the provider accepts, e.g. "4", "8", "12", or "15".'
        },
        size: {
            type: 'string',
            description: 'Output size as widthxheight, where the provider supports it (720x1280, 1280x720, ...).'
        },
        aspect_ratio: {
            type: 'string',
            description: 'Aspect ratio for the async dialect, e.g. 16:9, 9:16, 1:1.'
        },
        resolution: {
            type: 'string',
            description: 'Named resolution for the async dialect where supported, e.g. 720p, 1080p.'
        },
        seed: { type: 'integer', description: 'Seed where the provider supports one.' },
        output_path: {
            type: 'string',
            description: 'Directory, or one explicit video file path. Relative paths resolve from the session working directory. Defaults to that directory. Existing files are never overwritten.'
        },
        extra: {
            type: 'object',
            additionalProperties: true,
            description: 'Provider-specific JSON fields merged into the submit body.'
        }
    },
    required: ['prompt'],
    additionalProperties: false
};
export const PROVIDERS_OUTPUT = {
    type: 'object',
    properties: {
        text: { type: 'string', description: 'Human/model-facing summary' },
        providers: {
            type: 'array',
            description: 'Configured providers',
            items: {
                type: 'object',
                properties: {
                    id: { type: 'string' },
                    label: { type: 'string' },
                    baseUrl: { type: 'string' },
                    keyConfigured: { type: 'boolean' },
                    keySource: { type: 'string' },
                    models: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                id: { type: 'string' },
                                kind: { type: 'string' },
                                label: { type: 'string' }
                            },
                            required: ['id', 'kind', 'label'],
                            additionalProperties: false
                        }
                    },
                    liveModels: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                id: { type: 'string' },
                                kind: { type: 'string' }
                            },
                            required: ['id', 'kind'],
                            additionalProperties: false
                        }
                    },
                    error: { type: 'string' }
                },
                required: ['id', 'label', 'baseUrl', 'keyConfigured', 'keySource', 'models'],
                additionalProperties: false
            }
        },
        notes: { type: 'array', items: { type: 'string' } }
    },
    required: ['text', 'providers', 'notes'],
    additionalProperties: false
};
export const IMAGE_OUTPUT = {
    type: 'object',
    properties: {
        text: { type: 'string', description: 'Complete result description with Image paths' },
        path: { type: 'string', description: 'First produced image (absolute path)' },
        files: { type: 'array', items: { type: 'string' }, description: 'All produced files' },
        provider: { type: 'string' },
        model: { type: 'string' },
        mode: { type: 'string', description: 'generate or edit' },
        revised_prompts: { type: 'array', items: { type: 'string' } },
        width: { type: 'integer', description: 'Pixel width, 0 when unknown' },
        height: { type: 'integer', description: 'Pixel height, 0 when unknown' },
        duration_ms: { type: 'integer' },
        metadata_path: { type: 'string' },
        notes: { type: 'array', items: { type: 'string' } }
    },
    required: [
        'text',
        'path',
        'files',
        'provider',
        'model',
        'mode',
        'revised_prompts',
        'width',
        'height',
        'duration_ms',
        'notes'
    ],
    additionalProperties: false
};
export const VIDEO_OUTPUT = {
    type: 'object',
    properties: {
        text: { type: 'string', description: 'Complete result description with the Video path' },
        path: { type: 'string', description: 'Produced video (absolute path)' },
        files: { type: 'array', items: { type: 'string' } },
        provider: { type: 'string' },
        model: { type: 'string' },
        job_id: { type: 'string' },
        duration_seconds: { type: 'number', description: 'Clip duration, 0 when unknown' },
        width: { type: 'integer', description: 'Pixel width, 0 when unknown' },
        height: { type: 'integer', description: 'Pixel height, 0 when unknown' },
        duration_ms: { type: 'integer' },
        metadata_path: { type: 'string' },
        notes: { type: 'array', items: { type: 'string' } }
    },
    required: [
        'text',
        'path',
        'files',
        'provider',
        'model',
        'job_id',
        'duration_seconds',
        'width',
        'height',
        'duration_ms',
        'notes'
    ],
    additionalProperties: false
};
function textOf(value) {
    const record = value;
    return typeof record?.text === 'string' ? record.text : '';
}
/** Build the provider discovery tool. */
export function createProvidersTool(pluginConfig, host) {
    return {
        name: PROVIDERS_TOOL_NAME,
        description: PROVIDERS_DESCRIPTION,
        parameters: PROVIDERS_PARAMETERS,
        output: {
            schema: PROVIDERS_OUTPUT,
            render: (_args, value) => [{ type: 'text', text: textOf(value) }],
            presentationMeta: (_args, value) => ({
                kind: 'openai-providers',
                providers: Array.isArray(value?.providers)
                    ? value.providers.length
                    : 0
            })
        },
        async execute(args, exec) {
            const config = resolveConfig(pluginConfig);
            const input = (args ?? {});
            const selected = typeof input.provider === 'string' && input.provider.trim() !== ''
                ? [selectProvider(config, input.provider)]
                : config.providers;
            const notes = [...config.problems];
            const providers = [];
            const detailsById = new Map();
            for (const provider of selected) {
                const keyInfo = await describeApiKey(host, provider);
                const entry = {
                    id: provider.id,
                    label: provider.label ?? provider.id,
                    baseUrl: provider.baseUrl,
                    keyConfigured: keyInfo.configured,
                    keySource: keyInfo.source ?? '',
                    models: provider.models.map((model) => ({ id: model.id, kind: model.kind, label: model.label ?? model.id }))
                };
                if (input.refresh === true) {
                    let keyValue;
                    try {
                        const key = await resolveApiKey(host, provider);
                        keyValue = key.value;
                        const live = await discoverProviderModels({
                            provider,
                            key: key.value,
                            config,
                            ...(exec?.signal ? { signal: exec.signal } : {})
                        });
                        const exposed = new Set(provider.models.map((model) => model.id));
                        entry.liveModels = live.models
                            .filter((model) => input.include_unselected === true || exposed.has(model.id))
                            .map((model) => ({ id: model.id, kind: model.kind ?? '' }));
                        if (live.truncated)
                            notes.push(`Provider "${provider.id}" model list was truncated.`);
                        if (live.models.length === 0)
                            notes.push(`Provider "${provider.id}" returned no models.`);
                    }
                    catch (error) {
                        entry.error = redactSecrets(formatError(error), [keyValue]);
                        notes.push(`Could not refresh "${provider.id}" models: ${entry.error}`);
                    }
                }
                detailsById.set(provider.id, new Map(provider.models.map((model) => [model.id, describeModel(model)])));
                providers.push(entry);
            }
            const lines = [];
            if (providers.length === 0) {
                lines.push('No OpenAI-compatible providers are configured yet.');
                lines.push('Tell the user to open DSH → Plugins → Plugins → OpenAI Providers, add an endpoint and API key, click "Load models", tick the models to expose, and save.');
            }
            else {
                lines.push(`${providers.length} provider${providers.length === 1 ? '' : 's'} configured. Model generation tools only accept the exposed ids below.`);
            }
            for (const entry of providers) {
                lines.push('');
                lines.push(`Provider: ${entry.id}${entry.label !== entry.id ? ` (${entry.label})` : ''}`);
                lines.push(`  Endpoint: ${entry.baseUrl}`);
                lines.push(`  API key: ${entry.keyConfigured ? `configured (${entry.keySource})` : 'NOT configured — save it on the plugin page or export the reference'}`);
                if (entry.models.length === 0) {
                    lines.push('  Exposed models: none yet — load models and tick a few on the plugin page.');
                }
                else {
                    lines.push('  Exposed models:');
                    const details = detailsById.get(entry.id);
                    for (const model of entry.models)
                        lines.push(`    - ${details?.get(model.id) ?? `${model.id} [${model.kind}]`}`);
                }
                if (entry.liveModels !== undefined) {
                    if (entry.liveModels.length > 0) {
                        lines.push(`  Live /models (${entry.liveModels.length}${input.include_unselected === true ? '' : ', exposed only'}):`);
                        for (const model of entry.liveModels.slice(0, 80)) {
                            lines.push(`    - ${model.id}${model.kind !== '' ? ` [${model.kind}]` : ''}`);
                        }
                        if (entry.liveModels.length > 80)
                            lines.push('    … (list truncated in the summary)');
                    }
                    else if (entry.error === undefined) {
                        lines.push('  Live /models: no matching models');
                    }
                }
                if (entry.error !== undefined)
                    lines.push(`  Live /models error: ${entry.error}`);
            }
            if (notes.length > 0) {
                lines.push('');
                lines.push('Notes:');
                for (const note of notes)
                    lines.push(`  - ${note}`);
            }
            return { text: lines.join('\n'), providers, notes };
        }
    };
}
/** Build the image generation tool. */
export function createImageTool(pluginConfig, host) {
    return {
        name: IMAGE_TOOL_NAME,
        description: IMAGE_DESCRIPTION,
        parameters: IMAGE_PARAMETERS,
        output: {
            schema: IMAGE_OUTPUT,
            render: (_args, value) => [{ type: 'text', text: textOf(value) }],
            presentationMeta: (_args, value) => {
                const result = value;
                return {
                    kind: 'image-generation',
                    path: result?.path ?? '',
                    files: result?.files ?? [],
                    model: result?.model ?? '',
                    provider: result?.provider ?? ''
                };
            }
        },
        async execute(args, exec) {
            logDebug('openai image execute', { provider: args?.provider });
            const config = resolveConfig(pluginConfig);
            return runImageGeneration({
                ...(host !== undefined ? { host } : {}),
                config,
                ...(exec !== undefined ? { exec } : {})
            }, (args ?? {}));
        }
    };
}
/** Build the video generation tool. */
export function createVideoTool(pluginConfig, host) {
    return {
        name: VIDEO_TOOL_NAME,
        description: VIDEO_DESCRIPTION,
        parameters: VIDEO_PARAMETERS,
        output: {
            schema: VIDEO_OUTPUT,
            render: (_args, value) => [{ type: 'text', text: textOf(value) }],
            presentationMeta: (_args, value) => {
                const result = value;
                return {
                    kind: 'video-generation',
                    path: result?.path ?? '',
                    files: result?.files ?? [],
                    model: result?.model ?? '',
                    provider: result?.provider ?? ''
                };
            }
        },
        async execute(args, exec) {
            logDebug('openai video execute', { provider: args?.provider });
            const config = resolveConfig(pluginConfig);
            return runVideoGeneration({
                ...(host !== undefined ? { host } : {}),
                config,
                ...(exec !== undefined ? { exec } : {})
            }, (args ?? {}));
        }
    };
}
/** Register every tool against a registry; returns the number registered. */
export function registerTools(registry, pluginConfig, host) {
    registry.register(createProvidersTool(pluginConfig, host));
    registry.register(createImageTool(pluginConfig, host));
    registry.register(createVideoTool(pluginConfig, host));
    return 3;
}
