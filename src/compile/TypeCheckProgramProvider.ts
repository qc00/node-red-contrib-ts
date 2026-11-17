import ts from 'typescript';

/** In-memory source files layered over the real file system for a check program. */
export class VirtualSourceFileSet {
    private files = new Map<string, { text: string; version: number }>();

    constructor(readonly directory: string) {}

    pathOf(fileName: string): string {
        return `${this.directory}/${fileName}`;
    }

    set(path: string, text: string) {
        const existing = this.files.get(path);
        if (!existing) this.files.set(path, { text, version: 1 });
        else if (existing.text !== text) this.files.set(path, { text, version: existing.version + 1 });
    }

    retainOnly(paths: Set<string>) {
        for (const path of [...this.files.keys()]) {
            if (!paths.has(path)) this.files.delete(path);
        }
    }

    has(path: string): boolean { return this.files.has(path); }
    textOf(path: string): string | undefined { return this.files.get(path)?.text; }
    versionOf(path: string): string | undefined { return this.files.get(path)?.version.toString(); }
    paths(): string[] { return [...this.files.keys()]; }
}

function createLanguageService(files: VirtualSourceFileSet, options: ts.CompilerOptions, currentDirectory: string): ts.LanguageService {
    const host: ts.LanguageServiceHost = {
        getScriptFileNames: () => files.paths(),
        getScriptVersion: path => files.versionOf(path) ?? '0',
        getScriptSnapshot: path => {
            const text = files.textOf(path) ?? ts.sys.readFile(path);
            return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
        },
        getCurrentDirectory: () => currentDirectory,
        getCompilationSettings: () => options,
        getDefaultLibFileName: ts.getDefaultLibFilePath,
        useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
        fileExists: path => files.has(path) || ts.sys.fileExists(path),
        readFile: (path, encoding) => files.textOf(path) ?? ts.sys.readFile(path, encoding),
        directoryExists: path => path === files.directory || ts.sys.directoryExists(path),
        getDirectories: ts.sys.getDirectories,
        realpath: ts.sys.realpath,
    };
    return ts.createLanguageService(host, ts.createDocumentRegistry());
}

/** Owns the lifetime of the language service used to check one group of nodes. */
export interface TypeCheckProgramProvider {
    readonly files: VirtualSourceFileSet;
    /** The service over the current content of `files`. */
    open(): ts.LanguageService;
    /** The caller is done with the service for now. */
    close(): void;
    /** The group of nodes no longer exists. */
    dispose(): void;
}

abstract class LanguageServiceTypeCheckProgramProvider implements TypeCheckProgramProvider {
    private service: ts.LanguageService | undefined;

    constructor(
        readonly files: VirtualSourceFileSet,
        private readonly options: ts.CompilerOptions,
        private readonly currentDirectory: string,
    ) {}

    open(): ts.LanguageService {
        return this.service ??= createLanguageService(this.files, this.options, this.currentDirectory);
    }

    abstract close(): void;

    dispose() {
        this.service?.dispose();
        this.service = undefined;
    }
}

/** Frees the program after every use, so its memory is only held during a check. */
export class OneShotTypeCheckProgramProvider extends LanguageServiceTypeCheckProgramProvider {
    close() { this.dispose(); }
}

/** Keeps the program between checks, trading memory for incremental re-checks. */
export class PersistentTypeCheckProgramProvider extends LanguageServiceTypeCheckProgramProvider {
    close() {}
}
