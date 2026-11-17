import ts from 'typescript';
import * as path from 'path';
import { builtinModuleTypeFiles, isBuiltinModule } from './BuiltinModuleTypeFiles';

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
const RESOLUTION_OPTIONS: ts.CompilerOptions = {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
};
const RESOLUTION_MODES = [ts.ModuleKind.ESNext, ts.ModuleKind.CommonJS] as const;

/** Collects the declaration or TypeScript source files (and their package.json files) a module's typings consist of. */
export function collectModuleTypeFiles(moduleName: string, userDir: string): ModuleTypeFiles {
    if (isBuiltinModule(moduleName)) return builtinModuleTypeFiles();

    const root = path.resolve(userDir).replace(/\\/g, '/');
    const servedRoot = `${root}/node_modules/`;
    // No realpath: symlinked packages keep the node_modules/<name> path the editor resolves against.
    const host: ts.ModuleResolutionHost = {
        fileExists: ts.sys.fileExists,
        readFile: ts.sys.readFile,
        directoryExists: ts.sys.directoryExists,
        getCurrentDirectory: () => root,
    };

    const files = new Map<string, string>();
    let totalBytes = 0;
    let truncated = false;

    const add = (filePath: string): boolean => {
        if (files.has(filePath)) return false;
        if (!filePath.startsWith(servedRoot) || filePath.includes('/../')) return false;
        const content = ts.sys.readFile(filePath);
        if (content === undefined) return false;
        if (files.size >= MAX_FILES || totalBytes + content.length > MAX_TOTAL_BYTES) {
            truncated = true;
            return false;
        }
        files.set(filePath, content);
        totalBytes += content.length;
        return true;
    };

    const addPackageJson = (declarationPath: string) => {
        let directory = path.posix.dirname(declarationPath);
        while (directory.startsWith(servedRoot)) {
            const candidate = `${directory}/package.json`;
            if (ts.sys.fileExists(candidate)) {
                add(candidate);
                return;
            }
            directory = path.posix.dirname(directory);
        }
    };

    const resolve = (specifier: string, containingFile: string): string[] => {
        const resolved = new Set<string>();
        for (const mode of RESOLUTION_MODES) {
            const result = ts.resolveModuleName(specifier, containingFile, RESOLUTION_OPTIONS, host, undefined, undefined, mode);
            const fileName = result.resolvedModule?.resolvedFileName.replace(/\\/g, '/');
            if (fileName && TYPE_SOURCE_FILE_PATTERN.test(fileName)) resolved.add(fileName);
        }
        return [...resolved];
    };

    const queue = resolve(moduleName, `${root}/__node-red-contrib-ts__/__resolve.mts`);
    while (queue.length) {
        const filePath = queue.shift()!;
        if (!add(filePath)) continue;
        addPackageJson(filePath);

        const references = ts.preProcessFile(files.get(filePath)!, true, true);
        for (const reference of references.referencedFiles) {
            queue.push(path.posix.resolve(path.posix.dirname(filePath), reference.fileName));
        }
        for (const imported of references.importedFiles) {
            if (!isBuiltinModule(imported.fileName)) queue.push(...resolve(imported.fileName, filePath));
        }
    }

    return {
        builtin: false,
        files: [...files].map(([filePath, content]) => ({ path: filePath.slice(root.length + 1), content })),
        truncated,
    };
}
