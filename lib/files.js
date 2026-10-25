/**
 * Filesystem helpers: output planning, media sniffing, metadata sidecars.
 *
 * Writes never overwrite an existing file: a collision gets `-1`, `-2`, ….
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProviderPluginError } from './errors.js';
import { getService } from './credentials.js';
/** Maximum size of one local input image (edits/reference frames). */
export const MAX_INPUT_IMAGE_BYTES = 32 * 1024 * 1024;
export const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
export const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mov', '.m4v', '.mkv']);
/** Expand a leading `~` and resolve against `base`. */
export function resolveUserPath(value, base) {
    const expanded = value === '~' ? os.homedir() : value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
    return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(base, expanded);
}
/** Dig the agent's working directory out of the execution context, defensively. */
export function resolveCwd(exec) {
    const agent = exec?.agent;
    if (agent) {
        const candidates = [
            agent.cwd,
            agent.meta?.cwd,
            agent.session?.cwd,
            agent.session?.header?.cwd
        ];
        for (const candidate of candidates) {
            if (typeof candidate === 'string' && candidate.trim() !== '')
                return candidate;
        }
    }
    return process.cwd();
}
/**
 * Resolve the session working directory through DSH's workingDirectory service,
 * with the same defensive agent probes as a fallback. Outputs must not land in
 * the DSH process directory when the session has its own workspace.
 */
