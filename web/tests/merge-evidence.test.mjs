import test from "node:test";
import assert from "node:assert/strict";
import { mergeArguments, validateMerge } from "../../scripts/merge-evidence.mjs";
const report={reviewer:"review-agent",headSha:"a".repeat(40),baseSha:"b".repeat(40),mergeSha:"c".repeat(40),result:"approved",summary:"Reviewed synthetic fixture"};
const pr={number:1,state:"open",draft:false,head:{sha:report.headSha},base:{sha:report.baseSha},merge_commit_sha:report.mergeSha};
const checks=[{id:10,name:"checks",app:{id:15368},head_sha:report.headSha,status:"completed",conclusion:"success"}];
const statuses=[{id:10,context:"agent-review",state:"success",description:"PR 1 base="+report.baseSha}];
const log="DOCKLET_INTEGRATION_EVIDENCE "+JSON.stringify(report);
const payload={sha:report.headSha,merge_method:"squash",commit_title:"fix: Synthetischer Test (#1)",commit_message:"Closes #1"};
test("Merge verlangt aktuelle Integration und neuesten erfolgreichen Prüflauf",()=>{
  assert.equal(validateMerge(report,pr,checks,statuses,log,payload).id,10);
  assert.throws(()=>validateMerge(report,pr,[...checks,{...checks[0],id:11,status:"in_progress",conclusion:null}],statuses,log,payload),/newest/);
  assert.throws(()=>validateMerge(report,pr,[{...checks[0],app:{id:1}}],statuses,log,payload),/newest/);
  assert.throws(()=>validateMerge(report,pr,checks,statuses,log.replace(report.baseSha,"d".repeat(40)),payload),/reviewed integration/);
  assert.throws(()=>validateMerge(report,pr,checks,[...statuses,{...statuses[0],id:11,state:"failure"}],log,payload),/attestation/);
});
test("Merge lehnt fremden Head, private Texte und mehrdeutige CI-Belege ab",()=>{
  assert.throws(()=>validateMerge(report,pr,checks,statuses,log,{...payload,sha:"d".repeat(40)}),/expected-head/);
  assert.throws(()=>validateMerge(report,pr,checks,statuses,log+"\n"+log,payload),/One CI/);
  assert.throws(()=>validateMerge(report,pr,checks,statuses,log,{...payload,commit_title:"Synthetic merge"}),/Conventional/);
  assert.throws(()=>validateMerge(report,pr,checks,statuses,log,{...payload,commit_title:"fix: Synthetic test\nSecond line"}),/single-line/);
  const path=["C:","Users","synthetic-operator","file.txt"].join(String.fromCharCode(92));
  assert.throws(()=>validateMerge(report,pr,checks,statuses,log,{...payload,commit_message:path}),/non-public/);
});
test("Merge-Argumente binden den geprüften Head und übernehmen den Merge-Text unverändert",()=>{
  assert.deepEqual(mergeArguments(1,payload),{pullNumber:1,expectedHeadSha:report.headSha,merge_method:"squash",commit_title:payload.commit_title,commit_message:payload.commit_message});
});
