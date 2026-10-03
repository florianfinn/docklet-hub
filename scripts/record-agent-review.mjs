import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateReview } from "./review-evidence.mjs";

// A maintainer attests an actual independent review. This script never
// creates a review verdict or claims to identify an agent cryptographically.
const [number, path]=process.argv.slice(2);
if (!/^\d+$/.test(number??"") || !path) throw new Error("Usage: node scripts/record-agent-review.mjs <PR> <private-report.json>");
const report=JSON.parse(readFileSync(path,"utf8"));
const gh=args=>execFileSync("gh",args,{encoding:"utf8"});
const repo=JSON.parse(gh(["repo","view","--json","nameWithOwner"])).nameWithOwner;
const pr=JSON.parse(gh(["api","repos/"+repo+"/pulls/"+number]));
const body=validateReview(report,pr);
const dir=mkdtempSync(join(tmpdir(),"docklet-review-"));
try {
  const input=join(dir,"input.json");
  writeFileSync(input,JSON.stringify({body}),"utf8");
  const comment=JSON.parse(gh(["api","repos/"+repo+"/issues/"+number+"/comments","--input",input]));
  // Check again after writing the evidence, before opening the merge gate.
  const current=JSON.parse(gh(["api","repos/"+repo+"/pulls/"+number]));
  validateReview(report,current);
  writeFileSync(input,JSON.stringify({state:"success",context:"agent-review",description:"PR "+number+" base="+report.baseSha,target_url:comment.html_url}),"utf8");
  gh(["api","repos/"+repo+"/statuses/"+report.mergeSha,"--input",input]);
  console.log(comment.html_url);
} finally {rmSync(dir,{recursive:true,force:true});}
