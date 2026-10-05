import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Turns the structured review output into one PR comment and the job result.
// A missing or malformed verdict fails, so a broken review never passes.
export function parseVerdict(text) {
  let verdict;
  try {verdict=JSON.parse(text??"");} catch {return null;}
  if(!verdict || !["pass","fail"].includes(verdict.result) || typeof verdict.summary!=="string" || !Array.isArray(verdict.blocking))return null;
  if(verdict.result==="pass" && verdict.blocking.length>0)return null;
  return verdict;
}

export function commentBody(verdict) {
  const lines=["**Claude review: "+(verdict.result==="pass"?"passed":"blocking findings")+"**","",verdict.summary];
  if(verdict.blocking.length) {
    lines.push("");
    for(const finding of verdict.blocking)lines.push("- `"+finding.path+(finding.line?":"+finding.line:"")+"`: "+finding.problem);
  }
  return lines.join("\n")+"\n";
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const verdict=parseVerdict(process.env.REVIEW_OUTPUT);
  if(!verdict) {
    console.error("The review returned no valid verdict.");
    process.exit(1);
  }
  const pr=JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH,"utf8")).pull_request;
  const dir=mkdtempSync(join(tmpdir(),"review-"));
  try {
    const input=join(dir,"comment.json");
    writeFileSync(input,JSON.stringify({body:commentBody(verdict)}),"utf8");
    execFileSync("gh",["api","repos/"+process.env.GITHUB_REPOSITORY+"/issues/"+pr.number+"/comments","--input",input],{stdio:"inherit"});
  } finally {rmSync(dir,{recursive:true,force:true});}
  if(verdict.result!=="pass")process.exit(1);
}
