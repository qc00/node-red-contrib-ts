import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DeployTypeCheckCoordinator, TypeCheckNodeRegistration } from '../../src/compile/DeployTypeCheckCoordinator';
import { TypeScriptWorkerRequestHandler } from '../../src/worker/TypeScriptWorkerRequestHandler';
import { NodeSourceDefinition } from '../../src/compile/NodeVirtualSourceBuilder';

const PACKAGES: Record<string, string> = {
    'node_modules/esmlib/package.json': '{"name":"esmlib","type":"module","exports":{".":{"types":"./index.d.mts","default":"./index.mjs"}}}',
    'node_modules/esmlib/index.d.mts': [
        'export interface Opts { a: number }',
        'export default class Client { constructor(o: Opts); go(): string }',
        'export const helper: (o: Opts) => void;',
    ].join('\n'),
    'node_modules/nodef/package.json': '{"name":"nodef","type":"module","exports":{".":{"types":"./index.d.mts","default":"./index.mjs"}}}',
    'node_modules/nodef/index.d.mts': 'export interface Cfg { b: string }\nexport function make(c: Cfg): number;',
    'node_modules/cjslib/package.json': '{"name":"cjslib","main":"index.js","types":"index.d.ts"}',
    'node_modules/cjslib/index.d.ts': [
        'declare function cjslib(input: string): cjslib.Result;',
        'declare namespace cjslib { interface Result { ok: boolean } function parse(s: string): Result; }',
        'export = cjslib;',
    ].join('\n'),
    'node_modules/@types/typedonly/package.json': '{"name":"@types/typedonly","types":"index.d.ts"}',
    'node_modules/@types/typedonly/index.d.ts': 'import { Extra } from "./extra";\nexport declare function run(e: Extra): void;',
    'node_modules/@types/typedonly/extra.d.ts': 'export interface Extra { n: number }',
    'node_modules/@scope/srclib/package.json': '{"name":"@scope/srclib","version":"1.0.0"}',
    'node_modules/@scope/srclib/metrics.mts': 'import { Unit } from "./shared.mjs";\nexport function measure(u: Unit): number { return u.scale; }',
    'node_modules/@scope/srclib/metrics.mjs': 'export function measure(u) { return u.scale; }',
    'node_modules/@scope/srclib/shared.mts': 'export interface Unit { scale: number }',
    'node_modules/@scope/srclib/shared.mjs': 'export {};',
    'node_modules/typedonly/package.json': '{"name":"typedonly","main":"index.js"}',
    'node_modules/typedonly/index.js': 'exports.run = () => {};',
};

export class TypeCheckFixture {
    readonly userDir = realpathSync(mkdtempSync(join(tmpdir(), 'nr-ts-test-')));
    readonly warnings = new Map<string, string[]>();
    readonly log: string[] = [];
    readonly service: DeployTypeCheckCoordinator;

    constructor() {
        for (const [relativePath, content] of Object.entries(PACKAGES)) {
            const filePath = join(this.userDir, relativePath);
            mkdirSync(dirname(filePath), { recursive: true });
            writeFileSync(filePath, content);
        }
        const handler = new TypeScriptWorkerRequestHandler(this.userDir);
        this.service = new DeployTypeCheckCoordinator(
            (rev, targets, progress) => handler.handle('typeCheck', { rev, targets }, progress),
            () => false,
            { info: message => this.log.push(message), warn: message => this.log.push(message) },
        );
    }

    addNode(definition: Partial<NodeSourceDefinition> & { id: string }, tsconfig?: string, persistentService = false): TypeCheckNodeRegistration {
        const target: TypeCheckNodeRegistration = {
            definition: { flowId: 'flow1', libs: [], declare: '', initialize: '', func: '', finalize: '', ...definition },
            tsconfig,
            persistentService,
            log: () => {},
            warn: message => {
                const list = this.warnings.get(definition.id) || [];
                list.push(message);
                this.warnings.set(definition.id, list);
            },
        };
        this.service.register(definition.id, target);
        return target;
    }

    async check(rev = 'rev1') {
        this.warnings.clear();
        await this.service.schedule(rev);
    }

    warningsOf(nodeId: string): string {
        return (this.warnings.get(nodeId) || []).join('\n');
    }

    dispose() {
        rmSync(this.userDir, { recursive: true, force: true });
    }
}

export const STRICT = '{ "compilerOptions": { "strict": true } }';
