import assert from "node:assert/strict";
import test from "node:test";
import { mutabilityOf, mutabilityOfRef, isMutableTag, parseImageRef } from "./image-ref.js";

test("ein Digest-Ref geht vollstaendig an die Engine und gilt nie als mutabel", () => {
  const digest = `sha256:${"a".repeat(64)}`;
  const parsed = parseImageRef(`itzg/minecraft-server@${digest}`);
  assert.deepEqual(parsed, {
    fromImage: `itzg/minecraft-server@${digest}`,
    tag: null,
    digest,
    fullRef: `itzg/minecraft-server@${digest}`,
    mutable: false
  });
});

test("ein Tag-Ref wird in Name und Tag zerlegt", () => {
  assert.deepEqual(parseImageRef("postgres:16-alpine"), {
    fromImage: "postgres",
    tag: "16-alpine",
    digest: null,
    fullRef: "postgres:16-alpine",
    mutable: false
  });
});

test("ein Registry-Host mit Port wird nicht als Tag missverstanden", () => {
  assert.deepEqual(parseImageRef("registry.example.com:5000/team/app:1.2.3"), {
    fromImage: "registry.example.com:5000/team/app",
    tag: "1.2.3",
    digest: null,
    fullRef: "registry.example.com:5000/team/app:1.2.3",
    mutable: false
  });
});

test("fehlender Tag gilt als mutabel — ohne Tag meint Docker :latest", () => {
  const parsed = parseImageRef("postgres");
  assert.equal(parsed?.tag, null);
  assert.equal(parsed?.mutable, true);
});

test("bekannte rollende Tags sind mutabel", () => {
  assert.equal(parseImageRef("traefik:latest")?.mutable, true);
  assert.equal(parseImageRef("traefik:LATEST")?.mutable, true);
  assert.equal(parseImageRef("node:nightly")?.mutable, true);
  assert.equal(isMutableTag(null), true);
  assert.equal(isMutableTag("v1.4.2"), false);
});

// Everything here would go to the Docker Engine as a query parameter. A ref
// we do not fully understand is not pulled.
test("unclean refs are refused instead of passed through", () => {
  const rejected = [
    "",
    "   ",
    "postgres:16 alpine",
    "postgres:16&foo=bar",
    "../../etc/passwd",
    "team/../app:1.0",
    "/leading-slash:1.0",
    "trailing-slash/:1.0",
    "team//app:1.0",
    "app@sha256:zzzz",
    "app@md5:abc",
    "UPPERCASE/app:1.0",
    `${"a".repeat(600)}:1.0`
  ];
  for (const ref of rejected) {
    assert.equal(parseImageRef(ref), null, `should have been refused: ${ref}`);
  }
});

// Built via fromCharCode instead of as a literal: nobody can verify invisible
// characters in the source during review.
test("control characters in the ref are refused", () => {
  for (const code of [0, 9, 10, 13, 27, 127]) {
    const ref = `postgres:16${String.fromCharCode(code)}alpine`;
    assert.equal(parseImageRef(ref), null, `code ${code} should have been refused`);
  }
});

test("Digest schlaegt Tag, wenn beides angegeben ist", () => {
  const digest = `sha256:${"b".repeat(64)}`;
  const parsed = parseImageRef(`app:1.0@${digest}`);
  assert.equal(parsed?.fromImage, `app@${digest}`);
  assert.equal(parsed?.tag, null);
  assert.equal(parsed?.mutable, false);
});

// --- fullRef: the value for EVERYTHING except /images/create ---------------

test("fullRef carries the tag, fromImage does not", () => {
  // Found live 2026-07-20: fromImage is right for /images/create (name and
  // tag travel separately), but wrong for looking up and creating — the
  // engine resolves "nginx" to nginx:LATEST, not to the pinned
  // nginx:1.27-alpine.
  const parsed = parseImageRef("nginx:1.27-alpine");
  assert.ok(parsed);
  assert.equal(parsed.fromImage, "nginx");
  assert.equal(parsed.tag, "1.27-alpine");
  assert.equal(parsed.fullRef, "nginx:1.27-alpine");
});

test("fullRef macht das implizite :latest explizit", () => {
  const parsed = parseImageRef("nginx");
  assert.ok(parsed);
  assert.equal(parsed.fullRef, "nginx:latest");
});

test("bei Digest-Refs sind fromImage und fullRef identisch", () => {
  const ref = "nginx@sha256:" + "a".repeat(64);
  const parsed = parseImageRef(ref);
  assert.ok(parsed);
  assert.equal(parsed.fullRef, ref);
  assert.equal(parsed.fromImage, ref);
});

test("fullRef behaelt Registry-Host und Port", () => {
  const parsed = parseImageRef("registry.example.com:5000/team/app:2.1");
  assert.ok(parsed);
  assert.equal(parsed.fullRef, "registry.example.com:5000/team/app:2.1");
});

// --- Mutability (R1) -----------------------------------------------------

test("ein Digest-Ref gilt als gepinnt", () => {
  assert.equal(mutabilityOfRef(`ghcr.io/u/app@sha256:${"a".repeat(64)}`), "pinned");
  // Digest schlaegt Tag — auch wenn beides dasteht.
  assert.equal(mutabilityOfRef(`nginx:1.27@sha256:${"b".repeat(64)}`), "pinned");
});

test("ein konkreter Tag ist die mittlere Stufe, nicht die sichere", () => {
  // Der Punkt der drei Stufen: `nginx:1.27` ist NICHT unbeweglich, nur
  // unwahrscheinlich beweglich. Eine Zusicherung gibt allein der Digest.
  assert.equal(mutabilityOfRef("nginx:1.27"), "tag");
  assert.equal(mutabilityOfRef("ghcr.io/florianfinn/app:v2.11.0"), "tag");
});

test("Rolling-Tags und ein fehlender Tag sind beweglich", () => {
  assert.equal(mutabilityOfRef("traefik:latest"), "floating");
  assert.equal(mutabilityOfRef("traefik:LATEST"), "floating");
  assert.equal(mutabilityOfRef("node:nightly"), "floating");
  // Ohne Tag meint Docker :latest — die Einstufung muss dieselbe sein.
  assert.equal(mutabilityOfRef("nginx"), "floating");
});

test("ein unzerlegbarer oder fehlender Ref wird nicht eingeordnet", () => {
  // `null` ist ausdruecklich nicht dasselbe wie "floating": ein Ref, den wir
  // nicht verstehen, soll nicht so aussehen, als haetten wir ihn geprueft.
  assert.equal(mutabilityOfRef("nicht valide/../ref"), null);
  assert.equal(mutabilityOfRef(""), null);
  assert.equal(mutabilityOfRef(null), null);
});

test("mutabilityOf agrees with the internal mutable flag", () => {
  // If the two diverged, the internal flag and the level shown in the UI
  // would contradict each other.
  for (const ref of ["nginx", "nginx:latest", "nginx:1.27", `nginx@sha256:${"c".repeat(64)}`]) {
    const parsed = parseImageRef(ref);
    assert.ok(parsed);
    const level = mutabilityOf(parsed);
    assert.equal(level === "floating", parsed.mutable);
    assert.equal(level === "pinned", parsed.digest !== null);
  }
});
