/** `compilerOptions` applied underneath a node's tsconfig, in tsconfig.json form. */
export const DEFAULT_COMPILER_OPTIONS_JSON: Record<string, unknown> = {
    target: 'ES2022',
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    lib: ['ES2022'],
    types: ['node'],
    strict: false,
    allowJs: true,
    skipLibCheck: true,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
};
