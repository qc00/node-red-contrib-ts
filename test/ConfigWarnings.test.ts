import assert from 'node:assert/strict';
import { it } from 'node:test';
import { registerCompilerConfigNode } from '../src/editor/compiler-options';

it('ignores obsolete config warnings and cancels work when the dialog closes', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const responses: ((value: any) => void)[] = [];
    let definition: any;
    let change!: () => void;
    let renders = 0;
    const list = { empty() { renders++; return this; }, toggle() {} };
    const $ = Object.assign(() => list, {
        ajax: () => {
            const request = { done(callback: any) { responses.push(callback); return request; }, fail() { return request; } };
            return request;
        },
    });
    const editor = { getValue: () => '{}', getSession: () => ({ on: (_: string, callback: any) => { change = callback; } }), destroy() {} };
    (globalThis as any).$ = $;
    (globalThis as any).window = {};
    (globalThis as any).RED = {
        nodes: { registerType: (_: string, value: any) => { definition = value; } },
        editor: { createEditor: () => editor },
    };
    const node: any = {};
    try {
        registerCompilerConfigNode();
        definition.oneditprepare.call(node);
        change();
        t.mock.timers.tick(500);
        assert.equal(responses.length, 2);
        responses[1]({ warnings: [] });
        await Promise.resolve();
        responses[0]({ warnings: [] });
        await Promise.resolve();
        assert.equal(renders, 1);
        change();
        t.mock.timers.tick(500);
        change(); // This pending timer must be cancelled on close.
        definition.oneditcancel.call(node);
        responses[2]({ warnings: [] });
        await Promise.resolve();
        t.mock.timers.tick(500);
        assert.equal(renders, 1);
        assert.equal(responses.length, 3);
    } finally {
        node.stopWarnings?.();
        delete (globalThis as any).$;
        delete (globalThis as any).window;
        delete (globalThis as any).RED;
        t.mock.timers.reset();
    }
});
