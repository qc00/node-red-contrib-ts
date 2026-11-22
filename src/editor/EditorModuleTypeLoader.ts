import type { ModuleTypeFiles } from '../compile/ModuleTypeFileCollector';
import { monacoTypeScriptApi, monacoTypeScriptApiIfAvailable, removeExtraLibsWhere } from './MonacoTypeScriptApi';

declare const $: any;

const UNTYPED_MODULE_LIB_PREFIX = 'file:///node-red-ts-libs/untyped/';
const BUILTIN_REFERENCE_PATTERN = /(?:from\s+|import\(\s*)["'](?:node:)?([a-z_/]+)["']/g;
const MAX_BUILTIN_DECLARATION_FILES = 60;

/** Registers the typings of imported modules with Monaco: Node built-ins from Node-RED, npm packages from the runtime. */
export class EditorModuleTypeLoader {
    private loaded = new Set<string>();
    private builtinFilesRequested = new Set<string>();
    private builtinModules = new Set<string>();

    load(moduleName: string) {
        if (this.loaded.has(moduleName)) return;
        this.loaded.add(moduleName);
        $.getJSON('typescript-node/module-types', { module: moduleName })
            .done((result: ModuleTypeFiles) => {
                if (result.builtin) {
                    for (const name of result.builtinModules || []) this.builtinModules.add(name);
                    this.loadBuiltin(moduleName.replace(/^node:/, ''));
                } else if (result.files.length) {
                    const tsDefaults = monacoTypeScriptApi().typescriptDefaults;
                    for (const file of result.files) tsDefaults.addExtraLib(file.content, `file:///${file.path}`);
                } else {
                    this.declareUntyped(moduleName);
                }
            })
            .fail(() => this.declareUntyped(moduleName));
    }

    /** Modules may have been installed by a deploy, so the ones without typings are worth asking about again. */
    retryUntyped() {
        const api = monacoTypeScriptApiIfAvailable();
        if (!api) return;
        const untyped = Object.keys(api.typescriptDefaults.getExtraLibs())
            .filter(filePath => filePath.startsWith(UNTYPED_MODULE_LIB_PREFIX))
            .map(filePath => decodeURIComponent(filePath.slice(UNTYPED_MODULE_LIB_PREFIX.length, -'.d.ts'.length)));
        if (!untyped.length) return;
        removeExtraLibsWhere(filePath => filePath.startsWith(UNTYPED_MODULE_LIB_PREFIX));
        for (const moduleName of untyped) {
            this.loaded.delete(moduleName);
            this.load(moduleName);
        }
    }

    private declareUntyped(moduleName: string) {
        monacoTypeScriptApi().typescriptDefaults.addExtraLib(
            `declare module ${JSON.stringify(moduleName)};\n`,
            `${UNTYPED_MODULE_LIB_PREFIX}${encodeURIComponent(moduleName)}.d.ts`,
        );
    }

    /** Loads a Node built-in's declarations from Node-RED's bundled types, following its references to other built-ins. */
    private loadBuiltin(name: string) {
        if (this.builtinFilesRequested.has(name) || this.builtinFilesRequested.size >= MAX_BUILTIN_DECLARATION_FILES) return;
        this.builtinFilesRequested.add(name);
        $.get({ url: `types/node/${name}.d.ts`, dataType: 'text' }).done((content: string) => {
            monacoTypeScriptApi().typescriptDefaults.addExtraLib(content, `file://types/node/${name}/index.d.ts`);
            for (const reference of content.matchAll(BUILTIN_REFERENCE_PATTERN)) {
                if (this.builtinModules.has(reference[1])) this.loadBuiltin(reference[1]);
            }
        }).fail(() => {
            // Node-RED does not bundle declarations for every built-in; the module then stays untyped.
        });
    }
}
