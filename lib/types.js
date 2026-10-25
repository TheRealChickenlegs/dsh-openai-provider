/**
 * Shared types.
 *
 * These are intentionally local interfaces rather than imports from
 * `@deepseek-ai/dsh-*`: under a link install, Node resolves host packages from
 * the plugin's physical path, where they do not exist. The runtime accepts plain
 * objects, so structural types are enough.
 */
export {};
