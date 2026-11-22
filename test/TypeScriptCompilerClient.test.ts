import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { TypeScriptCompilerClient } from '../src/compiler/TypeScriptCompilerClient';
import { TypeScriptCompilerService } from '../src/compiler/TypeScriptCompilerService';
import { TypeCheckFixture } from './support/TypeCheckFixture';

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('TypeScriptCompilerClient', () => {
    const packages = new TypeCheckFixture();
    const clients: TypeScriptCompilerClient[] = [];
    const newService = () => {
        const log: string[] = [];
        const client = new TypeScriptCompilerClient(packages.userDir, { info: m => { log.push(m); }, warn: m => { log.push(m); } });
        clients.push(client);
        return { client, log, service: new TypeScriptCompilerService(client, packages.userDir) };
    };
    const count = (log: string[], text: string) => log.filter(line => line.includes(text)).length;
    after(async () => {
        for (const client of clients) await client.shutdown();
        await packages.dispose();
    });

    it('transpiles with syntax diagnostics per source and the tsconfig target', async () => {
        const { service, log } = newService();
        const transpiled = await service.transpile(
            ['(async function(msg, node) { const a: number = 1; enum E { A } return a + E.A; })(msg, node)', 'const b: string = ;'],
            '{ "compilerOptions": { "removeComments": true } }',
        );
        assert.match(transpiled.outputs[0], /const a = 1;/);
        assert.doesNotMatch(transpiled.outputs[0], /number/);
        assert.equal(await new Function('msg', 'node', `return ${transpiled.outputs[0]}`)({}, {}), 1, 'usable the way the node evaluates it');
        assert.deepEqual(transpiled.diagnostics[0], []);
        assert.match(transpiled.diagnostics[1].join('\n'), /^Line 1:19: Expression expected\.$/);
        assert.equal(count(log, 'TypeScript compiler started in'), 1);
    });

    it('answers a transpile while a type check is running', async () => {
        const { service } = newService();
        const order: string[] = [];
        const definition = { id: 'n', flowId: 'flow1', libs: [], declare: '', initialize: '', func: 'return msg;', finalize: '' };
        let transpile!: Promise<unknown>;
        const check = service.typeCheck('rev1', [{ instanceId: 'n', definition, tsconfig: undefined }], () => {
            transpile ??= service.transpile(['const x: number = 2;'], undefined).then(() => order.push('transpile'));
        }).then(() => order.push('check'));
        await check;
        await transpile;
        assert.deepEqual(order, ['transpile', 'check']);
    });

    it('stops the idle compiler after the configured time and starts a new one on demand', async () => {
        const { client, service, log } = newService();
        client.registerSettings('config', { keepAlive: false, idleTimeoutSeconds: 0.05 });
        await service.transpile(['1'], undefined);
        await wait(300);
        assert.equal(count(log, 'stopped after 0.05s idle'), 1);
        await service.transpile(['2'], undefined);
        assert.equal(count(log, 'TypeScript compiler started in'), 2);
    });

    it('keeps the compiler when a config asks for it', async () => {
        const { client, service, log } = newService();
        client.registerSettings('a', { keepAlive: false, idleTimeoutSeconds: 0.05 });
        client.registerSettings('b', { keepAlive: true, idleTimeoutSeconds: 0.05 });
        await service.transpile(['1'], undefined);
        await wait(300);
        assert.equal(count(log, 'stopped after'), 0);
    });

    for (const signal of ['SIGKILL', 'SIGTERM'] as const) {
        // On SIGTERM the compiler stays up for a while but fails every request.
        it(`still transpiles after the compiler process got ${signal}`, async () => {
            const { client, service, log } = newService();
            await service.transpile(['1'], undefined);
            await client.use(async compiler => { process.kill((compiler.api as any).client.process.pid, signal); });
            await wait(200);
            const transpiled = await service.transpile(['const y: number = 3;'], undefined);
            assert.match(transpiled.outputs[0], /const y = 3;/);
            assert.equal(count(log, 'TypeScript compiler started in'), 2);
        });
    }
});
