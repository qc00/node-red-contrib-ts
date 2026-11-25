# Node-RED TypeScript Node

Automatically compiles TypeScript and execute them like stock function nodes but with enhanced type checking.

## Installation

Install via Node-RED palette manager by searching for `node-red-contrib-ts`

Or via npm:
```bash
npm install node-red-contrib-ts
```

## Enhancements over Function Nodes

- **TypeScript**
  - Full TypeScript compilation with error & type checking
  - Type declarations for the Node RED APIs
  - Includes types for imported modules if correctly installed
  - Tracks types of data saved into contexts
  - Custom `tsconfig`
- **Custom Type Declarations** - Define your own TypeScript interfaces and types
- **Async/Await Ready** - Your code runs in an async function context
- **Two Execution Modes** - Function mode (fast) or VM mode (secure)

![TypeScript Node](screenshots/node.png)

![Monaco Editor with IntelliSense](screenshots/intelliSense.png)

![Setup Configuration](screenshots/props2.png)

### Performance Benchmark

Benchmark results for 500,000 executions:
- **Node-RED function node**: 11,886ms
- **TypeScript node (Function mode)**: 6,177ms - **1.9x faster**
- **TypeScript node (VM mode)**: 10,222ms - **1.2x faster**

![Performance Benchmark](screenshots/benchmark.png)

### Example

**API call with custom types:**
```typescript
// Type Declarations tab
interface ApiResponse {
    data: {
        id: number;
        name: string;
        status: 'active' | 'inactive';
    }[];
    meta: {
        total: number;
        page: number;
    };
}

interface NodeMessage {
    payload?: {
        userId: number;
        filter?: string;
    };
}
```

```typescript
// On Message tab
try {
    const apiKey = env.get('API_KEY');
    const { userId, filter } = msg.payload;
    
    const response = await fetch(`https://api.example.com/users/${userId}/data`, {
        headers: { 'Authorization': `Bearer ${apiKey}` }
    });
    
    if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
    }
    
    const apiData: ApiResponse = await response.json();
    msg.payload = apiData.data.filter(item => 
        filter ? item.name.includes(filter) : true
    );
    
    return msg;
} catch (error) {
    node.error(error.message);
    return null;
}
```

### Type Checking

Code is checked in the editor as you type and again on the server after every deploy.

This is because the type-checker in the Monaco Editor is part of the hosting Node RED distribution
and likely embeds an older version of TypeScript.
Checking again on the server also catches changes directly made to the flow file or after dependency upgrades.

The deploy-time check never stops a node from running: problems are reported as warnings on the node.

#### tsconfig

Add a `typescript-config` node from the **tsconfig** field on the Setup tab and write it like a `tsconfig.json` (comments and trailing commas are allowed):

```jsonc
{
    "compilerOptions": {
        "strict": true,
        "noUncheckedIndexedAccess": true
    }
}
```

Only `compilerOptions` is used, and options that control output files are ignored.

#### Module types

A module imported as variable `y` is typed as if the code started with `import * as y from 'module'`, so its types are available as `y.SomeType`:

```typescript
// Modules: path as "path"
const parsed: path.ParsedPath = path.parse(msg.filename);
```

For a package with a default export, the import variable `y` reflects the value & type of that default export.

In the editor, types of npm modules appear if the relevant package installed on the Node RED server
and a node using it has been deployed once.

#### Typed context

The type of every value stored with `context.set`, `flow.set` or `global.set` under a literal key is tracked,
across all typescript nodes, and `get` returns it:

```typescript
// node A
flow.set('lastReading', { celsius: 21.5, at: Date.now() });

// node B, same flow
const reading = flow.get('lastReading');   // { celsius: number; at: number } | undefined
```

If a key is set with different types in different places, `get` returns their union,
so only the common fields can be used without a check.

Keys that are not tracked (e.g. set by other node types) are untyped, as before;
use `flow.get<MyType>('key')` to state the type explicitly.

The editor shows the types of the last deploy and updates them for the node being edited as you type.

#### The TypeScript compiler

The node uses TypeScript 7 native `tsc`, which runs as a separate process that starts when it is first needed and is shared by all `typescript` nodes.
The type check is async.

A `typescript-config` node controls the process behaviour.

The editor checks with the TypeScript version built into Node-RED's code editor, 
so the editor and the deploy-time check can differ on newer language features.

### Editor Features

- **IntelliSense** - Auto-completion for available context variables with precise type definitions
- **TypeScript Validation** - Real-time error checking with Node-RED context awareness
- **Smart Error Filtering** - Automatically ignores await/return errors for seamless Node-RED integration
- **Syntax Highlighting** - Full TypeScript syntax support
- **Template Code** - Helpful starter template for new nodes

![TypeScript Validation](screenshots/typescript-validation.png)

## License

This project is licensed under the Apache-2.0 License - see the [LICENSE](LICENSE) file for details.

You are free to use this software in commercial environments, modify it, and distribute it without requiring to share your modifications.

## Acknowledgments

Special thanks to [@sheng-ri](https://github.com/sheng-ri) for the [fork](https://github.com/sheng-ri/node-red-contrib-ts) that contributed important fixes and improvements including:
- No declare-error check on close.
- Fixed duplicate type definition issue.
