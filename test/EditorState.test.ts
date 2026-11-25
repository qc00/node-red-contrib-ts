import assert from 'node:assert/strict';
import { afterEach, beforeEach, it } from 'node:test';
import { EditorContextTypeStore } from '../src/editor/context-types';

let pending: ((snapshot: any) => void)[] = [];
beforeEach(() => {
    pending = [];
    (globalThis as any).$ = { getJSON: () => ({ done: (callback: any) => pending.push(callback) }) };
    (globalThis as any).RED = { nodes: { version: () => 'rev' } };
});
afterEach(() => { delete (globalThis as any).$; delete (globalThis as any).RED; });

const snapshot = (types: Record<string, string>) => ({
    rev: 'rev',
    node: {},
    flow: { f: Object.fromEntries(Object.entries(types).map(([key, type]) => [key, { server: type }])) },
    global: {},
});

it('applies a server answer that arrived during an edit once the dialog is saved, keeping the edit', () => {
    const store = new EditorContextTypeStore();
    store.refresh();
    store.checkpoint();
    store.replaceContributor('edited', 'f', [{ scope: 'flow', key: 'mine', type: 'number' }]);
    pending.shift()!(snapshot({ deployed: 'string' }));
    assert.doesNotMatch(store.declarationsFor('edited', 'f'), /"deployed"/, 'not while the dialog is open');
    store.commit();
    assert.match(store.declarationsFor('edited', 'f'), /"deployed": string; "mine": number;/);
});

it('applies a server answer after a cancelled edit, without the cancelled edit', () => {
    const store = new EditorContextTypeStore();
    store.refresh();
    store.checkpoint();
    store.replaceContributor('edited', 'f', [{ scope: 'flow', key: 'mine', type: 'number' }]);
    store.rollback();
    pending.shift()!(snapshot({ deployed: 'string' }));
    assert.match(store.declarationsFor('edited', 'f'), /"deployed": string/);
    assert.doesNotMatch(store.declarationsFor('edited', 'f'), /"mine"/);
});

it('keeps edits saved after the refresh was requested and drops those it supersedes', () => {
    const store = new EditorContextTypeStore();
    store.replaceContributor('before', 'f', [{ scope: 'flow', key: 'old', type: 'boolean' }]);
    store.refresh();
    store.checkpoint();
    store.replaceContributor('after', 'f', [{ scope: 'flow', key: 'mine', type: 'number' }]);
    store.commit();
    pending.shift()!(snapshot({ deployed: 'string' }));
    assert.match(store.declarationsFor('after', 'f'), /"deployed": string; "mine": number;/);
    assert.doesNotMatch(store.declarationsFor('after', 'f'), /"old"/);
});

it('only applies the answer to the newest refresh', () => {
    const store = new EditorContextTypeStore();
    store.refresh();
    store.refresh();
    pending.pop()!(snapshot({ key: 'number' }));
    pending.pop()!(snapshot({ key: 'string' }));
    assert.match(store.declarationsFor('n', 'f'), /"key": number/);
});
