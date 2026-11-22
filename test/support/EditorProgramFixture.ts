import ts from 'typescript5';
import type { TypeScriptCompilerService } from '../../src/compiler/TypeScriptCompilerService';
import { ContextScopeKeyTypes, EMPTY_CONTEXT_SCOPE_KEY_TYPES, generateContextDeclarations } from '../../src/env/ContextTypeDeclarationGenerator';
import { generateEditorModuleDeclaration, ModuleLib } from '../../src/env/ModuleImportDeclarationGenerator';
import { NODE_RED_ENV_DECLARATION_SOURCE, NODE_RED_SANDBOX_VALUE_DECLARATIONS } from '../../src/env/NodeRedEnvDeclarationSource';

export interface EditorProgramInput {
    userDir: string;
    body: string;
    libs?: ModuleLib[];
    keyTypes?: ContextScopeKeyTypes;
    declare?: string;
    tsconfig?: string;
}

/**
 * Reproduces what the editor hands to Monaco: a bare script body plus the generated declaration files,
 * checked by the TypeScript version Node-RED's Monaco bundles, with compiler options resolved by the runtime's compiler.
 */
export class EditorProgramFixture {
    readonly bodyPath: string;
    readonly service: ts.LanguageService;
    private files = new Map<string, string>();

    static async create(compiler: TypeScriptCompilerService, input: EditorProgramInput): Promise<EditorProgramFixture> {
        return new EditorProgramFixture(input, (await compiler.resolveCompilerOptions(input.tsconfig)).options);
    }

    private constructor(input: EditorProgramInput, resolvedOptions: Record<string, unknown>) {
        const dir = input.userDir;
        this.bodyPath = `${dir}/ts-body.ts`;
        this.files.set(this.bodyPath, input.body);
        this.files.set(`${dir}/node-red-ts-env.d.ts`, `${NODE_RED_ENV_DECLARATION_SOURCE}\n${NODE_RED_SANDBOX_VALUE_DECLARATIONS}declare var msg: NodeMessage;\n`);
        this.files.set(`${dir}/node-red-ts-context.d.ts`, generateContextDeclarations(input.keyTypes || EMPTY_CONTEXT_SCOPE_KEY_TYPES));
        this.files.set(`${dir}/custom-declare.d.ts`, input.declare || '');
        for (const lib of input.libs || []) {
            this.files.set(`${dir}/node-red-ts-libs/module/${lib.var}.d.ts`, generateEditorModuleDeclaration(lib));
        }

        const options: ts.CompilerOptions = {
            ...resolvedOptions,
            skipLibCheck: false,
            typeRoots: [require.resolve('@types/node/package.json').replace(/[\\/]node[\\/]package\.json$/, '')],
        };
        const files = this.files;
        this.service = ts.createLanguageService({
            getScriptFileNames: () => [...files.keys()],
            getScriptVersion: () => '1',
            getScriptSnapshot: path => {
                const text = files.get(path) ?? ts.sys.readFile(path);
                return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
            },
            getCurrentDirectory: () => dir,
            getCompilationSettings: () => options,
            getDefaultLibFileName: ts.getDefaultLibFilePath,
            fileExists: path => files.has(path) || ts.sys.fileExists(path),
            readFile: path => files.get(path) ?? ts.sys.readFile(path),
            directoryExists: path => [...files.keys()].some(file => file.startsWith(`${path}/`)) || ts.sys.directoryExists(path),
            getDirectories: ts.sys.getDirectories,
        });
    }

    diagnosticsOf(path: string): string[] {
        return [...this.service.getSyntacticDiagnostics(path), ...this.service.getSemanticDiagnostics(path)].map(diagnostic => {
            const { line, character } = diagnostic.file!.getLineAndCharacterOfPosition(diagnostic.start!);
            return `${line + 1}:${character + 1} TS${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`;
        });
    }

    bodyDiagnostics(): string[] {
        return this.diagnosticsOf(this.bodyPath);
    }

    generatedFilePaths(): string[] {
        return [...this.files.keys()].filter(path => path !== this.bodyPath);
    }

    quickInfoAt(offset: number): string | undefined {
        const quickInfo = this.service.getQuickInfoAtPosition(this.bodyPath, offset);
        return quickInfo && ts.displayPartsToString(quickInfo.displayParts);
    }
}
