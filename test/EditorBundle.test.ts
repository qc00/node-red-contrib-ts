import assert from 'node:assert/strict';
import { it } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

it('loads the editor bundle and registers both node types without Monaco being open', () => {
    const html = readFileSync(join(__dirname, '../dist/typescript.html'), 'utf8');
    const script = /<script type="text\/javascript">([\s\S]*?)<\/script>/.exec(html)![1];
    const nodes = new Map<string, any>();
    const events: string[] = [];
    const RED = {
        nodes: { registerType: (name: string, definition: any) => nodes.set(name, definition), version: () => undefined },
        events: { on: (name: string) => events.push(name) },
        settings: { get: () => undefined },
        utils: { parseModuleList: (list: string[]) => list },
    };
    runInNewContext(script, { RED, window: {}, console, setTimeout, clearTimeout });
    assert.deepEqual([...nodes.keys()], ['typescript-config', 'typescript']);
    assert.equal(nodes.get('typescript-config').defaults.idleTimeoutSeconds.value, 30);
    assert.ok(events.includes('deploy'));
    assert.equal(typeof nodes.get('typescript').oneditprepare, 'function');
});

it('closes the edit dialog state when the node is deleted from its dialog', () => {
    const html = readFileSync(join(__dirname, '../dist/typescript.html'), 'utf8');
    const script = /<script type="text\/javascript">([\s\S]*?)<\/script>/.exec(html)![1];
    const nodes = new Map<string, any>();
    const RED = {
        nodes: { registerType: (name: string, definition: any) => nodes.set(name, definition), version: () => undefined },
        events: { on: () => {} },
        settings: { get: () => undefined },
        utils: { parseModuleList: (list: string[]) => list },
    };
    runInNewContext(script, { RED, window: {}, console, setTimeout, clearTimeout });
    const definition = nodes.get('typescript');
    const destroyed: string[] = [];
    const editor = (name: string) => ({ destroy: () => destroyed.push(name) });
    const open = { _def: definition, editor: editor('editor'), initEditor: editor('init'), finalizeEditor: editor('finalize'), declareEditor: editor('declare') };
    definition.oneditdelete.call(open);
    assert.deepEqual(destroyed, ['editor', 'init', 'finalize', 'declare']);
    assert.equal(open.editor, undefined);
    definition.oneditdelete.call({ _def: definition });
});
