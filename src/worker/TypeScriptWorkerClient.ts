import { Worker } from 'worker_threads';
import type { ContextTypeRegistrySnapshot } from '../compile/ContextTypeRegistry';
import type { ModuleTypeFiles } from '../compile/ModuleTypeFileCollector';
import type { TranspiledSections } from '../compile/NodeSectionTranspiler';
import {
    CompilerOptionsSummary,
    TypeCheckProgressEvent,
    TypeCheckRequestTarget,
    TypeScriptWorkerData,
    TypeScriptWorkerReplyMessage,
    TypeScriptWorkerRequestKind,
    TypeScriptWorkerRequestMessage,
    TypeScriptWorkerRequests,
    TypeScriptWorkerResults,
} from './TypeScriptWorkerProtocol';

export interface TypeScriptWorkerSettings {
    /** Never terminate the worker when idle. */
    keepAlive: boolean;
    idleTimeoutSeconds: number;
    /** Limit of the worker's old-generation heap; no limit when undefined. */
    maxHeapMb: number | undefined;
}

export interface TypeScriptWorkerLogger {
    info(message: string): void;
    warn(message: string): void;
}

/** A newer deploy needed the worker, so the running check was dropped. */
export class TypeCheckAbandonedError extends Error {
    constructor() { super('TypeScript type check abandoned for a newer deploy'); }
}

export const DEFAULT_IDLE_TIMEOUT_SECONDS = 30;
const MAX_ATTEMPTS = 2;

interface QueuedRequest {
    message: TypeScriptWorkerRequestMessage;
    attempts: number;
    resolve(result: any): void;
    reject(error: Error): void;
    progress?(event: TypeCheckProgressEvent): void;
}

interface RunningWorker {
    worker: Worker;
    maxHeapMb: number | undefined;
    startedAt: number;
    failure?: Error;
}

/** Runs everything that needs the `typescript` package in a worker thread, one request at a time. */
export class TypeScriptWorkerClient {
    private settings = new Map<string, TypeScriptWorkerSettings>();
    private queue: QueuedRequest[] = [];
    private inFlight: QueuedRequest | undefined;
    private running: RunningWorker | undefined;
    private idleTimer: NodeJS.Timeout | undefined;
    private nextId = 1;

    constructor(
        private readonly workerPath: string,
        private readonly userDir: string,
        private readonly log: TypeScriptWorkerLogger,
    ) {}

    registerSettings(ownerId: string, settings: TypeScriptWorkerSettings) {
        this.settings.set(ownerId, settings);
        this.pump();
    }

    unregisterSettings(ownerId: string) {
        this.settings.delete(ownerId);
        this.pump();
    }

    transpile(sources: string[], tsconfig: string | undefined): Promise<TranspiledSections> {
        return this.request('transpile', { sources, tsconfig });
    }

    resolveCompilerOptions(tsconfig: string | undefined): Promise<CompilerOptionsSummary> {
        return this.request('resolveCompilerOptions', { tsconfig });
    }

    collectModuleTypes(module: string): Promise<ModuleTypeFiles> {
        return this.request('collectModuleTypes', { module });
    }

    /** Rejects with `TypeCheckAbandonedError` when a transpile request arrives before the check has finished. */
    typeCheck(
        rev: string | undefined,
        targets: TypeCheckRequestTarget[],
        progress: (event: TypeCheckProgressEvent) => void,
    ): Promise<ContextTypeRegistrySnapshot> {
        return this.request('typeCheck', { rev, targets }, progress);
    }

    shutdown() {
        clearTimeout(this.idleTimer);
        this.discardWorker();
    }

    private request<K extends TypeScriptWorkerRequestKind>(
        kind: K,
        payload: TypeScriptWorkerRequests[K],
        progress?: (event: TypeCheckProgressEvent) => void,
    ): Promise<TypeScriptWorkerResults[K]> {
        return new Promise((resolve, reject) => {
            const queued: QueuedRequest = { message: { id: this.nextId++, kind, payload }, attempts: 0, resolve, reject, progress };
            if (kind === 'typeCheck') {
                this.queue.push(queued);
            } else {
                const firstTypeCheck = this.queue.findIndex(other => other.message.kind === 'typeCheck');
                this.queue.splice(firstTypeCheck < 0 ? this.queue.length : firstTypeCheck, 0, queued);
            }
            if (kind === 'transpile' && this.inFlight?.message.kind === 'typeCheck') {
                const abandoned = this.inFlight;
                this.inFlight = undefined;
                this.discardWorker();
                abandoned.reject(new TypeCheckAbandonedError());
            }
            this.pump();
        });
    }

