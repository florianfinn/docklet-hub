import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { inspectText } from "./check-publication.mjs";
import { findMojibake } from "./check-umlauts.mjs";
import { CONVENTIONAL } from "./commit-subject.mjs";

// A squash merge makes the PR title the commit subject on main.
export function titleProblems(title) {
  const problems=[];
  if(!CONVENTIONAL.test(title))problems.push("title is no Conventional Commit");
  if(findMojibake(title).length)problems.push("title contains double-encoded characters");
  return problems;
}

// Read event data as text; never interpolate user-authored PR text in a shell.
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href && process.env.GITHUB_EVENT_NAME==="pull_request") {
  const pr=JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH,"utf8")).pull_request;
  const findings=inspectText(pr.title+"\n"+(pr.body??""),"pull-request");
  for(const {path,line,category} of findings)console.error(path+":"+line+" ["+category+"]");
  const problems=titleProblems(pr.title);
  for(const problem of problems)console.error("pull-request: "+problem);
  if(findings.length || problems.length)process.exitCode=1;
}
