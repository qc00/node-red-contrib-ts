import { NODE_RED_SANDBOX_VALUE_DECLARATIONS, generateServerModuleImports, ModuleLib } from './declarations';

export interface NodeSourceDefinition {
    id: string;
    flowId: string;
    libs: ModuleLib[];
    declare: string;
    initialize: string;
    func: string;
    finalize: string;
}

export type NodeSourceSectionName = 'Type Declarations' | 'On Start' | 'On Message' | 'On Stop';

export interface TextSpan {
    start: number;
    end: number;
}

export interface NodeSourceSection extends TextSpan {
    name: NodeSourceSectionName;
}

export interface NodeSourceLocation {
    section: NodeSourceSectionName;
    line: number;
    column: number;
}

/** One node's code as a module the type checker can read, remembering where each user-written part sits. */
export class NodeVirtualSource {
    constructor(
        readonly text: string,
        readonly sections: NodeSourceSection[],
        readonly contextDeclarations: TextSpan,
    ) {}

    /** Maps an offset in `text` to the user's own line/column, or undefined for generated code. */
    locate(offset: number): NodeSourceLocation | undefined {
        const section = this.sections.find(s => offset >= s.start && offset <= s.end);
        if (!section) return undefined;
        const before = this.text.slice(section.start, offset);
        const lastBreak = before.lastIndexOf('\n');
        return {
            section: section.name,
            line: before.split('\n').length,
            column: before.length - lastBreak,
        };
    }
}

export function buildNodeVirtualSource(definition: NodeSourceDefinition, contextDeclarations: string): NodeVirtualSource {
    const moduleImports = generateServerModuleImports(definition.libs);
    const sections: NodeSourceSection[] = [];
    let text = '';

    const appendUserText = (name: NodeSourceSectionName, userText: string) => {
        sections.push({ name, start: text.length, end: text.length + userText.length });
        text += userText + '\n';
    };
    const appendHandler = (name: NodeSourceSectionName, functionName: string, parameters: string[], body: string) => {
        text += `async function ${functionName}(${parameters.join(', ')}) {\n`;
        appendUserText(name, body);
        text += '}\n';
    };

    text += moduleImports.imports;
    text += 'export {};\n';
    text += NODE_RED_SANDBOX_VALUE_DECLARATIONS;
    const contextStart = text.length;
    text += contextDeclarations;
    const contextSpan = { start: contextStart, end: text.length };
    appendUserText('Type Declarations', definition.declare || '');
    appendHandler('On Start', '__onStart', moduleImports.parameters, definition.initialize || '');
    appendHandler('On Message', '__onMessage', ['msg: NodeMessage & NodeRedBaseMessage', ...moduleImports.parameters], definition.func || '');
    appendHandler('On Stop', '__onStop', moduleImports.parameters, definition.finalize || '');

    return new NodeVirtualSource(text, sections, contextSpan);
}
