import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRepository } from "./github-repository.mjs";
import { validateReview } from "./review-evidence.mjs";
import { reportFromComment } from "./attest-review-comment.mjs";

// A maintainer attests an actual independent review by posting the evidence
// comment. The agent-review workflow reads it back and sets the status.
const [number, path]=process.argv.slice(2);
if (!/^\d+$/.test(number??"") || !path) throw new Error("Usage: node scripts/record-agent-review.mjs <PR> <private-report.json>");
const report=JSON.parse(readFileSync(path,"utf8"));
const gh=args=>execFileSync("gh",args,{encoding:"utf8"});
const repo=resolveRepository();
const pr=JSON.parse(gh(["api","repos/"+repo+"/pulls/"+number]));
const body=validateReview(report,pr);
if(validateReview(reportFromComment(body),pr)!==body)throw new Error("The review evidence does not read back unchanged");
const dir=mkdtempSync(join(tmpdir(),"docklet-review-"));
try {
  const input=join(dir,"input.json");
  writeFileSync(input,JSON.stringify({body}),"utf8");
  const comment=JSON.parse(gh(["api","repos/"+repo+"/issues/"+number+"/comments","--input",input]));
  console.log(comment.html_url);
} finally {rmSync(dir,{recursive:true,force:true});}
