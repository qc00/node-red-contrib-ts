import assert from 'node:assert/strict';
import { it } from 'node:test';
import { DeployTypeCheckCoordinator, TypeCheckRunner } from '../src/deploy-scheduler';

const empty = (rev?: string) => ({ rev, node: {}, flow: {}, global: {} });
const log = { info() {}, warn() {} };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

it('coalesces requests before checking and publishes only the latest revision', async () => {
    const revisions: (string | undefined)[] = [];
    const checks = new DeployTypeCheckCoordinator(async rev => {
        revisions.push(rev);
        return empty(rev);
    }, log);
    const first = checks.schedule('one');
    const second = checks.schedule('two');
    assert.equal(first, second);
    await second;
    assert.deepEqual(revisions, ['two']);
    assert.equal(checks.registry.rev, 'two');
});

it('does not publish an obsolete batch while a newer deploy is pending', async () => {
    const releases: (() => void)[] = [];
    const revisions: (string | undefined)[] = [];
    const checks = new DeployTypeCheckCoordinator(async rev => {
        revisions.push(rev);
        await new Promise<void>(resolve => releases.push(resolve));
        return empty(rev);
    }, log);
    const done = checks.schedule('one');
    await tick();
    checks.schedule('two');
    releases.shift()!();
    await tick();
    assert.equal(checks.registry.rev, undefined);
    assert.deepEqual(revisions, ['one', 'two']);
    releases.shift()!();
    await done;
    assert.equal(checks.registry.rev, 'two');
});

it('recovers after a failed batch', async () => {
    let fail = true;
    const warnings: string[] = [];
    const checks = new DeployTypeCheckCoordinator(async rev => {
        if (fail) throw new Error('test failure');
        return empty(rev);
    }, { info() {}, warn: message => warnings.push(message) });
    await checks.schedule('one');
    fail = false;
    await checks.schedule('two');
    assert.equal(warnings.length, 1);
    assert.equal(checks.registry.rev, 'two');
});
