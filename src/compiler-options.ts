import type { TypeScriptCompiler } from './compiler';

/** Compiler options in the compiler's own form: enum numbers, lib file names. */
export type CompilerOptionValues = Record<string, unknown>;

export interface ResolvedCompilerOptions {
    /** Options for the deploy-time check. */
    options: CompilerOptionValues;
    /** The effective `compilerOptions` in tsconfig.json form. */
    json: Record<string, unknown>;
    warnings: string[];
    /** Identifies nodes that can share one check program. */
    key: string;
    /** The options set in the tsconfig that change the JavaScript produced by transpiling. */
    emitOptions: CompilerOptionValues;
}

const HONOURED_TOP_LEVEL_KEYS = ['compilerOptions', '$schema'];

const EMIT_SHAPING_OPTIONS = [
    'outDir', 'outFile', 'rootDir', 'declaration', 'declarationDir', 'declarationMap',
    'emitDeclarationOnly', 'composite', 'incremental', 'tsBuildInfoFile',
];

const FORCED_CHECK_OPTIONS: CompilerOptionValues = {
    noEmit: true,
    noErrorTruncation: true,
};

const EMIT_RELEVANT_OPTIONS = [
    'target', 'useDefineForClassFields', 'experimentalDecorators', 'emitDecoratorMetadata',
    'removeComments', 'jsx', 'jsxFactory', 'jsxFragmentFactory', 'jsxImportSource',
];

/** "No inputs were found": expected, the node supplies the files itself. */
const NO_INPUT_DIAGNOSTIC_CODES = [18002, 18003];

export async function resolveCompilerOptions(
    compiler: TypeScriptCompiler,
    tsconfigText: string | undefined,
    basePath: string,
): Promise<ResolvedCompilerOptions> {
    const warnings: string[] = [];
    let userOptions: Record<string, unknown> = {};

    if (tsconfigText && tsconfigText.trim()) {
        let config: any;
        try {
            config = parseJsonWithComments(tsconfigText);
        } catch (error: any) {
            warnings.push(`tsconfig is not valid JSON: ${error?.message || error}`);
        }
        if (config !== undefined && (config === null || typeof config !== 'object' || Array.isArray(config))) {
            warnings.push('tsconfig must be an object');
        } else if (config) {
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

    const converted = await compiler.api.parseJsonConfigFileContent({ compilerOptions: json, files: [] }, { configDirectory: basePath });
    for (const error of converted.errors) {
        if (!NO_INPUT_DIAGNOSTIC_CODES.includes(error.code)) warnings.push(error.text);
    }
    const options = converted.options as CompilerOptionValues;

    const emitOptions: CompilerOptionValues = {};
    for (const name of EMIT_RELEVANT_OPTIONS) {
        if (name in userOptions && options[name] !== undefined) emitOptions[name] = options[name];
    }

    return {
        options: { ...options, ...FORCED_CHECK_OPTIONS },
        json,
        warnings,
        key: JSON.stringify(json),
        emitOptions,
    };
}

/** `compilerOptions` applied underneath a node's tsconfig, in tsconfig.json form. */
export const DEFAULT_COMPILER_OPTIONS_JSON: Record<string, unknown> = {
    target: 'ES2022',
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    lib: ['ES2022'],
    types: ['node'],
    strict: false,
    allowJs: true,
    skipLibCheck: true,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
};

/** Parses JSON that may contain comments and trailing commas, as tsconfig.json files do. */
export function parseJsonWithComments(text: string): unknown {
    let plain = '';
    let index = 0;
    while (index < text.length) {
        const char = text[index];
        const next = text[index + 1];
        if (char === '"') {
            const start = index++;
            while (index < text.length && text[index] !== '"') index += text[index] === '\\' ? 2 : 1;
            plain += text.slice(start, ++index);
        } else if (char === '/' && next === '/') {
            while (index < text.length && text[index] !== '\n') index++;
        } else if (char === '/' && next === '*') {
            const end = text.indexOf('*/', index + 2);
            index = end < 0 ? text.length : end + 2;
        } else {
            if ((char === '}' || char === ']') && plain.trimEnd().endsWith(',')) plain = plain.trimEnd().slice(0, -1);
            plain += char;
            index++;
        }
    }
    return JSON.parse(plain);
}
