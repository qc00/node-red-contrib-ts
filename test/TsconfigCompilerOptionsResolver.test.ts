import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { resolveCompilerOptions as resolveWith } from '../src/compile/TsconfigCompilerOptionsResolver';
import { startTypeScriptCompiler, TypeScriptCompiler } from '../src/compiler/TypeScriptCompiler';

const MODULE_KIND_NODE_NEXT = 199;
const MODULE_KIND_PRESERVE = 200;
const SCRIPT_TARGET_ES2023 = 10;

describe('resolveCompilerOptions', () => {
    let compiler: Promise<TypeScriptCompiler> | undefined;
    after(async () => (await compiler)?.close());
    const resolveCompilerOptions = async (text: string | undefined, basePath: string) =>
        resolveWith(await (compiler ??= startTypeScriptCompiler(process.cwd())), text, basePath);

    it('applies the defaults when there is no tsconfig', async () => {
        const resolved = await resolveCompilerOptions(undefined, '/base');
        assert.deepEqual(resolved.warnings, []);
        assert.equal(resolved.options.module, MODULE_KIND_NODE_NEXT);
        assert.equal(resolved.options.strict, false);
        assert.equal(resolved.options.noEmit, true);
        assert.equal(resolved.options.noErrorTruncation, true);
        assert.deepEqual(resolved.emitOptions, {});
    });

    it('accepts comments and trailing commas, warns about ignored keys and dropped options', async () => {
        const resolved = await resolveCompilerOptions(`{
            // a comment
            "compilerOptions": { "target": "es2023", "module": "preserve", "strict": true, "outDir": "x", "noEmit": false, },
            "include": ["src"],
            "exclude": [".backup",],
        }`, '/base');
        assert.equal(resolved.options.target, SCRIPT_TARGET_ES2023);
        assert.equal(resolved.options.module, MODULE_KIND_PRESERVE);
        assert.equal(resolved.options.moduleResolution, undefined);
        assert.equal(resolved.options.strict, true);
        assert.equal(resolved.options.outDir, undefined);
        assert.equal(resolved.options.noEmit, true);
        assert.deepEqual(resolved.emitOptions, { target: SCRIPT_TARGET_ES2023 });
        assert.deepEqual(resolved.warnings, [
            '"include" is ignored: only "compilerOptions" is used',
            '"exclude" is ignored: only "compilerOptions" is used',
            'compilerOptions.outDir is ignored: the node controls its own output',
        ]);
        assert.equal(resolved.json.moduleResolution, undefined);
    });

    it('reports invalid JSON and unknown options', async () => {
        assert.match((await resolveCompilerOptions('{ "compilerOptions": ', '/base')).warnings.join('\n'), /not valid JSON/);
        assert.match((await resolveCompilerOptions('{ "compilerOptions": { "strictt": true } }', '/base')).warnings.join('\n'), /Unknown compiler option 'strictt'/);
        assert.match((await resolveCompilerOptions('[]', '/base')).warnings.join('\n'), /must be an object/);
    });

    it('gives different keys to different effective options', async () => {
        const a = await resolveCompilerOptions('{ "compilerOptions": { "strict": true } }', '/base');
        const b = await resolveCompilerOptions('{ "compilerOptions": { "strict": true }, "include": [] }', '/base');
        assert.equal(a.key, b.key);
        assert.notEqual(a.key, (await resolveCompilerOptions('', '/base')).key);
    });
});
