import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { findTransliterations, findMojibake, loadWords } from "../../scripts/check-umlauts.mjs";

const ROOT=fileURLToPath(new URL("../../",import.meta.url));
// Commits on main whose subject is not a Conventional Commit and cannot be
// rewritten. Only the type check is skipped; the spelling check still applies.
// 6926c3c: GitHub merge commit of PR 140, merged through the web UI.
const NON_CONVENTIONAL_ON_MAIN=new Set(["6926c3c9f4f4a0115bc2101609b041c8ebb5c7fb"]);
test("vollständige neue Historie enthält gültige Conventional Commits und richtige Umlaute", () => {
  const shallow=execFileSync("git",["rev-parse","--is-shallow-repository"],{cwd:ROOT,encoding:"utf8"}).trim();
  assert.equal(shallow,"false","flacher Klon: git fetch --unshallow origin vor der vollständigen Commit-Prüfung ausführen");
  const historyRef=process.env.GITHUB_EVENT_NAME==="pull_request" && process.env.PUBLICATION_HEAD_SHA ? process.env.PUBLICATION_HEAD_SHA : "--all";
  const records=execFileSync("git",["log",historyRef,"--format=%H%x1e%B%x1f"],{cwd:ROOT,encoding:"utf8"}).split("\x1f").filter(r=>r.trim());
  assert.ok(records.length>0,"Die neue Historie enthält keinen Commit");
  const findings=[];
  for(const record of records) {
    const [sha,message]=record.trim().split("\x1e");
    if(!NON_CONVENTIONAL_ON_MAIN.has(sha) && !/^(?:feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(?:\([a-z0-9/-]+\))?!?: .+/.test(message.split("\n")[0]))findings.push(sha.slice(0,7)+": Conventional-Commit-Typ fehlt");
    if(findTransliterations(message,loadWords()).length||findMojibake(message).length)findings.push(sha.slice(0,7)+": Schreibweise verletzt");
  }
  assert.deepEqual(findings,[]);
});
