import test from "node:test";
import assert from "node:assert/strict";
import { curlArguments, githubGet } from "../../scripts/github-rest.mjs";

test("REST-Lesezugriff ruft curl nur mit HTTPS gegen api.github.com", () => {
  const args=curlArguments("example-org/demo-repo","pulls/7",{env:{}});
  assert.deepEqual(args.slice(0,3),["-fsSL","--proto","=https"]);
  assert.equal(args.at(-1),"https://api.github.com/repos/example-org/demo-repo/pulls/7");
  assert.equal(args.some(arg=>arg.startsWith("Authorization")),false);
  assert.ok(curlArguments("example-org/demo-repo","actions/jobs/1/logs",{raw:true,env:{}}).includes("Accept: application/vnd.github.raw"));
});

test("ein Token kommt nur aus DOCKLET_GITHUB_TOKEN", () => {
  const args=curlArguments("example-org/demo-repo","pulls/7",{env:{DOCKLET_GITHUB_TOKEN:"synthetic",GH_TOKEN:"other"}});
  assert.ok(args.includes("Authorization: Bearer synthetic"));
  assert.equal(args.some(arg=>arg.includes("other")),false);
});

test("Pfade außerhalb der REST-Form brechen ab", () => {
  for (const path of ["pulls/7 --upload-file x","../user","pulls/7#x"])
    assert.throws(()=>curlArguments("example-org/demo-repo",path,{env:{}}),/Unsupported/,path);
  assert.throws(()=>curlArguments("example-org/demo repo","pulls/7",{env:{}}),/Unsupported/);
});

test("JSON wird gelesen, Rohtext bleibt Text", () => {
  const run=(command,args)=>{
    assert.equal(command,"curl");
    return args.at(-1).endsWith("/logs")?"line one\nline two":JSON.stringify({number:7});
  };
  assert.deepEqual(githubGet("example-org/demo-repo","pulls/7",{env:{},run}),{number:7});
  assert.equal(githubGet("example-org/demo-repo","actions/jobs/1/logs",{raw:true,env:{},run}),"line one\nline two");
});
