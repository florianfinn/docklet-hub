import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  MAX_REGISTRATION_ATTEMPTS,
  MIN_REGISTRATION_TOKEN_LENGTH,
  hashRegistrationToken,
  isValidDockerGid,
  normalizeBindBasePath,
  normalizeTunnelAddress,
  secretsMatch
} from "./host-record.js";

test("der Abdruck ist SHA-256 in hex und hängt nur am Token", () => {
  const token = "x".repeat(40);
  assert.equal(hashRegistrationToken(token), createHash("sha256").update(token, "utf8").digest("hex"));
  assert.equal(hashRegistrationToken(token).length, 64);
  assert.notEqual(hashRegistrationToken(token), hashRegistrationToken(`${token}y`));
});

test("das Klartext-Token steht in keinem Abdruck", () => {
  // Der Punkt der Speicherung: wer die Tabelle liest, kann damit keinen Arm
  // anmelden.
  const token = "geheimes-token-mit-mindestens-32-zeichen";
  assert.ok(!hashRegistrationToken(token).includes(token));
});

test("die Mindestlänge des Tokens ist die des Agenten", () => {
  // Der Agent lehnt DOCKER_AGENT_REGISTRATION_TOKEN unter 32 Zeichen ab
  // (v0.18.1). Eine kleinere Marke hier ergäbe ein Archiv, das erst auf dem
  // Zielhost auffällt.
  assert.equal(MIN_REGISTRATION_TOKEN_LENGTH, 32);
});

test("die Sperre steht bei zwölf Versuchen", () => {
  assert.equal(MAX_REGISTRATION_ATTEMPTS, 12);
});

test("gleiche Geheimnisse sind gleich, ungleiche nicht — auch bei ungleicher Länge", () => {
  assert.equal(secretsMatch("abc", "abc"), true);
  assert.equal(secretsMatch("abc", "abd"), false);
  // Ungleiche Längen dürfen die Funktion nicht werfen lassen: `timingSafeEqual`
  // verlangt gleich lange Puffer, und genau deshalb wird über den Abdruck
  // verglichen.
  assert.equal(secretsMatch("abc", "abcdef"), false);
  assert.equal(secretsMatch("", ""), true);
});

test("eine gewöhnliche IPv4-Adresse bleibt, wie sie ist", () => {
  assert.equal(normalizeTunnelAddress("10.254.0.2"), "10.254.0.2");
  assert.equal(normalizeTunnelAddress("  10.254.0.2  "), "10.254.0.2");
});

test("die IPv4-abgebildete IPv6-Form wird zurückgeführt", () => {
  // ⚠️ Der Fall, der in einer Prüfumgebung nie auftritt und im Betrieb immer:
  // Node liefert die Gegenstelle auf einem dual-stack-Listener so. Ohne diese
  // Rückführung scheiterte die Anmeldung jedes Arms mit „unbekannte Quelle".
  assert.equal(normalizeTunnelAddress("::ffff:10.254.0.2"), "10.254.0.2");
  assert.equal(normalizeTunnelAddress("::FFFF:10.254.0.2"), "10.254.0.2");
  assert.equal(normalizeTunnelAddress("[::ffff:10.254.0.2]"), "10.254.0.2");
});

test("was keine IPv4-Adresse ist, ergibt null statt eines Datenbankfehlers", () => {
  for (const value of [
    "",
    "   ",
    "abc",
    "10.254.0",
    "10.254.0.2.3",
    "10.254.0.256",
    "10.254.0.-1",
    "::1",
    "10.254.0.2/32",
    "10.254.0.2:8099",
    null,
    undefined
  ]) {
    assert.equal(normalizeTunnelAddress(value), null, `„${String(value)}" hätte null ergeben müssen`);
  }
});

test("führende Nullen werden abgelehnt, nicht ausgelegt", () => {
  // „010.254.0.2" ist je nach Werkzeug 8.254.0.2 oder 10.254.0.2. Eine
  // zweideutige Quelladresse gegen eine eindeutige Tunneladresse zu vergleichen
  // wäre eine Auslegung, und Auslegungen an einer Türschwelle sind Lücken.
  assert.equal(normalizeTunnelAddress("010.254.0.2"), null);
  assert.equal(normalizeTunnelAddress("10.254.0.02"), null);
  // Eine einzelne Null ist keine führende Null.
  assert.equal(normalizeTunnelAddress("10.254.0.0"), "10.254.0.0");
});

test("die Gruppen-ID 0 ist gültig und nicht 'nicht gesetzt'", () => {
  // Der Fall, wegen dem es diese Funktion gibt. Auf einem Host, der Docker als
  // root fährt, gehört der Socket root:root — `if (!gid)` wiese genau diesen
  // Host ab, mit der Meldung, die Angabe fehle.
  assert.equal(isValidDockerGid(0), true);
  assert.equal(isValidDockerGid(996), true);
  assert.equal(isValidDockerGid(281), true);

  assert.equal(isValidDockerGid(-1), false);
  assert.equal(isValidDockerGid(1.5), false);
  // Aus einem JSON-Rumpf kommt alles Mögliche an.
  assert.equal(isValidDockerGid("996"), false);
  assert.equal(isValidDockerGid(null), false);
  assert.equal(isValidDockerGid(undefined), false);
  assert.equal(isValidDockerGid(Number.NaN), false);
});

test("der Basispfad lässt nichts durch, was die Compose-Zeile des Arms zerlegt", () => {
  // ⚠️ Der Wert steht im erzeugten Paket unmaskiert in
  // `- ${DOCKER_AGENT_BIND_BASE_PATH}:${DOCKER_AGENT_BIND_BASE_PATH}`.
  // Doppelpunkt und Leerzeichen fallen deshalb erst auf dem fremden Host auf,
  // beim `compose up`, und die Meldung spricht dort von YAML.
  assert.equal(normalizeBindBasePath("/home/docker"), "/home/docker");
  assert.equal(normalizeBindBasePath("/mnt/user/appdata"), "/mnt/user/appdata");
  assert.equal(normalizeBindBasePath("  /srv/docker  "), "/srv/docker");
  // Ein abschließender Schrägstrich ist derselbe Ort mit einem anderen Wort.
  assert.equal(normalizeBindBasePath("/mnt/user/appdata/"), "/mnt/user/appdata");

  assert.equal(normalizeBindBasePath("/mnt:/mnt"), null);
  assert.equal(normalizeBindBasePath("/mnt/my data"), null);
  assert.equal(normalizeBindBasePath("home/docker"), null);
  assert.equal(normalizeBindBasePath("/mnt/../etc"), null);
  assert.equal(normalizeBindBasePath(""), null);
  assert.equal(normalizeBindBasePath(996), null);

  // `..` als NAMENSTEIL ist ein gewoehnlicher Pfad und kein Aufstieg.
  assert.equal(normalizeBindBasePath("/mnt/..data"), "/mnt/..data");

  // ⚠️ `/` ist ausgeschlossen, und das ist eine Entscheidung: der Basispfad IST
  // die Schranke des Agenten gegen beliebige Bind-Mounts, und `/` schaltet sie
  // ab. Ein Hub, der so ein Paket ausliefert, ohne es zu sagen, wäre
  // schlimmer als einer, der den Wert nicht anbietet.
  assert.equal(normalizeBindBasePath("/"), null);
  assert.equal(normalizeBindBasePath("//"), null);
});
