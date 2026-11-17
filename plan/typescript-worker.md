# TypeScript work in a worker thread

Legend: 👤 = verbatim from user, 🤖 = from AI.
Numbering: `§` sections, `¶` items, gaps left for insertion; section numbers are shared across the files in this directory.

## §130 Context

- ¶10 👤 "Also, the "async" compilation seems really slow and have blocked the flow for almost a minute"
- ¶20 👤 "Please also log which node is being compiled"
- ¶30 👤 (where the check should run) "Can you move all the work that loads TS to the worker?"
- ¶40 👤 (off switch for the deploy check on the config node) "No"
- ¶50 🤖 Confirmed from the code: every use of the `typescript` package runs on Node-RED's main thread, and each is one synchronous call.
  These are `ts.transpileModule` per section (2.1s for 1173 chars in your log), the deploy check's program load and per-node diagnostics, tsconfig parsing, and module typings resolution.
- ¶60 🤖 Hypothesis, not verifiable from here: the ~30s gap in your log is the program load of the deploy check, possibly made worse by swapping.
  The logging of ¶20 (already added, §140 ¶70) will show which step it is on the device.
- ¶70 🤖 Measured locally (TS 5.9.3, macOS arm64): the same check in a worker thread costs about +33MB peak RSS over in-process, because the worker loads its own copy of TypeScript.
  In return the main thread no longer loads TypeScript at all.

## §140 Design

Worker
- ¶10 🤖 New esbuild entry `src/worker/TypeScriptWorkerMain.ts` → `dist/typescript-worker.js`, started with `new Worker(path.join(__dirname, 'typescript-worker.js'))`.
  It is the only bundle that imports `typescript` at run time; `src/typescript.ts` and `src/admin/` keep `import type` only.
- ¶20 🤖 The existing pure modules move behind it unchanged: `TsconfigCompilerOptionsResolver`, `ModuleTypeFileCollector`, `DeployTypeCheckService` and its helpers, plus the `transpileModule` call taken out of `src/typescript.ts` as `src/compile/NodeSectionTranspiler.ts`.
- ¶30 🤖 Requests handled by the worker, one at a time in arrival order:
  - `transpile { sections, tsconfig }` → the three JavaScript texts and transpile diagnostics;
  - `resolveCompilerOptions { tsconfig }` → `{ json, warnings }`;
  - `collectModuleTypes { module }` → `ModuleTypeFiles`;
  - `typeCheck { rev, targets[] }` → context type registry JSON, per-node reports, batch statistics.
- ¶40 🤖 Requests carry the tsconfig **text**; the worker resolves it and caches the result by text, so `ts.CompilerOptions` never crosses the thread boundary.
- ¶50 🤖 Per-node progress lines (¶70) are posted as they happen, so they appear in the log while a long check is still running.

Main thread
- ¶60 🤖 `src/worker/TypeScriptWorkerClient.ts` owns the worker: starts it on first request, matches replies to requests, and restarts it if it exits unexpectedly.
  A `transpile` request that was lost to a worker crash is retried once in a fresh worker; a lost `typeCheck` is only logged.
- ¶70 🤖 Logging (already implemented in-process, kept as is): batch start, files loaded and time per program, `Inferred context types in Xms` and `Type-checked in Xms, N problem(s)` per node through the node's own logger (so the line carries `[typescript:<name>]`), batch end with heap figures.
  The heap figures become those of the worker.
- ¶80 🤖 `DeployTypeCheckService` is split: `DeployTypeCheckCoordinator` stays on the main thread (live node map, `flows:started`, `usesModule`, latest registry, "only warn when the report changed"), and the checking itself (`DeployTypeChecker`) runs in the worker.
- ¶85 🤖 `src/worker/TypeScriptWorkerRequestHandler.ts` maps the requests of ¶30 onto the pure modules; the unit tests call it in-process.
- ¶90 🤖 `typescript-config` node: keeps the tsconfig text and `persistentService`; its warnings are logged when the worker's answer arrives.
- ¶100 🤖 `typescript` node: `newCompilation` awaits the worker for its JavaScript.
  Messages that arrive before that already wait on `comp.ready`, so behaviour is the same apart from the node becoming ready slightly later.
- ¶110 🤖 Admin routes call the client and answer asynchronously; their URLs and payloads do not change, so the editor is untouched.

Lifetime and memory
- ¶120 🤖 With no persistent config in use, the worker is terminated once it has been idle for the configured time (§150 ¶25), which frees TypeScript and the program completely.
- ¶130 🤖 With a persistent config in use, the worker stays alive and keeps the language service, as today.
- ¶140 🤖 Net effect on the device in one-shot mode: lower idle memory than today (no TypeScript in the main heap), higher peak during a deploy by roughly the +33MB of §130 ¶70.

## §150 Decisions taken

- ¶10 👤 (a deploy arriving while a check is running) "Abandon the check (Recommended)"
- ¶15 🤖 The abandoned check is started again 2s later unless the new deploy has scheduled its own by then; other requests overtake a check that is still queued.
- ¶20 👤 (idle time of the worker) "Let make timeout configurable. Checkbox = forever"
- ¶25 🤖 `idleTimeoutSeconds` on the config node, default 30; with several config nodes the longest applies, and 30s applies when there is none.
- ¶30 👤 (heap cap) "Setting on config node"
- ¶35 🤖 `maxHeapMb` on the config node, empty = no limit; with several config nodes the largest applies.
  A transpile that failed once is retried in a worker without the limit, because a node cannot run without its JavaScript.

## §160 Verification

- ¶10 🤖 Existing unit tests keep running the pure modules in-process.
- ¶20 🤖 New test against the built worker bundle: transpile, compiler options, module types and a two-node check through `TypeScriptWorkerClient`, a crash followed by a retried transpile, and idle termination.
- ¶30 🤖 A test asserting that loading `dist/typescript.js` does not load the `typescript` package.
- ¶40 🤖 End-to-end on scratch Node-RED 4.1.11 through the HTTP API: deploy, check warnings, registry route, module-types route, and the maximum event-loop delay of the main thread during a deploy.
- ¶50 🤖 Memory: main-thread and total RSS before, during and after a deploy, for one-shot and persistent.

## §170 Results (Node-RED 4.1.11, macOS arm64, Node 26)

- ¶10 🤖 Worker start-up 70–80ms; first transpile of a node about 90ms including that, later ones 3–5ms.
- ¶20 🤖 Two full deploys 250ms apart: the first check was abandoned once and re-run once; the main thread's longest event-loop delay over both deploys was 2ms.
- ¶30 🤖 Process RSS was about 460–500MB while the worker was alive after a check of 3 nodes in 2 programs, and 148MB after the idle stop.
  The worker's heap peaked at about 250MB before garbage collection, with no heap limit set and plenty of free memory on this machine.
- ¶40 🤖 Not measured: any of the above on the device.
