import assert from 'node:assert/strict';
import { it } from 'node:test';
import { contextTypeStore, scheduleContextInference, cancelContextInference } from '../src/editor/setup';

it('does not apply inference that finishes after cancellation', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let release!: (value: any) => void;
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const editor = {
        type: 'monaco', getValue: () => 'context.set("key", 1);',
        getModel: () => ({ getLanguageId: () => 'typescript', uri: { toString: () => 'file:///test.ts' } }),
    };
    const node = { id: 'n', z: 'f', editor, initEditor: editor, finalizeEditor: editor };
    const api = {
        getTypeScriptWorker: async () => async () => ({
            getQuickInfoAtPosition: async () => {
                entered();
                return new Promise(resolve => { release = resolve; });
            },
        }),
    };
    (globalThis as any).window = { currentNodeInstance: node, monaco: { typescript: api } };
    let replacements = 0;
    const original = contextTypeStore.replaceContributor;
    contextTypeStore.replaceContributor = () => { replacements++; };
    try {
        scheduleContextInference(node);
        t.mock.timers.tick(800);
        await ready;
        cancelContextInference();
        // Subsequent tabs must not block completion of the stale inference pass.
        api.getTypeScriptWorker = async () => async () => ({ getQuickInfoAtPosition: async () => undefined });
        release(undefined);
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(replacements, 0);
    } finally {
        cancelContextInference();
        contextTypeStore.replaceContributor = original;
        delete (globalThis as any).window;
        t.mock.timers.reset();
    }
});
