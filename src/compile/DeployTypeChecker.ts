import ts from 'typescript';
import * as path from 'path';
import { EMPTY_CONTEXT_SCOPE_KEY_TYPES, generateContextDeclarations } from '../env/ContextTypeDeclarationGenerator';
import { NODE_RED_ENV_DECLARATION_FILE_NAME, NODE_RED_ENV_DECLARATION_SOURCE } from '../env/NodeRedEnvDeclarationSource';
import { inferContextSets } from './ContextSetCallInferrer';
import { ContextTypeRegistry, ContextTypeRegistryEntry, ContextTypeRegistrySnapshot } from './ContextTypeRegistry';
import { buildNodeVirtualSource, NodeSourceDefinition, NodeVirtualSource } from './NodeVirtualSourceBuilder';
import { ResolvedCompilerOptions } from './TsconfigCompilerOptionsResolver';
import {
    OneShotTypeCheckProgramProvider,
    PersistentTypeCheckProgramProvider,
    TypeCheckProgramProvider,
    VirtualSourceFileSet,
} from './TypeCheckProgramProvider';

export interface TypeCheckTarget {
    /** Unique per running node; several subflow instances share one definition id. */
    instanceId: string;
    definition: NodeSourceDefinition;
    compilerOptions: ResolvedCompilerOptions;
    persistentService: boolean;
}

/** Receives what a check finds while it runs, so progress is visible before a long batch ends. */
export interface TypeCheckProgressSink {
    info(message: string): void;
    nodeLog(instanceId: string, message: string): void;
    nodeWarn(instanceId: string, message: string): void;
    /** The node's problems as one text; empty when it has none. */
    nodeReport(instanceId: string, report: string): void;
}

interface TypeCheckGroup {
    provider: TypeCheckProgramProvider;
    targets: TypeCheckTarget[];
}

const VIRTUAL_DIRECTORY_NAME = '__node-red-contrib-ts__';
const CONTEXT_VALIDATION_FILE_NAME = '__context-types.mts';
const UNUSED_DECLARATION_CODES = [6133, 6196];

const yieldToEventLoop = () => new Promise<void>(resolve => setImmediate(resolve));

function nodeFileName(nodeId: string): string {
    return `${nodeId.replace(/[^\w.-]/g, '_')}.mts`;
}

function bundledTypeRoot(): string | undefined {
    try {
        return path.dirname(path.dirname(require.resolve('@types/node/package.json'))).replace(/\\/g, '/');
    } catch {
        return undefined;
    }
}

function contextValidationSource(entries: ContextTypeRegistryEntry[]): string {
    return 'export {};\n' + entries.map((entry, index) => `type __ctx${index} = ${entry.type};\n`).join('');
}

/** Type-checks a set of typescript nodes and derives the context key types from their `set` calls. */
export class DeployTypeChecker {
    private persistentProviders = new Map<string, TypeCheckProgramProvider>();
    private readonly userDir: string;
    private readonly typeRoots: string[];

    constructor(userDir: string) {
        this.userDir = path.resolve(userDir).replace(/\\/g, '/');
        const bundled = bundledTypeRoot();
        this.typeRoots = [`${this.userDir}/node_modules/@types`, ...(bundled ? [bundled] : [])];
    }

    private createProvider(target: TypeCheckTarget): TypeCheckProgramProvider {
        const options: ts.CompilerOptions = { typeRoots: this.typeRoots, ...target.compilerOptions.options };
        const files = new VirtualSourceFileSet(`${this.userDir}/${VIRTUAL_DIRECTORY_NAME}`);
        return target.persistentService
            ? new PersistentTypeCheckProgramProvider(files, options, this.userDir)
            : new OneShotTypeCheckProgramProvider(files, options, this.userDir);
    }

    private groupTargets(targets: TypeCheckTarget[]): TypeCheckGroup[] {
        const groups = new Map<string, TypeCheckGroup>();
        const persistentInUse = new Map<string, TypeCheckProgramProvider>();
        for (const target of targets) {
            const key = `${target.persistentService ? 'persistent' : 'one-shot'}:${target.compilerOptions.key}`;
            let group = groups.get(key);
            if (!group) {
                const provider = this.persistentProviders.get(key) ?? this.createProvider(target);
                if (target.persistentService) persistentInUse.set(key, provider);
                group = { provider, targets: [] };
                groups.set(key, group);
            }
            group.targets.push(target);
        }
        for (const [key, provider] of this.persistentProviders) {
            if (!persistentInUse.has(key)) provider.dispose();
        }
        this.persistentProviders = persistentInUse;
        return [...groups.values()];
    }

    /** Writes the group's sources into its file set and returns each node's source by path. */
    private writeSources(
        group: TypeCheckGroup,
        contextDeclarationsOf: (definition: NodeSourceDefinition) => string,
        extraFiles: Record<string, string> = {},
    ): Map<TypeCheckTarget, { path: string; source: NodeVirtualSource }> {
        const files = group.provider.files;
        const written = new Map<TypeCheckTarget, { path: string; source: NodeVirtualSource }>();
        const paths = new Set<string>();
        const write = (fileName: string, text: string) => {
            const filePath = files.pathOf(fileName);
            files.set(filePath, text);
            paths.add(filePath);
            return filePath;
        };
        write(NODE_RED_ENV_DECLARATION_FILE_NAME, NODE_RED_ENV_DECLARATION_SOURCE);
        for (const fileName of Object.keys(extraFiles)) write(fileName, extraFiles[fileName]);
        for (const target of group.targets) {
            const source = buildNodeVirtualSource(target.definition, contextDeclarationsOf(target.definition));
            written.set(target, { path: write(nodeFileName(target.definition.id), source.text), source });
        }
        files.retainOnly(paths);
        return written;
    }

