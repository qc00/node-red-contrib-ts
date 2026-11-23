import type { API } from 'typescript/async';
import type { ContextTypeRegistrySnapshot } from './context-types';
import type { TypeCheckRequestTarget } from './deploy-scheduler';
import { DeployTypeChecker, TypeCheckProgressSink } from './type-checker';
import { collectModuleTypeFiles, ModuleTypeFiles } from './module-types';
import { CompilerOptionValues, ResolvedCompilerOptions, resolveCompilerOptions } from './compiler-options';

/** A running native TypeScript compiler process and the modules of the `typescript` package that talk to it. */
export interface TypeScriptCompiler {
    readonly api: API;
    readonly flags: Pick<typeof import('typescript/async'), 'TypeFormatFlags'>;
    readonly fs: typeof import('typescript/fs');
    readonly ast: typeof import('typescript/ast');
    /** Settles when the compiler process has ended, for whatever reason. */
    readonly exited: Promise<void>;
    /** Resident memory of the compiler process in bytes, where the platform makes it readable. */
    residentMemory(): Promise<number | undefined>;
    close(): Promise<void>;
}

const CLOSE_TIMEOUT_MS = 2000;

interface CompilerChildProcess {
    pid?: number;
    once(event: 'exit', listener: () => void): void;
    kill(signal: 'SIGKILL'): boolean;
}

/** The `typescript` package is ESM-only and this bundle is CommonJS, hence the dynamic imports. */
export async function startTypeScriptCompiler(currentDirectory: string): Promise<TypeScriptCompiler> {
    const [apiModule, fs, ast] = await Promise.all([
        import('typescript/async'),
        import('typescript/fs'),
        import('typescript/ast'),
    ]);
    const api = new apiModule.API({ cwd: currentDirectory });
    // Forces the process to start now, so a failure to start surfaces here.
    await api.parseJsonConfigFileContent({ files: [] }, { configDirectory: currentDirectory });
    const child: CompilerChildProcess | undefined = (api as any).client?.process;
    const exited = new Promise<void>(resolve => child?.once('exit', resolve));

    return {
        api,
        flags: apiModule,
        fs,
        ast,
        exited,
        residentMemory: async () => {
            const pid = child?.pid;
            if (!pid || process.platform !== 'linux') return undefined;
            try {
                const { readFile } = await import('fs/promises');
                const status = await readFile(`/proc/${pid}/status`, 'utf8');
                const kilobytes = /^VmHWM:\s+(\d+) kB/m.exec(status)?.[1];
                return kilobytes ? Number(kilobytes) * 1024 : undefined;
            } catch {
                return undefined;
            }
        },
        close: async () => {
            // A process that is shutting down on its own stops answering, including the request to close.
            await Promise.race([api.close().catch(() => {}), new Promise(resolve => setTimeout(resolve, CLOSE_TIMEOUT_MS).unref())]);
            child?.kill('SIGKILL');
        },
    };
}

export interface CompilerSettings {
    keepAlive: boolean;
    idleTimeoutSeconds: number;
}

export interface CompilerLogger {
    info(message: string): void;
    warn(message: string): void;
}

export const DEFAULT_IDLE_TIMEOUT_SECONDS = 30;
const MAX_CACHED_TSCONFIGS = 16;

export interface CompilerOptionsSummary {
    options: CompilerOptionValues;
    json: Record<string, unknown>;
    warnings: string[];
}

/** One compiler generation. Retirement never changes the instance used by existing calls. */
export class Compiler {
    private starting: Promise<TypeScriptCompiler> | undefined;
    private activeUses = 0;
    private retired = false;
    private closing: Promise<void> | undefined;
    private forceStop: NodeJS.Timeout | undefined;
    private resolvedByText = new Map<string, Promise<ResolvedCompilerOptions>>();
    private readonly typeChecker: DeployTypeChecker;

    constructor(
        private readonly userDir: string,
        private readonly log: CompilerLogger,
        private readonly start = startTypeScriptCompiler,
        private readonly onIdle: () => void = () => {},
        private readonly onDisposed: () => void = () => {},
    ) {
        this.typeChecker = new DeployTypeChecker(userDir);
    }

    get busy() { return this.activeUses > 0; }

