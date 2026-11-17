import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import ts from 'typescript';
import { resolveCompilerOptions } from '../src/compile/TsconfigCompilerOptionsResolver';

describe('resolveCompilerOptions', () => {
    it('applies the defaults when there is no tsconfig', () => {
        const resolved = resolveCompilerOptions(undefined, '/base');
        assert.deepEqual(resolved.warnings, []);
        assert.equal(resolved.options.module, ts.ModuleKind.NodeNext);
        assert.equal(resolved.options.strict, undefined);
        assert.equal(resolved.options.noEmit, true);
        assert.equal(resolved.options.noErrorTruncation, true);
        assert.deepEqual(resolved.emitOptions, {});
    });

    it('accepts comments and trailing commas, warns about ignored keys and dropped options', () => {
        const resolved = resolveCompilerOptions(`{
            // a comment
            "compilerOptions": { "target": "es2023", "module": "preserve", "strict": true, "outDir": "x", "noEmit": false, },
            "include": ["src"],
            "exclude": [".backup",],
        }`, '/base');
        assert.equal(resolved.options.target, ts.ScriptTarget.ES2023);
        assert.equal(resolved.options.module, ts.ModuleKind.Preserve);
        assert.equal(resolved.options.moduleResolution, undefined);
        assert.equal(resolved.options.strict, true);
        assert.equal(resolved.options.outDir, undefined);
        assert.equal(resolved.options.noEmit, true);
        assert.deepEqual(resolved.emitOptions, { target: ts.ScriptTarget.ES2023 });
        assert.deepEqual(resolved.warnings, [
            '"include" is ignored: only "compilerOptions" is used',
            '"exclude" is ignored: only "compilerOptions" is used',
            'compilerOptions.outDir is ignored: the node controls its own output',
        ]);
        assert.equal(resolved.json.moduleResolution, undefined);
    });

    it('reports invalid JSON and unknown options', () => {
        assert.match(resolveCompilerOptions('{ "compilerOptions": ', '/base').warnings.join('\n'), /not valid JSON/);
        assert.match(resolveCompilerOptions('{ "compilerOptions": { "strictt": true } }', '/base').warnings.join('\n'), /Unknown compiler option 'strictt'/);
        assert.match(resolveCompilerOptions('[]', '/base').warnings.join('\n'), /must be an object/);
    });

    it('gives different keys to different effective options', () => {
        const a = resolveCompilerOptions('{ "compilerOptions": { "strict": true } }', '/base');
        const b = resolveCompilerOptions('{ "compilerOptions": { "strict": true }, "include": [] }', '/base');
        assert.equal(a.key, b.key);
        assert.notEqual(a.key, resolveCompilerOptions('', '/base').key);
    });
});
