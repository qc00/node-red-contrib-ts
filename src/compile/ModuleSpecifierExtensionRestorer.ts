const RUNTIME_EXTENSION_OF: readonly [string, string][] = [
    ['.d.mts', '.mjs'],
    ['.d.cts', '.cjs'],
    ['.d.ts', '.js'],
    ['.mts', '.mjs'],
    ['.cts', '.cjs'],
    ['.tsx', '.js'],
    ['.ts', '.js'],
];

const IMPORT_TYPE_SPECIFIER_PATTERN = /import\("([^"]+)"\)/g;

/**
 * The checker prints types from other files as `import("<path without extension>")`,
 * which ES module resolution cannot follow; this puts back the runtime extension of the file the path came from.
 */
export class ModuleSpecifierExtensionRestorer {
    private readonly specifierOf = new Map<string, string>();

    constructor(sourceFileNames: Iterable<string>) {
        for (const fileName of sourceFileNames) {
            const match = RUNTIME_EXTENSION_OF.find(([extension]) => fileName.endsWith(extension));
            if (!match) continue;
            const [extension, runtimeExtension] = match;
            const withoutExtension = fileName.slice(0, -extension.length);
            if (!this.specifierOf.has(withoutExtension)) this.specifierOf.set(withoutExtension, withoutExtension + runtimeExtension);
        }
    }

    restore(typeText: string): string {
        return typeText.replace(IMPORT_TYPE_SPECIFIER_PATTERN, (whole, specifier: string) => {
            const restored = this.specifierOf.get(specifier);
            return restored ? `import(${JSON.stringify(restored)})` : whole;
        });
    }
}
