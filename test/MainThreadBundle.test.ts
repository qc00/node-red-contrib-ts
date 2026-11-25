import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('the runtime bundle', () => {
    it('loads the ESM-only typescript package with import() and has no worker bundle', () => {
        const dist = join(__dirname, '..', 'dist');
        const bundle = readFileSync(join(dist, 'typescript.js'), 'utf8');
        assert.doesNotMatch(bundle, /require\(["']typescript/);
        assert.match(bundle, /import\(["']typescript\/async["']\)/);
        assert.equal(existsSync(join(dist, 'typescript-worker.js')), false);
    });
});
