import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const EMAIL = /[A-Z0-9._%+-]+@(?:[A-Z0-9-]+\.)+[A-Z][A-Z0-9-]*/gi;
const PRIVATE_ADDRESS = /\b(?:192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3})\b/g;
const SECRET = /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16})\b/g;
const LOCAL_PATH = /[A-Z]:[\\/](?:Users|Documents and Settings)[\\/][^\s"'\x60]+/gi;
const PRIVATE_HOST = /\b[a-z0-9-]+\.(?:lan|home\.arpa|internal)\b/gi;
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

export function inspectText(text, path = "text") {
  const findings = [];
  const report = (category, index) => findings.push({ path, line: text.slice(0,index).split("\n").length, category });
  for (const match of text.matchAll(EMAIL)) if (!EXAMPLE_EMAIL.test(match[0]) && !PUBLIC_AUTOMATION_EMAILS.has(match[0].toLowerCase())) report("non-example-email", match.index);
  for (const match of text.matchAll(SECRET)) report("credential-pattern", match.index);
  for (const match of text.matchAll(LOCAL_PATH)) report("workstation-path", match.index);
  for (const match of text.matchAll(PRIVATE_HOST)) report("private-hostname", match.index);
  for (const match of text.matchAll(PRIVATE_ADDRESS)) {
    if (!ADDRESS_FIXTURES.get(path)?.has(match[0]) && !PRODUCT_NETWORK.test(match[0])) report("private-network-address", match.index);
  }
  return findings;
}

function inspectPath(path) {
  const findings=[];
  if (/(?:^|\/)\.env(?:\..+)?$/.test(path) && !path.endsWith(".env.example")) findings.push({ path, line: 1, category: "runtime-env-file" });
  if (/(?:^|\/)(?:\.claude|\.remember|\.private|review-reports)\//.test(path) || /\.(?:pem|key|p12|dump|sqlite3?|log|zip|tgz)$/.test(path)) findings.push({path,line:1,category:"private-artifact"});
  return findings;
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
    if(!content.includes(0))findings.push(...inspectText(content.toString("utf8"),path));
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
    if(!content.includes(0))findings.push(...inspectText(content.toString("utf8"),path));
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
