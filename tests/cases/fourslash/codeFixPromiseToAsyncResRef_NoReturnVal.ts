/// <reference path='fourslash.ts' />

// @target: es6

////function [|f|]():Promise<void> {
////    return fetch('http://yahoo.com').then(res);
////}
////
////function res(result){
////    console.log(result);
////}

verify.getSuggestionDiagnostics([{
    message: "This may be converted to use async and await.",
    code: 80006,
}]);

verify.codeFix({
    description: "Convert to use async and await",
    index: 0,
    newFileContent:
`async function f():Promise<void> {
    var result = await fetch('http://yahoo.com');
<<<<<<< HEAD
    return await res(result);
=======
    return res(result);
>>>>>>> 602a8a9941... Fixed spacing on tests and added a couple more tests
}

function res(result){
    console.log(result);
}`,
});
