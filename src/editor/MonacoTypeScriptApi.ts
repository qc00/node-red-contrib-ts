declare const window: any;

declare const RED: any;

/** Monaco moved its TypeScript API from `monaco.languages.typescript` to `monaco.typescript`. */
export function monacoTypeScriptApiIfAvailable(): any | undefined {
    const monaco = window.monaco;
    return monaco?.typescript || monaco?.languages?.typescript;
}

export function monacoTypeScriptApi(): any {
    const api = monacoTypeScriptApiIfAvailable();
    if (!api) throw new Error(`Monaco TypeScript support is required (${describeMissingMonacoTypeScriptApi()})`);
    return api;
}

export function describeMissingMonacoTypeScriptApi(): string {
    const monaco = window.monaco;
    const configuredEditor = RED?.editor?.codeEditor?.settings?.lib;
    return monaco
        ? `Monaco ${monaco.version || 'of unknown version'} is loaded without its TypeScript language service`
        : `Monaco is not loaded in this page; Node-RED's code editor setting is '${configuredEditor}'`;
}

/** Removes extra libs by path; Monaco only offers replacing the whole set. */
export function removeExtraLibsWhere(shouldRemove: (filePath: string) => boolean) {
    const tsDefaults = monacoTypeScriptApi().typescriptDefaults;
    const current: Record<string, { content: string }> = tsDefaults.getExtraLibs();
    const paths = Object.keys(current);
    const kept = paths.filter(filePath => !shouldRemove(filePath));
    if (kept.length === paths.length) return;
    tsDefaults.setExtraLibs(kept.map(filePath => ({ filePath, content: current[filePath].content })));
}
