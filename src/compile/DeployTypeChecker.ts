import * as path from 'path';
import type { Program, Snapshot } from 'typescript/async';
import type { TypeScriptCompiler } from '../compiler/TypeScriptCompiler';
import { EMPTY_CONTEXT_SCOPE_KEY_TYPES, generateContextDeclarations } from '../env/ContextTypeDeclarationGenerator';
import { NODE_RED_ENV_DECLARATION_FILE_NAME, NODE_RED_ENV_DECLARATION_SOURCE } from '../env/NodeRedEnvDeclarationSource';
import { inferContextSets } from './ContextSetCallInferrer';
import { ModuleSpecifierExtensionRestorer } from './ModuleSpecifierExtensionRestorer';
import { ContextTypeRegistry, ContextTypeRegistryEntry, ContextTypeRegistrySnapshot } from './ContextTypeRegistry';
import { buildNodeVirtualSource, NodeSourceDefinition, NodeVirtualSource } from './NodeVirtualSourceBuilder';
import { CompilerOptionValues, ResolvedCompilerOptions } from './TsconfigCompilerOptionsResolver';

export interface TypeCheckTarget {
    /** Unique per running node; several subflow instances share one definition id. */
    instanceId: string;
    definition: NodeSourceDefinition;
    compilerOptions: ResolvedCompilerOptions;
}

/** Receives what a check finds while it runs, so progress is visible before a long batch ends. */
export interface TypeCheckProgressSink {
    info(message: string): void;
    nodeLog(instanceId: string, message: string): void;
    nodeWarn(instanceId: string, message: string): void;
    /** The node's problems as one text; empty when it has none. */
    nodeReport(instanceId: string, report: string): void;
}

/** The nodes that share compiler options, and so one program. */
interface TypeCheckGroup {
    options: CompilerOptionValues;
    targets: TypeCheckTarget[];
}

interface WrittenNodeSource {
    target: TypeCheckTarget;
    path: string;
    source: NodeVirtualSource;
}

interface WrittenSources {
    files: [string, string][];
    rootFilesOf: Map<TypeCheckGroup, string[]>;
    nodesOf: Map<TypeCheckGroup, WrittenNodeSource[]>;
}

const VIRTUAL_DIRECTORY_NAME = '__node-red-contrib-ts__';
const CONTEXT_VALIDATION_FILE_NAME = '__context-types.mts';
const UNUSED_DECLARATION_CODES = [6133, 6196];

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

function megabytes(bytes: number): string {
    return (bytes / 1048576).toFixed(1);
}

/** Type-checks a set of typescript nodes and derives the context key types from their `set` calls. */
export class DeployTypeChecker {
    private readonly directory: string;
    private readonly typeRoots: string[];

    constructor(userDir: string) {
        const root = path.resolve(userDir).replace(/\\/g, '/');
        this.directory = `${root}/${VIRTUAL_DIRECTORY_NAME}`;
        const bundled = bundledTypeRoot();
        this.typeRoots = [`${root}/node_modules/@types`, ...(bundled ? [bundled] : [])];
    }

