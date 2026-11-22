import type { API } from 'typescript/async';

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
