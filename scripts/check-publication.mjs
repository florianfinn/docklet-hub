import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";

import { PUBLIC_SOURCE_ARCHIVE, inspectPublicSourceArchive } from "./check-publication-archive.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const EMAIL = /[A-Z0-9._%+-]+@(?:[A-Z0-9-]+\.)+[A-Z][A-Z0-9-]*/giy;
const PRIVATE_ADDRESS = /\b(?:192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3})\b/g;
const SECRET = /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16})\b/g;
const LOCAL_PATH = /[A-Z]:[\\/](?:Users|Documents and Settings)[\\/][^\s"'\x60]+/gi;
const PRIVATE_HOST = /\b[a-z0-9-]+\.(?:lan|home\.arpa|internal)\b/gi;
const PRIVATE_HOST_SUFFIX = /\.(?:lan|home\.arpa|internal)\b/gi;
// AI tools may be named in plain text, never as a co-author linked to an account.
// Token checks instead of nested patterns keep the scan linear on hostile input.
const CO_AUTHOR = /^[ \t]*Co-authored-by:([^<\n]*)<([^>\n]*)>/gim;
const AI_TOOLS = new Set(["claude","copilot","codex","chatgpt","openai","gemini","cursor","devin"]);
const AI_QUALIFIERS = new Set(["ai","agent","code","coding","codex","cli","assist","bot","[bot]","opus","sonnet","haiku","fable","pro","flash"]);
const AI_BOT_WORDS = [...AI_TOOLS,"jules"];
const AI_DOMAINS = ["anthropic.com","openai.com","cursor.com","cursor.sh","devin.ai","cognition.ai"];
const GITHUB_NOREPLY = "@users.noreply.github.com";

// Names people also carry (Claude Martin) pass; only the tool name with model words fails.
function isAiName(name) {
  const tokens=name.trim().toLowerCase().replace(/\[bot\]$/,"").split(/[\s_()-]+/).filter(Boolean);
  if(tokens[0]==="github")tokens.shift();
  return tokens.length>0 && AI_TOOLS.has(tokens[0]) && tokens.slice(1).every(t=>AI_QUALIFIERS.has(t) || /\d/.test(t));
}
function isAiEmail(email) {
  const address=email.trim().toLowerCase();
  if(AI_DOMAINS.some(d=>address.endsWith("@"+d) || address.endsWith("."+d)))return true;
  if(!address.endsWith(GITHUB_NOREPLY))return false;
  const login=address.slice(0,-GITHUB_NOREPLY.length).replace(/^\d+\+/,"");
  if(login.endsWith("[bot]"))return AI_BOT_WORDS.some(w=>login.includes(w));
  return AI_TOOLS.has(login);
}
const EXAMPLE_EMAIL = /@(?:users\.noreply\.github\.com|(?:[a-z0-9-]+\.)*example\.(?:com|org|net)|(?:[a-z0-9-]+\.)*(?:test|invalid))$/i;
// Public GitHub automation contacts are not private operator identities.
const PUBLIC_AUTOMATION_EMAILS = new Set(["noreply@github.com","support@github.com"]);
const PRODUCT_NETWORK = /^(?:10\.(?:253|254)\.0\.\d{1,3}|10\.0\.0\.0|172\.16\.0\.0|192\.168\.0\.0|100\.64\.0\.0)$/;
// Exact synthetic fixtures, never a blanket exemption for test directories.
const ADDRESS_FIXTURES = new Map([
  ["server/src/platform/config/config.test.ts",new Set(["192.168.77.0","192.168.77.1","192.168.77.31","10.0.0.5","172.16.0.1","172.31.255.254","100.64.0.1"])],
  ["server/src/features/hosts/enrollment.test.ts",new Set(["192.168.77.31","10.99.0.1"])],
  ["server/src/features/hosts/registration-app.test.ts",new Set(["10.9.9.9"])],
  ["server/src/features/hosts/bootstrap/host-archive.test.ts",new Set(["192.168.1.5"])],
  ["server/src/app/theme-routes.test.ts",new Set(["192.168.77.31"])],
  ["server/src/features/settings/service.test.ts",new Set(["192.168.77.10"])],
  ["server/src/domain/hosts/health.test.ts",new Set(["172.20.0.3"])],
  ["web/tests/host-list-contract.test.mjs",new Set(["10.0.0.2"])],
  ["web/tests/publication.test.mjs",new Set(["192.168.77.31"])],
  ["agent/src/recreate.test.ts",new Set(["172.20.0.5"])],
  ["scripts/check-publication.mjs",new Set(["192.168.77.0","192.168.77.1","192.168.77.31","10.0.0.5","172.16.0.1","172.31.255.254","100.64.0.1","10.99.0.1","10.9.9.9","192.168.1.5","192.168.77.10","172.20.0.3","10.0.0.2","172.20.0.5"])]
]);

// Same matches as EMAIL, tried once per "@" at the start of its local part; a scan from every
// position of a long word would be quadratic.
function emailMatches(text) {
  const found = [];
  let consumed = 0;
  for (let at = text.indexOf("@"); at !== -1; at = text.indexOf("@", at + 1)) {
    if (at < consumed) continue;
    let start = at;
    while (start > consumed && /[A-Z0-9._%+-]/i.test(text[start - 1])) start--;
    EMAIL.lastIndex = start;
    const match = EMAIL.exec(text);
    if (!match) continue;
    found.push(match);
    consumed = match.index + match[0].length;
  }
  return found;
}

// Same matches as PRIVATE_HOST, found per suffix hit so a long label is scanned once instead of once per start.
function privateHostIndexes(text) {
  const indexes = [];
  let consumed = 0;
  for (const hit of text.matchAll(PRIVATE_HOST_SUFFIX)) {
    if (hit.index < consumed) continue;
    let start = hit.index;
    while (start > consumed && /[a-z0-9-]/i.test(text[start - 1])) start--;
    const from = start > 0 ? start - 1 : 0;
    const window = text.slice(from, hit.index + hit[0].length);
    PRIVATE_HOST.lastIndex = start - from;
    const match = PRIVATE_HOST.exec(window);
    if (!match) continue;
    indexes.push(from + match.index);
    consumed = hit.index + hit[0].length;
  }
  return indexes;
}

// Line starts are collected once; slicing the text per finding would be quadratic in findings.
function lineLocator(text) {
  const starts = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  return index => {
    let low = 0, high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (starts[mid] <= index) low = mid; else high = mid - 1;
    }
    return low + 1;
  };
}

