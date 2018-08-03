namespace ts.codefix {
    const fixId = "convertToAsyncFunction";
    const errorCodes = [Diagnostics.This_may_be_converted_to_an_async_function.code];
    registerCodeFix({
        errorCodes,
        getCodeActions(context: CodeFixContext) {
            const changes = textChanges.ChangeTracker.with(context, (t) => convertToAsyncFunction(t, context.sourceFile, context.span.start, context.program.getTypeChecker(), context));
            return [createCodeFixAction(fixId, changes, Diagnostics.Convert_to_async_function, fixId, Diagnostics.Convert_all_to_async_functions)];
        },
        fixIds: [fixId],
        getAllCodeActions: context => codeFixAll(context, errorCodes, (changes, err) => convertToAsyncFunction(changes, err.file, err.start, context.program.getTypeChecker(), context)),
    });
    function convertToAsyncFunction(changes: textChanges.ChangeTracker, sourceFile: SourceFile, position: number, checker: TypeChecker, context: CodeFixContextBase): void {
        // get the function declaration - returns a promise
        const functionToConvert: FunctionLikeDeclaration = getContainingFunction(getTokenAtPosition(sourceFile, position)) as FunctionLikeDeclaration;
        if (!functionToConvert) {
            return;
        }

        // add the async keyword
        changes.insertModifierBefore(sourceFile, SyntaxKind.AsyncKeyword, functionToConvert);

        const synthNamesMap: Map<SynthIdentifier> = createMap(); // number indicates the number of times it is used after declaration

        const functionToConvertRenamed: FunctionLikeDeclaration = renameCollidingVarNames(functionToConvert, checker, synthNamesMap, context);
        const lastDotThenMap = findLastDotThens(functionToConvertRenamed, checker);
        const constIdentifiers = getConstIdentifiers(synthNamesMap);

        const returnStatements = getReturnStatementsWithPromiseCallbacks(functionToConvertRenamed);
        const allNewNodes: Map<Node[]> = createMap();

        function startParse(node: CallExpression, nodeToReplace: Node) {
            const newNodes = parseCallback(node, checker, node, synthNamesMap, lastDotThenMap, context, constIdentifiers);
            if (newNodes.length) {
                allNewNodes.set(getNodeId(nodeToReplace).toString(), newNodes);
            }
        }

        for (const statement of returnStatements) {
            if (isCallExpression(statement)) {
                startParse(statement, statement);
            }
            else {
                forEachChild(statement, function visit(node: Node) {
                    if (isCallExpression(node)) {
                        startParse(node, statement);
                    }
                    else if (!isFunctionLike(node)) {
                        forEachChild(node, visit);
                    }
                });
            }
        }

        replaceNodes(changes, sourceFile, returnStatements, allNewNodes);
    }

    function replaceNodes(changes: textChanges.ChangeTracker, sourceFile: SourceFile, oldNodes: Node[], allNewNodes: Map<Node[]>) {
        for (const statement of oldNodes) {
            const newNodes = allNewNodes.get(getNodeId(statement).toString());
            if (newNodes) {
                changes.replaceNodeWithNodes(sourceFile, statement, newNodes);
            }
        }
    }

    function getConstIdentifiers(synthNamesMap: Map<SynthIdentifier>): Identifier[] {
        const constIdentifiers: Identifier[] = [];
        synthNamesMap.forEach((val) => {
            if (val.numberOfUses === 1) {
                constIdentifiers.push(val.identifier);
            }
        });
        return constIdentifiers;
    }

    function findLastDotThens(func: FunctionLikeDeclaration, checker: TypeChecker): Map<boolean> {
        if (!func.body) {
            return createMap();
        }

        function willBeParsed(node: Expression): boolean {
            let nodeType = checker.getTypeAtLocation(node);
            return !!nodeType && (returnsAPromise(node, nodeType, checker) || (isCallExpression(node) && !!checker.getPromisedTypeOfPromise(nodeType) && (hasPropertyAccessExpressionWithName(node, "then") || hasPropertyAccessExpressionWithName(node, "catch"))));
        }

        // maps nodes to boolean - true indicates that there is another .then() in the callback chain
        const lastDotThen: Map<boolean> = createMap();

        forEachChild(func.body, function visit(node: Node) {
            let nodeType = checker.getTypeAtLocation(node);
            if (isCallExpression(node) && nodeType && !!checker.getPromisedTypeOfPromise(nodeType) && hasPropertyAccessExpressionWithName(node, "then")) {
                // false - there is no following .then() in the callback chain
                lastDotThen.set(getNodeId(node).toString(), false);

                for (const arg of node.arguments) {
                    forEachChild(arg, function visitArg(argChild: Expression) {
                        if (willBeParsed(argChild)) {
                            // false - there is no following .then() in the callback chain
                            lastDotThen.set(getNodeId(argChild).toString(), false);
                        }
                    });
                }

                forEachChild(node, function visit(child: Node) {
                    if (isExpression(child) && willBeParsed(child)) {
                        // true - there is a following .then() in the callback chain
                        lastDotThen.set(getNodeId(child).toString(), true);

                        if (!isCallExpression(child)) {
                            return;
                        }

                        for (const arg of child.arguments) {
                            forEachChild(arg, function visit(argChild: Expression) {
                                if (willBeParsed(argChild)) {
                                    // true - there is a following .then() in the callback chain
                                    lastDotThen.set(getNodeId(argChild).toString(), true);
                                }
                            });
                        }
                    }

                    forEachChild(child, visit);
                });
            }
            else {
                forEachChild(node, visit);
            }
        });

        return lastDotThen;
    }

    function isFunctionRef(node: Node): boolean {
        const callExpr = climbPastPropertyAccess(node);
        return !isCallExpression(callExpr) || callExpr.expression !== node;
    }

    function definedInFile(symbol: Symbol, sourceFile: SourceFile): boolean {
        return symbol.valueDeclaration && symbol.valueDeclaration.getSourceFile() === sourceFile;
    }

    // varNamesMap holds all of the variables in original source code. synthNamesMap holds all of the variables created by the refactor
    function renameCollidingVarNames(nodeToRename: FunctionLikeDeclaration, checker: TypeChecker, synthNamesMap: Map<SynthIdentifier>, context: CodeFixContextBase): FunctionLikeDeclaration {
        const allVarNames: [Identifier, Symbol][] = [];


        forEachChild(nodeToRename, function visit(node: Node) {
            const symbol = checker.getSymbolAtLocation(node);
            const isDefinedInFile = symbol ? definedInFile(symbol, context.sourceFile) : undefined;

            if (isIdentifier(node) && symbol && isDefinedInFile) {
                const type = checker.getTypeAtLocation(node);

                // if the identifier refers to a function
                if (type && type.getCallSignatures().length > 0 && isFunctionRef(node)) {
                    if (type.getCallSignatures()[0].parameters.length && !synthNamesMap.get(getSymbolId(symbol).toString())) {
                        // add the new synthesized variable for the declaration (ex. blob in let blob = res(arg))
                        const synthName = getNewNameIfConflict(createIdentifier(type.getCallSignatures()[0].parameters[0].name), allVarNames);
                        allVarNames.push([synthName.identifier, symbol]);
                        synthNamesMap.set(getSymbolId(symbol).toString(), synthName);
                    }
                }
                else {
                    const newName = getNewNameIfConflict(node, allVarNames);
                    let setName = false;

                    for (const ident of allVarNames) {
                        if (ident[0].text === node.text && ident[1] !== symbol) {
                            allVarNames.push([newName.identifier, symbol]);
                            synthNamesMap.set(getSymbolId(symbol).toString(), newName);
                            setName = true;
                        }
                    }

                    if (!setName) {
                        if (node.parent && isParameter(node.parent) || isVariableDeclaration(node.parent)) {
                            allVarNames.push([node, symbol]);
                        }
                        synthNamesMap.set(getSymbolId(symbol).toString(), {identifier: getSynthesizedDeepClone(node), numberOfUses: allVarNames.filter(elem => elem[0].text === node.text).length});
                    }
                }
            }
            else {
                forEachChild(node, visit);
            }
        });

        return getSynthesizedDeepClone(nodeToRename, /*includeTrivia*/ true, synthNamesMap, checker);
    }

    function getNewNameIfConflict(name: Identifier, allVarNames: [Identifier, Symbol][]): SynthIdentifier {
        const numVarsSameName = allVarNames.filter(elem => elem[0].text === name.text).length;
        return numVarsSameName === 0 ? {identifier: name, numberOfUses: 1} : {identifier: createIdentifier(name.text + "_" + numVarsSameName), numberOfUses: numVarsSameName};
    }

    function returnsAPromise(node: Expression, nodeType: Type, checker: TypeChecker): boolean {
        return (!isCallExpression(node) || !hasPropertyAccessExpressionWithName(node, "then") && !hasPropertyAccessExpressionWithName(node, "catch")) && !!checker.getPromisedTypeOfPromise(nodeType);
    }

    // dispatch function to recursively build the refactoring
    function parseCallback(node: Expression, checker: TypeChecker, outermostParent: CallExpression, synthNamesMap: Map<SynthIdentifier>,
        lastDotThenMap: Map<boolean>, context: CodeFixContextBase, constIdentifiers: Identifier[], prevArgName?: SynthIdentifier): Statement[] {
        if (!node) {
            return [];
        }

        const nodeType = checker.getTypeAtLocation(node);

        if (isCallExpression(node) && hasPropertyAccessExpressionWithName(node, "then") && nodeType && !!checker.getPromisedTypeOfPromise(nodeType)) {
            return parseThen(node, checker, outermostParent, synthNamesMap, lastDotThenMap, context, constIdentifiers, prevArgName);
        }
        else if (isCallExpression(node) && hasPropertyAccessExpressionWithName(node, "catch") && nodeType && !!checker.getPromisedTypeOfPromise(nodeType)) {
            return parseCatch(node, checker, synthNamesMap, lastDotThenMap, context, constIdentifiers, prevArgName);
        }
        else if (isPropertyAccessExpression(node)) {
            return parseCallback(node.expression, checker, outermostParent, synthNamesMap, lastDotThenMap, context, constIdentifiers, prevArgName);
        }
        else if (nodeType && returnsAPromise(node, nodeType, checker)) {
            return parsePromiseCall(node, lastDotThenMap, constIdentifiers, prevArgName);
        }

        return [];
    }

    function parseCatch(node: CallExpression, checker: TypeChecker, synthNamesMap: Map<SynthIdentifier>, lastDotThenMap: Map<boolean>, context: CodeFixContextBase, constIdentifiers: Identifier[], prevArgName?: SynthIdentifier): Statement[] {
        const func = node.arguments[0];
        const argName = getArgName(func, synthNamesMap, checker);

        let varDecl;
        if (prevArgName && lastDotThenMap.get(getNodeId(node).toString())) {
            varDecl = createVariableStatement(/*modifiers*/ undefined, createVariableDeclarationList([createVariableDeclaration(getSynthesizedDeepClone(prevArgName.identifier))], NodeFlags.Let));
            prevArgName.numberOfUses += 2;
        }
        const tryBlock = createBlock(parseCallback(node.expression, checker, node, synthNamesMap, lastDotThenMap, context, constIdentifiers, prevArgName));

        const callbackBody = getCallbackBody(func, prevArgName, argName, node, checker, synthNamesMap, lastDotThenMap, context, constIdentifiers);
        const catchClause = createCatchClause(argName.identifier.text, createBlock(callbackBody));

        const tryStatement = createTry(tryBlock, catchClause, /*finallyBlock*/ undefined);
        return varDecl ? [varDecl, tryStatement] : [tryStatement];
    }

    function parseThen(node: CallExpression, checker: TypeChecker, outermostParent: CallExpression, synthNamesMap: Map<SynthIdentifier>,
        lastDotThenMap: Map<boolean>, context: CodeFixContextBase, constIdentifiers: Identifier[], prevArgName?: SynthIdentifier): Statement[] {

        const [res, rej] = node.arguments;

        if (!res) {
            return parseCallback(node.expression, checker, outermostParent, synthNamesMap, lastDotThenMap, context, constIdentifiers, prevArgName);
        }

        const argNameRes = getArgName(res, synthNamesMap, checker);
        const callbackBody = getCallbackBody(res, prevArgName, argNameRes, node, checker, synthNamesMap, lastDotThenMap, context, constIdentifiers);

        if (rej) {
            const argNameRej = getArgName(rej, synthNamesMap, checker);

            const tryBlock = createBlock(parseCallback(node.expression, checker, node, synthNamesMap, lastDotThenMap, context, constIdentifiers, argNameRes).concat(callbackBody));

            const callbackBody2 = getCallbackBody(rej, prevArgName, argNameRej, node, checker, synthNamesMap, lastDotThenMap, context, constIdentifiers);
            const catchClause = createCatchClause(argNameRej.identifier.text, createBlock(callbackBody2));

            return [createTry(tryBlock, catchClause, /*finallyBlock*/ undefined) as Statement];
        }
        else {
            return parseCallback(node.expression, checker, node, synthNamesMap, lastDotThenMap, context, constIdentifiers, argNameRes).concat(callbackBody);
        }

        return [];
    }

    function getFlagOfIdentifier(node: Identifier, constIdentifiers: Identifier[]): NodeFlags {
        const inArr: boolean = constIdentifiers.filter(elem => elem.text === node.text).length > 0;
        return inArr ? NodeFlags.Const : NodeFlags.Let;
    }

    function parsePromiseCall(node: Expression, lastDotThenMap: Map<boolean>, constIdentifiers: Identifier[], prevArgName?: SynthIdentifier): Statement[] {
        const nextDotThen = lastDotThenMap.get(getNodeId(node).toString());
        const hasPrevArgName = prevArgName && prevArgName.identifier.text.length > 0;
        const originalNodeParent = node.original ? node.original.parent : node.parent;
        if (hasPrevArgName && nextDotThen && isPropertyAccessExpression(originalNodeParent)) {

            if (prevArgName!.numberOfUses > 1) {
                prevArgName!.numberOfUses -= 1;
                return [createStatement(createAssignment(getSynthesizedDeepClone(prevArgName!.identifier), createAwait(node)))];
            }

            const varDecl = createVariableDeclaration(getSynthesizedDeepClone(prevArgName!.identifier), /*type*/ undefined, createAwait(node));
            return [createVariableStatement(/*modifiers*/ undefined, (createVariableDeclarationList([varDecl], getFlagOfIdentifier(prevArgName!.identifier, constIdentifiers))))];
        }
        else if (!hasPrevArgName && nextDotThen && isPropertyAccessExpression(originalNodeParent)) {
            return [createStatement(createAwait(node))];
        }

        return [createReturn(getSynthesizedDeepClone(node))];
    }

    function getCallbackBody(func: Node, prevArgName: SynthIdentifier | undefined, argName: SynthIdentifier, parent: CallExpression, checker: TypeChecker,
        synthNamesMap: Map<SynthIdentifier>, lastDotThenMap: Map<boolean>, context: CodeFixContextBase, constIdentifiers: Identifier[]): NodeArray<Statement> {

        function createVariableDeclarationOrAssignment(prevArgName: SynthIdentifier, rightHandSide: Expression): NodeArray<Statement> {
            if (prevArgName.numberOfUses > 1) {
                prevArgName.numberOfUses -= 1;
                return createNodeArray([createStatement(createAssignment(getSynthesizedDeepClone(prevArgName.identifier), rightHandSide))]);
            }

            prevArgName.numberOfUses -= 1;
            return createNodeArray([createVariableStatement(/*modifiers*/ undefined,
                (createVariableDeclarationList([createVariableDeclaration(getSynthesizedDeepClone(prevArgName.identifier), /*type*/ undefined, rightHandSide)], getFlagOfIdentifier(prevArgName.identifier, constIdentifiers))))]);
        }


        const hasPrevArgName = prevArgName && prevArgName.identifier.text.length > 0;
        const hasArgName = argName && argName.identifier.text.length > 0;
        const nextDotThen = lastDotThenMap.get(getNodeId(parent).toString());
        switch (func.kind) {
            case SyntaxKind.Identifier:
                if (!hasArgName) {
                    break;
                }

                const synthCall = createCall(getSynthesizedDeepClone(func) as Identifier, /*typeArguments*/ undefined, [argName.identifier]);
                if (!nextDotThen) {
                    return createNodeArray([createReturn(synthCall)]);
                }

                if (!hasPrevArgName) {
                    break;
                }

                return createVariableDeclarationOrAssignment(prevArgName!, createAwait(synthCall));

            case SyntaxKind.FunctionDeclaration:
            case SyntaxKind.FunctionExpression:
            case SyntaxKind.ArrowFunction:
                // Arrow functions with block bodies { } will enter this control flow
                if (isFunctionLikeDeclaration(func) && func.body && isBlock(func.body) && func.body.statements) {
                    const indices = getReturnStatementsWithPromiseCallbacksIndices(func.body);
                    let refactoredStmts: Statement[] = [];

                    for (let i = 0; i < func.body.statements.length; i++) {
                        const statement = func.body.statements[i];
                        if (indices.filter(elem => elem === i).length) {
                            refactoredStmts = refactoredStmts.concat(getInnerCallbackBody(checker, [statement], synthNamesMap, lastDotThenMap, context, constIdentifiers, prevArgName));
                        }
                        else {
                            refactoredStmts.push(statement);
                        }
                    }

                    return nextDotThen ? removeReturns(createNodeArray(refactoredStmts), prevArgName!.identifier, constIdentifiers) : getSynthesizedDeepClones(createNodeArray(refactoredStmts));
                }
                else {
                    const funcBody = (<ArrowFunction>func).body;
                    const innerRetStmts = getReturnStatementsWithPromiseCallbacks(createReturn(funcBody as Expression));
                    const innerCbBody = getInnerCallbackBody(checker, innerRetStmts, synthNamesMap, lastDotThenMap, context, constIdentifiers, prevArgName);

                    if (innerCbBody.length > 0) {
                        return createNodeArray(innerCbBody);
                    }

                    if (hasPrevArgName && nextDotThen) {
                        return createVariableDeclarationOrAssignment(prevArgName!, getSynthesizedDeepClone(funcBody) as Expression);
                    }
                    else {
                        return createNodeArray([createReturn(getSynthesizedDeepClone(funcBody) as Expression)]);
                    }
                }
                break;
        }
        return createNodeArray([]);
    }

    function getReturnStatementsWithPromiseCallbacksIndices(block: Block): number[] {
        const indices: number[] = [];
        for (let i = 0; i < block.statements.length; i++) {
            const statement = block.statements[i];
            if (getReturnStatementsWithPromiseCallbacks(statement).length) {
                indices.push(i);
            }
        }
        return indices;
    }

    function removeReturns(stmts: NodeArray<Statement>, prevArgName: Identifier, constIdentifiers: Identifier[]): NodeArray<Statement> {
        const ret: Statement[] = [];
        for (const stmt of stmts) {
            if (isReturnStatement(stmt)) {
                if (stmt.expression) {
                    ret.push(createVariableStatement(/*modifiers*/ undefined,
                        (createVariableDeclarationList([createVariableDeclaration(prevArgName, /*type*/ undefined, stmt.expression)], getFlagOfIdentifier(prevArgName, constIdentifiers)))));
                }
            }
            else {
                ret.push(getSynthesizedDeepClone(stmt));
            }
        }

        return createNodeArray(ret);
    }


    function getInnerCallbackBody(checker: TypeChecker, innerRetStmts: Node[], synthNamesMap: Map<SynthIdentifier>, lastDotThenMap: Map<boolean>,
        context: CodeFixContextBase, constIdentifiers: Identifier[], prevArgName?: SynthIdentifier) {

        let innerCbBody: Statement[] = [];
        for (const stmt of innerRetStmts) {
            forEachChild(stmt, function visit(node: Node) {
                if (isCallExpression(node)) {
                    const temp = parseCallback(node, checker, node, synthNamesMap, lastDotThenMap, context, constIdentifiers, prevArgName);
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

    function hasPropertyAccessExpressionWithName(node: CallExpression, funcName: string): boolean {

        if (!isPropertyAccessExpression(node.expression)) {
            return false;
        }

        return node.expression.name.text === funcName;

    }

    function getArgName(funcNode: Node, synthNamesMap: Map<SynthIdentifier>, checker: TypeChecker): SynthIdentifier {

        function getMapEntryIfExists(node: Identifier): SynthIdentifier {
            const originalNode = getOriginalNode(node);
            const symbol = getSymbol(originalNode);

            if (!symbol) {
                return {identifier: node, numberOfUses: 1};
            }

            const mapEntry = synthNamesMap.get(getSymbolId(symbol).toString());
            return mapEntry ? mapEntry : {identifier: node, numberOfUses: 1};
        }

        function getSymbol(node: Node): Symbol | undefined {
            return node.symbol ? node.symbol : checker.getSymbolAtLocation(node);
        }

        function getOriginalNode(node: Node): Node {
            return node.original ? node.original : node;
        }

        let name: SynthIdentifier | undefined;

        if (isFunctionLikeDeclaration(funcNode) && funcNode.parameters.length > 0) {
            const param = funcNode.parameters[0].name as Identifier;
            name = getMapEntryIfExists(param);
        }
        else if (isCallExpression(funcNode) && funcNode.arguments.length > 0 && isIdentifier(funcNode.arguments[0])) {
            name = {identifier: funcNode.arguments[0] as Identifier, numberOfUses: 1};
        }
        else if (isIdentifier(funcNode)) {
            name = getMapEntryIfExists(funcNode);
        }

        if (!name || name.identifier === undefined || name.identifier.text === "_" || name.identifier.text === "undefined") {
            return {identifier: createIdentifier(""), numberOfUses: 1};
        }

        return name;
    }
}