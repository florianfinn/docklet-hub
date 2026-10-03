import assert from "node:assert/strict";
import test from "node:test";

import { renderWireGuardConfig, WireGuardConfigError, type WireGuardPeer } from "./wireguard-config.js";

// ⚠️ Die erwartete Ausgabe steht hier WÖRTLICH und wird nicht aus der Funktion
// erzeugt. Ein Vergleich gegen den eigenen Aufbau bestätigte nur, dass die
// Funktion tut, was sie tut — er wäre auch dann grün, wenn sie ab morgen eine
// Datei schriebe, die WireGuard nicht mehr liest. Was hier steht, ist der
// Vertrag mit einem fremden Programm, und den kann nur ein Mensch aufschreiben.

const HUB = {
  privateKey: "aHViLXByaXZhdGUta2V5LWJlaXNwaWVsLTAwMDAwMAA=",
  address: "10.254.0.1/24",
  listenPort: 51821
};

const ARM_ONE: WireGuardPeer = {
  publicKey: "YXJtLWVpbnMtcHVibGljLWtleS1iZWlzcGllbDAwAAA=",
  tunnelAddress: "10.254.0.2",
  name: "proxy"
};

const ARM_TWO: WireGuardPeer = {
  publicKey: "YXJtLXp3ZWktcHVibGljLWtleS1iZWlzcGllbDAwAAA=",
  tunnelAddress: "10.254.0.3",
  name: "nas"
};

const HEADER = [
  "# Erzeugt vom Hub. Änderungen von Hand gehen beim nächsten Schreiben verloren.",
  "[Interface]",
  "PrivateKey = aHViLXByaXZhdGUta2V5LWJlaXNwaWVsLTAwMDAwMAA=",
  "Address = 10.254.0.1/24",
  "ListenPort = 51821"
].join("\n");

test("ohne Arme steht nur die eigene Seite in der Datei", () => {
  // Der Regelfall eines frischen Betriebs. Sie muss trotzdem vollständig sein:
  // der Sidecar fährt mit genau dieser Datei hoch, bevor der erste Arm
  // existiert.
  assert.equal(renderWireGuardConfig(HUB, []), `${HEADER}\n`);
});

test("ein Arm ergibt genau einen Peer-Block mit /32", () => {
  assert.equal(
    renderWireGuardConfig(HUB, [ARM_ONE]),
    `${HEADER}
\n# proxy
[Peer]
PublicKey = YXJtLWVpbnMtcHVibGljLWtleS1iZWlzcGllbDAwAAA=
AllowedIPs = 10.254.0.2/32
`
  );
});

test("zwei Arme stehen nach Tunneladresse sortiert, unabhängig von der Eingabe", () => {
  // Rückwärts hineingegeben: die Reihenfolge, in der die Datenbank die Zeilen
  // liefert, darf die Datei nicht verändern. Sonst schriebe der Hub bei jedem
  // Durchlauf eine „geänderte" Datei, und der Sidecar lüde sie ohne Anlass nach.
  const expected = `${HEADER}
\n# proxy
[Peer]
PublicKey = YXJtLWVpbnMtcHVibGljLWtleS1iZWlzcGllbDAwAAA=
AllowedIPs = 10.254.0.2/32
\n# nas
[Peer]
PublicKey = YXJtLXp3ZWktcHVibGljLWtleS1iZWlzcGllbDAwAAA=
AllowedIPs = 10.254.0.3/32
`;
  assert.equal(renderWireGuardConfig(HUB, [ARM_TWO, ARM_ONE]), expected);
  assert.equal(renderWireGuardConfig(HUB, [ARM_ONE, ARM_TWO]), expected);
});

test("die Sortierung rechnet mit Zahlen, nicht mit Text", () => {
  // .10 gehört hinter .9. Eine Textsortierung fiele erst ab dem zehnten Arm
  // auf — und dann als Datei, die sich bei jedem Schreiben umsortiert.
  const tenth = { ...ARM_TWO, tunnelAddress: "10.254.0.10" };
  const ninth = { ...ARM_ONE, tunnelAddress: "10.254.0.9" };
  const rendered = renderWireGuardConfig(HUB, [tenth, ninth]);
  assert.ok(
    rendered.indexOf("AllowedIPs = 10.254.0.9/32") < rendered.indexOf("AllowedIPs = 10.254.0.10/32"),
    "10.254.0.10 steht vor 10.254.0.9"
  );
});

