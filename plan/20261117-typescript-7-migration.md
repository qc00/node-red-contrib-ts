# TypeScript 7 (native compiler) evaluation

Legend: 👤 = verbatim from user, 🤖 = from AI.
Numbering: `§` sections, `¶` items, gaps left for insertion; section numbers are shared across the files in this directory.

## §180 Context

- ¶10 👤 "The defferred type checking is so slow, it's exposing node dependency sequencing issues on server cold start. Evaluate the feasibility of using the native TS 7 compiler"
- ¶20 🤖 Evaluation only; no code in `src/` was changed.
- ¶30 🤖 Everything below was run on macOS arm64 with `typescript@7.0.2` (npm `latest` on 2026-11-17) in a scratch directory.
  Nothing was run on the device.

## §190 Findings

Availability
- ¶10 🤖 `typescript@7.0.2` ships the compiler as a native binary per platform, including `@typescript/typescript-linux-arm`.
- ¶20 🤖 That binary is a statically linked 32-bit ARM EABI5 executable (22MB, Go 1.26.4, built with `GOARM=6`), so it needs no particular libc and its instruction set is within what a Cortex-A8 has.
- ¶30 🤖 The package requires Node >= 16.20 and is ESM-only.

Speed and memory (two-node project, `strict`, `types: ["node"]`, 192 files loaded)
- ¶40 🤖 TypeScript 7 binary limited to one thread and one CPU: 0.10s CPU, 59MB peak RSS.
- ¶50 🤖 TypeScript 5.9 `tsc` on the same project: 0.39s CPU, 180MB peak RSS.
- ¶60 🤖 Through the API with in-memory files: project loaded in 34ms; re-check after changing one file in 1ms.
- ¶70 🤖 Hypothesis: the gain on the device is larger than this 4x, because the 5.9 figure on a Mac hides most of the cost of V8 compiling 9MB of compiler JavaScript, which a native binary does not have.

API (`typescript/unstable/sync`, `typescript/unstable/async`, `typescript/unstable/fs`)
- ¶80 🤖 The API starts the binary as a child process and talks to it over a pipe; there is no in-process compiler any more.
- ¶90 🤖 Confirmed working for what the deploy check does:
  - in-memory files layered over the real file system (`fs.readFile` / `fileExists` callbacks);
  - per-file semantic diagnostics with code, position and text;
  - walking the AST to find `set` calls and resolving the receiver's symbol;
  - `getTypeAtLocation` + `getBaseTypeOfLiteralType` + `typeToString` on the stored value, including fully qualified names (`import("node:fs").Stats`);
  - incremental update of one file between the two passes.
