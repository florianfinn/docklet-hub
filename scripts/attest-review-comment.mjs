import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveRepository } from "./github-repository.mjs";
import { validateReview } from "./review-evidence.mjs";

const FIELDS=[["reviewer","Reviewer: "],["headSha","Head: "],["baseSha","Base: "],["mergeSha","Integration: "],["result","Result: "]];

// Inverse of validateReview's body; the summary may contain blank lines.
export function reportFromComment(body) {
  const parts=typeof body==="string"?body.split("\n\n"):[];
  if(parts.length<7 || parts[0]!=="Independent review")throw new Error("Not an independent review comment");
  const report={};
  FIELDS.forEach(([field,prefix],index)=>{
    const part=parts[index+1];
    if(!part.startsWith(prefix))throw new Error("Malformed review comment field: "+field);
    report[field]=part.slice(prefix.length);
  });
  report.summary=parts.slice(6).join("\n\n");
  return report;
}

// Returns the agent-review status for the head only if the comment is exactly
// the evidence record-agent-review.mjs would publish for the current PR.
export function attestComment(event,pr) {
  if(event.comment?.author_association!=="OWNER" || !event.issue?.pull_request || pr.number!==event.issue.number)throw new Error("Only an owner review comment on this PR can attest");
  const body=event.comment.body;
  const report=reportFromComment(body);
  if(validateReview(report,pr)!==body)throw new Error("The comment is not the exact review evidence for the current PR");
  return {sha:report.headSha,status:{state:"success",context:"agent-review",description:"PR "+pr.number+" base="+report.baseSha,target_url:event.comment.html_url}};
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const event=JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH,"utf8"));
  const gh=args=>execFileSync("gh",args,{encoding:"utf8"});
  const repo=resolveRepository();
  const pr=JSON.parse(gh(["api","repos/"+repo+"/pulls/"+event.issue.number]));
  const {sha,status}=attestComment(event,pr);
  const dir=mkdtempSync(join(tmpdir(),"docklet-attest-"));
  try {
    const input=join(dir,"status.json");
    writeFileSync(input,JSON.stringify(status),"utf8");
    gh(["api","repos/"+repo+"/statuses/"+sha,"--input",input]);
    console.log("agent-review set for "+sha);
  } finally {rmSync(dir,{recursive:true,force:true});}
}
