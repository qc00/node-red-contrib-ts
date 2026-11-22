import type { ContextTypeRegistrySnapshot } from '../compile/ContextTypeRegistry';
import type { TypeCheckProgressEvent, TypeCheckRequestTarget } from '../compile/DeployTypeCheckCoordinator';
import { DeployTypeChecker } from '../compile/DeployTypeChecker';
import { collectModuleTypeFiles, ModuleTypeFiles } from '../compile/ModuleTypeFileCollector';
import { TranspiledSections, transpileSections } from '../compile/NodeSectionTranspiler';
import { CompilerOptionValues, ResolvedCompilerOptions, resolveCompilerOptions } from '../compile/TsconfigCompilerOptionsResolver';
import type { TypeScriptCompiler } from './TypeScriptCompiler';
import { TypeScriptCompilerClient } from './TypeScriptCompilerClient';

export interface CompilerOptionsSummary {
    /** In the compiler's own form (enum numbers, lib file names). */
    options: CompilerOptionValues;
    /** The effective `compilerOptions` in tsconfig.json form. */
    json: Record<string, unknown>;
    warnings: string[];
}

const MAX_CACHED_TSCONFIGS = 16;

/** Everything the node asks of the TypeScript compiler. */
export class TypeScriptCompilerService {
    private readonly typeChecker: DeployTypeChecker;
    private resolvedByText = new Map<string, Promise<ResolvedCompilerOptions>>();

    constructor(private readonly client: TypeScriptCompilerClient, private readonly userDir: string) {
        this.typeChecker = new DeployTypeChecker(userDir);
    }

    /** A node cannot run without its JavaScript, so a failure is tried once more with a new compiler process. */
    async transpile(sources: string[], tsconfig: string | undefined): Promise<TranspiledSections> {
        const attempt = () => this.client.use(async compiler =>
            transpileSections(compiler, sources, (await this.resolve(compiler, tsconfig)).emitOptions));
        try {
            return await attempt();
        } catch {
            this.client.restart();
            return attempt();
        }
    }

    resolveCompilerOptions(tsconfig: string | undefined): Promise<CompilerOptionsSummary> {
        return this.client.use(async compiler => {
            const { options, json, warnings } = await this.resolve(compiler, tsconfig);
            return { options, json, warnings };
        });
    }

    collectModuleTypes(moduleName: string): Promise<ModuleTypeFiles> {
        return this.client.use(compiler => collectModuleTypeFiles(compiler, moduleName, this.userDir));
    }

    typeCheck(
        rev: string | undefined,
        targets: TypeCheckRequestTarget[],
        progress: (event: TypeCheckProgressEvent) => void,
    ): Promise<ContextTypeRegistrySnapshot> {
        return this.client.use(async compiler => this.typeChecker.check(
            compiler,
            rev,
            await Promise.all(targets.map(async target => ({
                instanceId: target.instanceId,
                definition: target.definition,
                compilerOptions: await this.resolve(compiler, target.tsconfig),
            }))),
            {
                info: message => progress({ kind: 'info', message }),
                nodeLog: (instanceId, message) => progress({ kind: 'nodeLog', instanceId, message }),
                nodeWarn: (instanceId, message) => progress({ kind: 'nodeWarn', instanceId, message }),
                nodeReport: (instanceId, message) => progress({ kind: 'nodeReport', instanceId, message }),
            },
        ));
    }

    private resolve(compiler: TypeScriptCompiler, tsconfig: string | undefined): Promise<ResolvedCompilerOptions> {
        const text = tsconfig || '';
        let resolved = this.resolvedByText.get(text);
        if (!resolved) {
            if (this.resolvedByText.size >= MAX_CACHED_TSCONFIGS) this.resolvedByText.clear();
            resolved = resolveCompilerOptions(compiler, text, this.userDir);
            resolved.catch(() => this.resolvedByText.delete(text));
            this.resolvedByText.set(text, resolved);
        }
        return resolved;
    }
}
