# Message typing between TS nodes — evaluation

Legend: 👤 = verbatim from user, 🤖 = from AI.
Numbering: `§` sections, `¶` items, gaps left for insertion; section numbers are shared across the files in this directory.

## §85 Feature 4.1 — message typing between TS nodes (evaluation only, not implemented)

- ¶10 🤖 Difficulty: medium-hard, clearly above feature 4.
- ¶20 🤖 Feasible core: each node's virtual module exports its handler and a downstream node's `msg` type references `typeof` the upstream handler's return type.
  A chain A → B → C type-checked in a single pass with no type printing, so no portability issue.
- ¶30 🤖 `msg.payload = x; return msg` carries no new type information; only `return { ...msg, payload: x }` style propagates.
- ¶40 🤖 Per-output precision needs const-inferred tuples, which make fields readonly and literal-typed and break in-place mutation (TS2540 in the test).
- ¶50 🤖 Wiring cycles produce circularity errors (TS7022/TS2502) and must be cut before generating.
- ¶60 🤖 `node.send()` outputs are not captured by return-type inference.
- ¶70 🤖 Any non-TS node on the wire resets the type to `any` unless junctions and link nodes are traced.
- ¶80 🤖 The editor body has no handler to query, so it could show as-deployed types only, which reintroduces type printing and its portability limits.
