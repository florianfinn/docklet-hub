import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
const event=JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH,"utf8"));
if(event.pull_request) {
  const [mergeSha,...parents]=execFileSync("git",["rev-list","--parents","-n","1","HEAD"],{encoding:"utf8"}).trim().split(" ");
  const evidence={headSha:event.pull_request.head.sha,baseSha:parents[0],mergeSha};
  if(parents.length!==2 || parents[1]!==evidence.headSha)throw new Error("Checkout is not the expected PR integration");
  console.log("DOCKLET_INTEGRATION_EVIDENCE "+JSON.stringify(evidence));
}
