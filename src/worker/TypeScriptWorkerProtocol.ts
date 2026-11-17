import type { ContextTypeRegistrySnapshot } from '../compile/ContextTypeRegistry';
import type { ModuleTypeFiles } from '../compile/ModuleTypeFileCollector';
import type { TranspiledSections } from '../compile/NodeSectionTranspiler';
import type { NodeSourceDefinition } from '../compile/NodeVirtualSourceBuilder';

export interface TypeCheckRequestTarget {
    /** Unique per running node; several subflow instances share one definition id. */
    instanceId: string;
    definition: NodeSourceDefinition;
    tsconfig: string | undefined;
    persistentService: boolean;
}

export interface CompilerOptionsSummary {
    /** In the compiler's own form (enum numbers, lib file names). */
    options: Record<string, unknown>;
    /** The effective `compilerOptions` in tsconfig.json form. */
    json: Record<string, unknown>;
    warnings: string[];
}

export interface TypeScriptWorkerRequests {
    transpile: { sources: string[]; tsconfig: string | undefined };
    resolveCompilerOptions: { tsconfig: string | undefined };
    collectModuleTypes: { module: string };
    typeCheck: { rev: string | undefined; targets: TypeCheckRequestTarget[] };
}

export interface TypeScriptWorkerResults {
    transpile: TranspiledSections;
    resolveCompilerOptions: CompilerOptionsSummary;
    collectModuleTypes: ModuleTypeFiles;
    typeCheck: ContextTypeRegistrySnapshot;
}

export type TypeScriptWorkerRequestKind = keyof TypeScriptWorkerRequests;

export type TypeCheckProgressEvent =
    | { kind: 'info'; message: string }
    | { kind: 'nodeLog' | 'nodeWarn' | 'nodeReport'; instanceId: string; message: string };

export interface TypeScriptWorkerRequestMessage<K extends TypeScriptWorkerRequestKind = TypeScriptWorkerRequestKind> {
    id: number;
    kind: K;
    payload: TypeScriptWorkerRequests[K];
}

export type TypeScriptWorkerReplyMessage =
    | { type: 'ready' }
    | { type: 'result'; id: number; result: unknown }
    | { type: 'error'; id: number; message: string }
    | { type: 'progress'; id: number; event: TypeCheckProgressEvent };

export interface TypeScriptWorkerData {
    userDir: string;
}
