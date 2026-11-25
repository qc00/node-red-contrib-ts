import assert from 'node:assert/strict';
import { it } from 'node:test';
import { CompilerRuntime, TypeScriptCompiler } from '../src/compiler';

const log = { info() {}, warn() {} };
function fakeCompiler() {
    let exit!: () => void;
    let closes = 0;
    const compiler = {
        exited: new Promise<void>(resolve => { exit = resolve; }),
        close: async () => { closes++; exit(); },
    } as TypeScriptCompiler;
    return { compiler, exit: () => exit(), closes: () => closes };
}

it('shares startup between overlapping operations and closes once on shutdown', async () => {
    const fake = fakeCompiler();
    let starts = 0;
    const client = new CompilerRuntime('.', log, async () => { starts++; return fake.compiler; });
    try {
        const values = await Promise.all([client.use(async c => c), client.use(async c => c)]);
        assert.equal(starts, 1);
        assert.ok(values.every(c => c === fake.compiler));
    } finally { await client.shutdown(); }
    assert.equal(fake.closes(), 1);
});

it('allows a new startup after startup fails', async () => {
    const fake = fakeCompiler();
    let starts = 0;
    const client = new CompilerRuntime('.', log, async () => {
        if (++starts === 1) throw new Error('startup failed');
        return fake.compiler;
    });
    try {
        await assert.rejects(client.use(async () => 1), /startup failed/);
        assert.equal(await client.use(async () => 2), 2);
        assert.equal(starts, 2);
    } finally { await client.shutdown(); }
});

it('rejects pending work when its compiler exits', async () => {
    const fake = fakeCompiler();
    const client = new CompilerRuntime('.', log, async () => fake.compiler);
    try {
        const work = client.use(async () => {
            fake.exit();
            return new Promise<never>(() => {});
        });
        await assert.rejects(work, /compiler process stopped/);
    } finally { await client.shutdown(); }
});

it('retires a failed generation without interrupting its other operation', async () => {
    const generations: ReturnType<typeof fakeCompiler>[] = [];
    const runtime = new CompilerRuntime('.', log, async () => {
        const fake = fakeCompiler();
        const generation = generations.length;
        (fake.compiler as any).api = {
            parseJsonConfigFileContent: async () => ({ options: {}, errors: [] }),
            transpileModule: async (source: string) => {
                if (generation === 0) throw new Error('transpile failed');
                return { outputText: source, diagnostics: [] };
            },
        };
        generations.push(fake);
        return fake.compiler;
    });
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const other = runtime.use(async () => {
        entered();
        await new Promise<void>(resolve => { release = resolve; });
        return 42;
    });
    try {
        await ready;
        const results = await Promise.all([runtime.transpile(['one'], undefined), runtime.transpile(['two'], undefined)]);
        assert.deepEqual(results.map(r => r.outputs), [['one'], ['two']]);
        assert.equal(generations.length, 2, 'overlapping failures share one replacement');
        assert.equal(generations[0].closes(), 0, 'old work still owns the old process');
        release();
        assert.equal(await other, 42);
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(generations[0].closes(), 1);
    } finally { release?.(); await runtime.shutdown(); }
    assert.equal(generations[1].closes(), 1);
});

it('starts a new process for the next operation after the process exits by itself', async () => {
    const fakes: ReturnType<typeof fakeCompiler>[] = [];
    const warnings: string[] = [];
    const client = new CompilerRuntime('.', { info() {}, warn: message => { warnings.push(message); } }, async () => {
        const fake = fakeCompiler();
        fakes.push(fake);
        return fake.compiler;
    });
    client.registerSettings('config', { keepAlive: true, idleTimeoutSeconds: 30 });
    try {
        assert.equal(await client.use(async c => c), fakes[0].compiler);
        fakes[0].exit();
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(await client.use(async c => c), fakes[1].compiler);
        assert.deepEqual(warnings, ['TypeScript compiler process stopped unexpectedly']);
    } finally { await client.shutdown(); }
    assert.equal(fakes.length, 2);
});
