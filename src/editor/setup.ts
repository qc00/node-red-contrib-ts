import { generateEditorModuleDeclaration, ModuleLib, usableModuleLibs, NODE_RED_ENV_DECLARATION_SOURCE, NODE_RED_SANDBOX_VALUE_DECLARATIONS } from '../declarations';
import { inferContextSetsWithQuickInfo, EditorContextTypeStore } from './context-types';
import { EditorModuleTypeLoader } from './module-types';
import { monacoTypeScriptApi, removeExtraLibsWhere } from './monaco';

declare const window: any;
export const contextTypeStore = new EditorContextTypeStore();
export const moduleTypeLoader = new EditorModuleTypeLoader();
function throwRequired(name: string): never { throw new Error(name + ' is required'); }

export const customDeclarePath = 'file:///custom-declare.d.ts'
const envDeclarePath = 'file:///node-red-ts-env.d.ts';
const contextDeclarePath = 'file:///node-red-ts-context.d.ts';
const moduleDeclarePathPrefix = 'file:///node-red-ts-libs/module/';

// Node-RED's own sandbox declarations are looser than ours and would clash with them.
const replacedNodeRedLibPattern = /types\/(node-red\/(func|util)|extraModuleLibs|other)\//;
const nodeGlobalsLibPattern = /types\/node\/globals\/index\.d\.ts$/;
const nodeGlobalDeclaration = 'declare var global: typeof globalThis;';

function copyNodeRedTypeLibs(mts: any) {
    // Libs loaded by the extraLibs option of RED.editor.createEditor
    // (node-red/packages/node_modules/@node-red/editor-client/src/js/ui/editors/code-editors/monaco.js)
    const jsLibs: Record<string, { content: string }> = mts.javascriptDefaults.getExtraLibs();
    const tsLibs: Record<string, { content: string }> = mts.typescriptDefaults.getExtraLibs();
    for (const uri of Object.keys(jsLibs)) {
        if (replacedNodeRedLibPattern.test(uri) || !jsLibs[uri]?.content) continue;
        const content = nodeGlobalsLibPattern.test(uri)
            ? jsLibs[uri].content.replace(nodeGlobalDeclaration, '')
            : jsLibs[uri].content;
        if (tsLibs[uri]?.content !== content) mts.typescriptDefaults.addExtraLib(content, uri);
    }
}

function setExtraLib(mts: any, content: string, filePath: string) {
    if (mts.typescriptDefaults.getExtraLibs()[filePath]?.content !== content) {
        mts.typescriptDefaults.addExtraLib(content, filePath);
    }
}

function applyModuleDeclarations(mts: any, libs: ModuleLib[] | undefined) {
    const declarations = new Map<string, string>();
    for (const lib of usableModuleLibs(libs)) {
        declarations.set(`${moduleDeclarePathPrefix}${lib.var}.d.ts`, generateEditorModuleDeclaration(lib));
        moduleTypeLoader.load(lib.module);
    }
    removeExtraLibsWhere(filePath => filePath.startsWith(moduleDeclarePathPrefix) && !declarations.has(filePath));
    for (const [filePath, content] of declarations) setExtraLib(mts, content, filePath);
}

function applyContextDeclarations(mts: any) {
    const node = window.currentNodeInstance;
    if (node) setExtraLib(mts, contextTypeStore.declarationsFor(node.id, node.z || ''), contextDeclarePath);
}