    async check(
        compiler: TypeScriptCompiler,
        rev: string | undefined,
        targets: TypeCheckTarget[],
        sink: TypeCheckProgressSink,
    ): Promise<ContextTypeRegistrySnapshot> {
        const startedAt = Date.now();
        const groups = this.groupTargets(targets);
        sink.info(`TypeScript type check: starting for ${targets.length} node(s) in ${groups.length} program(s)`);

        const registry = new ContextTypeRegistry();
        registry.rev = rev;
        const snapshots: Snapshot[] = [];
        try {
            const emptyDeclarations = generateContextDeclarations(EMPTY_CONTEXT_SCOPE_KEY_TYPES);
            const inferenceSources = this.writeSources(groups, () => emptyDeclarations);
            const loadStartedAt = Date.now();
            const inferenceSnapshot = await compiler.api.createSnapshot({
                fileSystem: compiler.fs.createFileSystemLayer(inferenceSources.files),
                createPrograms: groups.map(group => ({
                    rootFiles: inferenceSources.rootFilesOf.get(group)!,
                    compilerOptions: group.options,
                })),
            });
            snapshots.push(inferenceSnapshot);
            const programs: Program[] = [...(inferenceSnapshot.operation.createdPrograms || [])];
            const fileNames = await Promise.all(programs.map(program => program.getSourceFileNames()));
            sink.info(`TypeScript type check: loaded ${fileNames.map(names => names.length).join(' + ')} source file(s) in ${Date.now() - loadStartedAt}ms`);

            for (const [index, group] of groups.entries()) {
                const program = programs[index];
                const checker = program.getProject().checker;
                const specifiers = new ModuleSpecifierExtensionRestorer(fileNames[index]);
                for (const { target, path: filePath, source } of inferenceSources.nodesOf.get(group)!) {
                    const inferenceStartedAt = Date.now();
                    const sourceFile = await program.getSourceFile(filePath);
                    if (!sourceFile) continue;
                    registry.replaceContributor(
                        target.definition.id,
                        target.definition.flowId,
                        await inferContextSets(compiler, checker, sourceFile, source, specifiers),
                    );
                    sink.nodeLog(target.instanceId, `Inferred context types in ${Date.now() - inferenceStartedAt}ms`);
                }
            }

            const entries = registry.entries();
            const nonPortable = new Map<ContextTypeRegistryEntry, string>();
            const validationPath = `${this.directory}/${CONTEXT_VALIDATION_FILE_NAME}`;
            const checkSources = this.writeSources(
                groups,
                definition => generateContextDeclarations(registry.keyTypesFor(definition.id, definition.flowId)),
                { [validationPath]: contextValidationSource(entries) },
            );
            const applyStartedAt = Date.now();
            const checkSnapshot = await inferenceSnapshot.update({
                fileSystem: compiler.fs.createFileSystemLayer(checkSources.files),
                reconfigurePrograms: groups.map((group, index) => ({
                    id: programs[index].getProject().id as any,
                    rootFiles: checkSources.rootFilesOf.get(group)!,
                    compilerOptions: group.options,
                })),
            });
            snapshots.push(checkSnapshot);
            sink.info(`TypeScript type check: applied the inferred context types in ${Date.now() - applyStartedAt}ms`);

            let nodeCount = 0;
            for (const [index, group] of groups.entries()) {
                const program = checkSnapshot.getProgram(programs[index].getProject().id);
                if (!program) throw new Error('The compiler lost a program between the two passes of the type check');

                for (const diagnostic of await program.getSemanticDiagnostics(validationPath)) {
                    if (UNUSED_DECLARATION_CODES.includes(diagnostic.code)) continue;
                    const entry = entries[(diagnostic.startPosition?.line ?? 0) - 1];
                    if (entry && !nonPortable.has(entry)) nonPortable.set(entry, diagnostic.text);
                }

                for (const { target, path: filePath, source } of checkSources.nodesOf.get(group)!) {
                    const checkStartedAt = Date.now();
                    const problems: string[] = [];
                    const diagnostics = [
                        ...await program.getSyntacticDiagnostics(filePath),
                        ...await program.getSemanticDiagnostics(filePath),
                    ];
                    for (const diagnostic of diagnostics) {
                        const location = source.locate(diagnostic.pos);
                        if (!location) continue;
                        problems.push(`[${location.section} ${location.line}:${location.column}] TS${diagnostic.code}: ${diagnostic.text}`);
                    }
                    sink.nodeReport(
                        target.instanceId,
                        problems.length ? `TypeScript type check found ${problems.length} problem(s):\n${problems.join('\n')}` : '',
                    );
                    sink.nodeLog(target.instanceId, `Type-checked in ${Date.now() - checkStartedAt}ms, ${problems.length} problem(s)`);
                    nodeCount++;
                }
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

            const memory = await compiler.residentMemory();
            sink.info(
                `TypeScript type check: finished ${nodeCount} node(s), ${groups.length} program(s), ${Date.now() - startedAt}ms`
                + (memory === undefined ? '' : `, compiler process peak memory ${megabytes(memory)}MB`),
            );
            return registry.toJSON();
        } finally {
            await Promise.all(snapshots.map(snapshot => snapshot.dispose().catch(() => {})));
        }
    }

    private groupTargets(targets: TypeCheckTarget[]): TypeCheckGroup[] {
        const groups = new Map<string, TypeCheckGroup>();
        for (const target of targets) {
            let group = groups.get(target.compilerOptions.key);
            if (!group) {
                group = { options: { typeRoots: this.typeRoots, ...target.compilerOptions.options }, targets: [] };
                groups.set(target.compilerOptions.key, group);
            }
            group.targets.push(target);
        }
        return [...groups.values()];
    }

    /** The in-memory files of one pass: the shared declarations, each node's module, and any extra files, per group. */
    private writeSources(
        groups: TypeCheckGroup[],
        contextDeclarationsOf: (definition: NodeSourceDefinition) => string,
        extraFiles: Record<string, string> = {},
    ): WrittenSources {
        const environmentPath = `${this.directory}/${NODE_RED_ENV_DECLARATION_FILE_NAME}`;
        const files = new Map<string, string>([[environmentPath, NODE_RED_ENV_DECLARATION_SOURCE], ...Object.entries(extraFiles)]);
        const rootFilesOf = new Map<TypeCheckGroup, string[]>();
        const nodesOf = new Map<TypeCheckGroup, WrittenNodeSource[]>();
        for (const group of groups) {
            const nodes: WrittenNodeSource[] = [];
            for (const target of group.targets) {
                const filePath = `${this.directory}/${nodeFileName(target.definition.id)}`;
                const source = buildNodeVirtualSource(target.definition, contextDeclarationsOf(target.definition));
                files.set(filePath, source.text);
                nodes.push({ target, path: filePath, source });
            }
            // Subflow instances share a definition, and so a file.
            const nodePaths = [...new Set(nodes.map(node => node.path))];
            rootFilesOf.set(group, [environmentPath, ...Object.keys(extraFiles), ...nodePaths]);
            nodesOf.set(group, nodes);
        }
        return { files: [...files], rootFilesOf, nodesOf };
    }
}
