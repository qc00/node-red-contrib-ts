import type { Checker } from 'typescript/async';
import type { CallExpression, Expression, Identifier, Node, SourceFile } from 'typescript/ast';
import type { TypeScriptCompiler } from '../compiler/TypeScriptCompiler';
import { ContextScope, InferredContextSet } from './ContextTypeRegistry';
import { ModuleSpecifierExtensionRestorer } from './ModuleSpecifierExtensionRestorer';
import { NodeVirtualSource } from './NodeVirtualSourceBuilder';

interface ContextSetCall {
    scope: ContextScope;
    root: Identifier;
    key: string;
    value: Expression;
}

/** Finds `context|flow|global.set('<literal>', value)` calls on the default store and prints the type of each value. */
export async function inferContextSets(
    compiler: TypeScriptCompiler,
    checker: Checker,
    sourceFile: SourceFile,
    source: NodeVirtualSource,
    specifiers: ModuleSpecifierExtensionRestorer,
): Promise<InferredContextSet[]> {
    const { ast, flags } = compiler;
    const typeFormat = flags.TypeFormatFlags.NoTruncation | flags.TypeFormatFlags.UseFullyQualifiedType;

    const scopeOfReceiver = (receiver: Expression): { scope: ContextScope; root: Identifier } | undefined => {
        if (ast.isIdentifier(receiver)) {
            if (receiver.text === 'context') return { scope: 'node', root: receiver };
            if (receiver.text === 'flow') return { scope: 'flow', root: receiver };
            if (receiver.text === 'global') return { scope: 'global', root: receiver };
        } else if (
            ast.isPropertyAccessExpression(receiver)
            && ast.isIdentifier(receiver.expression)
            && receiver.expression.text === 'context'
        ) {
            if (receiver.name.text === 'flow') return { scope: 'flow', root: receiver.expression };
            if (receiver.name.text === 'global') return { scope: 'global', root: receiver.expression };
        }
        return undefined;
    };

    const calls: ContextSetCall[] = [];
    const visit = (node: Node) => {
        if (ast.isCallExpression(node)) {
            const call = node as CallExpression;
            const callee = call.expression;
            const key = call.arguments[0];
            if (
                ast.isPropertyAccessExpression(callee)
                && callee.name.text === 'set'
                && call.arguments.length === 2
                && (ast.isStringLiteral(key) || ast.isNoSubstitutionTemplateLiteral(key))
            ) {
                const receiver = scopeOfReceiver(callee.expression);
                if (receiver) calls.push({ ...receiver, key: key.text, value: call.arguments[1] });
            }
        }
        node.forEachChild(visit);
    };
    visit(sourceFile);
    if (!calls.length) return [];

    const isGeneratedContextValue = async (identifier: Identifier) => {
        const declarations = (await checker.getSymbolAtLocation(identifier))?.declarations || [];
        if (!declarations.length) return false;
        for (const handle of declarations) {
            const declaration = await handle.resolve();
            if (
                !declaration
                || declaration.getSourceFile() !== sourceFile
                || declaration.getStart(sourceFile) < source.contextDeclarations.start
                || declaration.end > source.contextDeclarations.end
            ) return false;
        }
        return true;
    };

    const result: InferredContextSet[] = [];
    for (const call of calls) {
        if (!await isGeneratedContextValue(call.root)) continue;
        const valueType = await checker.getBaseTypeOfLiteralType(await checker.getTypeAtLocation(call.value));
        const type = specifiers.restore(await checker.typeToString(valueType, undefined, typeFormat));
        result.push({ scope: call.scope, key: call.key, type });
    }
    return result;
}
