# Node-RED API declarations

Legend: 👤 = verbatim from user, 🤖 = from AI.
Numbering: `§` sections, `¶` items, gaps left for insertion; section numbers are shared across the files in this directory.

## §70 Feature 3 — API declarations at least as tight as the reference file

- ¶10 🤖 `NodeRedEnvDeclarationSource` contains every signature of the reference file: all `get`/`set`/`keys` overloads (arrays, callbacks, store), `NodeRedStatusFill`/`Shape`/`NodeRedStatus`, `node` members, `env.get`, `RED.util.cloneMessage`, `Message<T>`.
- ¶20 🤖 Tighter than the reference where the runtime allows: `NodeRedContext<M>` gains the typed `get` overload (§30 ¶30) and generic `set<K, V>`; `node.send` takes `Message | Message[] | (Message | Message[] | null)[] | null`.
- ¶30 🤖 Kept from the current runtime because `NodeWrapper`/scope really provide them: `node.path`, `node.packageVersion`, `node.buildDate`, `RED.util.getSetting`, `require`.
- ¶40 🤖 The file declares types only (plus `NodeRedImportedModule`, §30 ¶60); the values `context`, `flow`, `global` are declared per scope by §80 ¶60, which lets the server's module-local `declare const global` shadow Node's `global` without a redeclaration error.
- ¶50 🤖 Server: the text is a root file of every check program (§60 ¶60).
  Editor: it replaces the loose blocks in `configMonaco` (`flow: { get: <T = any>... }`, `global: any`, `context.flow: any`).
- ¶60 🤖 `msg` is `NodeMessage` (`_msgid?`, `topic?`, any other property as `any`), so existing flows keep compiling and Type Declarations can still narrow it with `interface NodeMessage { payload?: ... }`.
- ¶70 🤖 The fallback `get<T = any>(key)` overload does not accept a key that has a tracked type, so a wrongly annotated read of a tracked key is an error; `get<T>(key)` with an explicit type argument still overrides.
- ¶80 🤖 Editor: Node-RED's own `node-red/func`, `node-red/util` and `extraModuleLibs` declarations are not copied into the TypeScript defaults, and `declare var global: typeof globalThis` is removed from its Node globals, so these declarations are the only ones.