    async check(rev: string | undefined, targets: TypeCheckTarget[], sink: TypeCheckProgressSink): Promise<ContextTypeRegistrySnapshot> {
        const startedAt = Date.now();
        const heapBefore = process.memoryUsage().heapUsed;
        let heapPeak = heapBefore;
        const sampleHeap = () => { heapPeak = Math.max(heapPeak, process.memoryUsage().heapUsed); };

        const groups = this.groupTargets(targets);
        sink.info(`TypeScript type check: starting for ${targets.length} node(s) in ${groups.length} program(s)`);
        const registry = new ContextTypeRegistry();
        registry.rev = rev;
        const emptyDeclarations = generateContextDeclarations(EMPTY_CONTEXT_SCOPE_KEY_TYPES);

        for (const group of groups) {
            const written = this.writeSources(group, () => emptyDeclarations);
            const programStartedAt = Date.now();
            const program = group.provider.open().getProgram()!;
            const checker = program.getTypeChecker();
            sink.info(
                `TypeScript type check: loaded ${program.getSourceFiles().length} source file(s) `
                + `for ${group.targets.length} node(s) in ${Date.now() - programStartedAt}ms`,
            );
            for (const [target, { path: filePath, source }] of written) {
                const sourceFile = program.getSourceFile(filePath);
                if (!sourceFile) continue;
                const inferenceStartedAt = Date.now();
                registry.replaceContributor(
                    target.definition.id,
                    target.definition.flowId,
                    inferContextSets(checker, sourceFile, source),
                );
                sink.nodeLog(target.instanceId, `Inferred context types in ${Date.now() - inferenceStartedAt}ms`);
                await yieldToEventLoop();
            }
            sampleHeap();
            if (groups.length > 1) group.provider.close();
            await yieldToEventLoop();
        }

        const entries = registry.entries();
        const nonPortable = new Map<ContextTypeRegistryEntry, string>();
        let nodeCount = 0;

        for (const group of groups) {
            const written = this.writeSources(
                group,
                definition => generateContextDeclarations(registry.keyTypesFor(definition.id, definition.flowId)),
                { [CONTEXT_VALIDATION_FILE_NAME]: contextValidationSource(entries) },
            );
            const service = group.provider.open();

            const validationPath = group.provider.files.pathOf(CONTEXT_VALIDATION_FILE_NAME);
            const validationStartedAt = Date.now();
            const validationDiagnostics = service.getSemanticDiagnostics(validationPath);
            sink.info(
                `TypeScript type check: applied the inferred context types to ${group.targets.length} node(s) `
                + `in ${Date.now() - validationStartedAt}ms`,
            );
            for (const diagnostic of validationDiagnostics) {
                if (diagnostic.start === undefined || !diagnostic.file) continue;
                if (UNUSED_DECLARATION_CODES.includes(diagnostic.code)) continue;
                const line = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line;
                const entry = entries[line - 1];
                if (entry && !nonPortable.has(entry)) {
                    nonPortable.set(entry, ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '));
                }
            }

            for (const [target, { path: filePath, source }] of written) {
                const checkStartedAt = Date.now();
                const problems: string[] = [];
                const diagnostics = [...service.getSyntacticDiagnostics(filePath), ...service.getSemanticDiagnostics(filePath)];
                for (const diagnostic of diagnostics) {
                    const location = diagnostic.start === undefined ? undefined : source.locate(diagnostic.start);
                    if (!location) continue;
                    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n  ');
                    problems.push(`[${location.section} ${location.line}:${location.column}] TS${diagnostic.code}: ${message}`);
                }
                const report = problems.length
                    ? `TypeScript type check found ${problems.length} problem(s):\n${problems.join('\n')}`
                    : '';
                sink.nodeReport(target.instanceId, report);
                sink.nodeLog(target.instanceId, `Type-checked in ${Date.now() - checkStartedAt}ms, ${problems.length} problem(s)`);
                nodeCount++;
                await yieldToEventLoop();
            }
            sampleHeap();
            group.provider.close();
        }

        for (const [entry, reason] of nonPortable) {
            registry.downgrade(entry);
            const scopeLabel = entry.scope === 'node' ? 'context' : entry.scope;
            const message = `The type stored under ${scopeLabel} key "${entry.key}" cannot be named outside this node, `
                + `so other nodes read it as any (${reason})`;
            for (const target of targets) {
                if (target.definition.id === entry.contributorId) sink.nodeWarn(target.instanceId, message);
            }
        }

        const megabytes = (bytes: number) => (bytes / 1048576).toFixed(1);
        sink.info(
            `TypeScript type check: finished ${nodeCount} node(s), ${groups.length} program(s), ${Date.now() - startedAt}ms, `
            + `heap used ${megabytes(heapBefore)}MB before, ${megabytes(heapPeak)}MB at peak (before garbage collection)`,
        );
        return registry.toJSON();
    }
}
