import test from "node:test";
import assert from "node:assert/strict";
import { attestation, reportFromComment } from "../../scripts/attest-review-comment.mjs";
import { validateReview } from "../../scripts/review-evidence.mjs";

const report={reviewer:"review-agent",headSha:"a".repeat(40),baseSha:"b".repeat(40),mergeSha:"c".repeat(40),result:"approved",summary:"Reviewed synthetic fixture.\n\nSecond paragraph."};
const pr={state:"open",draft:false,head:{sha:report.headSha},base:{sha:report.baseSha},merge_commit_sha:report.mergeSha};
const url="https://github.com/example/repo/pull/7#issuecomment-1";
const body=validateReview(report,pr);

test("the evidence comment yields its report back",()=>{
  assert.deepEqual(reportFromComment(body),report);
  assert.deepEqual(reportFromComment(body.replace(/\n/g,"\r\n")),report);
});

test("the status names the PR and the reviewed base at the reviewed head",()=>{
  assert.deepEqual(attestation("7",body,pr,url),{
    headSha:report.headSha,
    status:{state:"success",context:"agent-review",description:"PR 7 base="+report.baseSha,target_url:url}
  });
});

test("other comments attest nothing",()=>{
  assert.equal(attestation("7","LGTM",pr,url),null);
  assert.equal(attestation("7","Independent review\n\nReviewer: x",pr,url),null);
});

test("a stale or altered comment is refused",()=>{
  assert.throws(()=>attestation("7",body,{...pr,head:{sha:"d".repeat(40)}}),/changed/);
  assert.throws(()=>attestation("7",body,{...pr,merge_commit_sha:"d".repeat(40)}),/changed/);
  assert.throws(()=>attestation("7",body.replace("Result: approved","Result: rejected"),pr,url),/approved/);
});

test("a comment with a renamed or missing field attests nothing",()=>{
  assert.equal(attestation("7",body.replace("Integration: ","Merge: "),pr,url),null);
  assert.equal(attestation("7",body.replace("\n\nResult: approved",""),pr,url),null);
});
