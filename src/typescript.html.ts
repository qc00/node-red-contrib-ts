import { libsWithNodeRedBundledTypes } from './editor/module-types';
import { applyNodeCompilerOptions, registerCompilerConfigNode } from './editor/compiler-options';
import { contextTypeStore, moduleTypeLoader, customDeclarePath, configMonaco, removeExtraLib, scheduleContextInference, cancelContextInference } from './editor/setup';
import { describeMissingMonacoTypeScriptApi, monacoTypeScriptApiIfAvailable } from './editor/monaco';


declare const RED: any;
declare const window: typeof globalThis & {
    monaco: any;
    currentNodeInstance: any;
};


RED.events.on("flows:loaded", () => contextTypeStore.refresh());
RED.events.on("deploy", () => {
    contextTypeStore.refresh();
    moduleTypeLoader.retryUntyped();
});
if (RED.nodes.version && RED.nodes.version()) contextTypeStore.refresh();

function tr(key: string, params?: Record<string, string | number>) {
    var result = RED._("node-red:" + key);
    if (params) {
        for (var k in params) {
            result = result.replace("{" + k + "}", params[k]);
        }
    }
    return result;
}

function getLabel(this: any) {
    if (this.name) return this.name;

    let script = this.func || "";
    for (
        const [key, label] of Object.entries({
            "fetch(": "🌐 Fetch",
            "fs.": "📁 File",
            "crypto.": "🔐 Crypto",
            "setTimeout": "⏰ Timer",
            "setInterval": "🔄 Loop",
            "process.": "⚙️ Process",
            "JSON.": "📄 JSON",
            "Buffer": "🔢 Buffer",
        })
    ) {
        if (script.includes(key)) return label;
    }

    // Extract keywords, limit to 20 chars
    const e = {
        const: 1,
        let: 1,
        var: 1,
        msg: 1,
        payload: 1,
        as: 1,
        any: 1,
        string: 1,
        number: 1,
        return: 1,
        null: 1,
    };
    let s = "";
    const ws = script.toLowerCase().match(/\w\w+/g) || [];
    for (let w of ws) {
        if (!e[w]) {
            e[w] = 1;
            const n = s ? s + " " + w : w;
            if (n.length <= 20) s = n;
            else break;
        }
    }
    if (s) return s;

    return "typescript";
}

function throwRequired(msg: string) {
    throw new Error(msg + " is required");
}

function onTsEditorReady(editor: any) {
    if (editor.type === "monaco") {

        // Get current declarations from the node instance
        let customDeclare = null;
        if (
            window.currentNodeInstance &&
            window.currentNodeInstance.declareEditor
        ) {
            customDeclare = window.currentNodeInstance.declareEditor.getValue();
        }

        try {
            // Get current node's libs for dynamic module declarations
            const nodeLibs = window.currentNodeInstance ? getLibsList() : [];
            configMonaco(editor, customDeclare, nodeLibs);

            // Verify configuration
            const model = editor.getModel();
            if (!model) {
                console.warn(
                    "[TS] configTsEditor verification failed - no model found",
                );
            }
        } catch (error) {
            console.error(
                "[TS] configTsEditor Monaco configuration error:",
                error,
            );
        }
    } else {
        console.warn(
            "[TS] configTsEditor editor type is not Monaco:",
            editor.type,
        );
    }
}

function configTsEditor(options: any, that: any) {
    const tsOptions = {
        ...options,
        mode: "ace/mode/typescript",
        language: "typescript",
        globals: {
            msg: true,
            node: true,
            context: true,
            RED: true,
            flow: true,
            global: true,
            env: true,
            console: true,
            Buffer: true,
            process: true,
            fetch: true,
            setTimeout: true,
            clearTimeout: true,
            setInterval: true,
            clearInterval: true,
        },
        onready: onTsEditorReady,
    };
    return tsOptions;
}

function setEditor(editor: any) {
    if (editor.type === "monaco") {
        // Fallback to setTimeout since onready callback isn't being triggered
        setTimeout(() => {
            onTsEditorReady(editor);
        }, 100);
    } else {
        console.warn("[TS] setEditor unknown editor type:", editor.type);
    }
}

function resetDeclare(that: any) {
    that.declareEditor.setValue('');
}

