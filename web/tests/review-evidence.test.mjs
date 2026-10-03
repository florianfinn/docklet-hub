import test from "node:test";
import assert from "node:assert/strict";
import { validateReview } from "../../scripts/review-evidence.mjs";
const report={reviewer:"review-agent",headSha:"a".repeat(40),baseSha:"b".repeat(40),mergeSha:"c".repeat(40),result:"approved",summary:"Reviewed synthetic fixture"};
const pr={state:"open",draft:false,head:{sha:report.headSha},base:{sha:report.baseSha},merge_commit_sha:report.mergeSha};
test("Review bindet Head, Base und Test-Merge und lehnt geänderte Grundlage ab",()=>{
  assert.match(validateReview(report,pr),/Integration:/);
  assert.throws(()=>validateReview(report,{...pr,base:{sha:"d".repeat(40)}}),/changed/);
  assert.throws(()=>validateReview(report,{...pr,merge_commit_sha:"d".repeat(40)}),/changed/);
  assert.throws(()=>validateReview({...report,result:"changes_requested"},pr),/approved/);
});
test("Review prüft den öffentlichen Rohtext nach JSON-Dekodierung",()=>{
  const path=["C:","Users","synthetic-operator","file.txt"].join(String.fromCharCode(92));
  const decoded=JSON.parse(JSON.stringify({...report,summary:path}));
  assert.throws(()=>validateReview(decoded,pr),/non-public data/);
});
