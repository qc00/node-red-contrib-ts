import { ContextTypeRegistry, ContextTypeRegistrySnapshot, InferredContextSet, generateContextDeclarations, ContextScope } from '../context-types';

declare const RED: any;
declare const $: any;

/** The as-deployed context key types, overlaid with what the user has edited since. */
export class EditorContextTypeStore {
    private registry = new ContextTypeRegistry();
    private checkpointed: ContextTypeRegistrySnapshot | undefined;

    /** Replaces the registry with the server's, unless the server has since deployed other flows than the editor holds. */
    refresh() {
        $.getJSON('typescript-node/context-types').done((snapshot: ContextTypeRegistrySnapshot) => {
            const editorRev = RED.nodes.version();
            if (snapshot.rev && editorRev && snapshot.rev !== editorRev) return;
            this.registry = new ContextTypeRegistry(snapshot);
        });
    }

    /** Remembers the types as they are when an edit dialog opens. */
    checkpoint() {
        this.checkpointed = JSON.parse(JSON.stringify(this.registry));
    }

    /** Discards what was inferred from an edit that was cancelled. */
    rollback() {
        if (this.checkpointed) this.registry = new ContextTypeRegistry(this.checkpointed);
    }

    replaceContributor(nodeId: string, flowId: string, sets: InferredContextSet[]) {
        this.registry.replaceContributor(nodeId, flowId, sets);
    }

    declarationsFor(nodeId: string, flowId: string): string {
        return generateContextDeclarations(this.registry.keyTypesFor(nodeId, flowId));
    }
}

export interface ContextSetCallSite {
    scope: ContextScope;
    key: string;
    /** Offset of the `set` identifier. */
    setOffset: number;
}

const SET_CALL_PATTERN = /(context\s*\.\s*flow|context\s*\.\s*global|context|flow|global)\s*\.\s*set\s*\(\s*(["'`])([^"'`\\\n]*)\2\s*,/g;
const IDENTIFIER_OR_MEMBER_CHARACTER = /[\w$.]/;
const OPENING_BRACKETS = '([{<';
const CLOSING_BRACKETS = ')]}>';

function scopeOf(receiver: string): ContextScope {
    const compact = receiver.replace(/\s/g, '');
    if (compact === 'context') return 'node';
    return compact.endsWith('flow') ? 'flow' : 'global';
}

/** Finds `context|flow|global.set('<literal>', ` call sites by text; call shapes it misses are picked up at deploy. */
export function findContextSetCallSites(code: string): ContextSetCallSite[] {
    const sites: ContextSetCallSite[] = [];
    for (const match of code.matchAll(SET_CALL_PATTERN)) {
        const index = match.index!;
        if (index > 0 && IDENTIFIER_OR_MEMBER_CHARACTER.test(code[index - 1])) continue;
        if (match[2] === '`' && match[3].includes('${')) continue;
        sites.push({
            scope: scopeOf(match[1]),
            key: match[3],
            setOffset: index + match[0].search(/set\s*\(/),
        });
    }
    return sites;
}

/** Returns the index just past the bracket that closes the one at `openIndex`, or -1. */
function skipBracketed(text: string, openIndex: number): number {
    let depth = 0;
    for (let i = openIndex; i < text.length; i++) {
        const character = text[i];
        if (character === '"' || character === "'" || character === '`') {
            i = skipQuoted(text, i) - 1;
        } else if (OPENING_BRACKETS.includes(character)) {
            depth++;
        } else if (CLOSING_BRACKETS.includes(character) && !(character === '>' && text[i - 1] === '=')) {
            depth--;
            if (depth === 0) return i + 1;
        }
    }
    return -1;
}

function skipQuoted(text: string, quoteIndex: number): number {
    for (let i = quoteIndex + 1; i < text.length; i++) {
        if (text[i] === '\\') i++;
        else if (text[i] === text[quoteIndex]) return i + 1;
    }
    return text.length;
}

function splitTopLevel(text: string, separator: string): string[] {
    const parts: string[] = [];
    let partStart = 0;
    for (let i = 0; i < text.length; i++) {
        const character = text[i];
        if (character === '"' || character === "'" || character === '`') {
            i = skipQuoted(text, i) - 1;
        } else if (OPENING_BRACKETS.includes(character)) {
            const end = skipBracketed(text, i);
            if (end < 0) break;
            i = end - 1;
        } else if (character === separator) {
            parts.push(text.slice(partStart, i));
            partStart = i + 1;
        }
    }
    parts.push(text.slice(partStart));
    return parts.map(part => part.trim());
}

/**
 * Reads the value type out of the quick-info text of a `set` call resolved to `set<K, V>(key: K, value: V)`,
 * e.g. `(method) NodeRedContext<{}>.set<"p", string>(key: "p", value: string): void (+5 overloads)`.
 */
export function extractSetValueType(quickInfo: string): string | undefined {
    let memberStart = -1;
    for (let i = 0; i < quickInfo.length; i++) {
        if (OPENING_BRACKETS.includes(quickInfo[i])) {
            const end = skipBracketed(quickInfo, i);
            if (end < 0) return undefined;
            i = end - 1;
        } else if (quickInfo.startsWith('.set<', i)) {
            memberStart = i;
            break;
        }
    }
    if (memberStart < 0) return undefined;

    const typeArgumentsEnd = skipBracketed(quickInfo, memberStart + '.set'.length);
    if (typeArgumentsEnd < 0 || quickInfo[typeArgumentsEnd] !== '(') return undefined;
    const parametersEnd = skipBracketed(quickInfo, typeArgumentsEnd);
    if (parametersEnd < 0) return undefined;

    const parameters = splitTopLevel(quickInfo.slice(typeArgumentsEnd + 1, parametersEnd - 1), ',');
    if (parameters.length !== 2 || !parameters[1].startsWith('value:')) return undefined;
    return parameters[1].slice('value:'.length).replace(/\s+/g, ' ').trim();
}

/** Infers the types stored by the `set` calls in `code`, asking the editor's type checker about each call site. */
export async function inferContextSetsWithQuickInfo(
    code: string,
    quickInfoAt: (offset: number) => Promise<string | undefined>,
): Promise<InferredContextSet[]> {
    const sets: InferredContextSet[] = [];
    for (const site of findContextSetCallSites(code)) {
        const quickInfo = await quickInfoAt(site.setOffset);
        const type = quickInfo && extractSetValueType(quickInfo);
        if (type) sets.push({ scope: site.scope, key: site.key, type });
    }
    return sets;
}
