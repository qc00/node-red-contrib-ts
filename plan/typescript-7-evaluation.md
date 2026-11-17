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
  Not verified: that it actually starts on the device.
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

- ¶10 👤 "Does the transpileModule API appear in the 7.1 beta?"
- ¶20 🤖 Yes: `typescript@7.1.0-beta` has `transpileModule(input, options)` on the `API` class of both the sync and the async API, returning `outputText` and optional diagnostics.
- ¶30 🤖 Run on macOS arm64 against a node-style wrapper with a type assertion, an `enum`, a parameter property and `await using`: 9ms for the first call including starting the compiler process, 1ms for the next.
- ¶40 🤖 Its `compilerOptions` take the numeric enum values; passing `target: 'es2022'` made the compiler process panic.
- ¶50 🤖 In 7.1 the API is exported as `typescript/sync`, `typescript/async`, `typescript/fs`, `typescript/ast`, no longer under `unstable/`.
- ¶60 🤖 It is a beta (npm tag `beta`; `latest` is 7.0.2), and none of this was run on the device.