- ¶100 🤖 Missing compared with 5.x:
  - `transpileModule` (the package's main export is only the version);
  - `convertCompilerOptionsFromJson`, `resolveModuleName`, `preProcessFile` as standalone functions.
- ¶110 🤖 The API lives under `unstable/`, so the dependency would have to be pinned to an exact version.

Behaviour differences
- ¶120 🤖 TypeScript 7 has the 6.0 defaults: `strict` is on and `types` is empty unless set, and options deprecated in 5.x are gone (`moduleResolution: node10`, `suppressExcessPropertyErrors`, `suppressImplicitAnyIndexErrors`, ...).
  The node's defaults would state `strict: false` and `types: ["node"]` explicitly to stay as they are.
- ¶130 🤖 The editor keeps Node-RED 4.1.11's Monaco with TypeScript 5.4.5, so editor and deploy diagnostics would come from compilers two major versions apart.

## §200 What a migration would touch

👤 Note: work continued from (unaccepted) worker-based refactoring of the type-checking

- ¶10 🤖 `DeployTypeChecker`, `TypeCheckProgramProvider`: one project per tsconfig group inside a single compiler process; "persistent" becomes "keep the process".
- ¶20 🤖 `ContextSetCallInferrer`: same logic on the new AST and checker classes.
- ¶30 🤖 `TsconfigCompilerOptionsResolver`: let the compiler parse a virtual `tsconfig.json`; the numeric options the editor's Monaco needs are derived from the JSON names instead.
- ¶40 🤖 `ModuleTypeFileCollector`: take the files from the loaded program instead of resolving by hand.
- ¶50 🤖 Transpiling needs a replacement (§210 ¶10).
- ¶60 🤖 `TypeScriptWorkerClient`: with the async API the main thread can talk to the compiler process directly, so the worker thread and its copy of TypeScript could go; abandon, idle stop and heap limit would apply to the child process.
- ¶70 🤖 Tests: the fixtures use the 5.x LanguageService for the editor-form tests; those stay on 5.x as a dev dependency because the editor stays on 5.4.5.

## §210 Open decisions

- ¶10 🤖 Transpiling without `transpileModule`: Node's built-in type stripping (needs Node >= 22.13 on the device), a small transpiler dependency, or keeping `typescript@5` installed only for this.
- ¶20 🤖 Whether nodes should wait for anything at all at cold start: caching the transpiled JavaScript on disk keyed by source would let nodes start without any compiler.
- ¶30 🤖 Whether a `typescript@7` peer installed by the user should be optional (fall back to 5.x) or required.

## §220 TypeScript 7.1 beta

- ¶10 👤 "Does the transpileModule API (re)appear in the 7.1 beta?"
- ¶20 🤖 Yes: `typescript@7.1.0-beta` has `transpileModule(input, options)` on the `API` class of both the sync and the async API, returning `outputText` and optional diagnostics.
- ¶30 🤖 Run on macOS arm64 against a node-style wrapper with a type assertion, an `enum`, a parameter property and `await using`: 9ms for the first call including starting the compiler process, 1ms for the next.
- ¶40 🤖 Its `compilerOptions` take the numeric enum values; passing `target: 'es2022'` made the compiler process panic.
- ¶50 🤖 In 7.1 the API is exported as `typescript/sync`, `typescript/async`, `typescript/fs`, `typescript/ast`, no longer under `unstable/`.

# Migration
## §230 Context

- ¶10 👤 "So first commit the worker-based fixes and then implement the switch to TS 7 with no TS 5 fallback. No need for cache on disk if this works."
- ¶20 🤖 The worker-based state is commit `f142d16` on branch `typed-check-worker`.

## §240 What the 7.1 API was confirmed to do

- ¶10 🤖 `api.parseJsonConfigFileContent(json, { configDirectory })` returns the options in the compiler's numeric form (`"module":200`, `"lib":["lib.es2022.d.ts"]`, the form the editor's Monaco takes) and the option errors (`Unknown compiler option 'bogus'`).
- ¶20 🤖 `api.createSnapshot({ fileSystem: createFileSystemLayer(files), createPrograms: [{ rootFiles, compilerOptions }] })` builds a program over in-memory files layered on the real disk; 33ms for two nodes plus Node's types.
- ¶30 🤖 `program.getSemanticDiagnostics(file)` gives code, text, offset and line/character.
- ¶40 🤖 `checker.getTypeAtLocation` → `getBaseTypeOfLiteralType` → `typeToString` on a `set` call's value printed `{ celsius: number; at: number; st: import("node:fs").Stats; }`; `getSymbolAtLocation` on the receiver gives its declarations.
- ¶50 🤖 Second pass: `snapshot.update({ fileSystem, reconfigurePrograms: [{ id, rootFiles, compilerOptions }] })` re-checked with the new file contents in 4ms.
  `fileNotifications.changed` alone did not pick up the new contents.
- ¶60 🤖 A second program with different options in the same process took 8ms, so programs share what is already parsed.
- ¶70 🤖 `api.transpileModule(source, { compilerOptions, reportDiagnostics })` returns JavaScript and syntax diagnostics.
- ¶80 🤖 Requests are served concurrently: a transpile returned after 43ms while a 713ms check was running in the same process.
- ¶90 🤖 Options this node sets today that 7.1 rejects as unknown: `noImplicitUseStrict`, `suppressExcessPropertyErrors`, `suppressImplicitAnyIndexErrors`.
  The node's default options need `strict: false` stated, since 7 defaults to strict.

## §250 Design