const firstLower = (v: string) => v ? v[0].toLowerCase() + v.substring(1) : v;
const firstUpper = (v: string) => v ? v[0].toUpperCase() + v.substring(1) : v;
const getModuleVarName = (v: string) => {
    v = String(v).replace('node:', '');
    if (v === 'fs/promises') return 'fs';
    return firstLower(v.split(/[\W_]+/).map(firstUpper).join(''));
}

var invalidModuleVNames = [
    "msg",
    "node",
    "RED",
    "__global",
    "require",
    "context",
    "flow",
    "global",
    "env",
    "setTimeout",
    "clearTimeout",
    "setInterval",
    "clearInterval",
    "console",
    "Buffer",
    "URL",
    "URLSearchParams",
    "fetch",
];

// Simplification : on log juste les erreurs de modules manquants dans la console
RED.events.on("runtime-state", function (event) {
    if (event.error === "missing-modules") {
        event.modules.forEach(function (m) {
            console.error("[TS] Missing module:", m.module, "-", m.error);
        });
    }
});

var installAllowList = ["*"];
var installDenyList = [];

var settingsAllowList = RED.settings.get("externalModules.modules.allowList");
var settingsDenyList = RED.settings.get("externalModules.modules.denyList");
if (settingsAllowList || settingsDenyList) {
    installAllowList = settingsAllowList;
    installDenyList = settingsDenyList;
}
installAllowList = RED.utils.parseModuleList(installAllowList);
installDenyList = RED.utils.parseModuleList(installDenyList);

function getStandardModules(): string[] {
    return [
        "fs/promises",
        "path",
        "os",
        "crypto",
        "process",
        "child_process",
        "zlib",
        // "express",
        // "axios",
        // "lodash",
        // "moment",
        // "uuid",
    ];
}

function prepareLibraryConfig(node: any) {
    $(".node-input-libs-row").show();
    
    // Utilise simplement la liste des modules standards
    const availableModules = getStandardModules();
    
    var typedModules = availableModules.map(name => {
        return {
            icon: "fa fa-cube",
            value: name,
            label: name,
            hasValue: false,
        };
    });
    typedModules.push({
        value: "_custom_",
        label: RED._("editor:subflow.licenseOther"),
        icon: "red/images/typedInput/az.svg",
        hasValue: true,
    });

    var libList = $("#node-input-libs-container").css("min-height", "100px")
        .css("min-width", "450px").editableList({
            header: $(
                '<div><div data-i18n="node-red:function.require.moduleName"></div><div data-i18n="node-red:function.require.importAs"></div></div>',
            ),
            addItem: function (container: any, _i: any, opt: any) {
                var parent = container.parent();
                var row0 = $("<div/>").addClass("node-libs-entry").appendTo(
                    container,
                );
                var fmoduleSpan = $("<span>").appendTo(row0);
                var fmodule = $("<input/>", {
                    class: "node-input-libs-val",
                    placeholder: tr("function.require.module"),
                    type: "text",
                }).css({}).appendTo(fmoduleSpan).typedInput({
                    types: typedModules as any,
                    default: availableModules.includes(opt.module) ? opt.module : "_custom_",
                }) as any;
                if (!availableModules.includes(opt.module)) {
                    fmodule.typedInput("value", opt.module);
                }
                var moduleWarning = $(
                    '<span style="position: absolute;right:2px;top:7px; display:inline-block; width: 16px;"><i class="fa fa-warning"></i></span>',
                ).appendTo(fmoduleSpan);
                RED.popover.tooltip(moduleWarning.find("i"), function () {
                    var val = fmodule.typedInput("type");
                    if (val === "_custom_") {
                        val = fmodule.val();
                    }
                    if (
                        !RED.utils.checkModuleAllowed(
                            val,
                            null,
                            installAllowList,
                            installDenyList,
                        )
                    ) {
                        return tr("function.error.moduleNotAllowed", {
                            module: val,
                        });
                    } else {
                        return "Module may not be installed. Check console for errors.";
                    }
                });

                var fvarSpan = $("<span>").appendTo(row0);

                var fvar = $("<input/>", {
                    class: "node-input-libs-var red-ui-font-code",
                    placeholder: tr("function.require.var"),
                    type: "text",
                }).css({}).appendTo(fvarSpan).val(opt.var) as any;
                var vnameWarning = $(
                    '<span style="position: absolute; right:2px;top:7px;display:inline-block; width: 16px;"><i class="fa fa-warning"></i></span>',
                ).appendTo(fvarSpan);
                RED.popover.tooltip(vnameWarning.find("i"), function () {
                    var val = fvar.val() as string;
                    if (invalidModuleVNames.indexOf(val) !== -1) {
                        return tr("function.error.moduleNameReserved", {
                            name: val,
                        });
                    } else {
                        return tr("function.error.moduleNameError", {
                            name: val,
                        });
                    }
                });

                fvar.on("change keyup paste", function (this: any, e: any) {
                    var v = ($(this).val() as string || "").trim();
                    if (
                        v === "" || / /.test(v) ||
                        invalidModuleVNames.indexOf(v) !== -1
                    ) {
                        fvar.addClass("input-error");
                        vnameWarning.addClass("input-error");
                    } else {
                        fvar.removeClass("input-error");
                        vnameWarning.removeClass("input-error");
                    }
                });

                fmodule.on("change keyup paste", function (this: any, e: any) {
                    var val = $(this).typedInput("type");

                    if (val === "_custom_") {
                        val = $(this).val();
                    }
                    
                    var varName = getModuleVarName(val);
                    
                    fvar.val(varName);
                    fvar.trigger("change");

                    if (
                        RED.utils.checkModuleAllowed(
                            val as string,
                            null,
                            installAllowList as any,
                            installDenyList as any,
                        )
                    ) {
                        fmodule.removeClass("input-error");
                        moduleWarning.removeClass("input-error");
                    } else {
                        fmodule.addClass("input-error");
                        moduleWarning.addClass("input-error");
                    }
                });
                if (
                    RED.utils.checkModuleAllowed(
                        opt.module as string,
                        null,
                        installAllowList as any,
                        installDenyList as any,
                    )
                ) {
                    fmodule.removeClass("input-error");
                    moduleWarning.removeClass("input-error");
                } else {
                    fmodule.addClass("input-error");
                    moduleWarning.addClass("input-error");
                }
                if (opt.var) {
                    fvar.trigger("change");
                }
            },
            removable: true,
        });

    var libs = node.libs || [];
    for (var i = 0, l = libs.length; i < l; i++) {
        libList.editableList("addItem", libs[i]);
    }
}