export function configMonaco(editor: any, customDeclare: any, nodeLibs?: any[]) {
    const monaco = window.monaco || throwRequired("monaco");
    const mts = monacoTypeScriptApi();
    const tsEditor = editor || throwRequired("tsEditor");
    const tsConfig = mts.typescriptDefaults || throwRequired("tsConfig");

    copyNodeRedTypeLibs(mts);
    setExtraLib(
        mts,
        `${NODE_RED_ENV_DECLARATION_SOURCE}\n${NODE_RED_SANDBOX_VALUE_DECLARATIONS}declare var msg: NodeMessage;\n`,
        envDeclarePath,
    );
    applyModuleDeclarations(mts, nodeLibs);
    applyContextDeclarations(mts);
    setExtraLib(mts, customDeclare ?? '', customDeclarePath);

    tsConfig.setDiagnosticsOptions({
        noSemanticValidation: false,
        noSyntaxValidation: false,
        noSuggestionDiagnostics: false,
        diagnosticCodesToIgnore: [
            2451, // Cannot redeclare block-scoped variable 'msg'.
            1375, // 'await' expressions are only allowed at the top level of a file when that file is a module
            1378, // Top-level 'await' expressions are only allowed when the 'module' option is set to 'es2022'
            1108, // A 'return' statement can only be used within a function body
            1309, // The current file is a CommonJS module and cannot use 'await' at the top level
            1431, // 'for await' loops are only allowed at the top level of a file when that file is a module
            1432, // Top-level 'for await' loops are only allowed when the 'module' option is set to 'es2022'
        ],
    });

    // Configure individual editor model
    const tsModel = tsEditor.getModel();
    if (tsModel) {
        if (
            !tsModel.uri.path.endsWith(".ts") ||
            tsModel.getLanguageId() !== "typescript"
        ) {
            // Generate unique URI for this editor
            const uniqueId = tsEditor.getId
                ? tsEditor.getId()
                : Math.random().toString(36).substr(2, 9);
            const tsUri = monaco.Uri.parse(`file:///ts-${uniqueId}.ts`);

            // Check if model already exists with this URI
            let existingModel = monaco.editor.getModel(tsUri);
            if (existingModel) {
                tsEditor.setModel(existingModel);
            } else {
                const newModel = monaco.editor.createModel(
                    tsModel.getValue(),
                    "typescript",
                    tsUri,
                );
                tsEditor.setModel(newModel);
            }
        } else {
            // Force language to typescript if not already set
            if (tsModel.getLanguageId() !== "typescript") {
                monaco.editor.setModelLanguage(tsModel, "typescript");
            }
        }
    } else {
        console.warn("[TS] configMonaco no model found on editor");
    }
}

export function removeExtraLib(filePath: string) {
    const monaco = window.monaco;
    if (!monaco) throw new Error("monaco not found");

    const model = monaco.editor.getModel(monaco.Uri.parse(filePath));
    if (model) model.dispose();

    removeExtraLibsWhere(path => path === filePath);
}

const CONTEXT_INFERENCE_DELAY_MS = 800;
let contextInferenceTimer: any;

async function quickInfoTextAt(editor: any, offset: number): Promise<string | undefined> {
    const model = editor.getModel();
    if (!model || model.getLanguageId() !== "typescript") return undefined;
    const getWorker = await monacoTypeScriptApi().getTypeScriptWorker();
    const worker = await getWorker(model.uri);
    const quickInfo = await worker.getQuickInfoAtPosition(model.uri.toString(), offset);
    return quickInfo?.displayParts?.map((part: any) => part.text).join("");
}

/** Re-derives what the open node stores in context from its three code tabs and refreshes the `get` types. */
async function inferOpenNodeContextSets(node: any) {
    const sets: any[] = [];
    for (const editor of [node.initEditor, node.editor, node.finalizeEditor]) {
        if (!editor || editor.type !== "monaco") return;
        sets.push(...await inferContextSetsWithQuickInfo(editor.getValue(), offset => quickInfoTextAt(editor, offset)));
    }
    if (window.currentNodeInstance !== node || !node.editor) return;
    contextTypeStore.replaceContributor(node.id, node.z || "", sets);
    applyContextDeclarations(monacoTypeScriptApi());
}

// Each call site costs a round trip to the TypeScript worker and a changed declaration
// re-validates every open model, so inference waits for a pause in typing.
export function scheduleContextInference(node: any) {
    clearTimeout(contextInferenceTimer);
    contextInferenceTimer = setTimeout(() => {
        inferOpenNodeContextSets(node).catch(error => console.warn("[TS] Context type inference failed:", error));
    }, CONTEXT_INFERENCE_DELAY_MS);
}

export function cancelContextInference() { clearTimeout(contextInferenceTimer); }
