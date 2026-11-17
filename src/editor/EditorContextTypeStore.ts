import { ContextTypeRegistry, ContextTypeRegistrySnapshot, InferredContextSet } from '../compile/ContextTypeRegistry';
import { generateContextDeclarations } from '../env/ContextTypeDeclarationGenerator';

declare const RED: any;
declare const $: any;

/** The as-deployed context key types, overlaid with what the user has edited since. */
export class EditorContextTypeStore {
    private registry = new ContextTypeRegistry();
    private checkpointed: ContextTypeRegistrySnapshot | undefined;

    /** Replaces the registry with the server's, unless the server has since deployed other flows than the editor holds. */
    refresh() {
        $.getJSON('typescript-node/context-types').done((snapshot: ContextTypeRegistrySnapshot) => {
            const editorRev = RED.nodes.version();
            if (snapshot.rev && editorRev && snapshot.rev !== editorRev) return;
            this.registry = new ContextTypeRegistry(snapshot);
        });
    }

    /** Remembers the types as they are when an edit dialog opens. */
    checkpoint() {
        this.checkpointed = JSON.parse(JSON.stringify(this.registry));
    }

    /** Discards what was inferred from an edit that was cancelled. */
    rollback() {
        if (this.checkpointed) this.registry = new ContextTypeRegistry(this.checkpointed);
    }

    replaceContributor(nodeId: string, flowId: string, sets: InferredContextSet[]) {
        this.registry.replaceContributor(nodeId, flowId, sets);
    }

    declarationsFor(nodeId: string, flowId: string): string {
        return generateContextDeclarations(this.registry.keyTypesFor(nodeId, flowId));
    }
}
