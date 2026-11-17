# Typed context `get` from tracked `set`

Legend: 👤 = verbatim from user, 🤖 = from AI.
Numbering: `§` sections, `¶` items, gaps left for insertion; section numbers are shared across the files in this directory.

## §80 Feature 4 — typed `get` from tracked `set`

Server
- ¶10 🤖 `src/compile/ContextSetCallInferrer.ts` walks each section's AST for `<recv>.set('<literal>', value)` where `<recv>` is `context`, `flow`, `global`, `context.flow`, `context.global` and resolves to the generated declaration (not a user variable shadowing it).
- ¶20 🤖 Tracked: string-literal keys, default store only (no `store` argument); array-key and dynamic-key forms are not tracked and stay on the `any` overload.
- ¶30 🤖 `src/compile/ContextTypeRegistry.ts`: `{ node: {nodeId: {key: {contributorNodeId: typeText}}}, flow: {z: {...}}, global: {...} }`.
  A key set with different types `A` and `B` is read back as the TypeScript union `A | B | undefined`: only fields present in both are accessible directly, anything else needs a narrowing check first.
  Keeping the contributor id lets the editor replace only the open node's contribution (¶80).
- ¶40 🤖 Two passes per batch in the same LanguageService: pass 1 with empty key maps infers `set` types, pass 2 with the generated maps produces the diagnostics (§30 ¶90 for cost).
- ¶50 🤖 Portability: a printed type naming something from one node's own Type Declarations is not resolvable in other nodes.
  Pass 2 includes a validation file holding only the registry; entries with diagnostics there are downgraded to `any` and the contributing node gets a warning.
- ¶60 🤖 Generated per scope: `declare const context: NodeRedContext<{...node keys}> & { flow: NodeRedContext<{...flow keys}>; global: NodeRedContext<{...global keys}> }; declare const flow: ...; declare const global: ...;` — emitted into each node's module prefix on the server and into `file:///node-red-ts-context.d.ts` for the open node in the editor.
- ¶65 🤖 Route `GET /typescript-node/context-types` returns the registry of the last completed batch together with the flow revision it was computed for; it waits for a batch in progress.

Editor
- ¶70 🤖 The registry is fetched once per flow load (editor `flows:loaded`), not per dialog.
  It is fetched again only when the editor's own deploy completes, at which point the editor holds exactly the deployed revision.
  A response whose revision differs from `RED.nodes.version()` is discarded.
- ¶80 🤖 `src/editor/ContextSetQuickInfoInferrer.ts` watches the node's On Start, On Message and On Stop editors.
  On change it finds `.set('<literal>',` call sites by regex, asks Monaco's TS worker for quick-info on `set`, extracts the `value:` parameter type by bracket-depth scan, replaces the open node's contributions, and regenerates ¶60.
  The run is debounced because each call site is a worker round trip and regenerating ¶60 makes Monaco re-validate all open models.
- ¶90 🤖 The overlay is written into the editor's copy of the registry, so other nodes opened before the next deploy see it; it is dropped when ¶70 refetches.
- ¶95 🤖 Cancelling a dialog restores the types as they were when it opened.
  An edit made less than the debounce delay before pressing Done is not inferred in the editor; it is picked up by the next deploy.
- ¶100 🤖 A type inferred in the editor names module types through the node's own variable (`path.ParsedPath`), where the deploy-time check prints `import("path").ParsedPath`.
  Until the next deploy such a type resolves only in nodes importing the module under the same name; elsewhere it reads as `any`.
