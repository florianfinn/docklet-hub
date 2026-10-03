import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectText, inspectRepository } from "../../scripts/check-publication.mjs";
import { scratchGit } from "./scratch-git.mjs";

test("öffentliche Beispiele bleiben erlaubt, private Werte werden ohne Ausgabe erkannt", () => {
  assert.deepEqual(inspectText("admin@example.test 192.0.2.1 10.254.0.0/24"), []);
  assert.equal(inspectText(["operator","private-company.invalid-domain"].join("@"))[0].category,"non-example-email");
  assert.equal(inspectText("192.168.77.31")[0].category,"private-network-address");
  const token="ghp_"+"x".repeat(36);
  const findings=inspectText(token);
  assert.equal(findings[0].category,"credential-pattern");
  assert.equal(JSON.stringify(findings).includes(token),false);
});

test("Indexprüfung liest den vorgemerkten Wert trotz bereinigter Arbeitskopie", () => {
  const directory=mkdtempSync(join(tmpdir(),"publication-index-"));
  try {
    scratchGit(directory,["init","-q"]);
    const path=join(directory,"sample.md");
    writeFileSync(path,["operator","private-company.invalid-domain"].join("@"));
    scratchGit(directory,["add","sample.md"]);
    writeFileSync(path,"admin@example.test");
    assert.equal(inspectRepository(directory,{staged:true})[0].category,"non-example-email");
    assert.deepEqual(inspectRepository(directory),[]);
  } finally { rmSync(directory,{recursive:true,force:true}); }
});

test("versionierte öffentliche Dateien und Git-Metadaten bestehen die Prüfung", () => {
  assert.deepEqual(inspectRepository(undefined,{history:true}),[]);
});

test("Historie erkennt gelöschte Laufzeitdateien und umbenannte Artefakte", () => {
  const directory=mkdtempSync(join(tmpdir(),"publication-history-"));
  try {
    scratchGit(directory,["init","-q"]);
    scratchGit(directory,["config","user.name","Test"]);
    scratchGit(directory,["config","user.email","test@users.noreply.github.com"]);
    writeFileSync(join(directory,"sample.txt"),"synthetic fixture");
    scratchGit(directory,["add","sample.txt"]);
    scratchGit(directory,["commit","-qm","chore: fixture"]);
    scratchGit(directory,["mv","sample.txt",".env"]);
    scratchGit(directory,["commit","-qm","chore: rename"]);
    scratchGit(directory,["rm",".env"]);
    scratchGit(directory,["commit","-qm","chore: remove"]);
    assert.deepEqual(inspectRepository(directory),[]);
    assert.ok(inspectRepository(directory,{history:true}).some(f=>f.category==="runtime-env-file"));
  } finally {rmSync(directory,{recursive:true,force:true});}
});

test("Testdateien erhalten keine pauschale Freigabe privater Adressen", () => {
  const address=[192,168,88,44].join(".");
  assert.equal(inspectText(address,"web/tests/another.test.mjs")[0].category,"private-network-address");
});

test("offizielle GitHub-Automation bleibt erlaubt, persönliche Identitäten bleiben gesperrt", () => {
  assert.deepEqual(inspectText("noreply@github.com support@github.com"),[]);
  assert.equal(inspectText(["personal","github.com"].join("@"))[0].category,"non-example-email");
  const directory=mkdtempSync(join(tmpdir(),"publication-bot-"));
  try {
    scratchGit(directory,["init","-q"]);
    scratchGit(directory,["config","user.name","GitHub"]);
    scratchGit(directory,["config","user.email","noreply@github.com"]);
    scratchGit(directory,["commit","--allow-empty","-qm","chore: automation fixture"]);
    assert.deepEqual(inspectRepository(directory,{history:true}),[]);
    scratchGit(directory,["config","user.email",["personal","github.com"].join("@")]);
    scratchGit(directory,["commit","--allow-empty","-qm","chore: invalid identity fixture"]);
    assert.ok(inspectRepository(directory,{history:true}).some(f=>f.category==="private-commit-identity"));
  } finally {rmSync(directory,{recursive:true,force:true});}
});

test("KI-Werkzeuge erscheinen nicht als verknüpfte Co-Autoren", () => {
  const trailer=(name,email)=>["Co-authored-by",": "+name+" <"+email+">"].join("");
  assert.ok(inspectText(trailer("Claude","bot@users.noreply.github.com")).some(f=>f.category==="ai-co-author"));
  assert.ok(inspectText("fix: x\n\n"+trailer("Copilot","bot@users.noreply.github.com").toLowerCase()).some(f=>f.category==="ai-co-author"));
  assert.ok(inspectText(trailer("Claude Opus 5","bot@users.noreply.github.com")).some(f=>f.category==="ai-co-author"));
  assert.ok(inspectText(trailer("Helper",["noreply","anthropic.com"].join("@"))).some(f=>f.category==="ai-co-author"));
  assert.deepEqual(inspectText(trailer("Erika Muster","erika@users.noreply.github.com")),[]);
  assert.deepEqual(inspectText(trailer("Claude Martin","claude-martin@users.noreply.github.com")).filter(f=>f.category==="ai-co-author"),[]);
  for (const [name,login] of [["Copilot","175728472+Copilot"],["copilot-swe-agent[bot]","1+copilot-swe-agent[bot]"],["Gemini Code Assist","1+gemini-code-assist[bot]"],["Jules","1+google-labs-jules[bot]"]])
    assert.ok(inspectText(trailer(name,login+"@users.noreply.github.com")).some(f=>f.category==="ai-co-author"),name);
  for (const name of ["OpenAI Codex","Gemini CLI","Copilot Coding Agent","Claude (AI)","claude_code"])
    assert.ok(inspectText(trailer(name,"x@users.noreply.github.com")).some(f=>f.category==="ai-co-author"),name);
  assert.deepEqual(inspectText(trailer("Devin Muster","devin-muster@users.noreply.github.com")),[]);
  assert.deepEqual(inspectText("Assisted-by: Claude Code"),[]);
});

test("die Co-Autor-Prüfung bleibt bei feindlicher Eingabe linear", () => {
  // Synchronous code cannot be interrupted by a test timeout; measure instead so a regression fails.
  // A backtracking pattern needs seconds for 22 repetitions; the linear check needs well under 1 ms.
  const hostile=["Co-authored-by",": Claude"+"-1".repeat(22)+"! <x>"].join("");
  const started=performance.now();
  assert.ok(inspectText(hostile).some(f=>f.category==="ai-co-author"));
  assert.ok(performance.now()-started<500,"die Co-Autor-Prüfung ist nicht linear");
  assert.ok(inspectText(["Co-authored-by",": Claude"+"-1".repeat(50000)+" <x>"].join("")).length>0);
});

test("unter .claude ist nur die geteilte Projekteinstellung öffentlich", () => {
  const directory=mkdtempSync(join(tmpdir(),"publication-claude-"));
  try {
    scratchGit(directory,["init","-q"]);
    mkdirSync(join(directory,".claude"));
    writeFileSync(join(directory,".claude","settings.json"),"{}");
    writeFileSync(join(directory,".claude","settings.local.json"),"{}");
    scratchGit(directory,["add","-f",".claude"]);
    const findings=inspectRepository(directory,{staged:true});
    assert.equal(findings.some(f=>f.path===".claude/settings.json"),false);
    assert.equal(findings.some(f=>f.path===".claude/settings.local.json"&&f.category==="private-artifact"),true);
  } finally {rmSync(directory,{recursive:true,force:true});}
});
