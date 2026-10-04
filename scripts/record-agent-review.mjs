import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRepository } from "./github-repository.mjs";
import { githubGet } from "./github-rest.mjs";
import { validateReview } from "./review-evidence.mjs";
import { reportFromComment } from "./attest-review-comment.mjs";

// A maintainer attests an actual independent review by posting the evidence
// comment. The agent-review workflow reads it back and sets the status.
// With --print the validated comment goes to stdout instead; the session posts
// it unchanged through its GitHub connection, so no gh login is needed.
const args=process.argv.slice(2);
const print=args[0]==="--print";
const [number, path]=print?args.slice(1):args;
if (!/^\d+$/.test(number??"") || !path) throw new Error("Usage: node scripts/record-agent-review.mjs [--print] <PR> <private-report.json>");
const report=JSON.parse(readFileSync(path,"utf8"));
const repo=resolveRepository();
const pr=githubGet(repo,"pulls/"+number);
const body=validateReview(report,pr);
if(validateReview(reportFromComment(body),pr)!==body)throw new Error("The review evidence does not read back unchanged");
if(print) {
  process.stdout.write(body+"\n");
} else {
  const gh=args=>execFileSync("gh",args,{encoding:"utf8"});
  const dir=mkdtempSync(join(tmpdir(),"docklet-review-"));
  try {
    const input=join(dir,"input.json");
    writeFileSync(input,JSON.stringify({body}),"utf8");
    const comment=JSON.parse(gh(["api","repos/"+repo+"/issues/"+number+"/comments","--input",input]));
    console.log(comment.html_url);
  } finally {rmSync(dir,{recursive:true,force:true});}
}
