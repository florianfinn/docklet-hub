import { readFileSync } from "node:fs";
import { inspectText } from "./check-publication.mjs";

// Read event data as text; never interpolate user-authored PR text in a shell.
if(process.env.GITHUB_EVENT_NAME==="pull_request") {
  const pr=JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH,"utf8")).pull_request;
  const findings=inspectText(pr.title+"\n"+(pr.body??""),"pull-request");
  for(const {path,line,category} of findings)console.error(path+":"+line+" ["+category+"]");
  if(findings.length)process.exitCode=1;
}
