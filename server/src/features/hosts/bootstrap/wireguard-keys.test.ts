import test from "node:test";
import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey } from "node:crypto";

import { generateWireGuardKeyPair, publicKeyFromPrivate } from "./wireguard-keys.js";

// Die Fehlerklasse hier ist still: ein Schlüssel in der falschen Form ist eine
// Zeichenkette wie jede andere. Kein Typ, kein Compiler und keine Route merkt
// etwas davon — es merkt nur `wg-quick` auf einem fremden Host, Stunden später.

const BASE64_32_BYTES = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/;

test("beide Schlüssel sind 44 Zeichen Base64 über 32 Rohbytes", () => {
  const pair = generateWireGuardKeyPair();
  for (const key of [pair.privateKey, pair.publicKey]) {
    assert.equal(key.length, 44, `44 Zeichen erwartet, bekam ${key.length}: ${key}`);
    // Die letzte Gruppe trägt nur 2 der 6 Bits — daraus folgt das eingeschränkte
    // Zeichen vor dem `=`. Eine DER-Form fiele schon an der Länge auf, eine
    // Hex-Form hier.
    assert.match(key, BASE64_32_BYTES);
    assert.equal(Buffer.from(key, "base64").length, 32);
  }
});

test("privater und öffentlicher Schlüssel gehören zusammen", () => {
  const pair = generateWireGuardKeyPair();
  assert.equal(publicKeyFromPrivate(pair.privateKey), pair.publicKey);
});

test("der öffentliche Schlüssel ist aus dem privaten reproduzierbar", () => {
  // Die Gegenprobe ohne das Modul selbst: aus den Rohbytes eine PKCS#8-Struktur
  // bauen und Node den öffentlichen Teil rechnen lassen. Ginge das nicht, wäre
  // der private Teil im Archiv nicht der zum `[Peer]`-Eintrag des Hubs.
  const pair = generateWireGuardKeyPair();
  const der = Buffer.concat([
    Buffer.from("302e020100300506032b656e04220420", "hex"),
    Buffer.from(pair.privateKey, "base64")
  ]);
  const derived = createPublicKey(createPrivateKey({ key: der, format: "der", type: "pkcs8" }))
    .export({ type: "spki", format: "der" })
    .subarray(-32)
    .toString("base64");
  assert.equal(derived, pair.publicKey);
});

test("zwei Aufrufe liefern zwei verschiedene Paare", () => {
  // Ein Erzeuger, der zweimal dasselbe liefert, gäbe zwei Armen denselben
  // Schlüssel — und der zweite nähme dem ersten den Tunnel weg.
  const first = generateWireGuardKeyPair();
  const second = generateWireGuardKeyPair();
  assert.notEqual(first.privateKey, second.privateKey);
  assert.notEqual(first.publicKey, second.publicKey);
});

test("ein Schlüssel falscher Länge wird abgewiesen statt gerechnet", () => {
  assert.throws(() => publicKeyFromPrivate("too-short"), /Bytes/);
  assert.throws(() => publicKeyFromPrivate(""), /Bytes/);
});
