import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('the runtime bundle', () => {
    it('leaves the typescript package to the worker', () => {
        const dist = join(__dirname, '..', 'dist');
        assert.doesNotMatch(readFileSync(join(dist, 'typescript.js'), 'utf8'), /require\(["']typescript["']\)/);
        assert.match(readFileSync(join(dist, 'typescript-worker.js'), 'utf8'), /require\(["']typescript["']\)/);
    });
});