    async use<T>(operation: (compiler: TypeScriptCompiler) => Promise<T>): Promise<T> {
        if (this.retired) throw new Error('The TypeScript compiler has been retired');
        this.activeUses++;
        try {
            if (!this.starting) {
                const startedAt = Date.now();
                const starting = this.start(this.userDir);
                this.starting = starting;
                starting.then(
                    () => this.log.info(`TypeScript compiler started in ${Date.now() - startedAt}ms`),
                    () => { if (this.starting === starting) this.starting = undefined; },
                );
            }
            const compiler = await this.starting;
            const stopped = compiler.exited.then(() => { throw new Error('The TypeScript compiler process stopped'); });
            stopped.catch(() => {});
            return await Promise.race([operation(compiler), stopped]);
        } finally {
            this.activeUses--;
            if (!this.busy) {
                if (this.retired) void this[Symbol.asyncDispose]();
                else this.onIdle();
            }
        }
    }

    retire() {
        if (this.retired) return;
        this.retired = true;
        if (!this.busy) void this[Symbol.asyncDispose]();
        else this.forceStop = setTimeout(() => { void this[Symbol.asyncDispose](); }, CLOSE_TIMEOUT_MS).unref();
    }

    [Symbol.asyncDispose](): Promise<void> {
        this.retired = true;
        clearTimeout(this.forceStop);
        return this.closing ??= (async () => {
            try { await (await this.starting)?.close(); } catch { /* Already gone, or startup failed. */ }
            finally { this.onDisposed(); }
        })();
    }

    transpile(sources: string[], tsconfig: string | undefined): Promise<TranspiledSections> {
        return this.use(async compiler => transpileSections(compiler, sources, (await this.resolve(compiler, tsconfig)).emitOptions));
    }

    resolveCompilerOptions(tsconfig: string | undefined): Promise<CompilerOptionsSummary> {
        return this.use(async compiler => {
            const { options, json, warnings } = await this.resolve(compiler, tsconfig);
            return { options, json, warnings };
        });
    }

    collectModuleTypes(moduleName: string): Promise<ModuleTypeFiles> {
        return this.use(compiler => collectModuleTypeFiles(compiler, moduleName, this.userDir));
    }

    typeCheck(rev: string | undefined, targets: TypeCheckRequestTarget[], progress: TypeCheckProgressSink): Promise<ContextTypeRegistrySnapshot> {
        return this.use(async compiler => this.typeChecker.check(compiler, rev,
            await Promise.all(targets.map(async target => ({
                instanceId: target.instanceId,
                definition: target.definition,
                compilerOptions: await this.resolve(compiler, target.tsconfig),
            }))), progress));
    }

    private resolve(compiler: TypeScriptCompiler, tsconfig: string | undefined): Promise<ResolvedCompilerOptions> {
        const text = tsconfig || '';
        let resolved = this.resolvedByText.get(text);
        if (!resolved) {
            if (this.resolvedByText.size >= MAX_CACHED_TSCONFIGS) this.resolvedByText.clear();
            resolved = resolveCompilerOptions(compiler, text, this.userDir);
            resolved.catch(() => { if (this.resolvedByText.get(text) === resolved) this.resolvedByText.delete(text); });
            this.resolvedByText.set(text, resolved);
        }
        return resolved;
    }
}

// Each Node-RED runtime owns its current generation; existing calls keep their captured instance.
export class CompilerRuntime {
    private current: Compiler | undefined;
    private idleTimer: NodeJS.Timeout | undefined;
    private stopped = false;
    private readonly settings = new Map<string, CompilerSettings>();
    private readonly retired = new Set<Compiler>();

    constructor(
        private readonly userDir: string,
        private readonly log: CompilerLogger,
        private readonly start = startTypeScriptCompiler,
    ) {}

    private retire(compiler: Compiler) {
        this.retired.add(compiler);
        compiler.retire();
    }

    private scheduleIdleStop() {
        clearTimeout(this.idleTimer);
        if (!this.current || this.current.busy || this.stopped) return;
        const all = [...this.settings.values()];
        if (all.some(s => s.keepAlive)) return;
        const seconds = all.length ? Math.max(...all.map(s => s.idleTimeoutSeconds)) : DEFAULT_IDLE_TIMEOUT_SECONDS;
        const compiler = this.current;
        this.idleTimer = setTimeout(() => {
            if (this.current !== compiler || compiler.busy) return;
            this.current = undefined;
            this.retire(compiler);
            this.log.info(`TypeScript compiler stopped after ${seconds}s idle`);
        }, seconds * 1000).unref();
    }