// Preserve the published yaml copyright contact only in its original notice.
function isLicenseContact(text, path, match) {
  const licenses = new Set([
    "docs/next/mockups/THIRD-PARTY-LICENSES.txt",
    PUBLIC_SOURCE_ARCHIVE + "!/third-party/ANGULAR-BUNDLE-LICENSES.txt"
  ]);
  return licenses.has(path) && match[0] === ["eemeli", "gmail.com"].join("@") &&
    text.slice(text.lastIndexOf("\n", match.index) + 1, text.indexOf("\n", match.index) === -1 ? undefined : text.indexOf("\n", match.index)).trim() === "Copyright Eemeli Aro <" + match[0] + ">";
}

export function inspectText(text, path = "text") {
  const findings = [];
  const lineOf = lineLocator(text);
  const report = (category, index) => findings.push({ path, line: lineOf(index), category });
  for (const match of emailMatches(text)) if (!EXAMPLE_EMAIL.test(match[0]) && !PUBLIC_AUTOMATION_EMAILS.has(match[0].toLowerCase()) && !isLicenseContact(text, path, match)) report("non-example-email", match.index);
  for (const match of text.matchAll(SECRET)) report("credential-pattern", match.index);
  for (const match of text.matchAll(LOCAL_PATH)) report("workstation-path", match.index);
  for (const index of privateHostIndexes(text)) report("private-hostname", index);
  for (const match of text.matchAll(CO_AUTHOR)) if (isAiName(match[1]) || isAiEmail(match[2])) report("ai-co-author", match.index);
  for (const match of text.matchAll(PRIVATE_ADDRESS)) {
    if (!ADDRESS_FIXTURES.get(path)?.has(match[0]) && !PRODUCT_NETWORK.test(match[0])) report("private-network-address", match.index);
  }
  return findings;
}

