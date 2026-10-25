import { missingApiKey } from './errors.js';
import { logDebug } from './log.js';
/** Look up an optional DSH service without letting a missing one break the plugin. */
export function getService(ctx, name) {
    if (ctx === undefined)
        return undefined;
    const candidates = [];
    try {
        if (typeof ctx.get === 'function')
            candidates.push(ctx.get(name));
    }
    catch {
        /* an unavailable service can throw in some compositions */
    }
    try {
        if (typeof ctx.reflect?.get === 'function') {
            candidates.push(ctx.reflect.get(name, false));
            candidates.push(ctx.reflect.get(name));
        }
    }
    catch {
        /* same */
    }
    for (const candidate of candidates) {
        if (candidate !== undefined && candidate !== null)
            return candidate;
    }
    return undefined;
}
/** Resolve one provider's credential, or throw a message that explains exactly where to set it. */
export async function resolveApiKey(ctx, provider, env = process.env) {
    const ref = provider.apiKeyEnv;
    if (typeof ref === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) {
        const credentials = getService(ctx, 'credentials');
        if (credentials?.resolve !== undefined) {
            try {
                const hit = await credentials.resolve(ref);
                if (hit !== undefined && typeof hit.value === 'string' && hit.value.length > 0) {
                    return {
                        value: hit.value,
                        source: typeof hit.source === 'string' && hit.source !== '' ? hit.source : 'credentials'
                    };
                }
            }
            catch (error) {
                // A provider refusing a malformed store must not mask an environment fallback.
                logDebug('credentials.resolve failed; trying the process environment', {
                    ref,
                    reason: error instanceof Error ? error.message : String(error)
                });
            }
        }
    }
    const ambient = env[ref];
    if (typeof ambient === 'string' && ambient.trim() !== '') {
        return { value: ambient.trim(), source: 'environment' };
    }
    throw missingApiKey(ref, provider.id);
}
/** Describe one provider's key without resolving its value. */
export async function describeApiKey(ctx, provider, env = process.env) {
    const ref = provider.apiKeyEnv;
    const credentials = getService(ctx, 'credentials');
    if (credentials?.describe !== undefined) {
        try {
            const info = await credentials.describe(ref);
            if (info !== undefined && info.configured === true) {
                return { configured: true, source: typeof info.source === 'string' ? info.source : 'credentials' };
            }
        }
        catch {
            /* fall through to the environment check */
        }
    }
    const ambient = env[ref];
    if (typeof ambient === 'string' && ambient.trim() !== '') {
        return { configured: true, source: 'environment' };
    }
    return { configured: false, source: null };
}
/**
 * Remove every occurrence of a known secret from text that may reach a model,
 * a log, or the browser. Also scrubs common accidental header echoes as a
 * second line of defence.
 */
export function redactSecrets(text, secrets) {
    let out = text;
    for (const secret of secrets) {
        if (typeof secret !== 'string' || secret.length < 4)
            continue;
        out = out.split(secret).join('[redacted]');
    }
    return out
        .replace(/(authorization\s*[:=]\s*)(bearer\s+)?[^\s,;"']+/gi, '$1[redacted]')
        .replace(/((?:x-)?api[-_ ]?key\s*[:=]\s*)[^\s,;"']+/gi, '$1[redacted]');
}
/** Recursively scrub every string in a JSON-shaped value (metadata sidecars, results). */
export function redactDeep(value, secrets) {
    if (typeof value === 'string')
        return redactSecrets(value, secrets);
    if (Array.isArray(value))
        return value.map((entry) => redactDeep(entry, secrets));
    if (value !== null && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactDeep(entry, secrets)]));
    }
    return value;
}
