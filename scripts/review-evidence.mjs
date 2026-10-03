import { inspectText } from "./check-publication.mjs";

export function validateReview(report,pr) {
  if(report.result!=="approved" || typeof report.reviewer!=="string" || !report.reviewer.trim() || typeof report.summary!=="string" || !report.summary.trim())throw new Error("An approved independent review and summary are required");
  for(const field of ["headSha","baseSha","mergeSha"])if(!/^[a-f0-9]{40}$/.test(report[field]??""))throw new Error("Full review SHAs are required");
  if(pr.state!=="open" || pr.draft || report.headSha!==pr.head.sha || report.baseSha!==pr.base.sha || !pr.merge_commit_sha || report.mergeSha!==pr.merge_commit_sha)throw new Error("PR state or reviewed integration has changed; review again");
  const body=["Independent review","Reviewer: "+report.reviewer,"Head: "+report.headSha,"Base: "+report.baseSha,"Integration: "+report.mergeSha,"Result: approved",report.summary].join("\n\n");
  if(inspectText(body).length)throw new Error("The public review body contains non-public data");
  return body;
}
