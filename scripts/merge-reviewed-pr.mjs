import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolveRepository } from "./github-repository.mjs";
import { githubGet } from "./github-rest.mjs";
import { validateReview } from "./review-evidence.mjs";
import { mergeArguments, validateMerge } from "./merge-evidence.mjs";

// Reads PR, checks, statuses and the CI log over REST. With --print the
// validated merge arguments go to stdout instead of merging; the session merges
// with them through its GitHub connection right away, bound to expectedHeadSha.
const args=process.argv.slice(2);
const print=args[0]==="--print";
const [number,reportPath,payloadPath]=print?args.slice(1):args;
if(!/^\d+$/.test(number??"") || !reportPath || !payloadPath)throw new Error("Usage: node scripts/merge-reviewed-pr.mjs [--print] <PR> <private-report.json> <utf8-merge-payload.json>");
const report=JSON.parse(readFileSync(reportPath,"utf8"));
const payload=JSON.parse(readFileSync(payloadPath,"utf8"));
const repo=resolveRepository();
const api=path=>githubGet(repo,path);
const getPr=()=>api("pulls/"+number);
const pr=getPr();
validateReview(report,pr);
const checks=api("commits/"+report.headSha+"/check-runs?filter=latest&per_page=100").check_runs;
const statuses=api("commits/"+report.headSha+"/statuses?per_page=100");
const latest=checks.filter(check=>check.name==="checks" && check.app?.id===15368).sort((a,b)=>b.id-a.id)[0];
const match=latest?.details_url?.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)\/job\/(\d+)/);
if(!match || match[1]!==repo)throw new Error("The check must point to this repository's Actions job");
const log=githubGet(repo,"actions/jobs/"+match[3]+"/logs",{raw:true});
validateMerge(report,pr,checks,statuses,log,payload);
// GitHub supports expected head but not expected base. Revalidate immediately;
// maintainers must avoid concurrent target-branch merges during this operation.
validateReview(report,getPr());
if(print) {
  process.stdout.write(JSON.stringify(mergeArguments(Number(number),payload),null,2)+"\n");
} else {
  const gh=args=>execFileSync("gh",args,{encoding:"utf8",maxBuffer:32*1024*1024});
  const merged=JSON.parse(gh(["api","--method","PUT","repos/"+repo+"/pulls/"+number+"/merge","--input",payloadPath]));
  if(!merged.merged)throw new Error("GitHub did not merge the reviewed PR");
  console.log(merged.sha);
}
