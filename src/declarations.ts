

export const NODE_RED_ENV_DECLARATION_FILE_NAME = 'node-red-ts-env.d.ts';

/**
 * Ambient types of the Node-RED function sandbox, shared by the editor and the deploy-time check.
 * The values `context`, `flow` and `global` are declared per node by `generateContextDeclarations`.
 */
export const NODE_RED_ENV_DECLARATION_SOURCE = `
type NodeRedImportedModule<N> = N extends { default: infer D }
    ? (D extends null | undefined | false | 0 | '' ? N : D)
    : N;

interface NodeRedContext<M = {}> {
    get<K extends keyof M & string>(key: K): M[K] | undefined;
    get<T = any, K extends string = string>(key: K extends keyof M ? never : K): T | undefined;
    get<T = any>(keys: string[]): (T | undefined)[];
    get<T = any>(key: string, callback: (err: Error | null, value: T) => void): void;
    get<T = any>(keys: string[], callback: (err: Error | null, ...values: T[]) => void): void;
    get<T = any>(key: string, store: string): T | undefined;
    get<T = any>(key: string, store: string, callback: (err: Error | null, value: T) => void): void;

    set<K extends string, V>(key: K, value: V): void;
    set<T = any>(keys: string[], values: T[]): void;
    set<T = any>(key: string, value: T, callback: (err: Error | null) => void): void;
    set<T = any>(keys: string[], values: T[], callback: (err: Error | null) => void): void;
    set<T = any>(key: string, value: T, store: string): void;
    set<T = any>(key: string, value: T, store: string, callback: (err: Error | null) => void): void;

    keys(): string[];
    keys(callback: (err: Error | null, keys: string[]) => void): void;
    keys(store: string): string[];
    keys(store: string, callback: (err: Error | null, keys: string[]) => void): void;
}

interface NodeMessage {
    _msgid?: string;
    topic?: string;
    [other: string]: any;
}
type NodeRedBaseMessage = NodeMessage;

interface Message<T = any> {
    topic: string;
    payload: T;
    [rest: string]: any;
}

type NodeRedOutputMessage = { [key: string]: any } | null | undefined;
type NodeRedSendable = NodeRedOutputMessage | (NodeRedOutputMessage | NodeRedOutputMessage[])[];

type NodeRedStatusFill = 'red' | 'green' | 'yellow' | 'blue' | 'grey';
type NodeRedStatusShape = 'ring' | 'dot';

interface NodeRedStatus {
    fill?: NodeRedStatusFill;
    shape?: NodeRedStatusShape;
    text?: string;
}

interface NodeRedFunctionNode {
    readonly id: string;
    readonly name: string;
    readonly path: string;
    readonly outputCount: number;
    readonly packageVersion: string;
    readonly buildDate: string;

    log(message: string): void;
    warn(message: string): void;
    error(message: string, msg?: any): void;
    debug(message: string): void;
    trace(message: string): void;

    send(msg: NodeRedSendable, clone?: boolean): void;
    done(err?: any): void;

    status(status: NodeRedStatus): void;
    on(event: 'close', callback: () => void): void;
}

interface NodeRedEnv {
    get(name: string): any;
}

interface NodeRedSandboxApi {
    util: {
        cloneMessage<T>(msg: T): T;
        getSetting(node: any, name: string): any;
        encodeObject(msg: any, opts?: any): any;
        ensureString(o: any): string;
        ensureBuffer(o: any): Buffer;
        compareObjects(obj1: any, obj2: any): boolean;
        generateId(): string;
        getMessageProperty(msg: object, expr: string): any;
        setMessageProperty(msg: object, prop: string, value?: any, createMissing?: boolean): boolean;
        getObjectProperty(msg: object, expr: string): any;
        setObjectProperty(msg: object, prop: string, value?: any, createMissing?: boolean): boolean;
        evaluateNodeProperty(value: string, type: string, node: any, msg: any, callback?: (err: Error | null, result?: any) => void): any;
        normalisePropertyExpression(str: string): any[];
        normaliseNodeTypeName(name: string): string;
        prepareJSONataExpression(value: string, node: any): any;
        evaluateJSONataExpression(expr: any, msg: any, callback?: (err: Error | null, result?: any) => void): any;
        parseContextStore(key: string): { store?: string; key: string };
    };
}
`;

/** Values that are the same for every node; emitted globally in the editor and per module on the server. */
export const NODE_RED_SANDBOX_VALUE_DECLARATIONS = `declare const node: NodeRedFunctionNode;
declare const env: NodeRedEnv;
declare const RED: NodeRedSandboxApi;
declare const __global: typeof globalThis;
`;

export interface ModuleLib {
    var: string;
    module: string;
}

const IDENTIFIER_PATTERN = /^[A-Za-z_$][\w$]*$/;

export function usableModuleLibs(libs: ModuleLib[] | undefined): ModuleLib[] {
    return (libs || []).filter(lib => lib && lib.module && IDENTIFIER_PATTERN.test(lib.var || ''));
}

export interface ServerModuleImports {
    /** One `import * as y from 'x'` per line; gives `y` its type namespace. */
    imports: string;
    /** Wrapper parameters shadowing each import with the value the runtime injects. */
    parameters: string[];
}

export function generateServerModuleImports(libs: ModuleLib[] | undefined): ServerModuleImports {
    const usable = usableModuleLibs(libs);
    return {
        imports: usable.map(lib => `import * as ${lib.var} from ${JSON.stringify(lib.module)};\n`).join(''),
        parameters: usable.map(lib => `${lib.var}: NodeRedImportedModule<typeof import(${JSON.stringify(lib.module)})>`),
    };
}

/**
 * A module declaration file that makes `y` global for the editor's bare function body:
 * the alias carries the type namespace, the const carries the value the runtime injects.
 */
export function generateEditorModuleDeclaration(lib: ModuleLib): string {
    return [
        `import * as __ns from ${JSON.stringify(lib.module)};`,
        'declare global {',
        `    export import ${lib.var} = __ns;`,
        `    const ${lib.var}: NodeRedImportedModule<typeof __ns>;`,
        '}',
        '',
    ].join('\n');
}
