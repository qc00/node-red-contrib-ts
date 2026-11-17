import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { join } from 'node:path';
import { TypeCheckAbandonedError, TypeScriptWorkerClient } from '../src/worker/TypeScriptWorkerClient';
import { TypeCheckProgressEvent, TypeCheckRequestTarget } from '../src/worker/TypeScriptWorkerProtocol';
import { TypeCheckFixture } from './support/TypeCheckFixture';

const WORKER_PATH = join(__dirname, 'typescript-worker.js');

function target(id: string, func: string): TypeCheckRequestTarget {
    return {
        instanceId: id,
        definition: { id, flowId: 'flow1', libs: [], declare: '', initialize: '', func, finalize: '' },
        tsconfig: '{ "compilerOptions": { "strict": true } }',
        persistentService: false,
    };
}

describe('TypeScriptWorkerClient', () => {
    const packages = new TypeCheckFixture();
    const log: string[] = [];
    const clients: TypeScriptWorkerClient[] = [];
    const newClient = () => {
        const client = new TypeScriptWorkerClient(WORKER_PATH, packages.userDir, { info: m => log.push(m), warn: m => log.push(m) });
        clients.push(client);
        return client;
    };
    after(() => {
        for (const client of clients) client.shutdown();
        packages.dispose();
    });

    it('transpiles, resolves compiler options and collects module types in the worker', async () => {
        const client = newClient();
        const transpiled = await client.transpile(['const a: number = 1;', 'let b: string;'], undefined);
        assert.match(transpiled.outputs[0], /const a = 1;/);
        assert.doesNotMatch(transpiled.outputs[1], /string/);
        assert.deepEqual(transpiled.diagnostics, [[], []]);

        const resolved = await client.resolveCompilerOptions('{ "compilerOptions": { "strict": true }, "include": [] }');
        assert.equal(resolved.json.strict, true);
        assert.match(resolved.warnings.join('\n'), /"include" is ignored/);

        const types = await client.collectModuleTypes('esmlib');
        assert.deepEqual(types.files.map(file => file.path).sort(), ['node_modules/esmlib/index.d.mts', 'node_modules/esmlib/package.json']);
        assert.ok(log.some(line => /TypeScript worker started in \d+ms/.test(line)));
    });

    it('type-checks and streams per-node progress', async () => {
        const client = newClient();
        const events: TypeCheckProgressEvent[] = [];
        const registry = await client.typeCheck(
            'rev9',
            [target('writer', 'flow.set("n", 1); return msg;'), target('reader', 'const s: string = flow.get("n"); return msg;')],
            event => events.push(event),
        );
        assert.equal(registry.rev, 'rev9');
        assert.deepEqual(registry.flow.flow1.n, { writer: 'number' });
        const reports = events.filter(event => event.kind === 'nodeReport') as { instanceId: string; message: string }[];
        assert.match(reports.find(report => report.instanceId === 'reader')!.message, /TS2322/);
        assert.equal(reports.find(report => report.instanceId === 'writer')!.message, '');
        assert.ok(events.some(event => event.kind === 'nodeLog' && /Type-checked in \d+ms/.test(event.message)));
    });

    it('abandons a running check when a transpile arrives, and answers the transpile', async () => {
        const client = newClient();
        let abandon!: Promise<unknown>;
        const check = client.typeCheck('rev1', [target('n', 'return msg;')], event => {
            abandon ??= client.transpile(['const x: number = 2;'], undefined);
        });
        await assert.rejects(check, TypeCheckAbandonedError);
        assert.match(((await abandon) as any).outputs[0], /const x = 2;/);
    });

    it('lets other requests overtake a queued check', async () => {
        const client = newClient();
        const order: string[] = [];
        const first = client.resolveCompilerOptions(undefined).then(() => order.push('options'));
        const check = client.typeCheck('rev1', [target('n', 'return msg;')], () => {}).then(() => order.push('check'));
        const types = client.collectModuleTypes('cjslib').then(() => order.push('types'));
        await Promise.all([first, check, types]);
        assert.deepEqual(order, ['options', 'types', 'check']);
    });

    it('stops the idle worker after the configured time and starts a new one on demand', async () => {
        const client = newClient();
        client.registerSettings('config', { keepAlive: false, idleTimeoutSeconds: 0.05, maxHeapMb: undefined });
        await client.transpile(['1'], undefined);
        const startsBefore = log.filter(line => line.includes('worker started')).length;
        await new Promise(resolve => setTimeout(resolve, 300));
        assert.ok(log.some(line => line.includes('stopped after 0.05s idle')));
        await client.transpile(['2'], undefined);
        assert.equal(log.filter(line => line.includes('worker started')).length, startsBefore + 1);
        client.shutdown();
    });

    it('keeps the worker when a config asks for it', async () => {
        const client = newClient();
        client.registerSettings('a', { keepAlive: false, idleTimeoutSeconds: 0.05, maxHeapMb: undefined });
        client.registerSettings('b', { keepAlive: true, idleTimeoutSeconds: 0.05, maxHeapMb: undefined });
        const stopsBefore = log.filter(line => line.includes('stopped after')).length;
        await client.transpile(['1'], undefined);
        await new Promise(resolve => setTimeout(resolve, 300));
        assert.equal(log.filter(line => line.includes('stopped after')).length, stopsBefore);
    });

    it('fails a check that exceeds the heap limit but still transpiles', async () => {
        const client = newClient();
        client.registerSettings('config', { keepAlive: false, idleTimeoutSeconds: 30, maxHeapMb: 8 });
        await assert.rejects(client.typeCheck('rev1', [target('n', 'return msg;')], () => {}), /stopped unexpectedly \(heap limit 8MB\)/);
        const transpiled = await client.transpile(['const y: number = 3;'], undefined);
        assert.match(transpiled.outputs[0], /const y = 3;/);
    });
});
