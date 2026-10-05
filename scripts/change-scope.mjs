import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT=fileURLToPath(new URL("../",import.meta.url));
// Prose that no build, script or runtime reads. Everything else takes the full chain.
const EXECUTED=/^(?:scripts|eslint-rules|\.githooks|\.github\/workflows)\/|(?:^|\/)src\//;
const TEXT=/\.md$|^(?:LICENSE|NOTICE)$/;
// Node-only tests that cover prose: no install, no tsx.
export const TEXT_TESTS=["commit-messages","publication","documents-in-index","documents-without-status","german-umlauts","control-characters","english-filenames","break-glass-path"].map(name=>"web/tests/"+name+".test.mjs");

export function isTextOnly(paths) {
  return paths.length>0 && paths.every(path=>!EXECUTED.test(path) && TEXT.test(path));
}

const git=args=>execFileSync("git",args,{cwd:ROOT,encoding:"utf8"});
const changedPaths=(base,head)=>git(["diff","--name-only","--no-renames",base+"..."+head]).split("\n").filter(Boolean);

// Pull requests use the event SHAs; pushes to main always take the full chain.
function ciScope() {
  if(process.env.GITHUB_EVENT_NAME!=="pull_request")return "full";
  const pr=JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH,"utf8")).pull_request;
  return isTextOnly(changedPaths(pr.base.sha,pr.head.sha))?"text":"full";
}

// pre-push stdin: "<local ref> <local sha> <remote ref> <remote sha>" per ref.
// No refs or no reachable origin/main means the full chain.
function prePushScope(input) {
  const heads=input.split("\n").map(line=>line.trim().split(" ")[1]).filter(sha=>sha && !/^0+$/.test(sha));
  if(!heads.length)return "full";
  try {
    return heads.every(head=>isTextOnly(changedPaths(git(["merge-base","origin/main",head]).trim(),head)))?"text":"full";
  } catch {return "full";}
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const mode=process.argv[2];
  if(mode==="--ci")console.log(ciScope());
  else if(mode==="--pre-push"){
    let input="";
    try {input=readFileSync(0,"utf8");} catch {/* no stdin: full chain */}
    console.log(prePushScope(input));
  }
  else if(mode==="--run-text-tests")process.exitCode=spawnSync(process.execPath,["--test",...TEXT_TESTS],{cwd:ROOT,stdio:"inherit"}).status??1;
  else throw new Error("Usage: node scripts/change-scope.mjs --ci | --pre-push | --run-text-tests");
}
