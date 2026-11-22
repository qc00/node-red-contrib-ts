export interface ModuleLib {
    var: string;
    module: string;
}

const IDENTIFIER_PATTERN = /^[A-Za-z_$][\w$]*$/;

export function usableModuleLibs(libs: ModuleLib[] | undefined): ModuleLib[] {
    return (libs || []).filter(lib => lib && lib.module && IDENTIFIER_PATTERN.test(lib.var || ''));
}

export interface ServerModuleImports {
    /** One `import * as y from 'x'` per line; gives `y` its type namespace. */
    imports: string;
    /** Wrapper parameters shadowing each import with the value the runtime injects. */
    parameters: string[];
}

export function generateServerModuleImports(libs: ModuleLib[] | undefined): ServerModuleImports {
    const usable = usableModuleLibs(libs);
    return {
        imports: usable.map(lib => `import * as ${lib.var} from ${JSON.stringify(lib.module)};\n`).join(''),
        parameters: usable.map(lib => `${lib.var}: NodeRedImportedModule<typeof import(${JSON.stringify(lib.module)})>`),
    };
}

/**
 * A module declaration file that makes `y` global for the editor's bare function body:
 * the alias carries the type namespace, the const carries the value the runtime injects.
 */
export function generateEditorModuleDeclaration(lib: ModuleLib): string {
    return [
        `import * as __ns from ${JSON.stringify(lib.module)};`,
        'declare global {',
        `    export import ${lib.var} = __ns;`,
        `    const ${lib.var}: NodeRedImportedModule<typeof __ns>;`,
        '}',
        '',
    ].join('\n');
}
