import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { STRICT, TypeCheckFixture } from './support/TypeCheckFixture';

describe('deploy type check', () => {
    const fixtures: TypeCheckFixture[] = [];
    const fixture = () => { const f = new TypeCheckFixture(); fixtures.push(f); return f; };
    after(async () => { await Promise.all(fixtures.map(f => f.dispose())); });

    it('types module variables as what the runtime injects and keeps their type namespace', async () => {
        const f = fixture();
        f.addNode({
            id: 'ok',
            libs: [
                { var: 'esmlib', module: 'esmlib' }, { var: 'nodef', module: 'nodef' },
                { var: 'cjslib', module: 'cjslib' }, { var: 'path', module: 'path' }, { var: 'fs', module: 'fs/promises' },
            ],
            initialize: 'const c = new esmlib({ a: 1 }); const s: string = c.go();',
            func: [
                'const o: esmlib.Opts = { a: 2 };',
                'const n: number = nodef.make({ b: "" }); const cfg: nodef.Cfg = { b: "x" };',
                'const r: cjslib.Result = cjslib("x"); cjslib.parse("y").ok;',
                'const pp: path.ParsedPath = path.parse(path.join("a", "b"));',
                'const text: string = await fs.readFile("a", "utf8");',
                'return msg;',
            ].join('\n'),
        }, STRICT);
        f.addNode({
            id: 'bad',
            libs: [{ var: 'esmlib', module: 'esmlib' }, { var: 'nodef', module: 'nodef' }],
            func: 'esmlib.helper({ a: 1 });\nnodef.make({ b: 1 });\nreturn msg;',
        }, STRICT);
        await f.check();
        assert.equal(f.warningsOf('ok'), '');
        assert.match(f.warningsOf('bad'), /\[On Message 1:8\] TS2339: Property 'helper' does not exist/);
        assert.match(f.warningsOf('bad'), /\[On Message 2:14\] TS2322/);
        assert.match(f.warningsOf('bad'), /found 2 problem/);
    });

    it('reports locations per section and ignores generated code', async () => {
        const f = fixture();
        f.addNode({
            id: 'n',
            libs: [{ var: 'unused', module: 'path' }],
            declare: 'interface Shape { side: number }\nconst broken: Shape = { side: "x" };',
            initialize: '\n  node.status({ fill: "purple" });',
            func: 'return msg;',
            finalize: 'const x: number = "s";',
        }, '{ "compilerOptions": { "strict": true, "noUnusedLocals": true, "noUnusedParameters": true } }');
        await f.check();
        const warnings = f.warningsOf('n');
        assert.match(warnings, /\[Type Declarations 2:25\] TS2322/);
        assert.match(warnings, /\[On Start 2:17\] TS2322/);
        assert.match(warnings, /\[On Stop 1:7\] TS2322/);
        assert.doesNotMatch(warnings, /unused/);
        assert.doesNotMatch(warnings, /__on/);
    });

    it('types get from the set calls of every node on the flow', async () => {
        const f = fixture();
        f.addNode({ id: 'writer', func: 'flow.set("count", 1);\nglobal.set("who", { name: "x", tags: ["a"] });\ncontext.set("mine", true);\nreturn msg;' }, STRICT);
        f.addNode({
            id: 'reader',
            func: [
                'const c = flow.get("count");',
                'c.toFixed();',
                'flow.get("count")!.toFixed();',
                'context.flow.get("count")!.nope;',
                'const who = global.get("who"); if (who) { who.tags.map(t => t.length); who.missing; }',
                'const untracked: string = flow.get("something-else");',
                'const mine: number = context.get("mine");',
                'const overridden = flow.get<string>("count"); const fresh = flow.get<string>("fresh");',
                'return msg;',
            ].join('\n'),
        }, STRICT);
        f.addNode({ id: 'other-flow', flowId: 'flow2', func: 'const c: string | undefined = flow.get("count");\nreturn msg;' }, STRICT);
        await f.check();
        assert.equal(f.warningsOf('writer'), '');
        const reader = f.warningsOf('reader');
        assert.match(reader, /\[On Message 2:1\] TS18048: 'c' is possibly 'undefined'/);
        assert.doesNotMatch(reader, /On Message 3:/);
        assert.match(reader, /\[On Message 4:28\] TS2339: Property 'nope' does not exist on type 'number'/);
        assert.match(reader, /\[On Message 5:\d+\] TS2339: Property 'missing'/);
        assert.match(reader, /\[On Message 6:7\] TS2322: Type 'string \| undefined' is not assignable to type 'string'/);
        assert.match(reader, /\[On Message 7:\d+\] TS\d+/);
        assert.doesNotMatch(reader, /On Message 8:/);
        assert.match(reader, /found 5 problem/);
        assert.equal(f.warningsOf('other-flow'), '');

        assert.deepEqual(JSON.parse(JSON.stringify(f.service.registry)), {
            rev: 'rev1',
            node: { writer: { mine: { writer: 'boolean' } } },
            flow: { flow1: { count: { writer: 'number' } } },
            global: { who: { writer: '{ name: string; tags: string[]; }' } },
        });
    });

    it('reads a key set with different types as a union that needs narrowing', async () => {
        const f = fixture();
        f.addNode({ id: 'a', func: 'flow.set("u", { kind: "a" as const, x: 1 });\nreturn msg;' }, STRICT);
        f.addNode({ id: 'b', func: 'flow.set("u", { kind: "b" as const, y: "s" });\nreturn msg;' }, STRICT);
        f.addNode({
            id: 'reader',
            func: 'const u = flow.get("u")!;\nu.kind;\nu.x;\nif (u.kind === "a") u.x.toFixed(); else u.y.trim();\nreturn msg;',
        }, STRICT);
        await f.check();
        const reader = f.warningsOf('reader');
        assert.match(reader, /\[On Message 3:3\] TS2339: Property 'x' does not exist/);
        assert.match(reader, /found 1 problem/);
    });

    it('downgrades a type that only its own node can name', async () => {
        const f = fixture();
        f.addNode({ id: 'writer', declare: 'interface Local { n: number }', func: 'const v: Local = { n: 1 };\nflow.set("loc", v);\nflow.set("ok", 1);\nreturn msg;' }, STRICT);
        f.addNode({ id: 'reader', func: 'flow.get("loc")!.anything;\nreturn msg;' }, STRICT);
        await f.check();
        assert.match(f.warningsOf('writer'), /flow key "loc" cannot be named outside this node/);
        assert.equal(f.warningsOf('reader'), '');
        assert.deepEqual(f.service.registry.keyTypesFor('reader', 'flow1').flow, { loc: 'any', ok: 'number' });
    });

    it('lets other nodes read types declared in module files', async () => {
        const f = fixture();
        f.addNode({
            id: 'writer',
            libs: [
                { var: 'esmlib', module: 'esmlib' }, { var: 'cjslib', module: 'cjslib' },
                { var: 'metrics', module: '@scope/srclib/metrics.mjs' },
            ],
            declare: 'type Unit = Parameters<typeof metrics.measure>[0];',
            func: [
                'const o: esmlib.Opts = { a: 1 }; flow.set("opts", o);',
                'flow.set("result", cjslib("x"));',
                'const u: Unit = { scale: 2 }; flow.set("unit", u);',
                'return msg;',
            ].join('\n'),
        }, STRICT);
        f.addNode({
            id: 'reader',
            func: 'const a: string = flow.get("opts")!.a;\nconst ok: string = flow.get("result")!.ok;\nconst s: string = flow.get("unit")!.scale;\nreturn msg;',
        }, STRICT);
        await f.check();
        assert.equal(f.warningsOf('writer'), '');
        const reader = f.warningsOf('reader');
        assert.match(reader, /\[On Message 1:7\] TS2322: Type 'number' is not assignable to type 'string'/);
        assert.match(reader, /\[On Message 2:7\] TS2322: Type 'boolean' is not assignable to type 'string'/);
        assert.match(reader, /\[On Message 3:7\] TS2322: Type 'number' is not assignable to type 'string'/);
        assert.match(reader, /found 3 problem/);
    });

    it('ignores set calls on shadowed receivers, other stores and dynamic keys', async () => {
        const f = fixture();
        f.addNode({
            id: 'n',
            func: 'const k = "dyn"; flow.set(k, 1); flow.set("stored", 1, "file"); flow.set(["a", "b"], [1, 2]);\n{ const flow = new Map<string, number>(); flow.set("shadow", 1); }\nreturn msg;',
        }, STRICT);
        await f.check();
        assert.equal(f.warningsOf('n'), '');
        assert.deepEqual(f.service.registry.keyTypesFor('n', 'flow1'), { node: {}, flow: {}, global: {} });
    });

    it('checks nodes with different options in separate programs', async () => {
        const f = fixture();
        f.addNode({ id: 'loose', func: 'function f(a) { return a; }\nflow.set("k", "text");\nconst wrong: number = flow.get("k");\nreturn msg;' });
        f.addNode({ id: 'strict', func: 'function f(a) { return a; }\nconst k: number = flow.get("k")!;\nreturn msg;' }, STRICT);
        await f.check();
        assert.match(f.warningsOf('loose'), /found 1 problem[^]*\[On Message 3:\d+\]/);
        assert.match(f.warningsOf('strict'), /\[On Message 1:12\] TS7006/);
        assert.match(f.warningsOf('strict'), /\[On Message 2:7\] TS2322/);

        f.addNode({ id: 'loose', func: 'flow.set("k", 5);\nreturn msg;' });
        await f.check('rev2');
        assert.doesNotMatch(f.warningsOf('strict'), /TS2322/);
        assert.match(f.warningsOf('strict'), /found 1 problem/);

        await f.check('rev3');
        assert.equal(f.warningsOf('strict'), '', 'an unchanged report is not repeated');

        f.addNode({ id: 'loose', func: 'flow.set("k", "text again");\nreturn msg;' });
        await f.check('rev4');
        assert.match(f.warningsOf('strict'), /found 2 problem/);
        assert.equal(f.service.registry.rev, 'rev4');
        assert.match(f.log.at(-1)!, /2 node\(s\), 2 program\(s\)/);
    });
});
