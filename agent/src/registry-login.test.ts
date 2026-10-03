import assert from "node:assert/strict";
import test from "node:test";
import { registrationFrom, registryHostOf } from "./registry-login.js";

function auth(user: string, secret: string): string {
  return Buffer.from(`${user}:${secret}`, "utf8").toString("base64");
}

test("the registry host comes from the first segment — but only if it is one", () => {
  // The rule of the docker CLI. Without it `florianfinn/foo` would end up under
  // the host "florianfinn", and the login for Docker Hub would never be found.
  assert.equal(registryHostOf("ghcr.io/florianfinn/docklet-hub-agent"), "ghcr.io");
  assert.equal(registryHostOf("registry.local:5000/team/app"), "registry.local:5000");
  assert.equal(registryHostOf("localhost/app"), "localhost");
  assert.equal(registryHostOf("florianfinn/foo"), "docker.io");
  assert.equal(registryHostOf("nginx"), "docker.io");
});

test("the usual case: a base64 entry under the host", () => {
  const finding = registrationFrom(
    { auths: { "ghcr.io": { auth: auth("florianfinn", "ghp_geheim") } } },
    "ghcr.io"
  );
  assert.ok(finding.ok);
  assert.deepEqual(finding.auth, {
    username: "florianfinn",
    password: "ghp_geheim",
    serverAddress: "ghcr.io"
  });
});

test("a colon in the password does not split a second time", () => {
  // A user name cannot contain a colon, a token very well can. Splitting at
  // the last instead of the first would wrongly break apart exactly the
  // credentials that would still work.
  const finding = registrationFrom(
    { auths: { "ghcr.io": { auth: auth("wer", "ab:cd:ef") } } },
    "ghcr.io"
  );
  assert.ok(finding.ok);
  assert.equal(finding.auth.password, "ab:cd:ef");
});

test("Docker Hub is stored under its historical key", () => {
  // `docker login` writes "https://index.docker.io/v1/", the image ref contains
  // nothing of that. Without equating the two the login would never be found.
  const finding = registrationFrom(
    { auths: { "https://index.docker.io/v1/": { auth: auth("wer", "was") } } },
    "docker.io"
  );
  assert.ok(finding.ok);
  assert.equal(finding.auth.serverAddress, "docker.io");
});

test("a helper program is named, not invoked", () => {
  // ⚠️ Executing a credsStore would mean starting a program whose name is
  // determined by a configuration file — in the container that holds the
  // docker.sock. The price is one piece of information less, not a wrong one.
  const viaStore = registrationFrom({ credsStore: "desktop", auths: { "ghcr.io": {} } }, "ghcr.io");
  assert.equal(viaStore.ok, false);
  assert.equal(viaStore.ok === false && viaStore.reason, "credential-helper");

  const viaHelper = registrationFrom({ credHelpers: { "ghcr.io": "ecr-login" } }, "ghcr.io");
  assert.equal(viaHelper.ok, false);
  assert.equal(viaHelper.ok === false && viaHelper.reason, "credential-helper");
});

test("no entry is something different from a broken file", () => {
  const without = registrationFrom({ auths: { "docker.io": { auth: auth("a", "b") } } }, "ghcr.io");
  assert.equal(without.ok === false && without.reason, "no-entry");

  const broken = registrationFrom("kein objekt", "ghcr.io");
  assert.equal(broken.ok === false && broken.reason, "unreadable");
});

test("username/password without base64 are read as well", () => {
  const finding = registrationFrom(
    { auths: { "ghcr.io": { username: "wer", password: "was" } } },
    "ghcr.io"
  );
  assert.ok(finding.ok);
  assert.equal(finding.auth.username, "wer");
});