- ¶10 🤖 `src/compiler/TypeScriptCompilerClient.ts` replaces `src/worker/*`: it owns one `API` instance (one native compiler process), started on first use.
- ¶20 🤖 `TsconfigCompilerOptionsResolver`: tsconfig text → JSON (comments and trailing commas stripped by a small JSONC reader) → `parseJsonConfigFileContent`; warnings for ignored top-level keys and dropped options stay as they are.
- ¶30 🤖 `NodeSectionTranspiler`: `transpileModule` with the remaining permissive options plus the tsconfig's emit-relevant ones.
- ¶40 🤖 `DeployTypeChecker`: one snapshot with one program per tsconfig group for pass 1, `reconfigurePrograms` with the generated context types for pass 2; `TypeCheckProgramProvider` goes away.
- ¶50 🤖 `ContextSetCallInferrer`: same rules on the 7 AST (`typescript/ast`) and async checker.
- ¶60 🤖 `ModuleTypeFileCollector`: a program whose only root imports the module; the answer is that program's files under `<userDir>/node_modules`, without `@types/node`.
- ¶70 🤖 `DeployTypeCheckCoordinator`, admin routes, editor and config node stay as they are, apart from §260.
- ¶80 🤖 The `typescript` package is ESM-only, so the runtime bundle loads it with `import()`.
- ¶90 🤖 Tests: the pure-module tests run against the real 7.1 binary; the editor-form fixtures need the editor's compiler, so `typescript@5.4.5` (the version in Node-RED 4.1.11's Monaco) becomes a dev-only aliased dependency.
- ¶100 🤖 `npm run lint` uses TypeScript 7's `tsc`.

## §260 Decisions taken

- ¶10 👤 (worker thread between Node-RED and the compiler process) "Drop the worker (Recommended)"
- ¶20 👤 (a deploy arriving while a check is running) "Let it finish, then re-check (Recommended)"
- ¶25 🤖 The result of a check that was overtaken by a newer deploy is not published.
- ¶30 👤 (the config node's worker heap limit) "Remove the field (Recommended)"

## §265 Found while implementing

- ¶10 🤖 The compiler always emits a `"use strict";` prologue; the node evaluates each output as `return <output>`, so the prologue is stripped (it made a node return the string).
- ¶20 🤖 A compiler process that receives SIGTERM keeps running for a while and fails every request with `context canceled`.
  A failed transpile therefore restarts the compiler before its one retry, and `close` kills the process if it has not answered within 2s.
- ¶30 🤖 Requests to a process that has exited are never answered, so every use is raced against the process's exit.
- ¶40 🤖 Module typings are collected with `noLib` and `preserveSymlinks`: the compiler's own library files live under `<userDir>/node_modules` too, and symlinked packages must keep their `node_modules/<name>` path.
- ¶50 🤖 `target: "es2023"` is the number 10 in the compiler's form, which TypeScript 5.4.5 in Node-RED 4.1.11's editor does not know; this was already the case with TypeScript 5.9 on the server.
- ¶60 🤖 TypeScript 5.4.5 reports TS1479 and TS2667 next to TS2440 inside the generated editor file for an ES-module package; the editor does not show diagnostics of generated files.
- ¶70 🤖 The compiler's peak memory is logged on Linux only (read from `/proc`).
- ¶80 👤 "The type stored under context key "stats" cannot be named outside this node, so other nodes read it as any (Cannot find module '/data/home/nodered/.node-red/rxnr/dist/Metric' or its corresponding type declarations.)"
- ¶90 🤖 Confirmed by reproduction: the checker prints a type from a module file as `import("<absolute path without extension>")`, which ES-module resolution in the generated `.mts` files cannot follow.
  `ModuleSpecifierExtensionRestorer` puts back the runtime extension of the program file the path came from (`.d.ts` → `.js`, `.d.mts` → `.mjs`, `.d.cts` → `.cjs`).

## §270 Verification

- ¶10 🤖 Unit tests, lint, build.
- ¶20 🤖 Scratch Node-RED 4.1.11 through the HTTP API: deploy, warnings, registry, module types, compiler options, two deploys in quick succession, idle stop, main-thread event-loop delay, process memory.
- ¶30 🤖 The user's four `.func.ts` files and `qess` modules as node sources through the deploy check.

## §280 Results (Node-RED 4.1.11, macOS arm64, Node 26)

- ¶10 🤖 32 unit tests pass against the real 7.1 binary; lint and build pass.
- ¶20 🤖 Cold start: compiler started in 357ms the first time in a process (37ms later), four nodes compiled and running 367ms after their construction.
- ¶30 🤖 Deploy check of 4 nodes in 2 programs: 25–41ms (517–547ms with TypeScript 5.9 in the worker).
- ¶40 🤖 Two full deploys 100ms apart: main thread's longest event-loop delay 2ms.
- ¶50 🤖 Memory: Node-RED 217MB and compiler process 153MB RSS right after the deploys; compiler gone and Node-RED 140MB after the 30s idle stop.
- ¶60 🤖 The user's two typescript nodes from `flows.json`: both transpile without diagnostics