test("ein Name mit Zeilenumbruch wird abgelehnt, nicht bereinigt", () => {
  // Der Angriff: der Name kommt aus der Datenbank und landet in einer
  // Kommentarzeile. Ein Umbruch darin beendet den Kommentar, und die nächste
  // Zeile ist eine Anweisung an WireGuard — hier der ganze Verkehr für einen
  // einzelnen Arm.
  assert.throws(
    () => renderWireGuardConfig(HUB, [{ ...ARM_ONE, name: "proxy\nAllowedIPs = 0.0.0.0/0" }]),
    WireGuardConfigError
  );
  assert.throws(() => renderWireGuardConfig(HUB, [{ ...ARM_ONE, name: "proxy\r\nPersistentKeepalive = 1" }]), WireGuardConfigError);
  assert.throws(() => renderWireGuardConfig(HUB, [{ ...ARM_ONE, name: "  " }]), WireGuardConfigError);
});

test("ein Schlüssel mit Zeilenumbruch wird abgelehnt", () => {
  // `wg genkey | tee` hängt gern einen Umbruch an. Ungeprüft übernommen
  // stünde er in der Datei und schöbe alles Folgende in eine eigene Zeile.
  assert.throws(
    () => renderWireGuardConfig({ ...HUB, privateKey: `${HUB.privateKey}\n` }, []),
    WireGuardConfigError
  );
  assert.throws(
    () => renderWireGuardConfig(HUB, [{ ...ARM_ONE, publicKey: `${ARM_ONE.publicKey}\nListenPort = 1` }]),
    WireGuardConfigError
  );
  assert.throws(() => renderWireGuardConfig(HUB, [{ ...ARM_ONE, publicKey: "too-short" }]), WireGuardConfigError);
});

test("unbrauchbare Adressen und Ports kommen nicht in die Datei", () => {
  assert.throws(() => renderWireGuardConfig({ ...HUB, address: "10.254.0.1" }, []), WireGuardConfigError);
  assert.throws(() => renderWireGuardConfig({ ...HUB, address: "10.254.0.256/24" }, []), WireGuardConfigError);
  assert.throws(() => renderWireGuardConfig({ ...HUB, listenPort: 0 }, []), WireGuardConfigError);
  assert.throws(() => renderWireGuardConfig(HUB, [{ ...ARM_ONE, tunnelAddress: "10.254.0.2/32" }]), WireGuardConfigError);
  // Führende Nullen liest je nach Werkzeug jemand oktal — zweideutig ist
  // unbrauchbar.
  assert.throws(() => renderWireGuardConfig(HUB, [{ ...ARM_ONE, tunnelAddress: "10.254.0.02" }]), WireGuardConfigError);
});

test("zwei Arme auf derselben Adresse oder mit demselben Schlüssel werden abgelehnt", () => {
  // WireGuard nähme den zweiten Block still nicht an. Der Arm wäre dann
  // angelegt, in der Oberfläche sichtbar und nicht erreichbar — ein Fehlerbild
  // ohne Fehlermeldung.
  assert.throws(
    () => renderWireGuardConfig(HUB, [ARM_ONE, { ...ARM_TWO, tunnelAddress: ARM_ONE.tunnelAddress }]),
    WireGuardConfigError
  );
  assert.throws(
    () => renderWireGuardConfig(HUB, [ARM_ONE, { ...ARM_TWO, publicKey: ARM_ONE.publicKey }]),
    WireGuardConfigError
  );
});

test("die Eingabeliste bleibt unangetastet", () => {
  // Sortiert wird auf einer Kopie. Sortierte die Funktion die übergebene
  // Liste, änderte sie den Zustand ihres Aufrufers — und der Fehler fiele erst
  // an einer ganz anderen Stelle auf.
  const hosts = [ARM_TWO, ARM_ONE];
  renderWireGuardConfig(HUB, hosts);
  assert.deepEqual(hosts, [ARM_TWO, ARM_ONE]);
});

test("der ListenPort in der Datei ist der Port im Container, 51821", () => {
  // ⚠️ Festgehalten, weil es bis zur Verdrahtung keinen Aufrufer gibt, der es
  // falsch machen könnte — und danach genau einen, der es kann.
  //
  // 51821 ist die CONTAINERSEITE des veröffentlichten Ports
  // („${HUB_WIREGUARD_PORT:-51821}:51821/udp"). `config.wireguardPort` ist die
  // andere Seite: der Port auf dem Host, den ein Arm anwählt. Ändert ein
  // Betreiber HUB_WIREGUARD_PORT, laufen beide auseinander. Wer dann
  // `config.wireguardPort` hier durchreicht, lässt den Sidecar auf einem Port
  // lauschen, auf den keine Weiterleitung zeigt: der Tunnel kommt nicht
  // zustande, und nichts im Log nennt den Grund.
  assert.match(renderWireGuardConfig(HUB, []), /^ListenPort = 51821$/m);
  assert.match(renderWireGuardConfig(HUB, [ARM_ONE]), /^ListenPort = 51821$/m);
  // Und die Snapshots oben laufen gegen genau diesen Wert.
  assert.equal(HUB.listenPort, 51821);
});
