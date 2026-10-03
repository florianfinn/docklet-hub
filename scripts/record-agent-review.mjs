import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRepository } from "./github-repository.mjs";
import { validateReview } from "./review-evidence.mjs";

// A maintainer attests an actual independent review by posting its evidence.
// This script never creates a review verdict or claims to identify an agent cryptographically.
const [number, path]=process.argv.slice(2);
if (!/^\d+$/.test(number??"") || !path) throw new Error("Usage: node scripts/record-agent-review.mjs <PR> <private-report.json>");
const report=JSON.parse(readFileSync(path,"utf8"));
const gh=args=>execFileSync("gh",args,{encoding:"utf8"});
const repo=resolveRepository();
const pr=JSON.parse(gh(["api","repos/"+repo+"/pulls/"+number]));
const body=validateReview(report,pr);
const dir=mkdtempSync(join(tmpdir(),"docklet-review-"));
try {
  const input=join(dir,"input.json");
  writeFileSync(input,JSON.stringify({body}),"utf8");
  const comment=JSON.parse(gh(["api","repos/"+repo+"/issues/"+number+"/comments","--input",input]));
  // .github/workflows/agent-review.yml checks this comment against the then
  // current PR state and sets agent-review at the head.
  console.log(comment.html_url);
} finally {rmSync(dir,{recursive:true,force:true});}
