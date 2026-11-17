import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { collectModuleTypeFiles } from '../src/compile/ModuleTypeFileCollector';
import { TypeCheckFixture } from './support/TypeCheckFixture';

describe('collectModuleTypeFiles', () => {
    const packages = new TypeCheckFixture();
    after(() => packages.dispose());
    const paths = (moduleName: string) => collectModuleTypeFiles(moduleName, packages.userDir).files.map(file => file.path).sort();

    it('reports built-ins without reading files', () => {
        const result = collectModuleTypeFiles('node:fs/promises', packages.userDir);
        assert.deepEqual({ builtin: result.builtin, files: result.files }, { builtin: true, files: [] });
        assert.ok(result.builtinModules!.includes('fs/promises') && result.builtinModules!.includes('stream'));
    });

    it('returns a package\'s own typings with its package.json', () => {
        assert.deepEqual(paths('esmlib'), ['node_modules/esmlib/index.d.mts', 'node_modules/esmlib/package.json']);
        assert.deepEqual(paths('cjslib'), ['node_modules/cjslib/index.d.ts', 'node_modules/cjslib/package.json']);
    });

    it('falls back to @types and follows relative imports', () => {
        assert.deepEqual(paths('typedonly'), [
            'node_modules/@types/typedonly/extra.d.ts',
            'node_modules/@types/typedonly/index.d.ts',
            'node_modules/@types/typedonly/package.json',
        ]);
    });

    it('returns TypeScript sources of a package that ships them next to its JavaScript', () => {
        assert.deepEqual(paths('@scope/srclib/metrics.mjs'), [
            'node_modules/@scope/srclib/metrics.mts',
            'node_modules/@scope/srclib/package.json',
            'node_modules/@scope/srclib/shared.mts',
        ]);
    });

    it('returns nothing for unknown modules and paths outside node_modules', () => {
        assert.deepEqual(paths('does-not-exist'), []);
        assert.deepEqual(paths('../../etc/passwd'), []);
        assert.deepEqual(paths('./node_modules/../../x'), []);
    });
});
