import { ContextKeyTypes, ContextScopeKeyTypes } from '../env/ContextTypeDeclarationGenerator';

export type ContextScope = 'node' | 'flow' | 'global';

export interface InferredContextSet {
    scope: ContextScope;
    key: string;
    type: string;
}

/** key → contributing node id → type text of everything that node stores under the key */
export type ContextContributions = Record<string, Record<string, string>>;

export interface ContextTypeRegistrySnapshot {
    rev?: string;
    node: Record<string, ContextContributions>;
    flow: Record<string, ContextContributions>;
    global: ContextContributions;
}

export interface ContextTypeRegistryEntry {
    scope: ContextScope;
    scopeId: string;
    key: string;
    contributorId: string;
    type: string;
}

const NON_PORTABLE_TYPE = 'any';

function unionOf(types: string[]): string {
    const distinct = [...new Set(types)];
    return distinct.length === 1 ? distinct[0] : distinct.map(type => `(${type})`).join(' | ');
}

function keyTypesOf(contributions: ContextContributions | undefined): ContextKeyTypes {
    const result: ContextKeyTypes = {};
    for (const key of Object.keys(contributions || {})) {
        const types = Object.values(contributions![key]);
        if (types.length) result[key] = unionOf(types);
    }
    return result;
}

function removeContributor(contributions: ContextContributions | undefined, contributorId: string) {
    for (const key of Object.keys(contributions || {})) {
        delete contributions![key][contributorId];
        if (!Object.keys(contributions![key]).length) delete contributions![key];
    }
}

export class ContextTypeRegistry {
    private snapshot: ContextTypeRegistrySnapshot;

    constructor(snapshot?: ContextTypeRegistrySnapshot) {
        this.snapshot = snapshot
            ? JSON.parse(JSON.stringify(snapshot))
            : { node: {}, flow: {}, global: {} };
    }

    get rev(): string | undefined { return this.snapshot.rev; }
    set rev(rev: string | undefined) { this.snapshot.rev = rev; }

    private contributionsOf(scope: ContextScope, scopeId: string, create: boolean): ContextContributions | undefined {
        if (scope === 'global') return this.snapshot.global;
        const byScopeId = this.snapshot[scope];
        if (!byScopeId[scopeId] && create) byScopeId[scopeId] = {};
        return byScopeId[scopeId];
    }

    /** Replaces everything `contributorId` (a node on flow `flowId`) stores in any scope. */
    replaceContributor(contributorId: string, flowId: string, sets: InferredContextSet[]) {
        delete this.snapshot.node[contributorId];
        removeContributor(this.snapshot.flow[flowId], contributorId);
        removeContributor(this.snapshot.global, contributorId);

        const typesByTarget = new Map<string, { scope: ContextScope; key: string; types: string[] }>();
        for (const set of sets) {
            const targetId = `${set.scope}\n${set.key}`;
            const target = typesByTarget.get(targetId) || { scope: set.scope, key: set.key, types: [] };
            target.types.push(set.type);
            typesByTarget.set(targetId, target);
        }
        for (const { scope, key, types } of typesByTarget.values()) {
            const scopeId = scope === 'node' ? contributorId : flowId;
            const contributions = this.contributionsOf(scope, scopeId, true)!;
            (contributions[key] ||= {})[contributorId] = unionOf(types);
        }
    }

    keyTypesFor(nodeId: string, flowId: string): ContextScopeKeyTypes {
        return {
            node: keyTypesOf(this.snapshot.node[nodeId]),
            flow: keyTypesOf(this.snapshot.flow[flowId]),
            global: keyTypesOf(this.snapshot.global),
        };
    }

    entries(): ContextTypeRegistryEntry[] {
        const result: ContextTypeRegistryEntry[] = [];
        const collect = (scope: ContextScope, scopeId: string, contributions: ContextContributions) => {
            for (const key of Object.keys(contributions)) {
                for (const contributorId of Object.keys(contributions[key])) {
                    result.push({ scope, scopeId, key, contributorId, type: contributions[key][contributorId] });
                }
            }
        };
        for (const nodeId of Object.keys(this.snapshot.node)) collect('node', nodeId, this.snapshot.node[nodeId]);
        for (const flowId of Object.keys(this.snapshot.flow)) collect('flow', flowId, this.snapshot.flow[flowId]);
        collect('global', '', this.snapshot.global);
        return result;
    }

    /** Marks a type that other nodes cannot resolve as untyped. */
    downgrade(entry: ContextTypeRegistryEntry) {
        const contributions = this.contributionsOf(entry.scope, entry.scopeId, false);
        if (contributions?.[entry.key]?.[entry.contributorId] !== undefined) {
            contributions[entry.key][entry.contributorId] = NON_PORTABLE_TYPE;
        }
    }

    toJSON(): ContextTypeRegistrySnapshot {
        return this.snapshot;
    }
}
