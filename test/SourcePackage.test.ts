import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { TypeCheckFixture } from './support/TypeCheckFixture';

describe('a package that ships TypeScript sources instead of declarations', () => {
    const fixture = new TypeCheckFixture();
    after(() => fixture.dispose());

    it('is typed at deploy', async () => {
        fixture.addNode({
            id: 'n1',
            libs: [{ var: 'metrics', module: '@scope/srclib/metrics.mjs' }],
            func: 'const n: number = metrics.measure({ scale: 2 });\nmetrics.measure({ scale: "x" });\nreturn msg;',
        });
        await fixture.check();
        assert.match(fixture.warningsOf('n1'), /found 1 problem[\s\S]*\[On Message 2:\d+\] TS2322/);
    });
});
