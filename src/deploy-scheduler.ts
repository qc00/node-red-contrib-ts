import type { TypeCheckProgressSink } from './type-checker';
import { ContextTypeRegistry, ContextTypeRegistrySnapshot } from './context-types';
import type { NodeSourceDefinition } from './node-source';

export interface TypeCheckRequestTarget {
    /** Unique per running node; several subflow instances share one definition id. */
    instanceId: string;
    definition: NodeSourceDefinition;
    tsconfig: string | undefined;
}

export interface TypeCheckNodeRegistration {
    definition: NodeSourceDefinition;
    tsconfig: string | undefined;
    log(message: string): void;
    warn(message: string): void;
}

export interface TypeCheckLogger {
    info(message: string): void;
    warn(message: string): void;
}

export type TypeCheckRunner = (
    rev: string | undefined,
    targets: TypeCheckRequestTarget[],
    progress: TypeCheckProgressSink,
) => Promise<ContextTypeRegistrySnapshot>;

const yieldToEventLoop = () => new Promise<void>(resolve => setImmediate(resolve));

/** Knows the live typescript nodes, has them checked after each deploy and holds the resulting context key types. */
export class DeployTypeCheckCoordinator {
    private registrations = new Map<string, TypeCheckNodeRegistration>();
    private latestRegistry = new ContextTypeRegistry();
    /** What each running node was last told, so an unchanged node is not warned again on every deploy. */
    private reportedProblems = new WeakMap<TypeCheckNodeRegistration, string>();
    private requestedRev: string | undefined;
    private pending = false;
    private running: Promise<void> | undefined;

    constructor(
        private readonly runner: TypeCheckRunner,
        private readonly log: TypeCheckLogger,
    ) {}

    /** `instanceId` is unique per running node; several subflow instances share one definition id. */
    register(instanceId: string, registration: TypeCheckNodeRegistration) { this.registrations.set(instanceId, registration); }
    unregister(instanceId: string) { this.registrations.delete(instanceId); }

    usesModule(moduleName: string): boolean {
        for (const registration of this.registrations.values()) {
            if (registration.definition.libs.some(lib => lib.module === moduleName)) return true;
        }
        return false;
    }

    /** The registry of the last completed batch. */
    get registry(): ContextTypeRegistry { return this.latestRegistry; }

    whenIdle(): Promise<void> { return this.running ?? Promise.resolve(); }

    schedule(rev: string | undefined): Promise<void> {
        this.requestedRev = rev;
        this.pending = true;
        return this.running ??= this.drain();
    }

    private async drain() {
        await yieldToEventLoop();
        while (this.pending) {
            this.pending = false;
            try {
                await this.runBatch(this.requestedRev);
            } catch (error: any) {
                this.log.warn(`TypeScript type check failed: ${error?.message || error}`);
            }
        }
        this.running = undefined;
    }

    private async runBatch(rev: string | undefined) {
        const batch = new Map(this.registrations);
        const targets: TypeCheckRequestTarget[] = [...batch].map(([instanceId, registration]) => ({
            instanceId,
            definition: registration.definition,
            tsconfig: registration.tsconfig,
        }));

        const currentRegistration = (id: string) => {
            const registration = batch.get(id);
            return !this.pending && this.registrations.get(id) === registration ? registration : undefined;
        };
        const snapshot = await this.runner(rev, targets, {
            info: message => this.log.info(message),
            nodeLog: (id, message) => currentRegistration(id)?.log(message),
            nodeWarn: (id, message) => currentRegistration(id)?.warn(message),
            nodeReport: (id, message) => {
                const registration = currentRegistration(id);
                if (registration) this.report(registration, message);
            },
        });
        // A deploy that arrived meanwhile has scheduled its own check; this result describes nodes that are gone.
        if (!this.pending) this.latestRegistry = new ContextTypeRegistry(snapshot);
    }

    private report(registration: TypeCheckNodeRegistration, report: string) {
        if (report !== (this.reportedProblems.get(registration) ?? '')) {
            registration.warn(report || 'TypeScript type check found no problems any more');
        }
        this.reportedProblems.set(registration, report);
    }
}
