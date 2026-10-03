import assert from "node:assert/strict";
import test from "node:test";
import { localManifestDigest, repoOfRef } from "./update.js";

const A = `sha256:${"a".repeat(64)}`;
const B = `sha256:${"b".repeat(64)}`;

test("repoOfRef removes tag and digest", () => {
  assert.equal(repoOfRef("nginx:1.27-alpine"), "nginx");
  assert.equal(repoOfRef("ghcr.io/u/app:1.2"), "ghcr.io/u/app");
  assert.equal(repoOfRef("registry:5000/team/app@sha256:deadbeef"), "registry:5000/team/app");
  assert.equal(repoOfRef("nginx"), "nginx");
});

test("localManifestDigest picks the digest for the matching repo", () => {
  assert.equal(localManifestDigest([`nginx@${A}`], "nginx:1.27-alpine"), A);
  assert.equal(
    localManifestDigest([`other@${B}`, `ghcr.io/u/app@${A}`], "ghcr.io/u/app:1.2"),
    A
  );
});

test("localManifestDigest also matches with the library/ prefix", () => {
  assert.equal(localManifestDigest([`library/nginx@${A}`], "nginx:latest"), A);
});

test("localManifestDigest: the only entry is taken", () => {
  assert.equal(localManifestDigest([`irgendwas@${A}`], "sonst:tag"), A);
});

test("localManifestDigest: no RepoDigest -> null (not determinable)", () => {
  assert.equal(localManifestDigest([], "nginx:latest"), null);
  assert.equal(localManifestDigest(undefined, "nginx:latest"), null);
});

test("localManifestDigest: invalid digest -> null", () => {
  assert.equal(localManifestDigest(["nginx@sha256:kurz"], "nginx:latest"), null);
});

// Found live: after a pull without a tag (which accidentally pulled EVERY tag
// of the repo) there was more than one RepoDigest with DIFFERENT digests for
// the same repo name. A `.find()` would simply have taken the first one —
// sometimes the matching one, sometimes a foreign one, depending on order. This
// must not guess: ambiguous is just as undeterminable as "no match".
test("localManifestDigest: several matches with DIFFERENT digests -> null (ambiguous)", () => {
  assert.equal(
    localManifestDigest([`adguard/adguardhome@${A}`, `adguard/adguardhome@${B}`], "adguard/adguardhome:arm64-edge"),
    null
  );
});

// Two tags can point to the same digest (e.g. ":latest" and the current
// version number) — that is not ambiguity but the same state named twice.
test("localManifestDigest: several matches with the SAME digest are unambiguous", () => {
  assert.equal(localManifestDigest([`nginx@${A}`, `nginx@${A}`], "nginx:latest"), A);
});
