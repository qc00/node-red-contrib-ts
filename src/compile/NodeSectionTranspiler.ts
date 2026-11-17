import ts from 'typescript';

export interface TranspiledSections {
    outputs: string[];
    /** `Line l:c: message` texts, per source. */
    diagnostics: string[][];
}

function scriptTargetOfRuntime(): ts.ScriptTarget {
    const major = parseInt(process.version.slice(1).split('.')[0], 10);
    if (major >= 22) return ts.ScriptTarget.ES2024;
    if (major >= 20) return ts.ScriptTarget.ES2023;
    if (major >= 18) return ts.ScriptTarget.ES2022;
    if (major >= 16) return ts.ScriptTarget.ES2021;
    if (major >= 14) return ts.ScriptTarget.ES2020;
    return ts.ScriptTarget.ES2019;
}

/** As permissive as possible: transpiling only strips types, problems are reported by the deploy-time check. */
const TRANSPILE_OPTIONS: ts.CompilerOptions = {
    target: scriptTargetOfRuntime(),
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10,

    allowJs: true,
    allowUnreachableCode: true,
    allowUnusedLabels: true,

    strict: false,
    noImplicitAny: false,
    noImplicitThis: false,
    noImplicitReturns: false,
    noImplicitUseStrict: false,

    noUnusedLocals: false,
    noUnusedParameters: false,
    exactOptionalPropertyTypes: false,
    noUncheckedIndexedAccess: false,
    noPropertyAccessFromIndexSignature: false,

    skipLibCheck: true,
    skipDefaultLibCheck: true,

    suppressExcessPropertyErrors: true,
    suppressImplicitAnyIndexErrors: true,

    allowSyntheticDefaultImports: true,
    allowUmdGlobalAccess: true,

    noEmitOnError: false,

    downlevelIteration: true,
    importHelpers: false,
};

function describe(diagnostic: ts.Diagnostic): string {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
    if (diagnostic.file && diagnostic.start !== undefined) {
        const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
        return `Line ${line + 1}:${character + 1}: ${message}`;
    }
    return message;
}

/** Turns each TypeScript source into JavaScript without type checking. */
export function transpileSections(sources: string[], emitOptions: ts.CompilerOptions): TranspiledSections {
    const compilerOptions = { ...TRANSPILE_OPTIONS, ...emitOptions };
    const results = sources.map(source => ts.transpileModule(source, { compilerOptions }));
    return {
        outputs: results.map(result => result.outputText),
        diagnostics: results.map(result => (result.diagnostics || []).map(describe)),
    };
}
