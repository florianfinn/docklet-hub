import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { inspectText } from "./check-publication.mjs";
import { findMojibake, findTransliterations, loadWords } from "./check-umlauts.mjs";
import { CONVENTIONAL } from "./commit-subject.mjs";

// A squash merge makes the title the commit subject and the body the commit
// message on main, where the commit guard checks both.
export function textProblems(title,body="",words=loadWords()) {
  const problems=[];
  if(!CONVENTIONAL.test(title))problems.push("title is no Conventional Commit");
  const text=title+"\n\n"+body;
  if(findMojibake(text).length)problems.push("text contains double-encoded characters");
  if(findTransliterations(text,words).length)problems.push("text contains German words without umlauts");
  return problems;
}

// Read event data as text; never interpolate user-authored PR text in a shell.
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href && process.env.GITHUB_EVENT_NAME==="pull_request") {
  const pr=JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH,"utf8")).pull_request;
  const findings=inspectText(pr.title+"\n"+(pr.body??""),"pull-request");
  for(const {path,line,category} of findings)console.error(path+":"+line+" ["+category+"]");
  const problems=textProblems(pr.title,pr.body??"");
  for(const problem of problems)console.error("pull-request: "+problem);
  if(findings.length || problems.length)process.exitCode=1;
}
