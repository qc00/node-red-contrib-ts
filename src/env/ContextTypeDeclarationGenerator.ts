export type ContextKeyTypes = Record<string, string>;

export interface ContextScopeKeyTypes {
    node: ContextKeyTypes;
    flow: ContextKeyTypes;
    global: ContextKeyTypes;
}

export const EMPTY_CONTEXT_SCOPE_KEY_TYPES: ContextScopeKeyTypes = { node: {}, flow: {}, global: {} };

function keyMapType(keyTypes: ContextKeyTypes): string {
    const members = Object.keys(keyTypes).sort().map(key => `${JSON.stringify(key)}: ${keyTypes[key]};`);
    return members.length ? `{ ${members.join(' ')} }` : '{}';
}

/** Declares `context`, `flow` and `global` with the key→type maps visible to one node. */
export function generateContextDeclarations(scopes: ContextScopeKeyTypes): string {
    const flowType = `NodeRedContext<${keyMapType(scopes.flow)}>`;
    const globalType = `NodeRedContext<${keyMapType(scopes.global)}>`;
    return [
        `declare const context: NodeRedContext<${keyMapType(scopes.node)}> & { flow: ${flowType}; global: ${globalType} };`,
        `declare const flow: ${flowType};`,
        `declare const global: ${globalType};`,
        '',
    ].join('\n');
}
