import { monacoTypeScriptApi } from './MonacoTypeScriptApi';

declare const $: any;

export interface CompilerOptionsResponse {
    /** In the compiler's own form (enum numbers, lib file names). */
    options: Record<string, unknown>;
    json: Record<string, unknown>;
    warnings: string[];
}

/** Asks the runtime to parse tsconfig text, so the editor and the deploy-time check interpret it identically. */
export function requestCompilerOptions(tsconfigText: string | undefined): Promise<CompilerOptionsResponse> {
    return new Promise((resolve, reject) => {
        $.ajax({
            url: 'typescript-node/compiler-options',
            type: 'POST',
            contentType: 'application/json',
            data: JSON.stringify({ tsconfig: tsconfigText || '' }),
        }).done(resolve).fail(reject);
    });
}

let latestRequest = 0;

export async function applyCompilerOptionsToMonaco(tsconfigText: string | undefined) {
    const request = ++latestRequest;
    const response = await requestCompilerOptions(tsconfigText);
    if (request !== latestRequest) return;
    // Type roots are directories on the runtime's disk; the editor gets Node's types from Node-RED instead.
    const { types, typeRoots, ...options } = response.options;
    // Monaco's own default; without it the worker rejects models whose URI has no .ts extension.
    monacoTypeScriptApi().typescriptDefaults.setCompilerOptions({ ...options, allowNonTsExtensions: true });
}
