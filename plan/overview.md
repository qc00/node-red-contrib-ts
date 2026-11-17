# Typed imports, tsconfig config node, API types, typed context — overview

Legend: 👤 = verbatim from user, 🤖 = from AI.
Numbering: `§` sections, `¶` items, gaps left for insertion; section numbers are shared across the files in this directory.

## §10 Context

- ¶10 👤 "Support TypeScript type import for module imports: for each module `x` imported as variable `y`, synthesise `import * as y from 'x'` declaration when compiling the TS"
- ¶20 👤 "Have a config node that allows setting a json that serves as `tsconfig.json`"
- ¶30 👤 "Ensure its Node RED API type checking is at least as tight as `/Users/bc/Coding/node-red-proj/node-red-function-env.d.ts`"
- ¶40 👤 "Keep track of the type of data saved using the `set` function and synthesise strongly typed `get`"
- ¶50 🤖 Today the runtime (`src/typescript.ts`) only calls `ts.transpileModule`, so no type information exists on the server.
  All checking happens in Monaco (`configMonaco` in `src/typescript.html.ts`) with loose `any`-heavy declarations.
- ¶60 🤖 Outcome: one shared, tight API declaration used by both editor and server, a deploy-time type check on the server, module namespaces usable as types, and `get` typed from inferred `set` calls.

## §20 Decisions taken

- ¶10 👤 (where typing takes effect) "I would like to do both, but can you check how much additional RAM is required for doing this during deployment because the server is running on an embedded device"
- ¶20 👤 (npm module types in Monaco) "Admin endpoint (Recommended)"
- ¶30 👤 (typed get tracking) "How about editor gets the type as deployed from server and then updates it as user edits"
- ¶40 👤 (live update mechanism) "Monaco quick-info (Recommended)"
- ¶50 👤 (tsconfig attachment, superseding the earlier "One global config") "We're adding the reference, and shouldn't remove the flexibility to have multiple config nodes that the user choose from"
- ¶60 👤 (RAM strategy) "`free` on device Mem: 508368 292620 60292 5168 155456 198676. and 118M in swap, so I guess one-shot in-process is doable? Maybe have an option in the config node for persistent service?"
- ¶70 🤖 Measured (TS 5.9.3, @types/node 25, macOS arm64): transpile-only peak 112MB RSS; full check of 1–100 node bodies ≈ 205MB peak RSS (+~95MB), +47MB live heap, 170–190ms.
  After a one-shot check the heap returns to +5MB.
  `@types/node` is ~35MB of the live heap; node count barely matters.
- ¶80 🤖 ~95MB transient peak fits the 198MB "available" on the device, so one-shot in-process is the default; persistent service is an opt-in checkbox (§50 ¶30).
- ¶90 👤 (ignored tsconfig keys) "Just checking the warning is in the edit dialog not just logged in server logs."
- ¶100 👤 (set-type merge) "surely it should be the intersection and accessing non-common fields should require explicit checks"
- ¶110 👤 (second check pass, after seeing the 155ms + 23ms measurement) "Two passes (+~15%)"
- ¶120 👤 (registry fetch) "should do it once when the flow is requested. Otherwise can get out of sync if there were concurrent modifications on the server"
- ¶130 👤 (runtime `default || module`) "can you replicate the `||` in TS type space when you do the `declare global` per §30 ¶10?" → editor form: "Merged alias + const (Recommended)"
- ¶140 👤 (feature 4.1) "evaluate how difficult it will be to do the same typing for messages exchanged between TS nodes" → "Evaluation only"

## §30 Proof-of-concept results (already run, nothing written to disk)

- ¶10 🤖 `import * as __ns from 'x'; declare global { export import y = __ns; }` in a module `.d.ts` gives the bare editor model a global `y` usable as value **and** type namespace (`y.ParsedPath`) under `NodeNext`.
- ¶20 🤖 The UMD alternative (`export as namespace y`) fails under `NodeNext` (TS2686), so it is not used.
- ¶30 🤖 `get<K extends keyof M & string>(key: K): M[K] | undefined` over a key map types `flow.get('count')` as `number | undefined`; unknown keys fall through to the reference file's `get<T = any>(key: string)` overload.
- ¶40 🤖 With `set<K extends string, V>(key: K, value: V)`, quick-info on the `set` identifier returns the instantiated signature, e.g. `set<"p", string>(key: "p", value: string): void`, untruncated when `noErrorTruncation` is on.
- ¶50 🤖 Server side, `checker.typeToString(getBaseTypeOfLiteralType(getTypeAtLocation(arg)), undefined, NoTruncation | UseFullyQualifiedType)` yields the same type text.
- ¶60 🤖 `type NodeRedImportedModule<N> = N extends { default: infer D } ? (D extends null | undefined | false | 0 | '' ? N : D) : N` reproduces `loadedModule.default || loadedModule`.
  Tested against an ESM package with a default class, an ESM package without default, and `path` (`export =`).
