/// <reference path='fourslash.ts' />

////function [|f|]():Promise<any> {
////    return fetch('http://yahoo.com').then(result => { console.log(result); }, rejection => { console.log("rejected:", rejection); }).catch(err => { console.log(err) });
////}

verify.getSuggestionDiagnostics([{
    message: "This may be converted to use async and await.",
    code: 80006,
}]);


verify.codeFix({
    description: "Convert to use async and await",
    index: 0,
    newFileContent:
`async function f() {
    try{
        try{
            var result = await fetch('http://yahoo.com);
        }catch(rejection){
            console.log("rejected", rejection);
        }
        console.log(result);
    }catch(err){
        console.log(err);
    }
}`,
});
