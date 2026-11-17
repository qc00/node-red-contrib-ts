# Synthesised module imports and deploy-time type check

Legend: 👤 = verbatim from user, 🤖 = from AI.
Numbering: `§` sections, `¶` items, gaps left for insertion; section numbers are shared across the files in this directory.

## §60 Feature 1 — synthesised module imports

Server
- ¶10 🤖 `src/compile/NodeVirtualSourceBuilder.ts` builds one in-memory module per node at `<userDir>/__node-red-contrib-ts__/<nodeId>.mts`, so resolution sees `<userDir>/node_modules`.
  The `.mts` extension makes imports resolve the way the runtime's `import()` does.
  ```ts
  import * as y from 'x';                 // one per libs entry; type namespace
  /* node's "Type Declarations" text */
  /* per-node value declarations: context / flow / global (§80 ¶60) */
  async function __onStart(y: NodeRedImportedModule<typeof import('x')>) { /* initialize */ }
  async function __onMessage(msg: NodeMessage & NodeRedBaseMessage, y: ...) { /* func */ }
  async function __onStop(y: ...) { /* finalize */ }
  ```
- ¶20 🤖 The builder records the text span of each user section; diagnostics outside those spans are dropped, the rest are remapped to `Type Declarations/On Start/On Message/On Stop line:col`.
- ¶25 🤖 `@types/node` is a runtime dependency of this package and its directory is added to `typeRoots`, so the check has Node's types even when the user directory does not install them.
- ¶50 🤖 Runtime injection (`injectModules`) is unchanged; ¶10 types exactly what it assigns.
- ¶60 🤖 `src/compile/DeployTypeCheckCoordinator.ts` keeps a map of live typescript nodes and, on the runtime `flows:started` event, has `src/compile/DeployTypeChecker.ts` (in the worker, `typescript-worker.md`) check all of them in one batch (the cross-node registry of §80 needs every node even on a partial deploy).
- ¶70 🤖 Nodes are grouped by resolved compiler options; groups are checked sequentially so peak memory is that of one program.
- ¶80 🤖 Program lifetime sits behind one interface with two implementations: `OneShotTypeCheckProgramProvider` (default; creates and disposes the LanguageService per batch) and `PersistentTypeCheckProgramProvider` (§50 ¶30; bumps script versions for incremental re-check).
- ¶90 🤖 The check never blocks execution: nodes run on the transpiled JS immediately, diagnostics arrive after the batch.
- ¶100 🤖 Diagnostics are reported with `node.warn`, not `node.error`, so Catch nodes are not triggered by type errors.
- ¶105 🤖 A running node is only warned again when its report differs from the previous batch.
- ¶110 🤖 Heap delta and duration of each batch, the time to load each program, and the time each node took are logged at `info` level so the real cost on the device is visible.
- ¶120 🤖 Route `GET /typescript-node/module-types?module=x`: resolves with `ts.resolveModuleName` from `userDir` (package typings or `@types/x`), follows imports/references with `ts.preProcessFile` (parse only, no program), returns `.d.ts` + `package.json` files, size-capped.
  Only modules listed by a deployed typescript node are served, and only paths under `<userDir>/node_modules`.
  Node built-ins are answered with `{ builtin: true }`; the editor then loads Node-RED's own `types/node/<name>.d.ts`.
- ¶125 🤖 ¶120 also returns TypeScript sources (`.ts`, `.mts`, `.cts`) when a package ships those next to its JavaScript instead of declaration files.

Editor
- ¶30 🤖 `generateModuleDeclarations` in `configMonaco` is replaced by the editor form (§30 ¶80), one generated file per lib under `file:///node-red-ts-libs/module/`.
- ¶40 🤖 For each non-built-in lib the editor calls ¶120 and registers the returned files as extra libs under `file:///node_modules/...`; modules without typings get `declare module 'x';` so the alias still resolves (as `any`).
- ¶45 🤖 Node-RED's own editor loader (`extraLibs`, `refreshModuleLibs`) is only given the libs it bundles declarations for (`src/editor/NodeRedBundledModuleTypes.ts`), so it never requests `types/other/<module>.d.ts`.
