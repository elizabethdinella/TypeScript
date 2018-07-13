namespace ts.codefix {
    const fixId = "convertToAsyncFunction";
    const errorCodes = [Diagnostics.This_may_be_converted_to_an_async_function.code];
    registerCodeFix({
        errorCodes,
        getCodeActions(context: CodeFixContext) {
            const changes = textChanges.ChangeTracker.with(context, (t) => convertToAsyncFunction(t, context.sourceFile, context.span.start, context.program.getTypeChecker()));
            return [createCodeFixAction(fixId, changes, Diagnostics.Convert_to_async_function, fixId, Diagnostics.Convert_all_to_async_functions)];
        },
        fixIds: [fixId],
        getAllCodeActions: context => codeFixAll(context, errorCodes, (changes, err) => convertToAsyncFunction(changes, err.file, err.start, context.program.getTypeChecker())),
    });
    function convertToAsyncFunction(changes: textChanges.ChangeTracker, sourceFile: SourceFile, position: number, checker: TypeChecker): void {
        // get the function declaration - returns a promise
        const funcToConvert: FunctionLikeDeclaration = getContainingFunction(getTokenAtPosition(sourceFile, position)) as FunctionLikeDeclaration;

        // add the async keyword
        changes.insertModifierBefore(sourceFile, SyntaxKind.AsyncKeyword, funcToConvert);

        const varNamesMap: Map<string> = new MapCtr();
        const synthNamesMap: Map<string> = new MapCtr();
        const funcToConvertRenamed = renameCollidingVarNames(funcToConvert, checker, varNamesMap, synthNamesMap);

        const retStmts: Node[] = getReturnStatementsWithPromiseCallbacks(funcToConvertRenamed, checker);

        const glued = glueTogetherCallbacks(retStmts);
        const gluedCallback = glued[0];
        let retStmtName = glued[1];
        if (gluedCallback) {
            const newNodes = parseCallback(gluedCallback, checker, gluedCallback, synthNamesMap, retStmtName, retStmtName);
            if (newNodes.length > 0) {
                changes.replaceNodeRangeWithNodes(sourceFile, retStmts[1].original!, retStmts[retStmts.length - 1].original!, newNodes);
            }
        }
        else {
            for (const stmt of retStmts) {
                if (isCallExpression(stmt)) {
                    const newNodes = parseCallback(stmt, checker, stmt, synthNamesMap, retStmtName, retStmtName);
                    if (newNodes.length > 0) {
                        changes.replaceNodeWithNodes(sourceFile, stmt, newNodes);
                    }
                }
                else if (isReturnStatement(stmt) && stmt.expression && isIdentifier(stmt.expression)) {
                    retStmtName = stmt.expression.text;
                }
                else {
                    forEachChild(stmt, function visit(node: Node) {

                        if (isReturnStatement(node) && node.expression && isIdentifier(node.expression)) {
                            retStmtName = node.expression.text;
                        }

                        if (isCallExpression(node)) {
                            const newNodes = parseCallback(node, checker, node, synthNamesMap, retStmtName, retStmtName);
                            if (newNodes.length > 0) {
                                changes.replaceNodeWithNodes(sourceFile, stmt, newNodes);
                            }
                        }
                        else if (!isFunctionLike(node)) {
                            forEachChild(node, visit);
                        }
                    });
                }
            }
        }
    }

    function glueTogetherCallbacks(retStmts: Node[]): [CallExpression | undefined, string] {
        retStmts = retStmts.slice(0);
        const stmt = retStmts.pop();
        if (!stmt) {
            return [undefined, ""];
        }

        if (isExpressionStatement(stmt) && stmt.expression && isCallExpression(stmt.expression)
            && stmt.expression.expression && isPropertyAccessExpression(stmt.expression.expression)) {
            const callArgs: NodeArray<Expression> = stmt.expression.arguments;
            const funcName: Identifier = stmt.expression.expression.name;
            const [gluedExpr, retName] = glueTogetherCallbacks(retStmts);
            if (gluedExpr) {
                const propertyAccessExpr = createPropertyAccess(gluedExpr, funcName);
                return [createCall(propertyAccessExpr, /*typeArguments*/ undefined, callArgs), retName];
            }
        }
        // fix this for multiple declarations
        else if (isVariableStatement(stmt) && stmt.declarationList.declarations.length > 0 && stmt.declarationList.declarations[0].initializer) {
            return [glueTogetherCallbacks([stmt.declarationList.declarations[0].initializer!])[0], glueTogetherCallbacks(retStmts)[1]];
        }
        else if (isCallExpression(stmt)) {
            return [stmt, glueTogetherCallbacks(retStmts)[1]];
        }
        else if (isReturnStatement(stmt) && stmt.expression && isIdentifier(stmt.expression)) {
            return [undefined, stmt.expression.text];
        }

        return [undefined, ""];
    }


    function renameCollidingVarNames(nodeToRename: Node, checker: TypeChecker, varNamesMap: Map<string>, synthNamesMap: Map<string>): Node {
        const allVarNames: string[] = [];

        forEachChild(nodeToRename, function visit(node: Node) {

            if (isIdentifier(node)) {
                const type = checker.getTypeAtLocation(node);
                const symbol = checker.getSymbolAtLocation(node);
                const newName = getNewNameIfConflict(node.text, allVarNames);

                if (symbol && type && type.getCallSignatures().length > 0 && type.getCallSignatures()[0].parameters.length > 0) {
                    // first, add the actual function name
                    if (allVarNames.filter(elem => elem === node.text).length > 0) {
                        // we have a conflict with the function name, but function names take precedence over variable names
                        varNamesMap.forEach((value: string, key: string) => {
                            if (value === node.text) {
                                varNamesMap.set(key, getNewNameIfConflict(node.text, allVarNames));
                                return;
                            }
                        });
                    }

                    varNamesMap.set(String(getSymbolId(symbol)), node.text);
                    allVarNames.push(node.text);

                    // next, add the new variable for the declaration
                    const synthName = type.getCallSignatures()[0].parameters[0].name;
                    const newSynthName = getNewNameIfConflict(synthName, allVarNames);
                    varNamesMap.set(String(getSymbolId(checker.createSymbol(SymbolFlags.BlockScopedVariable, getEscapedTextOfIdentifierOrLiteral(createIdentifier(newSynthName))))), newSynthName);
                    allVarNames.push(newSynthName);
                    synthNamesMap.set(node.text, newSynthName);
                }
                else if (symbol && !varNamesMap.get(String(getSymbolId(symbol)))) {
                    varNamesMap.set(String(getSymbolId(symbol)), newName);
                    allVarNames.push(node.text);
                }
            }

            forEachChild(node, visit);
        });

        return getSynthesizedDeepClone(nodeToRename, /*includeTrivia*/ true, varNamesMap, checker);
    }

    function getNewNameIfConflict(name: string, allVarNames: string[]) {
        const numVarsSameName = allVarNames.filter(elem => elem === name).length;
        return numVarsSameName === 0 ? name : name + "_" + numVarsSameName;
    }

    function returnsAPromise(node: CallExpression, checker: TypeChecker): boolean {
        const nodeType = checker.getTypeAtLocation(node);
        if (!nodeType) {
            return false;
        }

        return checker.isPromiseLikeType(nodeType) && !isCallback(node, "then", checker) && !isCallback(node, "catch", checker) && !isCallback(node, "finally", checker);
    }

    function parseCallback(node: Expression, checker: TypeChecker, outermostParent: CallExpression, synthNamesMap: Map<string>, prevArgName?: string, varDeclName?: string): Statement[] {
        if (!node) {
            return [];
        }

        if (isCallExpression(node) && returnsAPromise(node, checker)) {
            return parsePromiseCall(node, checker, prevArgName, varDeclName);
        }
        else if (isCallExpression(node) && isCallback(node, "then", checker)) {
            return parseThen(node, checker, outermostParent, synthNamesMap, prevArgName, varDeclName);
        }
        else if (isCallExpression(node) && isCallback(node, "catch", checker)) {
            return parseCatch(node, checker, synthNamesMap, prevArgName, varDeclName);
        }
        else if (isPropertyAccessExpression(node)) {
            return parseCallback(node.expression, checker, outermostParent, synthNamesMap, prevArgName, varDeclName);
        }

        return [];
    }

    function parseCatch(node: CallExpression, checker: TypeChecker, synthNamesMap: Map<string>, prevArgName?: string, varDeclName?: string): Statement[] {
        const func = getSynthesizedDeepClone(node.arguments[0]);
        const argName = getArgName(func, checker, synthNamesMap);

        const tryBlock = createBlock(parseCallback(node.expression, checker, node, synthNamesMap, argName, varDeclName));

        const callbackBody = getCallbackBody(func, prevArgName, argName, node, checker, synthNamesMap, varDeclName);
        const catchClause = createCatchClause(argName, createBlock(callbackBody));

        return [createTry(tryBlock, catchClause, /*finallyBlock*/ undefined)];
    }

    function parseThen(node: CallExpression, checker: TypeChecker, outermostParent: CallExpression, synthNamesMap: Map<string>, prevArgName?: string, varDeclName?: string): Statement[] {
        const [res, rej] = node.arguments;

        // TODO - what if this is a binding pattern and not an Identifier
        if (!res) {
            return parseCallback(node.expression, checker, outermostParent, synthNamesMap, prevArgName, varDeclName);
        }


        const argNameRes = getArgName(res, checker, synthNamesMap);
        const callbackBody = getCallbackBody(res, prevArgName, argNameRes, node, checker, synthNamesMap, varDeclName);

        if (rej) {
            const argNameRej = getArgName(rej, checker, synthNamesMap);

            const tryBlock = createBlock(parseCallback(node.expression, checker, node, synthNamesMap, argNameRes, varDeclName).concat(callbackBody));

            const callbackBody2 = getCallbackBody(rej, prevArgName, argNameRej, node, checker, synthNamesMap, varDeclName, /*isRej*/ true);
            const catchClause = createCatchClause(argNameRej, createBlock(callbackBody2));

            return [createTry(tryBlock, catchClause, /*finallyBlock*/ undefined) as Statement];
        }
        else if (res) {
            return parseCallback(node.expression, checker, node, synthNamesMap, argNameRes, varDeclName).concat(callbackBody);
        }

        return [];
    }

    function parsePromiseCall(node: CallExpression, checker: TypeChecker, prevArgName?: string, varDeclName?: string): Statement[] {
        const nextDotThen = getNextDotThen(node.original!.parent as Expression, checker);
        if (prevArgName && nextDotThen && isPropertyAccessExpression(node.original!.parent) || (prevArgName && varDeclName)) {
            const varDecl = createVariableDeclaration(prevArgName, /*type*/ undefined, createAwait(node));
            return [createVariableStatement(/* modifiers */ undefined, (createVariableDeclarationList([varDecl], NodeFlags.Let)))];
        }
        else if (!prevArgName && nextDotThen && isPropertyAccessExpression(node.original!.parent)) {
            return [createStatement(createAwait(node))];
        }

        return [createReturn(node)];
    }

    function getNextDotThen(node: Expression, checker: TypeChecker): CallExpression | undefined {
        if (!node) {
            return undefined;
        }

        if (isCallExpression(node) && isCallback(node, "then", checker)) {
            return node;
        }
        else {
            return getNextDotThen(node.parent as Expression, checker);
        }
    }

    function getCallbackBody(func: Node, prevArgName: string | undefined, argName: string, parent: CallExpression, checker: TypeChecker, synthNamesMap: Map<string>, varDeclName?: string, isRej = false): NodeArray<Statement> {
        if (!prevArgName && argName) {
            prevArgName = argName;
        }

        const outerParent = parent.original ? parent.original.parent : undefined;
        const nextDotThen = getNextDotThen(outerParent as Expression, checker);

        switch (func.kind) {
            case SyntaxKind.Identifier:
                if (!prevArgName || !argName) {
                    break;
                }

                let synthCall = createCall(func as Identifier, /*typeArguments*/ undefined, [createIdentifier(argName)]);
                if (!nextDotThen || (<PropertyAccessExpression>parent.expression).name.text === "catch" || isRej) {
                    return createNodeArray([createReturn(synthCall)]);
                }

                synthCall = createCall(func as Identifier, /*typeArguments*/ undefined, [createIdentifier(argName)]);
                return createNodeArray([createVariableStatement(/*modifiers*/ undefined, (createVariableDeclarationList([createVariableDeclaration(prevArgName, /*type*/ undefined, (createAwait(synthCall)))], NodeFlags.Let)))]);

            case SyntaxKind.FunctionDeclaration:
            case SyntaxKind.FunctionExpression:
            case SyntaxKind.ArrowFunction:

                if (isFunctionLikeDeclaration(func) && func.body && isBlock(func.body) && func.body.statements) {
                    const innerRetStmts: Node[] = getReturnStatementsWithPromiseCallbacks(func.body as Node, checker);
                    const innerCbBody = getInnerCallbackBody(checker, innerRetStmts, synthNamesMap, prevArgName, varDeclName);
                    if (innerCbBody.length > 0) {
                        return createNodeArray(innerCbBody);
                    }

                    return nextDotThen ? removeReturns(func.body.statements, prevArgName!) : func.body.statements;

                }
                else if (isArrowFunction(func)) {
                    // if there is another outer dot then, don't actually return

                    const innerRetStmts: Node[] = getReturnStatementsWithPromiseCallbacks(createReturn(func.body as Expression), checker);
                    const innerCbBody = getInnerCallbackBody(checker, innerRetStmts, synthNamesMap, prevArgName, varDeclName);
                    if (innerCbBody.length > 0) {
                        return createNodeArray(innerCbBody);
                    }

                    return nextDotThen || (prevArgName && varDeclName) ?
                        createNodeArray([createVariableStatement(/*modifiers*/ undefined, (createVariableDeclarationList([createVariableDeclaration(prevArgName!, /*type*/ undefined, func.body as Expression)], NodeFlags.Let)))]) :
                        createNodeArray([createReturn(func.body as Expression)]);
                }
                break;
        }
        return createNodeArray([]);
    }

    function removeReturns(stmts: NodeArray<Statement>, prevArgName: string): NodeArray<Statement> {
        const ret: Statement[] = [];
        for (const stmt of stmts) {
            if (isReturnStatement(stmt)) {
                if (stmt.expression) {
                    ret.push(createVariableStatement(/*modifiers*/ undefined, (createVariableDeclarationList([createVariableDeclaration(prevArgName, /*type*/ undefined, stmt.expression)], NodeFlags.Let))));
                }
            }
            else {
                ret.push(stmt);
            }
        }

        return createNodeArray(ret);
    }

    function getInnerCallbackBody(checker: TypeChecker, innerRetStmts: Node[], synthNamesMap: Map<string>, prevArgName?: string, varDeclName?: string) {
        let innerCbBody: Statement[] = [];
        for (const stmt of innerRetStmts) {
            forEachChild(stmt, function visit(node: Node) {
                if (isCallExpression(node)) {
                    const temp = parseCallback(node, checker, node, synthNamesMap, prevArgName, varDeclName);
                    innerCbBody = innerCbBody.concat(temp);
                    if (innerCbBody.length > 0) {
                        return;
                    }
                }
                else if (!isFunctionLike(node)) {
                    forEachChild(node, visit);
                }
            });
        }
        return innerCbBody;
    }

    function isCallback(node: CallExpression, funcName: string, checker: TypeChecker): boolean {
        // can probably get rid of this if statement
        if (node.expression.kind !== SyntaxKind.PropertyAccessExpression) {
            return false;
        }

        const nodeType = checker.getTypeAtLocation(node);
        if (!nodeType) {
            return false;
        }

        return (<PropertyAccessExpression>node.expression).name.text === funcName && checker.isPromiseLikeType(nodeType);
    }

    function getArgName(funcNode: Node, checker: TypeChecker, synthNamesMap: Map<string>): string {
        let name;
        const funcNodeType = checker.getTypeAtLocation(funcNode);

        if (isFunctionLikeDeclaration(funcNode) && funcNode.parameters.length > 0) {
            name = (<Identifier>funcNode.parameters[0].name).text;
        }
        else if (funcNodeType && funcNodeType.getCallSignatures().length > 0 && funcNodeType.getCallSignatures()[0].parameters.length > 0) {
            name = funcNodeType.getCallSignatures()[0].parameters[0].name;
            // TODO : maybe get rid of this
        }
        else if (isCallExpression(funcNode) && funcNode.arguments.length > 0 && isIdentifier(funcNode.arguments[0])) {
            name = (<Identifier>funcNode.arguments[0]).text;
        }
        else if (isIdentifier(funcNode)) {
            name = synthNamesMap.get(funcNode.text);
        }

        if (name === undefined || name === "_") {
            return "";
        }

        return name;
    }
}