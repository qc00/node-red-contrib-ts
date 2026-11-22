import { startTypeScriptCompiler, TypeScriptCompiler } from './TypeScriptCompiler';

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