    private newCompiler(): Compiler {
        const compiler = new Compiler(this.userDir, this.log, this.start,
            () => this.scheduleIdleStop(), () => this.retired.delete(compiler));
        return compiler;
    }

    private getCompiler() {
        if (this.stopped) throw new Error('The TypeScript compiler runtime has shut down');
        clearTimeout(this.idleTimer);
        return this.current ??= this.newCompiler();
    }

    async transpile(sources: string[], tsconfig: string | undefined) {
        const compiler = this.getCompiler();
        try { return await compiler.transpile(sources, tsconfig); }
        catch {
            if (this.current === compiler) {
                this.current = this.newCompiler();
                this.retire(compiler);
                this.log.warn('TypeScript compiler is being restarted');
            }
            return this.getCompiler().transpile(sources, tsconfig);
        }
    }

    resolveCompilerOptions(text: string | undefined) {
        return this.getCompiler().resolveCompilerOptions(text);
    }

    collectModuleTypes(name: string) {
        return this.getCompiler().collectModuleTypes(name);
    }

    typeCheck(rev: string | undefined, targets: TypeCheckRequestTarget[], progress: TypeCheckProgressSink) {
        return this.getCompiler().typeCheck(rev, targets, progress);
    }

    use<T>(operation: (compiler: TypeScriptCompiler) => Promise<T>) {
        return this.getCompiler().use(operation);
    }

    registerSettings(id: string, value: CompilerSettings) {
        this.settings.set(id, value);
        this.scheduleIdleStop();
    }

    unregisterSettings(id: string) {
        this.settings.delete(id);
        this.scheduleIdleStop();
    }

    async shutdown() {
        this.stopped = true;
        clearTimeout(this.idleTimer);
        if (this.current) this.retired.add(this.current);
        this.current = undefined;
        await Promise.all([...this.retired].map(c => c[Symbol.asyncDispose]()));
        this.retired.clear();
    }
}

export interface TranspiledSections {
    outputs: string[];
    /** `Line l:c: message` texts, per source. */
    diagnostics: string[][];
}

/** `ScriptTarget` values of the compiler. */
function scriptTargetOfRuntime(): number {
    const major = parseInt(process.version.slice(1).split('.')[0], 10);
    if (major >= 22) return 11; // ES2024
    if (major >= 20) return 10; // ES2023
    if (major >= 18) return 9; // ES2022
    return 8; // ES2021
}

const COMMON_JS_MODULE_KIND = 1;

/** As permissive as possible: transpiling only strips types, problems are reported by the deploy-time check. */
const TRANSPILE_OPTIONS: CompilerOptionValues = {
    target: scriptTargetOfRuntime(),
    module: COMMON_JS_MODULE_KIND,
    allowJs: true,
    strict: false,
    noEmitOnError: false,
    importHelpers: false,
};

/**
 * The compiler always emits the prologue, but the node evaluates each output as `return <output>`,
 * where a leading string statement would become the returned value.
 */
const USE_STRICT_PROLOGUE_PATTERN = /^\s*(["'])use strict\1;?\s*/;

/** Turns each TypeScript source into JavaScript without type checking. */
export async function transpileSections(
    compiler: TypeScriptCompiler,
    sources: string[],
    emitOptions: CompilerOptionValues,
): Promise<TranspiledSections> {
    const compilerOptions = { ...TRANSPILE_OPTIONS, ...emitOptions };
    const results = await Promise.all(
        sources.map(source => compiler.api.transpileModule(source, { compilerOptions, reportDiagnostics: true })),
    );
    return {
        outputs: results.map(result => result.outputText.replace(USE_STRICT_PROLOGUE_PATTERN, '')),
        diagnostics: results.map(result => (result.diagnostics || []).map(diagnostic => {
            const start = diagnostic.startPosition;
            return start ? `Line ${start.line + 1}:${start.character + 1}: ${diagnostic.text}` : diagnostic.text;
        })),
    };
}
