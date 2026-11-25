import * as path from 'path';
import type { TypeScriptCompiler } from './compiler';
import type { CompilerOptionValues } from './compiler-options';
import { builtinModules } from 'module';

export interface ModuleTypeFile {
    /** Relative to the Node-RED user directory, forward slashes. */
    path: string;
    content: string;
}

export interface ModuleTypeFiles {
    builtin: boolean;
    /** Sent for a built-in, so the editor can tell which references in its declarations are built-ins too. */
    builtinModules?: string[];
    files: ModuleTypeFile[];
    truncated: boolean;
}

const MAX_FILES = 400;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const TYPE_SOURCE_FILE_PATTERN = /\.[mc]?ts$/;
const NODE_MODULE_KIND_NODE_NEXT = 199;
const MODULE_RESOLUTION_KIND_NODE_NEXT = 99;

/**
 * `types: []` and `noLib` keep Node's and the language's own declarations out: the editor has those already.
 * Symlinked packages keep the node_modules/<name> path the editor resolves against.
 */
const RESOLUTION_OPTIONS: CompilerOptionValues = {
    module: NODE_MODULE_KIND_NODE_NEXT,
    moduleResolution: MODULE_RESOLUTION_KIND_NODE_NEXT,
    types: [],
    noLib: true,
    noEmit: true,
    skipLibCheck: true,
    allowJs: false,
    preserveSymlinks: true,
};

/** Collects the declaration or TypeScript source files (and their package.json files) a module's typings consist of. */
export async function collectModuleTypeFiles(compiler: TypeScriptCompiler, moduleName: string, userDir: string): Promise<ModuleTypeFiles> {
    if (isBuiltinModule(moduleName)) return builtinModuleTypeFiles();

    const root = path.resolve(userDir).replace(/\\/g, '/');
    const servedRoot = `${root}/node_modules/`;
    const nodeTypesRoot = `${servedRoot}@types/node/`;
    const specifier = JSON.stringify(moduleName);
    // One importer per module format, so both the `import` and the `require` typings of a package are found.
    const importers: [string, string][] = [
        [`${root}/__node-red-contrib-ts__/__resolve.mts`, `import ${specifier};\n`],
        [`${root}/__node-red-contrib-ts__/__resolve.cts`, `import __module = require(${specifier});\n`],
    ];

    const snapshot = await compiler.api.createSnapshot({
        fileSystem: compiler.fs.createFileSystemLayer(importers),
        createPrograms: [{ rootFiles: importers.map(([fileName]) => fileName), compilerOptions: RESOLUTION_OPTIONS }],
    });
    try {
        const program = snapshot.operation.createdPrograms[0];
        const files = new Map<string, string>();
        let totalBytes = 0;
        let truncated = false;

        const add = (filePath: string, content: string | undefined) => {
            if (content === undefined || files.has(filePath)) return;
            if (files.size >= MAX_FILES || totalBytes + content.length > MAX_TOTAL_BYTES) {
                truncated = true;
                return;
            }
            files.set(filePath, content);
            totalBytes += content.length;
        };

        const { readFile } = await import('fs/promises');
        const readIfPresent = (filePath: string) => readFile(filePath, 'utf8').catch(() => undefined);

        for (const fileName of await program.getSourceFileNames()) {
            const filePath = String(fileName).replace(/\\/g, '/');
            if (!filePath.startsWith(servedRoot) || filePath.startsWith(nodeTypesRoot) || !TYPE_SOURCE_FILE_PATTERN.test(filePath)) continue;
            add(filePath, (await program.getSourceFile(filePath))?.text);

            let directory = path.posix.dirname(filePath);
            while (directory.startsWith(servedRoot)) {
                const candidate = `${directory}/package.json`;
                if (files.has(candidate)) break;
                const content = await readIfPresent(candidate);
                if (content !== undefined) {
                    add(candidate, content);
                    break;
                }
                directory = path.posix.dirname(directory);
            }
        }

        return {
            builtin: false,
            files: [...files].map(([filePath, content]) => ({ path: filePath.slice(root.length + 1), content })),
            truncated,
        };
    } finally {
        await snapshot.dispose();
    }
}

export function isBuiltinModule(moduleName: string): boolean {
    return builtinModules.includes(moduleName.replace(/^node:/, ''));
}

/** The answer for a Node built-in: the editor takes its declarations from Node-RED, and needs to know which references are built-ins too. */
export function builtinModuleTypeFiles(): ModuleTypeFiles {
    return { builtin: true, builtinModules: [...builtinModules], files: [], truncated: false };
}
