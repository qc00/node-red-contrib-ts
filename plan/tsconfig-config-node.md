# `typescript-config` config node

Legend: 👤 = verbatim from user, 🤖 = from AI.
Numbering: `§` sections, `¶` items, gaps left for insertion; section numbers are shared across the files in this directory.

## §50 Feature 2 — `typescript-config` config node

Node definition
- ¶10 🤖 New node type `typescript-config` (`category: 'config'`) with fields `name`, `tsconfig` (text, edited in a JSON Monaco editor), `persistentService` (checkbox).
- ¶20 🤖 The typescript node gains an optional `tsconfig` property (`type: 'typescript-config'`) shown as the standard config dropdown on the Setup tab.
  Any number of config nodes may exist; each node picks one or none.
- ¶30 🤖 `persistentService` label: "Keep the TypeScript worker running (uses more RAM, faster deploys and dialogs)"; default off.
- ¶35 🤖 Worker fields `idleTimeoutSeconds` (default 30) and `maxHeapMb` (empty = no limit); see `typescript-worker.md` §140.
- ¶35 🤖 Measured on the built service (20 nodes, strict, macOS arm64): persistent keeps +66MB heap and re-checks in 66ms; one-shot returns to +7MB heap and re-checks in 196ms.
- ¶60 🤖 A node with no config selected uses the current permissive editor options (`strict: false`, `target ES2022`, `module/moduleResolution NodeNext`, `types: ["node"]`, `skipLibCheck: true`), held in one shared constant so editor and server agree.

Server
- ¶40 🤖 `src/compile/TsconfigCompilerOptionsResolver.ts`: parses with `ts.parseConfigFileTextToJson` (comments and trailing commas allowed, as in your own `tsconfig.json`) then `ts.convertCompilerOptionsFromJson`.
  Only `compilerOptions` is honoured.
  It returns the options plus a list of warnings: ignored top-level keys (`include`, `files`, `extends`, `references`), dropped options (¶50), and option errors from TypeScript.
- ¶50 🤖 Forced regardless of user JSON: `noEmit: true` for the check, `noErrorTruncation: true`; emit-shaping options (`outDir`, `outFile`, `rootDir`, `declaration`, `declarationDir`, `declarationMap`, `emitDeclarationOnly`, `composite`, `incremental`, `tsBuildInfoFile`) are dropped.
- ¶70 🤖 Runtime emit (`compileTypeScript`) keeps `ts.transpileModule` but takes `target` and other emit-relevant options from the node's resolved config when the tsconfig sets them (otherwise the Node-version-based target stays); `module` stays `CommonJS` because the emitted text is evaluated via `new Function` / `vm.Script`.
- ¶80 🤖 Config changes reach nodes through Node-RED's native restart of referencing nodes; `getCompilation` is unchanged.
- ¶85 🤖 Route `POST /typescript-node/compiler-options` with body `{ tsconfig }` returns `{ options, warnings }` from ¶40; parse only, no program is created.

Editor
- ¶90 🤖 `configMonaco` applies compiler options every time an edit dialog opens and when the config dropdown changes, using ¶85 for the selected config's current (possibly undeployed) text.
  The existing run-once flag `window.tsConfigured` (`src/typescript.html.ts:134`) is removed, since it would stop any later config from taking effect.
  The route's `options` are already in the compiler's own form (enum numbers, lib file names) and are passed to Monaco as they are, minus `types`/`typeRoots`.
- ¶100 🤖 The config node's edit dialog calls ¶85 on change and lists the warnings under the JSON editor; the same warnings are also logged by the runtime when the config node starts.
