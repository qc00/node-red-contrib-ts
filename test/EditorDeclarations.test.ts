import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { ContextTypeRegistry } from '../src/compile/ContextTypeRegistry';
import { extractSetValueType, findContextSetCallSites, inferContextSetsWithQuickInfo } from '../src/editor/ContextSetQuickInfoInferrer';
import { EditorProgramFixture } from './support/EditorProgramFixture';
import { STRICT, TypeCheckFixture } from './support/TypeCheckFixture';

describe('editor declarations', () => {
    const packages = new TypeCheckFixture();
    after(async () => { await packages.dispose(); });
    const userDir = packages.userDir;

    it('makes module variables global with the runtime value type and their type namespace', async () => {
        const program = await EditorProgramFixture.create(packages.compiler, {
            userDir,
            tsconfig: STRICT,
            libs: [
                { var: 'esmlib', module: 'esmlib' }, { var: 'nodef', module: 'nodef' },
                { var: 'cjslib', module: 'cjslib' }, { var: 'path', module: 'path' },
            ],
            body: [
                'const c = new esmlib({ a: 1 }); const s: string = c.go(); const o: esmlib.Opts = { a: 2 };',
                'const n: number = nodef.make({ b: "" }); const cfg: nodef.Cfg = { b: "x" };',
                'const r: cjslib.Result = cjslib("x"); cjslib.parse("y").ok;',
                'const pp: path.ParsedPath = path.parse(path.join("a", "b"));',
                'esmlib.helper({ a: 1 });',
            ].join('\n'),
        });
        assert.deepEqual(program.bodyDiagnostics(), ["5:8 TS2339: Property 'helper' does not exist on type 'typeof Client'."]);
    });

    it('relies only on the alias/const conflict being reported inside the generated module files', async () => {
        const program = await EditorProgramFixture.create(packages.compiler, {
            userDir,
            libs: [{ var: 'esmlib', module: 'esmlib' }, { var: 'path', module: 'path' }],
            body: 'path.sep;',
        });
        for (const filePath of program.generatedFilePaths()) {
            const codes = program.diagnosticsOf(filePath).map(d => d.match(/TS\d+/)![0]);
            // The fixture loads @types/node unmodified; the editor strips its `declare var global` (copyNodeRedTypeLibs).
            if (filePath.includes('/node-red-ts-libs/module/')) {
                // TypeScript 5.4 also objects to the generated file importing an ES module (TS1479, TS2667).
                assert.ok(codes.includes('TS2440') && codes.every(code => ['TS1479', 'TS2667', 'TS2440'].includes(code)), `${filePath}: ${codes}`);
            } else {
                assert.deepEqual(codes, filePath.endsWith('node-red-ts-context.d.ts') ? ['TS2451'] : [], filePath);
            }
        }
    });

    it('accepts what the reference declarations accept and rejects what they reject', async () => {
        const program = await EditorProgramFixture.create(packages.compiler, {
            userDir,
            tsconfig: STRICT,
            body: [
                'const a: number | undefined = context.get<number>("a");',
                'const many: (string | undefined)[] = flow.get<string>(["a", "b"]);',
                'global.get<number>("a", (err: Error | null, value: number) => {});',
                'flow.get<number>(["a", "b"], (err, ...values) => { values[0].toFixed(); });',
                'const stored: string | undefined = context.get<string>("a", "file");',
                'context.get<string>("a", "file", (err, value) => value.trim());',
                'context.set("a", 1); context.set(["a", "b"], [1, 2]); context.set("a", 1, err => {}); context.set(["a"], [1], err => {});',
                'context.set("a", 1, "file"); context.set("a", 1, "file", err => {});',
                'const keys: string[] = flow.keys(); flow.keys(keys2 => {}); flow.keys("file").length; flow.keys("file", (err, k) => k.length);',
                'context.flow.keys(); context.global.set("g", 1);',
                'const id: string = node.id + node.name + node.path; const count: number = node.outputCount;',
                'node.log("a"); node.warn("a"); node.error("a", msg); node.debug("a"); node.trace("a");',
                'node.send(msg); node.send([msg, null]); node.send([[msg, msg], null], false); node.done();',
                'node.status({ fill: "red", shape: "dot", text: "t" }); node.status({}); node.on("close", () => {});',
                'const v = env.get("X"); const copy: { n: number } = RED.util.cloneMessage({ n: 1 });',
                'const m: Message<number> = { topic: "t", payload: 1, extra: true };',
                'msg.payload; msg.anything.goes; const mid: string | undefined = msg._msgid;',
                // rejected by the reference
                'node.status({ fill: "purple" });',
                'node.status({ shape: "square" });',
                'node.log(1);',
                'node.on("input", () => {});',
                'env.get(1);',
                'context.set("a");',
                'flow.keys(1);',
                'const bad: Message = { payload: 1 };',
                'node.id = "x";',
                'node.send("text");',
            ].join('\n'),
        });
        const lines = program.bodyDiagnostics().map(d => Number(d.split(':')[0]));
        assert.deepEqual([...new Set(lines)], [18, 19, 20, 21, 22, 23, 24, 25, 26, 27], program.bodyDiagnostics().join('\n'));
    });

    it('lets Type Declarations extend NodeMessage', async () => {
        const program = await EditorProgramFixture.create(packages.compiler, {
            userDir,
            tsconfig: STRICT,
            declare: 'interface NodeMessage { payload?: { userId: number } }',
            body: 'msg.payload?.userId.toFixed();\nmsg.payload?.nope;\nmsg.other.thing;',
        });
        assert.deepEqual(program.bodyDiagnostics().map(d => d.split(' ')[0]), ['2:14']);
    });

    it('infers set types through quick-info exactly as the deploy-time check prints them', async () => {
        const body = [
            'flow.set("count", 1);',
            'flow.set(\'seen\', { at: new Date(), tags: ["x"], n: 1 as const, f: (a: string) => a.length > 1 });',
            'global.set(`who`, path.parse("a"));',
            'context.set("mine", [1, "a"]); context . flow . set("spaced", null);',
            'context.global.set("g", new Map<string, number[]>());',
            'flow.set("stored", 1, "file"); flow.set(dynamicKey, 1); other.flow.set("no", 1); myflow.set("no", 1);',
        ].join('\n');
        const libs = [{ var: 'path', module: 'path' }];
        const program = await EditorProgramFixture.create(packages.compiler, { userDir, tsconfig: STRICT, libs, body: `declare const dynamicKey: string; declare const other: any; declare const myflow: any;\n${body}` });
        const offsetShift = program.service.getProgram()!.getSourceFile(program.bodyPath)!.text.indexOf(body);
        const sets = await inferContextSetsWithQuickInfo(body, async offset => program.quickInfoAt(offset + offsetShift));

        packages.addNode({ id: 'same', libs, declare: 'declare const dynamicKey: string; declare const other: any; declare const myflow: any;', func: body }, STRICT);
        await packages.check();
        const editorRegistry = new ContextTypeRegistry();
        editorRegistry.replaceContributor('same', 'flow1', sets);
        const editorTypes = editorRegistry.keyTypesFor('same', 'flow1');
        const deployedTypes = packages.service.registry.keyTypesFor('same', 'flow1');
        // The editor names a module type through the node's own variable; the deploy-time check prints a portable name.
        assert.equal(editorTypes.global.who, 'path.ParsedPath');
        assert.equal(deployedTypes.global.who, 'import("path").ParsedPath');
        delete editorTypes.global.who;
        delete deployedTypes.global.who;
        assert.deepEqual(editorTypes, deployedTypes);
        assert.deepEqual(Object.keys(editorRegistry.keyTypesFor('same', 'flow1').flow).sort(), ['count', 'seen', 'spaced']);
        assert.equal(editorRegistry.keyTypesFor('same', 'flow1').global.g, 'Map<string, number[]>');
    });

    it('types get in the editor from the key types', async () => {
        const program = await EditorProgramFixture.create(packages.compiler, {
            userDir,
            tsconfig: STRICT,
            keyTypes: { node: {}, flow: { count: 'number', u: '({ kind: "a"; x: number; }) | ({ kind: "b"; y: string; })' }, global: {} },
            body: 'flow.get("count")!.toFixed();\nflow.get("count")!.nope;\nconst u = flow.get("u")!; u.kind; u.x;\nflow.get("unknown").anything;\nconst wrong: string = flow.get("count")!;',
        });
        assert.deepEqual(program.bodyDiagnostics().map(d => d.split(' ')[0]), ['2:20', '3:37', '5:7']);
    });
});

