import assert from "node:assert/strict";
import test from "node:test";
import { envQuerySchema } from "contract";

import { queryObject, bodyWithLegacyKeys } from "./request-keys.js";
import { handlerSource } from "./handler-source-test-support.js";

// The requests are built the way `docker-agent-client.ts` assembles them in
// the dashboard: `new URLSearchParams({ share, path })` to the WebFTP routes,
// `?plaintext=1` to the .env view, `{ set, remove }` as the body.
const WEBFTP = "http://agent.invalid/v1/containers/abc123/files";
const ENV = "http://agent.invalid/v1/containers/abc123/env";

const query = (base: string, pairs: Record<string, string>) =>
  new URL(`${base}?${new URLSearchParams(pairs).toString()}`);

// --- Query: share ----------------------------------------------------------

test("share: the NEW name reaches the access check", () => {
  const url = query(WEBFTP, { share: "Pal/Saved/SaveData", path: "welt1" });
  assert.equal(queryObject(url).share ?? null, "Pal/Saved/SaveData");
});

test("share: the OLD name keeps working (old dashboard, new agent)", () => {
  const url = query(WEBFTP, { "freigabe": "Pal/Saved/SaveData", "pfad": "welt1" });
  assert.equal(queryObject(url).share ?? null, "Pal/Saved/SaveData");
});

test("share: if both are in the URL, the new one wins", () => {
  const url = query(WEBFTP, { "freigabe": "alt", share: "neu" });
  assert.equal(queryObject(url).share ?? null, "neu");
});

// --- Query: path -----------------------------------------------------------

test("path: the NEW name reaches the path check", () => {
  const url = query(WEBFTP, { share: "Saved", path: "unterordner/file.txt" });
  assert.equal(queryObject(url).path ?? null, "unterordner/file.txt");
});

test("path: the OLD name keeps working", () => {
  const url = query(WEBFTP, { "freigabe": "Saved", "pfad": "unterordner/file.txt" });
  assert.equal(queryObject(url).path ?? null, "unterordner/file.txt");
});

// ⚠️ The empty path is a VALID value (the share itself), not an absence. A
// reader with `||` would fall back to `pfad` here and list the wrong
// directory — without an error message, because both responses are
// well-formed.
test("path: an empty `path=` is a value and does not fall back to `pfad`", () => {
  const url = query(WEBFTP, { path: "", "pfad": "unterordner" });
  assert.equal(queryObject(url).path ?? null, "");
});

test("path: if both are missing, it stays null (the call site then sets \"\")", () => {
  const url = query(WEBFTP, { share: "Saved" });
  assert.equal(queryObject(url).path ?? null, null);
});

// --- Query: plaintext ------------------------------------------------------

test("plaintext: the NEW name unlocks the plaintext", () => {
  const url = query(ENV, { plaintext: "1" });
  assert.equal(envQuerySchema.parse(queryObject(url)).plaintext, true);
});

test("plaintext: the OLD name keeps working", () => {
  const url = query(ENV, { "klartext": "1" });
  assert.equal(envQuerySchema.parse(queryObject(url)).plaintext, true);
});

// ⚠️ The direction that counts: the new name may also SUPPRESS the old one.
// If `plaintext=0` falls back to an old `klartext=1`, the agent hands out
// secrets the caller did not request.
test("plaintext: `plaintext=0` overrules an old `klartext=1`", () => {
  const url = query(ENV, { "klartext": "1", plaintext: "0" });
  assert.equal(envQuerySchema.parse(queryObject(url)).plaintext, false);
});

test("plaintext: without a value it stays masked", () => {
  const url = new URL(ENV);
  assert.equal(envQuerySchema.parse(queryObject(url)).plaintext, false);
});

// --- Body: set / remove ---------------------------------------------------

// The assertions read the moved value the way the schema then sees it.
const rawSet = (body: Record<string, unknown>) =>
  (bodyWithLegacyKeys(body).set ?? {}) as Record<string, unknown>;

test("set: the NEW name carries the change into the .env file", () => {
  assert.deepEqual(rawSet({ expectedEnvHash: null, set: { PUID: "99" } }), { PUID: "99" });
});

test("set: the OLD name keeps working", () => {
  assert.deepEqual(rawSet({ expectedEnvHash: null, "setzen": { PUID: "99" } }), { PUID: "99" });
});

