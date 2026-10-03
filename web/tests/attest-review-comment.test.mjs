import test from "node:test";
import assert from "node:assert/strict";
import { validateReview } from "../../scripts/review-evidence.mjs";
import { reportFromComment, attestComment } from "../../scripts/attest-review-comment.mjs";

const report={reviewer:"review-agent",headSha:"a".repeat(40),baseSha:"b".repeat(40),mergeSha:"c".repeat(40),result:"approved",summary:"Reviewed synthetic fixture\n\nNo findings."};
const pr={number:7,state:"open",draft:false,head:{sha:report.headSha},base:{sha:report.baseSha},merge_commit_sha:report.mergeSha};
const body=validateReview(report,pr);
const event=(text,association="OWNER")=>({issue:{number:7,pull_request:{}},comment:{body:text,author_association:association,html_url:"https://github.com/example/repo/pull/7#issuecomment-1"}});

test("Beleg-Kommentar ergibt den Bericht samt mehrteiliger Zusammenfassung zurück",()=>{
  assert.deepEqual(reportFromComment(body),report);
});

test("Wörtlicher Beleg setzt agent-review am geprüften Head",()=>{
  const {sha,status}=attestComment(event(body),pr);
  assert.equal(sha,report.headSha);
  assert.deepEqual(status,{state:"success",context:"agent-review",description:"PR 7 base="+report.baseSha,target_url:"https://github.com/example/repo/pull/7#issuecomment-1"});
});

test("Geänderte Integrationsgrundlage oder fremder PR setzt keinen Status",()=>{
  assert.throws(()=>attestComment(event(body),{...pr,head:{sha:"d".repeat(40)}}),/changed/);
  assert.throws(()=>attestComment(event(body),{...pr,merge_commit_sha:"d".repeat(40)}),/changed/);
  assert.throws(()=>attestComment(event(body),{...pr,number:8}),/owner review comment/);
});

test("Nur Owner-Kommentare an Pull Requests attestieren",()=>{
  assert.throws(()=>attestComment(event(body,"MEMBER"),pr),/owner review comment/);
  assert.throws(()=>attestComment(event(body,"NONE"),pr),/owner review comment/);
  const issue=event(body);
  delete issue.issue.pull_request;
  assert.throws(()=>attestComment(issue,pr),/owner review comment/);
});

test("Abweichender oder unvollständiger Beleg wird abgelehnt",()=>{
  const variant=(from,to)=>event(body.replace(from,to));
  assert.throws(()=>attestComment(variant("Reviewer: review-agent","Reviewer:review-agent"),pr),/Malformed/);
  assert.throws(()=>attestComment(variant("Reviewer: review-agent","Reviewer: "),pr),/approved independent review/);
  assert.throws(()=>attestComment(variant("Result: approved","Result: approved "),pr),/approved independent review/);
  assert.throws(()=>attestComment(variant("Result: approved","Result: changes_requested"),pr),/approved independent review/);
  assert.throws(()=>attestComment(variant("Head: "+report.headSha,"Head: "+report.headSha.slice(1)),pr),/Full review SHAs/);
  assert.throws(()=>attestComment(event(body.replaceAll("\n","\r\n")),pr),/Not an independent review/);
  assert.throws(()=>attestComment(event(body.split("\n\n").slice(0,6).join("\n\n")),pr),/Not an independent review/);
  assert.throws(()=>attestComment(event("Independent review"),pr),/Not an independent review/);
});
