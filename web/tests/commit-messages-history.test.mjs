import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { scratchGit, scratchGitEnvironment } from "./scratch-git.mjs";
const ROOT=fileURLToPath(new URL("../../",import.meta.url));
test("neue Historie prüft den Root-Commit, lehnt falschen Typ und flachen Klon ab", () => {
  const dir=mkdtempSync(join(tmpdir(),"new-history-"));
  const source=join(dir,"source");const clone=join(dir,"clone");
  try {
    mkdirSync(source);scratchGit(source,["init","-q"]);
    const message=join(dir,"message.txt");writeFileSync(message,"invalid initial message\n");
    scratchGit(source,["-c","user.name=Guard","-c","user.email=guard@example.invalid","commit","--allow-empty","-qF",message]);
    scratchGit(dir,["clone","-q","--depth=1",pathToFileURL(source).href,clone]);
    for(const path of ["web/tests/commit-messages.test.mjs","web/tests/umlaut-words.txt","scripts/check-umlauts.mjs","scripts/commit-subject.mjs"]) {mkdirSync(dirname(join(clone,path)),{recursive:true});copyFileSync(join(ROOT,path),join(clone,path));}
    const env=scratchGitEnvironment();delete env.NODE_TEST_CONTEXT;delete env.PUBLICATION_HEAD_SHA;
    const run=()=>spawnSync(process.execPath,["--test","web/tests/commit-messages.test.mjs"],{cwd:clone,encoding:"utf8",env,timeout:10000});
    const shallow=run();assert.equal(shallow.status,1);assert.match(shallow.stdout+shallow.stderr,/git fetch --unshallow origin/);
    scratchGit(clone,["fetch","-q","--unshallow","origin"]);
    const full=run();assert.equal(full.status,1);assert.match(full.stdout+full.stderr,/Conventional-Commit-Typ fehlt/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
