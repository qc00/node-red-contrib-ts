import { DeployTypeChecker } from '../compile/DeployTypeChecker';
import { collectModuleTypeFiles } from '../compile/ModuleTypeFileCollector';
import { transpileSections } from '../compile/NodeSectionTranspiler';
import { ResolvedCompilerOptions, resolveCompilerOptions } from '../compile/TsconfigCompilerOptionsResolver';
import {
    TypeCheckProgressEvent,
    TypeScriptWorkerRequestKind,
    TypeScriptWorkerRequests,
    TypeScriptWorkerResults,
} from './TypeScriptWorkerProtocol';

const MAX_CACHED_TSCONFIGS = 16;

/** Everything that needs the `typescript` package, addressed by request kind. */
export class TypeScriptWorkerRequestHandler {
    private readonly typeChecker: DeployTypeChecker;
    private resolvedByText = new Map<string, ResolvedCompilerOptions>();

    constructor(private readonly userDir: string) {
        this.typeChecker = new DeployTypeChecker(userDir);
    }

    async handle<K extends TypeScriptWorkerRequestKind>(
        kind: K,
        payload: TypeScriptWorkerRequests[K],
        progress: (event: TypeCheckProgressEvent) => void,
    ): Promise<TypeScriptWorkerResults[K]> {
        const handlers: { [P in TypeScriptWorkerRequestKind]: (payload: TypeScriptWorkerRequests[P]) => TypeScriptWorkerResults[P] | Promise<TypeScriptWorkerResults[P]> } = {
            transpile: ({ sources, tsconfig }) => transpileSections(sources, this.resolve(tsconfig).emitOptions),
            resolveCompilerOptions: ({ tsconfig }) => {
                const { options, json, warnings } = this.resolve(tsconfig);
                return { options: options as Record<string, unknown>, json, warnings };
            },
            collectModuleTypes: ({ module }) => collectModuleTypeFiles(module, this.userDir),
            typeCheck: ({ rev, targets }) => this.typeChecker.check(
                rev,
                targets.map(target => ({
                    instanceId: target.instanceId,
                    definition: target.definition,
                    compilerOptions: this.resolve(target.tsconfig),
                    persistentService: target.persistentService,
                })),
                {
                    info: message => progress({ kind: 'info', message }),
                    nodeLog: (instanceId, message) => progress({ kind: 'nodeLog', instanceId, message }),
                    nodeWarn: (instanceId, message) => progress({ kind: 'nodeWarn', instanceId, message }),
                    nodeReport: (instanceId, message) => progress({ kind: 'nodeReport', instanceId, message }),
                },
            ),
        };
        return handlers[kind](payload);
    }

    private resolve(tsconfig: string | undefined): ResolvedCompilerOptions {
        const text = tsconfig || '';
        let resolved = this.resolvedByText.get(text);
        if (!resolved) {
            if (this.resolvedByText.size >= MAX_CACHED_TSCONFIGS) this.resolvedByText.clear();
            resolved = resolveCompilerOptions(text, this.userDir);
            this.resolvedByText.set(text, resolved);
        }
        return resolved;
    }
}
