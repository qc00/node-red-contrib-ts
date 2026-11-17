import ts from 'typescript';
import { ContextScope, InferredContextSet } from './ContextTypeRegistry';
import { NodeVirtualSource } from './NodeVirtualSourceBuilder';

const TYPE_FORMAT = ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseFullyQualifiedType;

function scopeOfReceiver(receiver: ts.Expression): { scope: ContextScope; root: ts.Identifier } | undefined {
    if (ts.isIdentifier(receiver)) {
        if (receiver.text === 'context') return { scope: 'node', root: receiver };
        if (receiver.text === 'flow') return { scope: 'flow', root: receiver };
        if (receiver.text === 'global') return { scope: 'global', root: receiver };
    } else if (
        ts.isPropertyAccessExpression(receiver)
        && ts.isIdentifier(receiver.expression)
        && receiver.expression.text === 'context'
    ) {
        if (receiver.name.text === 'flow') return { scope: 'flow', root: receiver.expression };
        if (receiver.name.text === 'global') return { scope: 'global', root: receiver.expression };
    }
    return undefined;
}

/** Finds `context|flow|global.set('<literal>', value)` calls on the default store and prints the type of each value. */
export function inferContextSets(
    checker: ts.TypeChecker,
    sourceFile: ts.SourceFile,
    source: NodeVirtualSource,
): InferredContextSet[] {
    const result: InferredContextSet[] = [];

    const isGeneratedContextValue = (identifier: ts.Identifier) => {
        const declarations = checker.getSymbolAtLocation(identifier)?.declarations || [];
        return declarations.length > 0 && declarations.every(declaration =>
            declaration.getSourceFile() === sourceFile
            && declaration.getStart() >= source.contextDeclarations.start
            && declaration.getEnd() <= source.contextDeclarations.end);
    };

    const visit = (node: ts.Node) => {
        if (
            ts.isCallExpression(node)
            && ts.isPropertyAccessExpression(node.expression)
            && node.expression.name.text === 'set'
            && node.arguments.length === 2
            && ts.isStringLiteralLike(node.arguments[0])
        ) {
            const receiver = scopeOfReceiver(node.expression.expression);
            if (receiver && isGeneratedContextValue(receiver.root)) {
                const valueType = checker.getBaseTypeOfLiteralType(checker.getTypeAtLocation(node.arguments[1]));
                result.push({
                    scope: receiver.scope,
                    key: (node.arguments[0] as ts.StringLiteralLike).text,
                    type: checker.typeToString(valueType, undefined, TYPE_FORMAT),
                });
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return result;
}
