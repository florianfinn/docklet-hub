import test from "node:test";
import assert from "node:assert/strict";

import {
  MIN_AGENT_VERSION,
  compareAgentVersions,
  isAgentOutdated,
  parseAgentVersion,
  supportsExternallyManaged
} from "./version.js";

// Die Fehlerklasse, gegen die diese Datei steht, kommt in einer Prüfumgebung
// nie von selbst vor: dort meldet jeder eingespeiste Agent brav eine Version.
// Im Betrieb meldet ein alter gar keine und ein kaputtes Image „unbekannt" —
// und beide Fälle dürfen nicht „in Ordnung" ergeben.

test("die Marke ist die Fassung, gegen die dieser Hub gebaut ist", () => {
  assert.equal(MIN_AGENT_VERSION, "0.32.0");
});

test("genau die Marke gilt als aktuell genug", () => {
  assert.equal(isAgentOutdated("0.32.0"), false);
});

test("eine Fassung darunter ist zu alt", () => {
  assert.equal(isAgentOutdated("0.31.0"), true);
});

test("eine fehlende Version ist zu alt und nicht unbekannt", () => {
  // Der stille Fall: `null` durchzulassen ergäbe „online" für einen Agenten,
  // von dem der Hub nichts weiß.
  assert.equal(isAgentOutdated(null), true);
  assert.equal(isAgentOutdated(undefined), true);
  assert.equal(isAgentOutdated(""), true);
});

test(`die Auskunft „unbekannt" des Agenten ist zu alt`, () => {
  // So meldet sich ein Agent, der seine eigene package.json nicht lesen kann
  // (version.ts im Agent-Repo, v0.18.1).
  assert.equal(isAgentOutdated("unbekannt"), true);
});

test("verglichen wird numerisch, nicht als Text", () => {
  // The mistake that looks right until the first two-digit minor: as a
  // string "0.9.0" is greater than "0.32.0".
  assert.equal(isAgentOutdated("0.9.0"), true);
  assert.equal(isAgentOutdated("0.33.0"), false);
  assert.equal(isAgentOutdated("1.0.0"), false);
});

test("ein vorangestelltes v stört nicht", () => {
  assert.equal(isAgentOutdated("v0.32.0"), false);
  assert.equal(isAgentOutdated("v0.31.9"), true);
});

test("ein Vorabstand derselben Fassung gilt als diese Fassung", () => {
  assert.equal(isAgentOutdated("0.32.0-rc.1"), false);
});

test("was nicht wie eine Version aussieht, ist zu alt", () => {
  for (const value of ["0.32", "abc", "0.32.0.2", "-1.0.0", " ", "0.32.x"]) {
    assert.equal(isAgentOutdated(value), true, `„${value}" hätte als zu alt gelten müssen`);
  }
});

test("Leerraum um die Angabe wird abgeschnitten", () => {
  assert.deepEqual(parseAgentVersion("  0.18.1 "), [0, 18, 1]);
});

test("der Vergleich selbst: jede Stelle zählt, von links nach rechts", () => {
  assert.ok(compareAgentVersions([0, 18, 0], [0, 18, 1]) < 0);
  assert.ok(compareAgentVersions([0, 18, 1], [0, 18, 1]) === 0);
  assert.ok(compareAgentVersions([0, 18, 2], [0, 18, 1]) > 0);
  assert.ok(compareAgentVersions([0, 9, 99], [0, 18, 0]) < 0);
  assert.ok(compareAgentVersions([1, 0, 0], [0, 99, 99]) > 0);
});

test("externallyManaged erst ab v0.31.0, eine unlesbare Fassung heißt nein", () => {
  assert.equal(supportsExternallyManaged("0.30.9"), false);
  assert.equal(supportsExternallyManaged("0.31.0"), true);
  assert.equal(supportsExternallyManaged("v0.32.1"), true);
  assert.equal(supportsExternallyManaged("0.31.0-rc.1"), true);
  assert.equal(supportsExternallyManaged(null), false);
  assert.equal(supportsExternallyManaged("latest"), false);
});


test("release candidates retain their numeric identifier", () => {
  assert.deepEqual(parseAgentVersion(" v0.32.0-rc.10 "), [0, 32, 0, 10]);
  assert.deepEqual(parseAgentVersion("0.32.0-rc.4+build.1"), [0, 32, 0, 4]);
  for (const value of ["0.32.0-rc", "0.32.0-rc.x", "0.32.0-rc.01", "0.32.0-beta.1", "0.32.0-rc.9007199254740992", "9007199254740992.0.0"]) {
    assert.equal(parseAgentVersion(value), null, value);
  }
});

test("update ordering follows numeric rc precedence and then the release core", () => {
  const versions = ["0.32.0-rc.3", "0.32.0-rc.4", "0.32.0-rc.10", "0.32.0", "0.32.1-rc.1"];
  for (const [i, left] of versions.entries()) {
    for (const [j, right] of versions.entries()) {
      const a = parseAgentVersion(left);
      const b = parseAgentVersion(right);
      assert.ok(a && b);
      assert.equal(Math.sign(compareAgentVersions(a, b)) || 0, Math.sign(i - j) || 0, `${left} vs ${right}`);
    }
  }
});

test("minimum release admits candidates without admitting an older release", () => {
  assert.equal(isAgentOutdated("0.32.0-rc.3"), false);
  assert.equal(isAgentOutdated("0.31.9-rc.10"), true);
  assert.equal(supportsExternallyManaged("0.31.0-rc.3"), true);
});