function inspectPath(path) {
  const findings=[];
  if (/(?:^|\/)\.env(?:\..+)?$/.test(path) && !path.endsWith(".env.example")) findings.push({ path, line: 1, category: "runtime-env-file" });
  // Shared project settings are public; everything else below .claude/ stays local.
  if ((path!==".claude/settings.json" && /(?:^|\/)(?:\.claude|\.remember|\.private|review-reports)\//.test(path)) || (path !== PUBLIC_SOURCE_ARCHIVE && /\.(?:pem|key|p12|dump|sqlite3?|log|zip|tgz)$/.test(path))) findings.push({path,line:1,category:"private-artifact"});
  return findings;
}

function inspectContent(content, path) {
  if (path === PUBLIC_SOURCE_ARCHIVE) return inspectPublicSourceArchive(content, (text, entry) => [
    ...inspectPath(entry), ...inspectText(text, path + "!/" + entry)
  ]);
  return content.includes(0) ? [] : inspectText(content.toString("utf8"), path);
}

function environment() {
  const env={...process.env};
  for (const key of Object.keys(env)) if(key.startsWith("GIT_"))delete env[key];
  return env;
}
function git(root,args) {
  return execFileSync("git",args,{cwd:root,encoding:"utf8",env:environment(),maxBuffer:64*1024*1024});
}
function readBlobs(root,objects) {
  const shas=[...new Set(objects.map(o=>o.sha))];
  if(!shas.length)return new Map();
  const batch=execFileSync("git",["cat-file","--batch"],{cwd:root,env:environment(),input:shas.join("\n")+"\n",maxBuffer:128*1024*1024});
  let offset=0;
  const blobs=new Map();
  for(const sha of shas) {
    const newline=batch.indexOf(10,offset);
    const [,type,size]=batch.subarray(offset,newline).toString("utf8").split(" ");
    if(type!=="blob"||!/^\d+$/.test(size))throw new Error("Expected a complete blob object");
    const content=batch.subarray(newline+1,newline+1+Number(size));
    offset=newline+1+Number(size)+1;
    blobs.set(sha,content);
  }
  return blobs;
}
function inspectObjects(root,objects) {
  const findings=[];
  const blobs=readBlobs(root,objects);
  for(const {path,sha} of objects) {
    findings.push(...inspectPath(path));
    const content=blobs.get(sha);
    findings.push(...inspectContent(content,path));
  }
  return findings;
}

export function inspectRepository(root = ROOT, { staged = false, history = false } = {}) {
  const entries=git(root,["ls-files","--stage","-z"]).split("\0").filter(Boolean).map(entry=>{
    const [metadata,path]=entry.split("\t");
    const [,sha,stage]=metadata.split(" ");
    if(stage!=="0")throw new Error("Resolve index conflicts before publication");
    return {sha,path};
  });
  const findings=[];
  if(staged)findings.push(...inspectObjects(root,entries));
  else for(const {path} of entries) {
    findings.push(...inspectPath(path));
    const content=readFileSync(resolve(root,path));
    findings.push(...inspectContent(content,path));
  }
  if(history) {
    const historyRef=root===ROOT && process.env.GITHUB_EVENT_NAME==="pull_request" && process.env.PUBLICATION_HEAD_SHA ? process.env.PUBLICATION_HEAD_SHA : "--all";
    const commits=git(root,["log",historyRef,"--format=%H%x1e%ae%x1e%ce%x1e%B%x1f"]).split("\x1f").filter(r=>r.trim());
    const objects=new Map();
    for(const record of commits) {
      const [sha,author,committer,...body]=record.trim().split("\x1e");
      for(const email of [author,committer])if(!/@users\.noreply\.github\.com$/i.test(email) && email.toLowerCase()!=="noreply@github.com")findings.push({path:sha.slice(0,7),line:1,category:"private-commit-identity"});
      findings.push(...inspectText(body.join("\x1e"),sha.slice(0,7)));
      for(const entry of git(root,["ls-tree","-rz","--full-tree",sha]).split("\0").filter(Boolean)) {
        const [metadata,path]=entry.split("\t");
        const [,type,blob]=metadata.split(" ");
        if(type==="blob")objects.set(blob+"\0"+path,{sha:blob,path});
      }
    }
    findings.push(...inspectObjects(root,[...objects.values()]));
  }
  return findings;
}

function main() {
  const args=process.argv.slice(2);
  const textIndex=args.indexOf("--text");
  const findings=textIndex>=0?inspectText(readFileSync(args[textIndex+1],"utf8")):inspectRepository(ROOT,{staged:args.includes("--staged"),history:args.includes("--history")});
  for(const {path,line,category} of findings)console.error(path+":"+line+" ["+category+"]");
  if(findings.length)process.exitCode=1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main();
