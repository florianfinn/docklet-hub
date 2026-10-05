import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Reads an independent review comment and sets the `review` status on the
// reviewed head. A later push leaves the new head without status until the
// next review; a base change does not, because main has no strict up-to-date rule.
export const MARKER="Independent review";

export function parseReview(body) {
  const lines=(body??"").split(/\r?\n/).map(line=>line.trim());
  if(lines[0]!==MARKER)return null;
  // Fields come from the header block only, so findings or footers cannot supply them.
  const blank=lines.indexOf("");
  lines.splice(blank<0?lines.length:blank);
  const field=name=>lines.find(line=>line.startsWith(name+": "))?.slice(name.length+2).trim();
  const head=field("Head");
  const result=field("Result");
  if(!/^[a-f0-9]{40}$/.test(head??"") || !["pass","fail"].includes(result) || !field("Reviewer"))return null;
  return {head,result};
}

export function statusFor(review,pr) {
  if(pr.state!=="open")return null;
  if(review.head!==pr.head.sha)return {state:"failure",description:"Review names "+review.head.slice(0,7)+", head is "+pr.head.sha.slice(0,7)};
  return review.result==="pass"
    ? {state:"success",description:"Independent review passed"}
    : {state:"failure",description:"Independent review found blocking issues"};
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const event=JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH,"utf8"));
  const review=parseReview(event.comment.body);
  if(!review) {
    console.error("The comment is no valid review: first line \""+MARKER+"\", then Reviewer, Head (full SHA) and Result (pass or fail).");
    process.exit(1);
  }
  const repo=process.env.GITHUB_REPOSITORY;
  const gh=args=>execFileSync("gh",args,{encoding:"utf8"});
  const pr=JSON.parse(gh(["api","repos/"+repo+"/pulls/"+event.issue.number]));
  const status=statusFor(review,pr);
  if(!status) {
    console.log("The pull request is not open; no status set.");
    process.exit(0);
  }
  // A stale review marks the current head, so a review of an old head never counts.
  gh(["api","--method","POST","repos/"+repo+"/statuses/"+pr.head.sha,"-f","context=review","-f","state="+status.state,"-f","description="+status.description,"-f","target_url="+event.comment.html_url]);
  console.log(status.state+": "+status.description);
  if(status.state!=="success")process.exitCode=1;
}
