import test from "node:test";
import assert from "node:assert/strict";

import { COMMANDS, parseArguments } from "./break-glass-args.js";

// Das Break-Glass wird von jemandem aufgerufen, der gerade ausgesperrt ist.
// Eine Meldung, die den Tippfehler benennt, ist dort mehr wert als anderswo —
// und eine Auswertung, die einen Tippfehler als Befehl liest, teurer.

test("ohne Argumente kommt die Hilfe", () => {
  assert.deepEqual(parseArguments([]), { kind: "help" });
  assert.deepEqual(parseArguments(["help"]), { kind: "help" });
  assert.deepEqual(parseArguments(["--help"]), { kind: "help" });
  assert.deepEqual(parseArguments(["-h"]), { kind: "help" });
});

test("--help schlägt jeden Befehl", () => {
  // Wer nachschlagen will, während er einen Befehl tippt, soll die Hilfe
  // bekommen und nicht den halb getippten Befehl ausgeführt.
  assert.deepEqual(parseArguments(["reset-password", "a@b.test", "--help"]), { kind: "help" });
});

test("list braucht nichts weiter", () => {
  assert.deepEqual(parseArguments(["list"]), { kind: "command", command: "list" });
});

test("ein unbekannter Befehl nennt die bekannten", () => {
  const parsed = parseArguments(["reset"]);
  assert.equal(parsed.kind, "error");
  assert.ok(parsed.kind === "error" && parsed.message.includes("reset"));
  for (const command of COMMANDS) {
    assert.ok(parsed.kind === "error" && parsed.message.includes(command));
  }
});

test("die Befehle mit Konto verlangen eine E-Mail-Adresse", () => {
  for (const command of ["create-admin", "promote", "reset-password"]) {
    assert.equal(parseArguments([command]).kind, "error", `„${command}" ohne Adresse hätte scheitern müssen`);
    assert.equal(
      parseArguments([command, "kein-at-zeichen"]).kind,
      "error",
      `„${command}" mit Unsinn hätte scheitern müssen`
    );
  }
});

test("create-admin nimmt einen Namen entgegen und hat sonst einen Vorgabenamen", () => {
  assert.deepEqual(parseArguments(["create-admin", "rescue@example.test"]), {
    kind: "command",
    command: "create-admin",
    email: "rescue@example.test",
    // Ein Pflichtfeld wäre hier eine Frage an jemanden, der gerade ausgesperrt ist.
    name: "rescue"
  });
  assert.deepEqual(parseArguments(["create-admin", "rescue@example.test", "--name", "Zweiter Admin"]), {
    kind: "command",
    command: "create-admin",
    email: "rescue@example.test",
    name: "Zweiter Admin"
  });
});

test("eine Angabe hinter --name gilt nicht als Befehl", () => {
  // Der Wert hinter --name landet in derselben Liste wie die
  // Positionsangaben. Gelesen werden dort nur die ersten beiden Stellen —
  // ohne diese Zusage wäre ein Name, der zufällig ein Befehl ist, ein
  // Fallstrick, den niemand vermutet.
  const parsed = parseArguments(["create-admin", "rescue@example.test", "--name", "list"]);
  assert.deepEqual(parsed, {
    kind: "command",
    command: "create-admin",
    email: "rescue@example.test",
    name: "list"
  });
});
