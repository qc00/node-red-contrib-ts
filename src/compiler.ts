import type { API } from 'typescript/async';
import type { ContextTypeRegistrySnapshot } from './context-types';
import type { TypeCheckProgressEvent, TypeCheckRequestTarget } from './deploy-scheduler';
import { DeployTypeChecker } from './type-checker';
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

export interface TypeScriptCompilerSettings {
    /** Never stop the compiler process when idle. */
    keepAlive: boolean;
    idleTimeoutSeconds: number;
}

export interface TypeScriptCompilerLogger {
    info(message: string): void;
    warn(message: string): void;
}

export const DEFAULT_IDLE_TIMEOUT_SECONDS = 30;

/** Owns the lifetime of the compiler process: started on first use, stopped when idle. */
export class TypeScriptCompilerClient {
    private settings = new Map<string, TypeScriptCompilerSettings>();
    private starting: Promise<TypeScriptCompiler> | undefined;
    private activeUses = 0;
    private idleTimer: NodeJS.Timeout | undefined;

    constructor(
        private readonly currentDirectory: string,
        private readonly log: TypeScriptCompilerLogger,
        private readonly start: (currentDirectory: string) => Promise<TypeScriptCompiler> = startTypeScriptCompiler,
    ) {}

    registerSettings(ownerId: string, settings: TypeScriptCompilerSettings) {
        this.settings.set(ownerId, settings);
        this.scheduleIdleStop();
    }

    unregisterSettings(ownerId: string) {
        this.settings.delete(ownerId);
        this.scheduleIdleStop();
    }

    /** Runs `operation` against the compiler, starting it if needed; uses may overlap. */
    async use<T>(operation: (compiler: TypeScriptCompiler) => Promise<T>): Promise<T> {
        clearTimeout(this.idleTimer);
        this.activeUses++;
        try {
            const compiler = await this.running();
            // Requests to a process that has gone are never answered.
            const stopped = compiler.exited.then(() => { throw new Error('The TypeScript compiler process stopped'); });
            stopped.catch(() => {});
            return await Promise.race([operation(compiler), stopped]);
        } finally {
            this.activeUses--;
            this.scheduleIdleStop();
        }
    }

    async shutdown() {
        clearTimeout(this.idleTimer);
        await this.stop();
    }

    /** Replaces a compiler process that no longer answers properly; the next use starts a new one. */
    restart() {
        this.log.warn('TypeScript compiler is being restarted');
        this.stop();
    }

    private running(): Promise<TypeScriptCompiler> {
        if (!this.starting) {
            const startedAt = Date.now();
            const starting = this.start(this.currentDirectory);
            this.starting = starting;
            starting.then(
                compiler => {
                    this.log.info(`TypeScript compiler started in ${Date.now() - startedAt}ms`);
                    compiler.exited.then(() => {
                        if (this.starting !== starting) return;
                        this.starting = undefined;
                        this.log.warn('TypeScript compiler process stopped unexpectedly');
                    });
                },
                () => { if (this.starting === starting) this.starting = undefined; },
            );
        }
        return this.starting;
    }

    private async stop() {
        const starting = this.starting;
        this.starting = undefined;
        try {
            await (await starting)?.close();
        } catch {
            // Already gone.
        }
    }

    private scheduleIdleStop() {
        clearTimeout(this.idleTimer);
        if (this.activeUses > 0 || !this.starting) return;
        const all = [...this.settings.values()];
        if (all.some(settings => settings.keepAlive)) return;
        const idleTimeoutSeconds = all.length
            ? Math.max(...all.map(settings => settings.idleTimeoutSeconds))
            : DEFAULT_IDLE_TIMEOUT_SECONDS;
        this.idleTimer = setTimeout(() => {
            this.log.info(`TypeScript compiler stopped after ${idleTimeoutSeconds}s idle`);
            this.stop();
        }, idleTimeoutSeconds * 1000);
        this.idleTimer.unref();
    }
}

export interface CompilerOptionsSummary {
    /** In the compiler's own form (enum numbers, lib file names). */
    options: CompilerOptionValues;
    /** The effective `compilerOptions` in tsconfig.json form. */
    json: Record<string, unknown>;
    warnings: string[];
}

const MAX_CACHED_TSCONFIGS = 16;

/** Everything the node asks of the TypeScript compiler. */
export class TypeScriptCompilerService {
    private readonly typeChecker: DeployTypeChecker;
    private resolvedByText = new Map<string, Promise<ResolvedCompilerOptions>>();

    constructor(private readonly client: TypeScriptCompilerClient, private readonly userDir: string) {
        this.typeChecker = new DeployTypeChecker(userDir);
    }

    /** A node cannot run without its JavaScript, so a failure is tried once more with a new compiler process. */
    async transpile(sources: string[], tsconfig: string | undefined): Promise<TranspiledSections> {
        const attempt = () => this.client.use(async compiler =>
            transpileSections(compiler, sources, (await this.resolve(compiler, tsconfig)).emitOptions));
        try {
            return await attempt();
        } catch {
            this.client.restart();
            return attempt();
        }
    }

    resolveCompilerOptions(tsconfig: string | undefined): Promise<CompilerOptionsSummary> {
        return this.client.use(async compiler => {
            const { options, json, warnings } = await this.resolve(compiler, tsconfig);
            return { options, json, warnings };
        });
    }

    collectModuleTypes(moduleName: string): Promise<ModuleTypeFiles> {
        return this.client.use(compiler => collectModuleTypeFiles(compiler, moduleName, this.userDir));
    }

    typeCheck(
        rev: string | undefined,
        targets: TypeCheckRequestTarget[],
        progress: (event: TypeCheckProgressEvent) => void,
    ): Promise<ContextTypeRegistrySnapshot> {
        return this.client.use(async compiler => this.typeChecker.check(
            compiler,
            rev,
            await Promise.all(targets.map(async target => ({
                instanceId: target.instanceId,
                definition: target.definition,
                compilerOptions: await this.resolve(compiler, target.tsconfig),
            }))),
            {
                info: message => progress({ kind: 'info', message }),
                nodeLog: (instanceId, message) => progress({ kind: 'nodeLog', instanceId, message }),
                nodeWarn: (instanceId, message) => progress({ kind: 'nodeWarn', instanceId, message }),
                nodeReport: (instanceId, message) => progress({ kind: 'nodeReport', instanceId, message }),
            },
        ));
    }

    private resolve(compiler: TypeScriptCompiler, tsconfig: string | undefined): Promise<ResolvedCompilerOptions> {
        const text = tsconfig || '';
        let resolved = this.resolvedByText.get(text);
        if (!resolved) {
            if (this.resolvedByText.size >= MAX_CACHED_TSCONFIGS) this.resolvedByText.clear();
            resolved = resolveCompilerOptions(compiler, text, this.userDir);
            resolved.catch(() => this.resolvedByText.delete(text));
            this.resolvedByText.set(text, resolved);
        }
        return resolved;
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
