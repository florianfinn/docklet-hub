import assert from "node:assert/strict";
import test from "node:test";

import { HARDENING_RULES } from "contract";

import { deCompose } from "../src/features/compose/messages/de.ts";
import { enCompose } from "../src/features/compose/messages/en.ts";
import {
  HARDENING_RULE_KEYS,
  findingsOf,
  ruleKeysOf,
  unconfirmedCount
} from "../src/features/compose/hardening-findings.ts";

// The explanation of a hardening finding (#8) comes from the rule the agent
// names. Every rule of the contract needs a text in both languages; a rule the
// hub does not know is shown verbatim and rated by nobody.

test("every contract rule has a title and an explanation in German and English", () => {
  for (const rule of HARDENING_RULES) {
    const keys = HARDENING_RULE_KEYS[rule];
    assert.ok(keys, rule);
    for (const key of [keys.title, keys.explanation]) {
      assert.equal(typeof deCompose[key], "string", `${rule} de ${key}`);
      assert.equal(typeof enCompose[key], "string", `${rule} en ${key}`);
    }
  }
});

test("findings are parsed and ordered by the contract's severity", () => {
  const findings = findingsOf([
    "web:resource-limit-missing — no limit: Memory",
    "db:sensitive-host-path — /etc/ssl",
    "web:privileged — privileged=true",
    "web:privileged — privileged=true"
  ]);
  assert.deepEqual(
    findings.map((finding) => [finding.service, finding.rule, finding.severity, finding.subject]),
    [
      ["web", "privileged", "delegation-lock", "privileged=true"],
      ["db", "sensitive-host-path", "warning", "/etc/ssl"],
      ["web", "resource-limit-missing", "notice", "no limit: Memory"]
    ]
  );
});

test("an unknown rule stays verbatim, without a rating and without a text", () => {
  const [finding] = findingsOf(["web:future-rule — something"]);
  assert.ok(finding);
  assert.equal(finding.rule, "future-rule");
  assert.equal(finding.severity, null);
  assert.equal(ruleKeysOf(finding), null);
});

test("a key without subject keeps service and rule", () => {
  const [finding] = findingsOf(["a:privileged"]);
  assert.equal(finding?.service, "a");
  assert.equal(finding?.rule, "privileged");
  assert.equal(finding?.subject, "");
});

test("only the agent's own findings count as confirmed", () => {
  const keys = ["a:privileged — privileged=true", "b:host-namespace — pid=host"];
  assert.equal(unconfirmedCount(keys, new Set()), 2);
  assert.equal(unconfirmedCount(keys, new Set(["a:privileged — privileged=true", "c:other"])), 1);
  assert.equal(unconfirmedCount(keys, new Set(keys)), 0);
});

test("only the separator is stripped, not punctuation the subject starts with", () => {
  const [relative] = findingsOf(["web:bind-outside-base — ./data"]);
  assert.equal(relative?.subject, "./data");
  const [unknown] = findingsOf(["web:future-rule — -x"]);
  assert.equal(unknown?.subject, "-x");
});
