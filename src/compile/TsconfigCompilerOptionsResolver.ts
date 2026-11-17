import ts from 'typescript';
import { DEFAULT_COMPILER_OPTIONS_JSON } from '../env/DefaultCompilerOptions';

export interface ResolvedCompilerOptions {
    /** Options for the deploy-time check. */
    options: ts.CompilerOptions;
    /** The effective `compilerOptions` in tsconfig.json form. */
    json: Record<string, unknown>;
    warnings: string[];
    /** Identifies nodes that can share one check program. */
    key: string;
    /** The options set in the tsconfig that change the JavaScript produced by `transpileModule`. */
    emitOptions: ts.CompilerOptions;
}

const HONOURED_TOP_LEVEL_KEYS = ['compilerOptions', '$schema'];

const EMIT_SHAPING_OPTIONS = [
    'outDir', 'outFile', 'rootDir', 'declaration', 'declarationDir', 'declarationMap',
    'emitDeclarationOnly', 'composite', 'incremental', 'tsBuildInfoFile',
];

const FORCED_CHECK_OPTIONS: ts.CompilerOptions = {
    noEmit: true,
    noErrorTruncation: true,
};

const EMIT_RELEVANT_OPTIONS: (keyof ts.CompilerOptions)[] = [
    'target', 'useDefineForClassFields', 'experimentalDecorators', 'emitDecoratorMetadata',
    'removeComments', 'jsx', 'jsxFactory', 'jsxFragmentFactory', 'jsxImportSource',
];

function flatten(diagnostic: ts.Diagnostic): string {
    return ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ');
}

export function resolveCompilerOptions(tsconfigText: string | undefined, basePath: string): ResolvedCompilerOptions {
    const warnings: string[] = [];
    let userOptions: Record<string, unknown> = {};

    if (tsconfigText && tsconfigText.trim()) {
        const parsed = ts.parseConfigFileTextToJson('tsconfig.json', tsconfigText);
        if (parsed.error) warnings.push(`tsconfig is not valid JSON: ${flatten(parsed.error)}`);
        const config = parsed.config;
        if (config && typeof config === 'object' && !Array.isArray(config)) {
            for (const key of Object.keys(config)) {
                if (!HONOURED_TOP_LEVEL_KEYS.includes(key)) {
                    warnings.push(`"${key}" is ignored: only "compilerOptions" is used`);
                }
            }
            if (config.compilerOptions && typeof config.compilerOptions === 'object') {
                userOptions = { ...config.compilerOptions };
            }
        }
    }

    for (const option of EMIT_SHAPING_OPTIONS) {
        if (option in userOptions) {
            warnings.push(`compilerOptions.${option} is ignored: the node controls its own output`);
            delete userOptions[option];
        }
    }

    const json: Record<string, unknown> = { ...DEFAULT_COMPILER_OPTIONS_JSON };
    if ('module' in userOptions && !('moduleResolution' in userOptions)) delete json.moduleResolution;
    Object.assign(json, userOptions);

    const converted = ts.convertCompilerOptionsFromJson(json, basePath);
    for (const error of converted.errors) warnings.push(flatten(error));

    const emitOptions: ts.CompilerOptions = {};
    for (const name of EMIT_RELEVANT_OPTIONS) {
        if (name in userOptions && converted.options[name] !== undefined) emitOptions[name] = converted.options[name];
    }

    return {
        options: { ...converted.options, ...FORCED_CHECK_OPTIONS },
        json,
        warnings,
        key: JSON.stringify(json),
        emitOptions,
    };
}