    private effectiveSettings(): TypeScriptWorkerSettings {
        const all = [...this.settings.values()];
        const caps = all.map(settings => settings.maxHeapMb).filter((cap): cap is number => cap !== undefined);
        return {
            keepAlive: all.some(settings => settings.keepAlive),
            idleTimeoutSeconds: all.length ? Math.max(...all.map(settings => settings.idleTimeoutSeconds)) : DEFAULT_IDLE_TIMEOUT_SECONDS,
            maxHeapMb: caps.length ? Math.max(...caps) : undefined,
        };
    }

    private pump() {
        clearTimeout(this.idleTimer);
        if (this.inFlight) return;
        const settings = this.effectiveSettings();
        const next = this.queue.shift();
        if (!next) {
            if (this.running && !settings.keepAlive) {
                this.idleTimer = setTimeout(() => {
                    this.log.info(`TypeScript worker stopped after ${settings.idleTimeoutSeconds}s idle`);
                    this.discardWorker();
                }, settings.idleTimeoutSeconds * 1000);
                this.idleTimer.unref();
            }
            return;
        }
        // A node cannot run without its JavaScript, so a transpile that already failed once is not held to the limit.
        const maxHeapMb = next.message.kind === 'transpile' && next.attempts > 0 ? undefined : settings.maxHeapMb;
        if (this.running && this.running.maxHeapMb !== maxHeapMb) this.discardWorker();
        this.running ??= this.startWorker(maxHeapMb);
        this.inFlight = next;
        next.attempts++;
        this.running.worker.postMessage(next.message);
    }

    private startWorker(maxHeapMb: number | undefined): RunningWorker {
        const workerData: TypeScriptWorkerData = { userDir: this.userDir };
        const worker = new Worker(this.workerPath, {
            workerData,
            resourceLimits: maxHeapMb === undefined ? undefined : { maxOldGenerationSizeMb: maxHeapMb },
        });
        worker.unref();
        const running: RunningWorker = { worker, maxHeapMb, startedAt: Date.now() };
        worker.on('message', (reply: TypeScriptWorkerReplyMessage) => {
            if (this.running === running) this.onReply(running, reply);
        });
        worker.on('error', error => { running.failure = error; });
        worker.on('exit', code => {
            if (this.running === running) this.onUnexpectedExit(running, code);
        });
        return running;
    }

    private discardWorker() {
        const running = this.running;
        this.running = undefined;
        running?.worker.terminate();
    }

    private onReply(running: RunningWorker, reply: TypeScriptWorkerReplyMessage) {
        if (reply.type === 'ready') {
            const cap = running.maxHeapMb === undefined ? '' : `, heap limited to ${running.maxHeapMb}MB`;
            this.log.info(`TypeScript worker started in ${Date.now() - running.startedAt}ms${cap}`);
            return;
        }
        const request = this.inFlight;
        if (!request || request.message.id !== reply.id) return;
        if (reply.type === 'progress') {
            request.progress?.(reply.event);
            return;
        }
        this.inFlight = undefined;
        if (reply.type === 'result') request.resolve(reply.result);
        else request.reject(new Error(reply.message));
        this.pump();
    }

    private onUnexpectedExit(running: RunningWorker, code: number) {
        this.running = undefined;
        const reason = running.failure?.message || `exit code ${code}`;
        const cap = running.maxHeapMb === undefined ? '' : ` (heap limit ${running.maxHeapMb}MB)`;
        this.log.warn(`TypeScript worker stopped unexpectedly${cap}: ${reason}`);
        const request = this.inFlight;
        this.inFlight = undefined;
        if (request) {
            if (request.message.kind === 'transpile' && request.attempts < MAX_ATTEMPTS) this.queue.unshift(request);
            else request.reject(new Error(`TypeScript worker stopped unexpectedly${cap}: ${reason}`));
        }
        this.pump();
    }
}