describe('quick-info parsing', () => {
    it('finds call sites', async () => {
        assert.deepEqual(findContextSetCallSites('a.flow.set("x", 1); flow.set("k", 1);\nglobal\n  .set(\'g\', 2)'), [
            { scope: 'flow', key: 'k', setOffset: 25 },
            { scope: 'global', key: 'g', setOffset: 48 },
        ]);
        assert.deepEqual(findContextSetCallSites('flow.set(`a${b}`, 1); flow.set("a" + b, 1); flow.set("only")'), []);
    });

    it('extracts the value type', async () => {
        const type = (text: string) => extractSetValueType(text);
        assert.equal(type('(method) NodeRedContext<{}>.set<"p", string>(key: "p", value: string): void (+5 overloads)'), 'string');
        assert.equal(
            type('(method) NodeRedContext<{ "a": { x: (v: string) => void; }; }>.set<"seen", {\n    at: Date;\n    f: (a: string, b: number) => Map<string, number[]>;\n}>(key: "seen", value: {\n    at: Date;\n    f: (a: string, b: number) => Map<string, number[]>;\n}): void (+5 overloads)'),
            '{ at: Date; f: (a: string, b: number) => Map<string, number[]>; }',
        );
        assert.equal(type('(method) NodeRedContext<{}>.set<"k", "a, b)" | [1, 2]>(key: "k", value: "a, b)" | [1, 2]): void'), '"a, b)" | [1, 2]');
        assert.equal(type('(method) NodeRedContext<{}>.set<number>(key: string, value: number, store: string): void (+5 overloads)'), undefined);
        assert.equal(type('(method) Map<string, number>.set(key: string, value: number): Map<string, number>'), undefined);
        assert.equal(type('const flow: NodeRedContext<{}>'), undefined);
    });
});