function getLibsList() {
    var _libs = [];
    if (RED.settings.functionExternalModules !== false) {
        var libs = $("#node-input-libs-container").editableList("items");
        libs.each(function (i) {
            var item = $(this);
            var v = item.find(".node-input-libs-var").val() as string;
            var n = item.find(".node-input-libs-val").typedInput("type");
            if (n === "_custom_") {
                n = item.find(".node-input-libs-val").val() as string;
            }
            if (
                (!v || (v === "")) ||
                (!n || (n === ""))
            ) {
                return;
            }
            (_libs as any).push({
                var: v,
                module: n as string,
            });
        });
    }
    return _libs;
}

/** The expanded editor is created by Node-RED inside its own tray, so it is found among Monaco's editors once it exists. */
function configExpandedTsEditors(node: any, nodeLibs: any[]) {
    const editors = window.monaco?.editor?.getEditors?.() || [];
    for (const editor of editors) {
        const model = editor.getModel();
        if (model && model.getLanguageId() === "typescript" && !model.uri.path.endsWith(".ts")) {
            configMonaco(editor, node.declareEditor ? node.declareEditor.getValue() : null, nodeLibs);
        }
    }
}

registerCompilerConfigNode();

RED.nodes.registerType("typescript", {
    color: "#61adff",
    category: "function",
    paletteLabel: "typescript",
    defaults: {
        name: { value: "_DEFAULT_" },
        func: { value: "\nreturn msg;" },
        outputs: { value: 1 },
        timeout: { value: RED.settings.functionTimeout || 0 },
        useVm: { value: false },
        updated: { value: 0 },
        declare: { value: "" },
        tsconfig: { value: "", type: "typescript-config", required: false },
        noerr: {
            value: 0,
            required: true,
            validate: function (v: any, opt: any) {
                if (!v) {
                    return true;
                }
                return tr("function.error.invalid-js");
            },
        },
        initialize: { value: "" },
        finalize: { value: "" },
        libs: {
            value: [],
            validate: function (v: any, opt: any) {
                if (!v) return true;
                for (var i = 0, l = v.length; i < l; i++) {
                    var m = v[i];
                    if (
                        !RED.utils.checkModuleAllowed(
                            m.module,
                            null,
                            installAllowList,
                            installDenyList,
                        )
                    ) {
                        return tr("function.error.moduleNotAllowed", {
                            module: m.module,
                        });
                    }
                    if (m.var === "" || / /.test(m.var)) {
                        return tr("function.error.moduleNameError", {
                            name: m.var,
                        });
                    }
                    // Simplification : plus de validation des modules manquants ici
                    // Les erreurs sont loggées dans la console via runtime-state
                    if (invalidModuleVNames.indexOf(m.var) !== -1) {
                        return tr("function.error.moduleNameError", {
                            name: m.var,
                        });
                    }
                }
                return true;
            },
        },
    },
    inputs: 1,
    outputs: 1,
    icon: "typescript.svg",
    label: getLabel,
    labelStyle: function (this: any) {
        return this.name ? "node_label_italic" : "";
    },
    oneditprepare: function (this: any) {
        var that = this;
        window.currentNodeInstance = this;

        var tabs = RED.tabs.create({
            id: "func-tabs",
            onchange: function (tab: any) {
                $("#func-tabs-content").children().hide();
                $("#" + tab.id).show();
                let editor = $("#" + tab.id).find(".monaco-editor").first();
                if (editor.length) {
                    if (that.editor.nodered && that.editor.type == "monaco") {
                        that.editor.nodered.refreshModuleLibs(libsWithNodeRedBundledTypes(getLibsList()));
                        
                        // Also refresh TypeScript configuration for all editors
                        try {
                            const customDeclare = that.declareEditor ? that.declareEditor.getValue() : null;
                            const nodeLibs = getLibsList();
                            
                            // Refresh all Monaco editors
                            [that.editor, that.initEditor, that.finalizeEditor].forEach(editor => {
                                if (editor && editor.type === "monaco") {
                                    configMonaco(editor, customDeclare, nodeLibs);
                                }
                            });
                        } catch (error) {
                            console.warn("[TS] Failed to refresh Monaco TypeScript on tab change:", error);
                        }
                    }
                    RED.tray.resize();
                    //auto focus editor on tab switch
                    if (that.initEditor.getDomNode() == editor[0]) {
                        that.initEditor.focus();
                    } else if (that.editor.getDomNode() == editor[0]) {
                        that.editor.focus();
                    } else if (that.finalizeEditor.getDomNode() == editor[0]) {
                        that.finalizeEditor.focus();
                    } else if (that.declareEditor.getDomNode() === editor[0]) {
                        console.debug('hack declare editor error')
                        removeExtraLib(customDeclarePath)
                    }
                }
            },
        });
        tabs.addTab({
            id: "func-tab-config",
            iconClass: "fa fa-cog",
            label: tr("function.label.setup"),
        });

        tabs.addTab({
            id: "func-tab-init",
            label: tr("function.label.initialize"),
        });
        tabs.addTab({
            id: "func-tab-body",
            label: tr("function.label.function"),
        });
        tabs.addTab({
            id: "func-tab-finalize",
            label: tr("function.label.finalize"),
        });

        tabs.activateTab("func-tab-body");

        ($("#node-input-outputs") as any).spinner({
            min: 0,
            max: 500,
            change: function (this: any, _event: any, _ui: any) {
                var value = parseInt(this.value);
                value = isNaN(value) ? 1 : value;
                value = Math.max(
                    value,
                    parseInt($(this).attr("aria-valuemin") || "0"),
                );
                value = Math.min(
                    value,
                    parseInt($(this).attr("aria-valuemax") || "500"),
                );
                if (value !== this.value) {
                    ($(this) as any).spinner("value", value);
                }
            },
        });

        // 4294967 is max in node.js timeout.
        ($("#node-input-timeout") as any).spinner({
            min: 0,
            max: 4294967,
            change: function (this: any, event: any, ui: any) {
                var value = this.value;
                if (value == "") {
                    value = 0;
                } else {
                    value = parseInt(value);
                }
                value = isNaN(value) ? 1 : value;
                value = Math.max(
                    value,
                    parseInt($(this).attr("aria-valuemin") || "0"),
                );
                value = Math.min(
                    value,
                    parseInt($(this).attr("aria-valuemax") || "4294967"),
                );
                if (value !== this.value) {
                    ($(this) as any).spinner("value", value);
                }
            },
        });

        var buildEditor = function (
            id: any,
            stateId: any,
            _focus: any,
            value: any,
            defaultValue: any,
            extraLibs: any,
            offset: any,
        ) {
            var editor = RED.editor.createEditor(configTsEditor({
                id: id,
                value: value || defaultValue || "",
                stateId: stateId,
                focus: true,
                extraLibs: libsWithNodeRedBundledTypes(extraLibs),
            }, that));
            if (defaultValue && value === "") {
                editor.moveCursorTo(
                    defaultValue.split("\n").length + offset,
                    0,
                );
            }
            editor.__stateId = stateId;
            setEditor(editor);
            return editor;
        };
        this.initEditor = buildEditor(
            "node-input-init-editor",
            this.id + "/" + "initEditor",
            false,
            $("#node-input-initialize").val(),
            tr("function.text.initialize"),
            undefined,
            0,
        );
        this.editor = buildEditor(
            "node-input-func-editor",
            this.id + "/" + "editor",
            true,
            $("#node-input-func").val(),
            undefined,
            that.libs || [],
            -1,
        );
        this.finalizeEditor = buildEditor(
            "node-input-finalize-editor",
            this.id + "/" + "finalizeEditor",
            false,
            $("#node-input-finalize").val(),
            tr("function.text.finalize"),
            undefined,
            0,
        );
        this.declareEditor = buildEditor(
            "node-input-declare-editor",
            this.id + "/" + "declareEditor",
            false,
            this.declare,
            undefined,
            undefined,
            0,
        );

        RED.library.create({
            url: "functions", // where to get the data from
            type: "function", // the type of object the library is for
            editor: this.editor, // the field name the main text body goes to
            mode: "ace/mode/nrjavascript",
            fields: [
                "name",
                "outputs",
                "timeout",
                {
                    name: "initialize",
                    get: function () {
                        return that.initEditor.getValue();
                    },
                    set: function (v) {
                        that.initEditor.setValue(
                            v || tr("function.text.initialize"),
                            -1,
                        );
                    },
                },
                {
                    name: "finalize",
                    get: function () {
                        return that.finalizeEditor.getValue();
                    },
                    set: function (v) {
                        that.finalizeEditor.setValue(
                            v || tr("function.text.finalize"),
                            -1,
                        );
                    },
                },
                {
                    name: "info",
                    get: function () {
                        return that.infoEditor.getValue();
                    },
                    set: function (v) {
                        that.infoEditor.setValue(v || "", -1);
                    },
                },
            ],
            ext: "js",
        });

        var expandButtonClickHandler = function (editor) {
            return function (e) {
                e.preventDefault();
                var value = editor.getValue();
                editor.saveView(
                    `inside function-expandButtonClickHandler ${editor.__stateId}`,
                );
                var extraLibs = that.libs || [];
                // Read now: the module list leaves the DOM while the expanded tray is open.
                var nodeLibs = getLibsList();
                RED.editor.editJavaScript(configTsEditor({
                    value: value,
                    width: "Infinity",
                    stateId: editor.__stateId,
                    focus: true,
                    cancel: function () {
                        setTimeout(function () {
                            editor.focus();
                        }, 250);
                    },
                    complete: function (v, _cursor) {
                        editor.setValue(v, -1);
                        setTimeout(function () {
                            editor.restoreView();
                            editor.focus();
                        }, 250);
                    },
                    extraLibs: libsWithNodeRedBundledTypes(extraLibs),
                }, that));
                for (const delayMs of [100, 500]) {
                    setTimeout(() => configExpandedTsEditors(that, nodeLibs), delayMs);
                }
            };
        };
        $("#node-init-expand-js").on(
            "click",
            expandButtonClickHandler(this.initEditor),
        );
        $("#node-function-expand-js").on(
            "click",
            expandButtonClickHandler(this.editor),
        );
        $("#node-finalize-expand-js").on(
            "click",
            expandButtonClickHandler(this.finalizeEditor),
        );
        $("#node-declare-expand-js").on(
            "click",
            expandButtonClickHandler(this.declareEditor),
        );

        RED.popover.tooltip(
            $("#node-init-expand-js"),
            tr("common.label.expand"),
        );
        RED.popover.tooltip(
            $("#node-function-expand-js"),
            tr("common.label.expand"),
        );
        RED.popover.tooltip(
            $("#node-finalize-expand-js"),
            tr("common.label.expand"),
        );
        RED.popover.tooltip(
            $("#node-declare-expand-js"),
            tr("common.label.expand"),
        );
        RED.popover.tooltip($("#node-reset-declare"), "Reset declare types");

        // Auto-detect button handler
        $("#node-reset-declare").on("click", function () {
            resetDeclare(that);
        });

        contextTypeStore.checkpoint();
        $("#node-input-tsconfig").on("change", applyNodeCompilerOptions);
        applyNodeCompilerOptions();

        for (const editor of [this.initEditor, this.editor, this.finalizeEditor]) {
            editor.getSession().on("change", () => scheduleContextInference(that));
        }
        scheduleContextInference(that);

        if (RED.settings.functionExternalModules !== false) {
            prepareLibraryConfig(that);

            // Add default modules button logic
            $("#node-add-default-modules").on("click", function () {
                var libList = $("#node-input-libs-container");
                getStandardModules().forEach((name) => {
                    libList.editableList("addItem", {
                        var: getModuleVarName(name),
                        module: name
                    });
                });
            });
        }
    },
    oneditsave: function (this: any) {
        var node = this;
        var noerr = 0;
        cancelContextInference();
        contextTypeStore.commit();
        $("#node-input-noerr").val(0);

        // Transfer old script property to func for backward compatibility
        if (this.script && !this.func) {
            this.func = this.script;
            delete this.script;
        }

        // Update timestamp to invalidate compilation cache
        $("#node-input-updated").val(Date.now());

        var disposeEditor = function (
            editorName: string,
            targetName: string,
            defaultValue?: string,
        ) {
            var editor = node[editorName];
            console.debug('hack validate error')
            if (editorName !== 'declareEditor') {
                var annot = editor.getSession().getAnnotations();
                for (var k = 0; k < annot.length; k++) {
                    if (annot[k].type === "error") {
                        noerr += annot.length;
                        break;
                    }
                }
            }
            var val = editor.getValue();
            if (defaultValue) {
                if (val.trim() == defaultValue.trim()) {
                    val = "";
                }
            }
            editor.destroy();
            delete node[editorName];
            $("#" + targetName).val(val);
        };
        disposeEditor("editor", "node-input-func");
        disposeEditor(
            "initEditor",
            "node-input-initialize",
            tr("function.text.initialize"),
        );
        disposeEditor(
            "finalizeEditor",
            "node-input-finalize",
            tr("function.text.finalize"),
        );
        disposeEditor("declareEditor", "node-input-declare");

        $("#node-input-noerr").val(noerr);
        this.noerr = noerr;
        node.libs = getLibsList();
    },
    oneditcancel: function (this: any) {
        var node = this;
        cancelContextInference();
        contextTypeStore.rollback();

        node.editor.destroy();
        delete node.editor;

        node.initEditor.destroy();
        delete node.initEditor;

        node.finalizeEditor.destroy();
        delete node.finalizeEditor;

        node.declareEditor.destroy();
        delete node.declareEditor;
    },
    // The Delete button of the edit dialog closes it without calling oneditcancel.
    oneditdelete: function (this: any) {
        if (this.editor) this._def.oneditcancel.call(this);
    },
    oneditresize: function (this: any, size: any) {
        var rows = $("#dialog-form>div:not(.node-text-editor-row)");
        var height = $("#dialog-form").height() || 0;
        for (var i = 0; i < rows.length; i++) {
            height -= $(rows[i]).outerHeight(true) || 0;
        }
        var editorRow = $("#dialog-form>div.node-text-editor-row");
        height -= parseInt(editorRow.css("marginTop") || "0") +
            parseInt(editorRow.css("marginBottom") || "0");
        $("#dialog-form .node-text-editor").css("height", height + "px");

        var sizeHeight = size.height || 0;
        $("#node-input-init-editor").css("height", (sizeHeight - 75) + "px");
        $("#node-input-func-editor").css("height", (sizeHeight - 75) + "px");
        $("#node-input-finalize-editor").css(
            "height",
            (sizeHeight - 75) + "px",
        );

        for (const editor of [this.initEditor, this.editor, this.finalizeEditor, this.declareEditor]) {
            if (editor) editor.resize();
        }

        $("#node-input-libs-container").css(
            "height",
            (sizeHeight - 376) + "px",
        );
    },
    onadd: function (this: any) {
        if (this.name === "_DEFAULT_") {
            this.name = "";
            RED.actions.invoke("core:generate-node-names", this, {
                generateHistory: false,
            });
        }
    },
});
