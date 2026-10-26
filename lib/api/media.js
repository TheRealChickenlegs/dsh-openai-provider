/**
 * Media materialization: turn `b64_json` payloads or provider URLs into files.
 *
 * Downloads go to a hidden temporary name first, are sniffed for their real
 * format, then renamed to a collision-free final path. A failed download can
 * therefore never leave a half-written file behind under the user's chosen name.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { downloadFile } from '../http.js';
import { decodeBase64Image, ensureDir, extensionForContentType, mimeForExtension, sniffImageExtension, sniffVideoExtension, uniquePath } from '../files.js';
function tempPath(directory, stem) {
    ensureDir(directory);
    return path.join(directory, `.${stem}.${randomBytes(6).toString('hex')}.part`);
}
function pickExtension(sniffed, contentType, preferred, requested) {
    return sniffed ?? (contentType !== undefined ? extensionForContentType(contentType) : undefined) ?? requested ?? preferred;
}
/** Write an already-decoded buffer to its final path. */
export function writeBuffer(buffer, options, kind) {
    const sniffed = kind === 'image' ? sniffImageExtension(buffer) : sniffVideoExtension(buffer);
    if (buffer.length === 0) {
        throw new Error('The provider returned an empty image payload.');
    }
    const extension = pickExtension(sniffed, options.contentType, options.preferredExtension, options.requestedExtension);
    const finalPath = uniquePath(options.directory, options.stem, extension);
    fs.writeFileSync(finalPath, buffer, { mode: 0o644 });
    return {
        path: finalPath,
        bytes: buffer.length,
        contentType: options.contentType ?? mimeForExtension(extension)
    };
}
/** Decode a base64 image payload and write it. */
export function writeBase64Image(value, options) {
    return writeBuffer(decodeBase64Image(value), options, 'image');
}
/** Decode a base64 video payload and write it. */
export function writeBase64Video(value, options) {
    return writeBuffer(decodeBase64Image(value), options, 'video');
}
/** Download a provider media URL and move it into place with the right extension. */
export async function downloadMedia(url, options, kind) {
    const temp = tempPath(options.directory, options.stem);
    try {
        const downloaded = await downloadFile({
            url,
            destination: temp,
            headers: options.authHeaders,
            authOrigin: options.authOrigin,
            timeoutMs: options.timeoutMs,
            maxBytes: options.maxBytes,
            signal: options.signal,
            what: options.what
        });
        const head = Buffer.alloc(32);
        const handle = fs.openSync(temp, 'r');
        try {
            fs.readSync(handle, head, 0, head.length, 0);
        }
        finally {
            fs.closeSync(handle);
        }
        const sniffed = kind === 'image' ? sniffImageExtension(head) : sniffVideoExtension(head);
        const extension = pickExtension(sniffed, downloaded.contentType, options.preferredExtension, options.requestedExtension);
        const finalPath = uniquePath(options.directory, options.stem, extension);
        fs.renameSync(temp, finalPath);
        return { path: finalPath, bytes: downloaded.bytes, contentType: downloaded.contentType };
    }
    catch (error) {
        fs.rmSync(temp, { force: true });
        throw error;
    }
}
