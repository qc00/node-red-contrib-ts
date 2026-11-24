import assert from 'node:assert/strict';
import { it } from 'node:test';
import { EditorContextTypeStore } from '../src/editor/context-types';

it('ignores refreshes that arrive after editing, cancellation or a newer refresh', () => {
    const pending: ((snapshot: any) => void)[] = [];
    (globalThis as any).$ = { getJSON: () => ({ done: (callback: any) => pending.push(callback) }) };
    (globalThis as any).RED = { nodes: { version: () => 'rev' } };
    const snapshot = (type: string) => ({ rev: 'rev', node: { n: { key: { n: type } } }, flow: {}, global: {} });
    try {
        const store = new EditorContextTypeStore();
        store.refresh();
        store.checkpoint();
        store.replaceContributor('n', 'f', [{ scope: 'node', key: 'key', type: 'number' }]);
        pending.shift()!(snapshot('string'));
        assert.match(store.declarationsFor('n', 'f'), /"key": number/);
        store.rollback();
        assert.doesNotMatch(store.declarationsFor('n', 'f'), /"key"/);
        store.refresh();
        store.checkpoint();
        store.rollback();
        pending.shift()!(snapshot('boolean'));
        assert.doesNotMatch(store.declarationsFor('n', 'f'), /"key"/);
        store.refresh();
        store.refresh();
        pending.pop()!(snapshot('number'));
        pending.pop()!(snapshot('string'));
        assert.match(store.declarationsFor('n', 'f'), /"key": number/);
    } finally { delete (globalThis as any).$; delete (globalThis as any).RED; }
});
