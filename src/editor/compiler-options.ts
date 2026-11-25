import { monacoTypeScriptApi, monacoTypeScriptApiIfAvailable, describeMissingMonacoTypeScriptApi } from './monaco';

declare const $: any;

export interface CompilerOptionsResponse {
    /** In the compiler's own form (enum numbers, lib file names). */
    options: Record<string, unknown>;
    json: Record<string, unknown>;
    warnings: string[];
}

/** Asks the runtime to parse tsconfig text, so the editor and the deploy-time check interpret it identically. */
export function requestCompilerOptions(tsconfigText: string | undefined): Promise<CompilerOptionsResponse> {
    return new Promise((resolve, reject) => {
        $.ajax({
            url: 'typescript-node/compiler-options',
            type: 'POST',
            contentType: 'application/json',
            data: JSON.stringify({ tsconfig: tsconfigText || '' }),
        }).done(resolve).fail(reject);
    });
}

let latestRequest = 0;

export async function applyCompilerOptionsToMonaco(tsconfigText: string | undefined) {
    const request = ++latestRequest;
    const response = await requestCompilerOptions(tsconfigText);
    if (request !== latestRequest) return;
    // Type roots are directories on the runtime's disk; the editor gets Node's types from Node-RED instead.
    const { types, typeRoots, ...options } = response.options;
    // Monaco's own default; without it the worker rejects models whose URI has no .ts extension.
    monacoTypeScriptApi().typescriptDefaults.setCompilerOptions({ ...options, allowNonTsExtensions: true });
}

declare const RED: any;
declare const window: any;

function selectedTsconfigText(): string | undefined {
    const configNode = RED.nodes.node($("#node-input-tsconfig").val());
    return configNode ? configNode.tsconfig : undefined;
}

export function applyNodeCompilerOptions() {
    if (!monacoTypeScriptApiIfAvailable()) {
        console.warn(`[TS] No type checking in the editor: ${describeMissingMonacoTypeScriptApi()}`);
        return;
    }
    applyCompilerOptionsToMonaco(selectedTsconfigText()).catch(error => {
        console.warn("[TS] Failed to apply compiler options:", error);
    });
}

/** tsconfig files allow comments and trailing commas; Monaco's JSON checking is global, so the returned function puts it back. */
function allowJsonComments(): () => void {
    const jsonDefaults = window.monaco?.json?.jsonDefaults || window.monaco?.languages?.json?.jsonDefaults;
    if (!jsonDefaults) return () => {};
    const previous = jsonDefaults.diagnosticsOptions;
    jsonDefaults.setDiagnosticsOptions({ ...previous, allowComments: true, trailingCommas: "ignore" });
    return () => jsonDefaults.setDiagnosticsOptions(previous);
}

const DEFAULT_TSCONFIG_TEXT = `{
    "compilerOptions": {
        "strict": true
    }
}
`;

export function registerCompilerConfigNode() {
RED.nodes.registerType("typescript-config", {
    category: "config",
    defaults: {
        name: { value: "" },
        tsconfig: { value: DEFAULT_TSCONFIG_TEXT },
        persistentService: { value: false },
        idleTimeoutSeconds: { value: 30, validate: function (value: any) { return value === "" || Number(value) >= 0; } },
    },
    label: function (this: any) {
        return this.name || "tsconfig";
    },
    oneditprepare: function (this: any) {
        const node = this;
        node.restoreJsonDiagnostics = allowJsonComments();
        node.tsconfigEditor = RED.editor.createEditor({
            id: "node-config-input-tsconfig-editor",
            mode: "ace/mode/json",
            value: node.tsconfig || "",
        });

        let warningsTimer: any;
        let latestWarningRequest = 0;
        let closed = false;
        node.stopWarnings = () => { closed = true; latestWarningRequest++; clearTimeout(warningsTimer); };
        const showWarnings = () => {
            if (closed || !node.tsconfigEditor) return;
            const request = ++latestWarningRequest;
            requestCompilerOptions(node.tsconfigEditor.getValue()).then(response => {
                if (closed || request !== latestWarningRequest) return;
                const list = $("#node-config-tsconfig-warnings").empty();
                for (const warning of response.warnings) {
                    $("<li/>").text(warning).appendTo(list);
                }
                list.toggle(response.warnings.length > 0);
            }).catch(error => console.warn("[TS] Failed to validate tsconfig:", error));
        };
        node.tsconfigEditor.getSession().on("change", () => {
            clearTimeout(warningsTimer);
            warningsTimer = setTimeout(showWarnings, 500);
        });
        showWarnings();
    },
    oneditsave: function (this: any) {
        $("#node-config-input-tsconfig").val(this.tsconfigEditor.getValue());
        this.stopWarnings();
        this.tsconfigEditor.destroy();
        delete this.tsconfigEditor;
        this.restoreJsonDiagnostics();
    },
    oneditcancel: function (this: any) {
        this.stopWarnings();
        this.tsconfigEditor.destroy();
        delete this.tsconfigEditor;
        this.restoreJsonDiagnostics();
    },
    oneditresize: function (this: any, size: any) {
        const editorElement = $("#node-config-input-tsconfig-editor");
        let height = size.height;
        editorElement.closest("form").children(":visible").not(".node-text-editor-row").each(function (this: any) {
            height -= $(this).outerHeight(true) || 0;
        });
        editorElement.css("height", Math.max(150, height - 40) + "px");
        if (this.tsconfigEditor) this.tsconfigEditor.resize();
    },
});

}
