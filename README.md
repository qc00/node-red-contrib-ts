# Node-RED TypeScript Node

A fast TypeScript execution node for Node-RED with Monaco editor, type checking, and multi-tab configuration.

## Installation

Install via Node-RED palette manager by searching for `node-red-contrib-ts`

Or via npm:
```bash
npm install node-red-contrib-ts
```

## TypeScript Node

Execute TypeScript code directly in your Node-RED flows with full type checking, modern JavaScript features, and multi-tab editor interface similar to the standard Function node.

### Features

- **Monaco Editor** - Same editor as VS Code with syntax highlighting and IntelliSense
- **TypeScript Support** - Full TypeScript compilation with error checking
- **Multi-Tab Interface** - Separate tabs for initialization, main function, and cleanup code
- **Custom Type Declarations** - Define your own TypeScript interfaces and types
- **External Module Support** - Import npm modules with type safety
- **Async/Await Ready** - Your code runs in an async function context
- **Multiple Outputs** - Route messages to different outputs
- **Two Execution Modes** - Function mode (fast) or VM mode (secure)

![TypeScript Node](screenshots/node.png)

![Monaco Editor with IntelliSense](screenshots/intelliSense.png)

### Performance Benchmark

Benchmark results for 500,000 executions:
- **Node-RED function node**: 11,886ms
- **TypeScript node (Function mode)**: 6,177ms - **1.9x faster**
- **TypeScript node (VM mode)**: 10,222ms - **1.2x faster**

![Performance Benchmark](screenshots/benchmark.png)

### Available Context

Your TypeScript code has access to these variables:

- `msg` - The incoming message object
- `node` - The current node instance for logging, status and sending
- `RED` - Node-RED API
- `context`, `flow`, `global` - Node, flow and global context storage
- `env` - Environment variables via `env.get('VAR_NAME')`
- `Buffer`, `fetch`, `URL`, `console`, timers - Node.js globals
- Modules added under **Setup → Modules**, each under the variable name given there.
  Node.js modules such as `fs`, `path`, `os` or `crypto` are not present until they are added; the **Add Defaults** button adds the common ones.

### Usage

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

### Configuration

The TypeScript node provides the same functionality as the standard Function node but with TypeScript support and enhanced features:

#### Editor Tabs

- **On Start** - Code executed once when the node starts (initialization)
- **On Message** - Main function code executed for each incoming message  
- **On Stop** - Code executed when the node is stopped or redeployed (cleanup)

#### Setup Tab

- **tsconfig** - Optional `typescript-config` node holding the compiler options for this node
- **Type Declarations** - Define custom TypeScript interfaces and types
- **External Modules** - Import npm modules with automatic type definitions
- **Outputs** - Number of outputs
- **Timeout** - Execution timeout in milliseconds
- **Execution Mode** - Function mode (faster) or VM mode (more secure)

![Setup Configuration](screenshots/props2.png)

### Type Checking

Code is checked in the editor as you type and again on the server after every deploy.
The deploy-time check never stops a node from running: problems are reported as warnings on the node, with the tab and line they belong to.

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

Only `compilerOptions` is used, and options that control output files are ignored; the dialog lists anything it ignores.
Any number of config nodes can exist and each typescript node picks one.
A node without one is checked with TypeScript's non-strict defaults.

#### Module types

A module imported as variable `y` is typed as if the code started with `import * as y from 'module'`, so its types are available as `y.SomeType`:

```typescript
// Modules: path as "path"
const parsed: path.ParsedPath = path.parse(msg.filename);
```

For a package with a default export, `y` is that default export, which is what the node provides at runtime.
In the editor, types of npm packages appear once the package is installed, i.e. after the node using it has been deployed once.

#### Typed context

The type of every value stored with `context.set`, `flow.set` or `global.set` under a literal key is tracked, across all typescript nodes, and `get` returns it:

```typescript
// node A
flow.set('lastReading', { celsius: 21.5, at: Date.now() });

// node B, same flow
const reading = flow.get('lastReading');   // { celsius: number; at: number } | undefined
```

If a key is set with different types in different places, `get` returns their union, so only the common fields can be used without a check.
Keys that are not tracked (set by other node types, computed keys, non-default stores) are untyped, as before; `flow.get<MyType>('key')` states the type explicitly.
The editor shows the types of the last deploy and updates them for the node being edited as you type.

#### The TypeScript worker

Compiling, the deploy-time check and the editor's tsconfig and module typing requests all run in one worker thread, so flows keep running while TypeScript works.
The worker starts when it is first needed and is shared by all `typescript` nodes.
A deploy that arrives while a check is still running abandons that check, compiles the new nodes, and then checks again.

A `typescript-config` node controls the worker:

- **Keep the TypeScript worker running**: the worker is never stopped, which keeps TypeScript and the last check's program in memory.
- **Stop idle worker after**: seconds without work before the worker is stopped and its memory freed (default 30).
  With several configurations the longest time applies.
- **Worker heap limit**: megabytes of JavaScript heap the worker may use.
  A check that needs more is skipped with a warning; compiling is retried without the limit so nodes still start.
  With several configurations the largest limit applies.

The log shows how long the worker took to start, how long each node took to compile and check, and the worker's heap use per check.

### Editor Features

- **IntelliSense** - Auto-completion for available context variables with precise type definitions
- **TypeScript Validation** - Real-time error checking with Node-RED context awareness
- **Smart Error Filtering** - Automatically ignores await/return errors for seamless Node-RED integration
- **Syntax Highlighting** - Full TypeScript syntax support
- **Template Code** - Helpful starter template for new nodes

![TypeScript Validation](screenshots/typescript-validation.png)

The editor provides comprehensive TypeScript support with:
- **Type checking** for all Node-RED context variables (`msg`, `node`, `env`, etc.)
- **Automatic filtering** of context-specific errors (await/return statements work seamlessly)
- **Real-time validation** as you type with precise error messages and suggestions

## License

This project is licensed under the Apache-2.0 License - see the [LICENSE](LICENSE) file for details.

You are free to use this software in commercial environments, modify it, and distribute it without requiring to share your modifications.

## Acknowledgments

Special thanks to [@sheng-ri](https://github.com/sheng-ri) for the [fork](https://github.com/sheng-ri/node-red-contrib-ts) that contributed important fixes and improvements including:
- No declare-error check on close.
- Fixed duplicate type definition issue.
