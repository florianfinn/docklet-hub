import { test } from "node:test";
import assert from "node:assert/strict";
import { SecretValidation } from "./secret.js";

const Main = "h".repeat(32);
const Secondary = "z".repeat(32);

test("without a transition value the check behaves as before", () => {
  const validation = new SecretValidation(Main);
  assert.equal(validation.check(Main), "primary");
  assert.equal(validation.check(Secondary), "wrong");
  assert.equal(validation.secondaryActive, false);
  assert.equal(validation.secondaryUsed, 0);
});

test("during rotation both values are accepted, a third one is not", () => {
  const validation = new SecretValidation(Main, Secondary);
  assert.equal(validation.check(Main), "primary");
  assert.equal(validation.check(Secondary), "secondary");
  assert.equal(validation.check("x".repeat(32)), "wrong");
  assert.equal(validation.secondaryActive, true);
});

test("only what came in via the transition value is counted", () => {
  // This is the number used to decide "may the old value go?": it must not
  // keep growing when the new value has long been in use.
  const validation = new SecretValidation(Main, Secondary);
  validation.check(Main);
  validation.check(Main);
  assert.equal(validation.secondaryUsed, 0);
  validation.check(Secondary);
  validation.check(Secondary);
  assert.equal(validation.secondaryUsed, 2);
  validation.check("wrong".repeat(8));
  assert.equal(validation.secondaryUsed, 2);
});

test("a missing or duplicated header is not a match", () => {
  const validation = new SecretValidation(Main, Secondary);
  // This is how the value arrives from Node: undefined without a header,
  // string[] for a duplicated header.
  assert.equal(validation.check(undefined), "wrong");
  assert.equal(validation.check([Main]), "wrong");
  assert.equal(validation.check(null), "wrong");
});

test("a too short or too long value does not throw but yields \"wrong\"", () => {
  // crypto.timingSafeEqual throws on unequal length — so the length comparison
  // before it is not a detail but keeps the check alive at all. Without it
  // every short input would be a 500 instead of a 401.
  const validation = new SecretValidation(Main, Secondary);
  assert.equal(validation.check(""), "wrong");
  assert.equal(validation.check("h"), "wrong");
  assert.equal(validation.check(`${Main}x`), "wrong");
});
