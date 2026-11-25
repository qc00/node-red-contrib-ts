import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TypeCheckFixture } from './support/TypeCheckFixture';

describe('collectModuleTypeFiles', () => {
    const packages = new TypeCheckFixture();
    after(async () => { await packages.dispose(); });
    const paths = async (moduleName: string) => (await packages.compiler.collectModuleTypes(moduleName)).files.map(file => file.path).sort();

    it('reports built-ins without reading files', async () => {
        const result = await packages.compiler.collectModuleTypes('node:fs/promises');
        assert.deepEqual({ builtin: result.builtin, files: result.files }, { builtin: true, files: [] });
        assert.ok(result.builtinModules!.includes('fs/promises') && result.builtinModules!.includes('stream'));
    });

    it('returns a package\'s own typings with its package.json', async () => {
        assert.deepEqual(await paths('esmlib'), ['node_modules/esmlib/index.d.mts', 'node_modules/esmlib/package.json']);
        assert.deepEqual(await paths('cjslib'), ['node_modules/cjslib/index.d.ts', 'node_modules/cjslib/package.json']);
    });

    it('falls back to @types and follows relative imports', async () => {
        assert.deepEqual(await paths('typedonly'), [
            'node_modules/@types/typedonly/extra.d.ts',
            'node_modules/@types/typedonly/index.d.ts',
            'node_modules/@types/typedonly/package.json',
        ]);
    });

    it('returns TypeScript sources of a package that ships them next to its JavaScript', async () => {
        assert.deepEqual(await paths('@scope/srclib/metrics.mjs'), [
            'node_modules/@scope/srclib/metrics.mts',
            'node_modules/@scope/srclib/package.json',
            'node_modules/@scope/srclib/shared.mts',
        ]);
    });

    it('serves a symlinked package under its node_modules path', async () => {
        const target = join(packages.userDir, 'linked-source');
        mkdirSync(target);
        writeFileSync(join(target, 'package.json'), '{"name":"linked","types":"index.d.ts"}');
        writeFileSync(join(target, 'index.d.ts'), 'export declare const linked: number;');
        symlinkSync(target, join(packages.userDir, 'node_modules', 'linked'), 'dir');
        assert.deepEqual(await paths('linked'), ['node_modules/linked/index.d.ts', 'node_modules/linked/package.json']);
    });

    it('returns nothing for unknown modules and paths outside node_modules', async () => {
        assert.deepEqual(await paths('does-not-exist'), []);
        assert.deepEqual(await paths('../../etc/passwd'), []);
        assert.deepEqual(await paths('./node_modules/../../x'), []);
    });
});
