import { validateReview } from "./review-evidence.mjs";
import { inspectText } from "./check-publication.mjs";
import { findTransliterations, findMojibake } from "./check-umlauts.mjs";

export function validateMerge(report,pr,checks,statuses,log,payload) {
  validateReview(report,pr);
  const latest=checks.filter(check=>check.name==="checks" && check.app?.id===15368).sort((a,b)=>b.id-a.id)[0];
  if(!latest || latest.status!=="completed" || latest.conclusion!=="success" || latest.head_sha!==report.headSha)throw new Error("The newest GitHub checks run must succeed");
  const markers=log.split("\n").filter(line=>line.includes("DOCKLET_INTEGRATION_EVIDENCE "));
  if(markers.length!==1)throw new Error("One CI integration evidence marker is required");
  let evidence;
  try {evidence=JSON.parse(markers[0].split("DOCKLET_INTEGRATION_EVIDENCE ")[1]);}catch{throw new Error("Invalid CI integration evidence");}
  for(const field of ["headSha","baseSha","mergeSha"])if(evidence[field]!==report[field])throw new Error("CI did not test the reviewed integration; rerun and review");
  const status=statuses.filter(item=>item.context==="agent-review").sort((a,b)=>b.id-a.id)[0];
  if(status?.state!=="success" || status.description!=="PR "+pr.number+" base="+report.baseSha)throw new Error("The current independent review attestation is required");
  if(payload.sha!==report.headSha || !["squash","merge"].includes(payload.merge_method) || typeof payload.commit_title!=="string" || !payload.commit_title.trim() || typeof payload.commit_message!=="string")throw new Error("An expected-head merge payload is required");
  if(!/^(?:feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(?:\([a-z0-9/-]+\))?!?: .+/.test(payload.commit_title) || /[\r\n]/.test(payload.commit_title))throw new Error("A single-line Conventional Commit title is required");
  const text=payload.commit_title+"\n"+payload.commit_message;
  if(inspectText(text).length)throw new Error("The merge text contains non-public data");
  if(findTransliterations(text).length || findMojibake(text).length)throw new Error("The merge text has invalid German spelling or encoding");
  return latest;
}