export async function resolveSessionCwd(host, exec) {
    const agent = exec?.agent;
    const service = getService(host, 'workingDirectory');
    if (agent !== undefined && service?.ensure !== undefined) {
        try {
            const resolved = await service.ensure(agent, exec?.signal);
            if (typeof resolved === 'string' && resolved.trim() !== '')
                return resolved;
        }
        catch {
            /* fall through to the structural probes */
        }
    }
    return resolveCwd(exec);
}
/** Timestamp used in generated file names. */
export function timestampSlug(date = new Date()) {
    const pad = (value, width = 2) => String(value).padStart(width, '0');
    return (`${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
        `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`);
}
/** Reduce arbitrary text to a safe filename component. */
export function sanitizeComponent(value, max = 60) {
    const clean = value
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, max)
        .replace(/-+$/g, '');
    return clean === '' ? 'file' : clean;
}
/** File extension implied by a content type. */
export function extensionForContentType(contentType) {
    const type = contentType.split(';', 1)[0].trim().toLowerCase();
    switch (type) {
        case 'image/png':
            return '.png';
        case 'image/jpeg':
        case 'image/jpg':
            return '.jpg';
        case 'image/webp':
            return '.webp';
        case 'image/gif':
            return '.gif';
        case 'video/mp4':
            return '.mp4';
        case 'video/webm':
            return '.webm';
        case 'video/quicktime':
            return '.mov';
        case 'video/x-matroska':
            return '.mkv';
        default:
            return undefined;
    }
}
/** Detect an image extension from magic bytes. */
export function sniffImageExtension(buffer) {
    if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
        return '.png';
    }
    if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff)
        return '.jpg';
    if (buffer.length >= 12 &&
        buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
        buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
        return '.webp';
    }
    if (buffer.length >= 6 && buffer.subarray(0, 6).toString('ascii').startsWith('GIF8'))
        return '.gif';
    return undefined;
}
/** Detect a video extension from magic bytes / `ftyp` brand. */
export function sniffVideoExtension(buffer) {
    if (buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp') {
        const brand = buffer.subarray(8, 12).toString('ascii');
        if (brand.startsWith('qt'))
            return '.mov';
        return '.mp4';
    }
    if (buffer.length >= 4 && buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])))
        return '.webm';
    return undefined;
}
/** Whether a path looks like a file because it carries a recognised extension. */
export function looksLikeFile(value, extensions) {
    return extensions.has(path.extname(value).toLowerCase());
}
/** Create a directory if needed. */
export function ensureDir(directory) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o755 });
}
/** Return `base.ext` or the first free `base-1.ext`, `base-2.ext`, … */
export function uniquePath(directory, base, extension) {
    const ext = extension.startsWith('.') ? extension : `.${extension}`;
    let candidate = path.join(directory, `${base}${ext}`);
    let index = 1;
    while (fs.existsSync(candidate)) {
        candidate = path.join(directory, `${base}-${index}${ext}`);
        index += 1;
        if (index > 10_000) {
            throw new ProviderPluginError('OUTPUT_COLLISION', `Could not find a free output name for "${base}${ext}".`);
        }
    }
    return candidate;
}
/** Decide the output directory and stem for a call. */
export function resolveOutputTarget(input) {
    const { cwd, basename, fileExtensions, count } = input;
    let directory;
    let stem = basename;
    let requestedExtension;
    let exactFile = false;
    if (input.requested !== undefined && input.requested.trim() !== '') {
        const resolved = resolveUserPath(input.requested.trim(), cwd);
        const existingFile = count === 1 && fs.existsSync(resolved) && fs.statSync(resolved).isFile();
        if (looksLikeFile(resolved, fileExtensions) || existingFile) {
            directory = path.dirname(resolved);
            stem = sanitizeComponent(path.basename(resolved, path.extname(resolved)));
            requestedExtension = path.extname(resolved).toLowerCase();
            exactFile = count === 1;
        }
        else {
            directory = resolved;
        }
    }
    else if (input.defaultDir !== undefined && input.defaultDir.trim() !== '') {
        directory = resolveUserPath(input.defaultDir.trim(), cwd);
    }
    else {
        directory = cwd;
    }
    ensureDir(directory);
    return { directory, stem, requestedExtension, exactFile };
}
/** Read a local image for an edit/reference upload, with a size cap. */
export function readInputImage(value, cwd) {
    const resolved = resolveUserPath(value, cwd);
    let stat;
    try {
        stat = fs.statSync(resolved);
    }
    catch {
        throw new ProviderPluginError('INPUT_IMAGE_MISSING', `Input image does not exist: ${resolved}`, 'Pass an absolute path or a path relative to the session working directory.');
    }
    if (!stat.isFile()) {
        throw new ProviderPluginError('INPUT_IMAGE_INVALID', `Input image is not a file: ${resolved}`);
    }
    if (stat.size > MAX_INPUT_IMAGE_BYTES) {
        throw new ProviderPluginError('INPUT_IMAGE_TOO_LARGE', `Input image is larger than ${Math.round(MAX_INPUT_IMAGE_BYTES / (1024 * 1024))} MiB: ${resolved}`, 'Resize the image before using it as an edit or reference input.');
    }
    const buffer = fs.readFileSync(resolved);
    const sniffed = sniffImageExtension(buffer);
    const mime = sniffed === '.png'
        ? 'image/png'
        : sniffed === '.jpg'
            ? 'image/jpeg'
            : sniffed === '.webp'
                ? 'image/webp'
                : sniffed === '.gif'
                    ? 'image/gif'
                    : guessMimeFromName(resolved);
    if (mime === undefined) {
        throw new ProviderPluginError('INPUT_IMAGE_UNSUPPORTED', `Unsupported input image format: ${resolved}`, 'Use PNG, JPEG, WebP, or GIF.');
    }
    return { buffer, mime, name: path.basename(resolved) };
}
function guessMimeFromName(file) {
    switch (path.extname(file).toLowerCase()) {
        case '.png':
            return 'image/png';
        case '.jpg':
        case '.jpeg':
            return 'image/jpeg';
        case '.webp':
            return 'image/webp';
        case '.gif':
            return 'image/gif';
        default:
            return undefined;
    }
}
/** Encode a buffer as a data URL. */
export function toDataUri(buffer, mime) {
    return `data:${mime};base64,${buffer.toString('base64')}`;
}
/** Write a JSON sidecar; the caller picks the exact target through {@link uniquePath}. */
export function writeJsonSidecar(filePath, value) {
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o644 });
    return filePath;
}
/** Content type implied by a media extension. */
export function mimeForExtension(extension) {
    switch (extension.toLowerCase()) {
        case '.png': return 'image/png';
        case '.jpg':
        case '.jpeg': return 'image/jpeg';
        case '.webp': return 'image/webp';
        case '.gif': return 'image/gif';
        case '.mp4': return 'video/mp4';
        case '.webm': return 'video/webm';
        case '.mov': return 'video/quicktime';
        case '.m4v': return 'video/x-m4v';
        case '.mkv': return 'video/x-matroska';
        default: return 'application/octet-stream';
    }
}
/** Decode a base64 or data-URI image payload. */
export function decodeBase64Image(value) {
    const comma = value.indexOf(',');
    const payload = value.startsWith('data:') && comma !== -1 ? value.slice(comma + 1) : value;
    return Buffer.from(payload, 'base64');
}
/** Best-effort pixel dimensions for common image formats (PNG, JPEG, GIF, WebP VP8X). */
export function imageDimensions(buffer) {
    // PNG: IHDR is the first chunk.
    if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
        return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }
    // GIF: logical screen descriptor.
    if (buffer.length >= 10 && buffer.subarray(0, 6).toString('ascii').startsWith('GIF8')) {
        return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
    }
    // WebP with the extended (VP8X) header.
    if (buffer.length >= 30 &&
        buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
        buffer.subarray(8, 12).toString('ascii') === 'WEBP' &&
        buffer.subarray(12, 16).toString('ascii') === 'VP8X') {
        const width = 1 + (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16));
        const height = 1 + (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16));
        return { width, height };
    }
    // JPEG: walk the marker chain to the first start-of-frame.
    if (buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
        let offset = 2;
        while (offset + 8 < buffer.length) {
            if (buffer[offset] !== 0xff) {
                offset += 1;
                continue;
            }
            const marker = buffer[offset + 1];
            if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
                offset += 2;
                continue;
            }
            const length = buffer.readUInt16BE(offset + 2);
            if (length < 2)
                return undefined;
            const isSof = (marker >= 0xc0 && marker <= 0xc3) ||
                (marker >= 0xc5 && marker <= 0xc7) ||
                (marker >= 0xc9 && marker <= 0xcb) ||
                (marker >= 0xcd && marker <= 0xcf);
            if (isSof && offset + 9 < buffer.length) {
                return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
            }
            offset += 2 + length;
        }
    }
    return undefined;
}
/** Parse `1024x1024` / `1280x720` into numbers. */
export function parseDimensions(value) {
    if (value === undefined)
        return undefined;
    const match = /^(\d{2,5})[x×](\d{2,5})$/i.exec(value.trim());
    if (match === null)
        return undefined;
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (!Number.isFinite(width) || !Number.isFinite(height))
        return undefined;
    return { width, height };
}
