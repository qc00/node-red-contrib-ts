import type { ModuleLib } from '../env/ModuleImportDeclarationGenerator';

/** The modules Node-RED's code editor has declarations for (`knownModules` in its monaco.js). */
const NODE_RED_BUNDLED_MODULE_TYPES = new Set([
    'assert', 'assert/strict', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'crypto', 'dgram',
    'dns', 'dns/promises', 'domain', 'events', 'fs', 'fs/promises', 'http', 'http2', 'https', 'module', 'net', 'os',
    'path', 'perf_hooks', 'process', 'querystring', 'readline', 'stream', 'stream/consumers', 'stream/promises',
    'stream/web', 'string_decoder', 'test', 'timers', 'timers/promises', 'tls', 'trace_events', 'tty', 'url', 'util',
    'v8', 'vm', 'wasi', 'worker_threads', 'zlib',
]);

/**
 * The libs Node-RED's editor may be asked to load typings for.
 * It requests `types/other/<module>.d.ts` for anything else, which never exists; `EditorModuleTypeLoader` covers those.
 */
export function libsWithNodeRedBundledTypes(libs: ModuleLib[] | undefined): ModuleLib[] {
    return (libs || []).filter(lib => NODE_RED_BUNDLED_MODULE_TYPES.has(lib.module));
}
