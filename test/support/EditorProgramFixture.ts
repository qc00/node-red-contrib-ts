import ts from 'typescript';
import { resolveCompilerOptions } from '../../src/compile/TsconfigCompilerOptionsResolver';
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

/** Reproduces what the editor hands to Monaco: a bare script body plus the generated declaration files. */
export class EditorProgramFixture {
    readonly bodyPath: string;
    readonly service: ts.LanguageService;
    private files = new Map<string, string>();

    constructor(input: EditorProgramInput) {
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
            ...resolveCompilerOptions(input.tsconfig, dir).options,
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
