import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { validateReview } from "./review-evidence.mjs";
import { validateMerge } from "./merge-evidence.mjs";

const [number,reportPath,payloadPath]=process.argv.slice(2);
if(!/^\d+$/.test(number??"") || !reportPath || !payloadPath)throw new Error("Usage: node scripts/merge-reviewed-pr.mjs <PR> <private-report.json> <utf8-merge-payload.json>");
const report=JSON.parse(readFileSync(reportPath,"utf8"));
const payload=JSON.parse(readFileSync(payloadPath,"utf8"));
const gh=args=>execFileSync("gh",args,{encoding:"utf8",maxBuffer:32*1024*1024});
const repo=JSON.parse(gh(["repo","view","--json","nameWithOwner"])).nameWithOwner;
const api=path=>JSON.parse(gh(["api","repos/"+repo+"/"+path]));
const getPr=()=>api("pulls/"+number);
const pr=getPr();
validateReview(report,pr);
const checks=api("commits/"+report.headSha+"/check-runs?filter=latest&per_page=100").check_runs;
const statuses=api("commits/"+report.headSha+"/statuses?per_page=100");
const latest=checks.filter(check=>check.name==="checks" && check.app?.id===15368).sort((a,b)=>b.id-a.id)[0];
const match=latest?.details_url?.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)\/job\/(\d+)/);
if(!match || match[1]!==repo)throw new Error("The check must point to this repository's Actions job");
const log=gh(["run","view",match[2],"--job",match[3],"--log","--repo",repo]);
validateMerge(report,pr,checks,statuses,log,payload);
// GitHub supports expected head but not expected base. Revalidate immediately;
// maintainers must avoid concurrent target-branch merges during this operation.
validateReview(report,getPr());
const merged=JSON.parse(gh(["api","--method","PUT","repos/"+repo+"/pulls/"+number+"/merge","--input",payloadPath]));
if(!merged.merged)throw new Error("GitHub did not merge the reviewed PR");
console.log(merged.sha);