- ¶70 🤖 Server form, zero diagnostics: module-level `import * as y from 'x'` (type namespace) shadowed in value space by a wrapper parameter `y: NodeRedImportedModule<typeof import('x')>`.
- ¶80 🤖 Editor form: `declare global { export import y = __ns; const y: NodeRedImportedModule<typeof __ns>; }`.
  The body gets the right value type, `y.Opts` resolves, and `y.helper` is rejected for a default-export module.
  TypeScript reports TS2440 inside the generated file, which Monaco does not surface.
- ¶90 🤖 A second pass in the same LanguageService with every node prefix changed took 23ms after a 155ms first pass (40 nodes).

## §40 Shared pieces (new modules, bundled by the existing esbuild entries)

- ¶10 🤖 `src/env/NodeRedEnvDeclarationSource.ts`: the single ambient API declaration text (§70), imported by both the server and the editor bundle.
- ¶20 🤖 `src/env/ContextTypeDeclarationGenerator.ts`: pure function from a key→type map per scope to declaration text (§80 ¶60); used by server and editor.
- ¶30 🤖 `src/env/ModuleImportDeclarationGenerator.ts`: pure function from `libs` (`{var, module}[]`) to import text, in the server form (§30 ¶70) and the editor form (§30 ¶80).
- ¶40 🤖 `src/typescript.ts` keeps the runtime node and registers the new config node and admin routes; `src/typescript.html` gains a second `data-template-name` block.
  No change to `esbuild.config.mjs` entry points or `package.json` `node-red.nodes`.
- ¶50 🤖 `src/admin/TypeScriptAdminHttpController.ts` mounts the routes named in §50–§80 on `RED.httpAdmin`, guarded by `RED.auth.needsPermission`.

## §100 To verify during implementation

- ¶40 🤖 Resolved: the editor side was exercised in headless Firefox against Node-RED 4.1.11 (Monaco 0.52, TypeScript 5.4.5) and 5.0.9 (Monaco 0.57, TypeScript 5.9.3).
  From Node-RED's editor source: built-in module declarations are only loaded on demand, so the editor loads them itself (§60 ¶120), and the clashing `global` declaration is removed (§70 ¶80).
- ¶50 🤖 Resolved: the `flows:started` event payload carries `config.rev`.
- ¶60 🤖 Resolved for Node-RED 4.1.11 and 5.0.9; the generated module files produce no visible markers on either.

## §110 Implementation order

- ¶10 🤖 Copy this plan into the repo as per-component files under `plan/` (numbering unchanged).
- ¶15 🤖 Fix `package.json` `build:watch` (points at `esbuild.config.js`; the file is `esbuild.config.mjs`).
- ¶20 🤖 §40 shared generators + §70 declarations, wired into `configMonaco` (editor-only, no server change yet).
- ¶30 🤖 §50 config node, resolver, compiler-options route, dialog warnings.
- ¶40 🤖 §60 virtual source builder and check service (one-shot), then the persistent provider.
- ¶50 🤖 §80 registry, context-types route, editor load, then quick-info live update.
- ¶60 🤖 §60 ¶120 module-types route and editor registration.
- ¶70 🤖 README: config node, typed context, RAM note, and correct "Available Context" (`fs`, `path`, `os`, `crypto`, `util` are only present when added under Modules).

## §120 Verification

- ¶10 🤖 `npm install`, `npm run lint`, `npm run build`.
- ¶20 🤖 New `test/` using `node --test` (no new runtime deps) against the pure modules with an in-memory LanguageService host, as in the PoC:
  - import synthesis, server form: default-export ESM, no-default ESM and `export =` modules give the value and `y.SomeType` results of §30 ¶60–¶70 with zero diagnostics;
  - import synthesis, editor form: same body results, and the generated file's only diagnostic is TS2440 (pins §30 ¶80);
  - resolver: JSONC input, forced options, warnings for ignored keys;
  - span remapping and filtering of prefix diagnostics;
  - registry: union of contributors needs narrowing for non-common fields, non-portable type downgraded to `any` with a warning, typed `get` result, unknown key → `any`;
  - a type-level fixture asserting each signature of the reference `.d.ts` is accepted and that misuse it rejects (e.g. `node.status({ fill: 'purple' })`) is rejected.
- ¶30 🤖 Quick-info parser tested against captured display strings (object types, unions, 3- and 4-argument `set` overloads).
- ¶40 🤖 Memory: rerun the PoC measurement against the built service for one-shot and persistent modes and report both.
- ¶50 🤖 End-to-end via `local-deployment.sh` on a local Node-RED: two typescript nodes on one tab (`flow.set` in one, `flow.get` in the other), two config nodes (one `"strict": true`), one npm module in Modules.
  Confirm deploy warnings, dialog warnings for an ignored tsconfig key, editor hover types before and after editing the `set`, and that changing a config node restarts only the nodes that reference it.
  I will ask before using any browser-driving tool for this step.
