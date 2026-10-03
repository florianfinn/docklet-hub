import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolveRepository } from "./github-repository.mjs";
import { validateReview } from "./review-evidence.mjs";

// Reads the evidence comment of scripts/record-agent-review.mjs back into its
// report. Only a body that validateReview would produce verbatim for the
// current PR state counts; a hand-written or stale comment is never attested.
export function reportFromComment(body) {
  const parts=body.replace(/\r\n/g,"\n").split("\n\n");
  if(parts.length<7 || parts[0]!=="Independent review")return null;
  const field=(index,label)=>parts[index].startsWith(label+": ")?parts[index].slice(label.length+2):null;
  const report={
    reviewer:field(1,"Reviewer"),
    headSha:field(2,"Head"),
    baseSha:field(3,"Base"),
    mergeSha:field(4,"Integration"),
    result:field(5,"Result"),
    summary:parts.slice(6).join("\n\n")
  };
  return Object.values(report).every((value)=>typeof value==="string")?report:null;
}

// The status the rulesets and scripts/merge-evidence.mjs require.
export function attestation(number,body,pr,commentUrl) {
  const report=reportFromComment(body);
  if(!report)return null;
  if(validateReview(report,pr)!==body.replace(/\r\n/g,"\n"))throw new Error("The comment is not the evidence for the current PR state");
  return {
    headSha:report.headSha,
    status:{state:"success",context:"agent-review",description:"PR "+number+" base="+report.baseSha,target_url:commentUrl}
  };
}

// Runs in .github/workflows/agent-review.yml for a comment by the owner.
function main() {
  const {PR_NUMBER:number,COMMENT_BODY:body="",COMMENT_URL:commentUrl}=process.env;
  if(!/^\d+$/.test(number??"") || !commentUrl)throw new Error("PR_NUMBER and COMMENT_URL are required");
  const gh=(args,input)=>execFileSync("gh",args,{encoding:"utf8",input});
  const repo=resolveRepository();
  const pr=JSON.parse(gh(["api","repos/"+repo+"/pulls/"+number]));
  const result=attestation(number,body,pr,commentUrl);
  if(!result){console.log("No review evidence comment; nothing to attest.");return;}
  gh(["api","repos/"+repo+"/statuses/"+result.headSha,"--input","-"],JSON.stringify(result.status));
  console.log("agent-review set on "+result.headSha);
}

if(import.meta.url===pathToFileURL(process.argv[1]??"").href)main();