// ⚠️ An empty `set` from a NEW dashboard means "nothing to set" and must not
// mix with an old `setzen` — otherwise the agent would write values that the
// caller no longer sends in this request.
test("set: an empty `set` does not fall back to `setzen`", () => {
  assert.deepEqual(rawSet({ set: {}, "setzen": { PUID: "99" } }), {});
});

test("set: if both are missing, it stays empty", () => {
  assert.deepEqual(rawSet({ expectedEnvHash: null }), {});
});

const rawRemove = (body: Record<string, unknown>) => {
  const value = bodyWithLegacyKeys(body).remove;
  return Array.isArray(value) ? value.filter((e): e is string => typeof e === "string") : [];
};

test("remove: the NEW name deletes the line", () => {
  assert.deepEqual(rawRemove({ expectedEnvHash: null, remove: ["ALT_KEY"] }), ["ALT_KEY"]);
});

test("remove: the OLD name keeps working", () => {
  assert.deepEqual(rawRemove({ expectedEnvHash: null, "entfernen": ["ALT_KEY"] }), ["ALT_KEY"]);
});

test("remove: both set — the new one wins", () => {
  assert.deepEqual(rawRemove({ remove: ["NEU"], "entfernen": ["ALT"] }), ["NEU"]);
});

// --- Body: path -----------------------------------------------------------

const rawPath = (body: Record<string, unknown>) => {
  const value = bodyWithLegacyKeys(body).path;
  return typeof value === "string" ? value : "";
};

test("body path: the NEW name targets the intended entry", () => {
  assert.equal(rawPath({ action: "rename", path: "welt1/alt.sav", name: "neu.sav" }), "welt1/alt.sav");
});

test("body path: the OLD name keeps working", () => {
  assert.equal(rawPath({ action: "rename", "pfad": "welt1/alt.sav", name: "neu.sav" }), "welt1/alt.sav");
});

// ⚠️ The most expensive case of this route: without a path, rename and delete
// target the share ITSELF. If the field is missing, the empty path has to
// come out — and the check behind it (`checkEntryPath`) rejects it for
// mutating actions.
test("body path: if both are missing, the path stays empty instead of undefined", () => {
  assert.equal(rawPath({ action: "delete" }), "");
});

// --- The old names do not travel on ---------------------------------------

test("the old names are removed after the move, so no schema sees two", () => {
  const url = query(WEBFTP, { "freigabe": "Saved", "pfad": "welt1" });
  assert.deepEqual(queryObject(url), { share: "Saved", path: "welt1" });
  assert.deepEqual(bodyWithLegacyKeys({ "setzen": { A: "1" }, "entfernen": ["B"] }), { set: { A: "1" }, remove: ["B"] });
});

test("a key given twice in the query is read once, as its first value", () => {
  const url = new URL(`${WEBFTP}?path=a&path=b`);
  assert.deepEqual(queryObject(url), { path: "a" });
});

// --- Guard: the handlers really use the transition readers ----------------

// ⚠️ The transition readers above can be completely correct and still hang on
// NO route — exactly the failure shape that triggered this work: both sides
// green on their own, the line between them open. Since #272 every handler
// parses its whole query from `queryObject(url)` and every body comes through
// `readJsonBody`, which moves the old names itself (runtime/http.ts). This
// guard reads the source (routes/, runtime/, dispatch.ts, index.ts) and holds
// both.
const SOURCE = handlerSource();

test("no handler reads a query parameter past queryObject", () => {
  const direct = SOURCE.match(/searchParams\.get\(/g);
  assert.equal(direct, null, `read directly: ${JSON.stringify(direct)}`);
});

test("the handlers no longer read any request key under the old name", () => {
  const alone = SOURCE.match(/\bbody\.(pfad|setzen|entfernen)\b/g);
  assert.equal(alone, null, `still read directly: ${JSON.stringify(alone)}`);
});

test("readJsonBody moves the old body names", () => {
  assert.match(SOURCE, /return bodyWithLegacyKeys\(/);
});

// ⚠️ The second half of the promise: both names are read, only the new one
// is WRITTEN. What is forbidden is putting a German name into an outgoing URL.
test("the handlers do not produce a German request key", () => {
  const produced = SOURCE.match(/searchParams\.set\("(pfad|freigabe|klartext)"/g);
  assert.equal(produced, null, `produced in German: ${JSON.stringify(produced)}`);
});
