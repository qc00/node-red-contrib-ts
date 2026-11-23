import assert from 'node:assert/strict';
import { it } from 'node:test';
import { TypeScriptCompilerClient, TypeScriptCompiler } from '../src/compiler';

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
    const client = new TypeScriptCompilerClient('.', log, async () => { starts++; return fake.compiler; });
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
    const client = new TypeScriptCompilerClient('.', log, async () => {
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
    const client = new TypeScriptCompilerClient('.', log, async () => fake.compiler);
    try {
        const work = client.use(async () => {
            fake.exit();
            return new Promise<never>(() => {});
        });
        await assert.rejects(work, /compiler process stopped/);
    } finally { await client.shutdown(); }
});
