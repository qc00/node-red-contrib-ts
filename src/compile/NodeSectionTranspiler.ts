import type { TypeScriptCompiler } from '../compiler/TypeScriptCompiler';
import type { CompilerOptionValues } from './TsconfigCompilerOptionsResolver';

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
