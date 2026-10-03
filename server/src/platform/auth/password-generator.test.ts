import test from "node:test";
import assert from "node:assert/strict";

import { createPassword, PASSWORD_ALPHABET, PASSWORD_LENGTH } from "./password-generator.js";

test("das erzeugte Passwort hat die zugesagte Form", () => {
  const password = createPassword();
  assert.equal(password.length, PASSWORD_LENGTH);
  assert.match(password, /^[A-Za-z0-9]{5}(-[A-Za-z0-9]{5}){4}$/);
});

test("das Alphabet lässt die verwechselbaren Zeichen aus", () => {
  // Das Passwort wird abgetippt, oft von einem Bildschirm neben der Tastatur.
  // 0/O und 1/l/I sind dort die Stellen, an denen ein Betreiber sich verliest
  // und den Fehler dem System zuschreibt.
  for (const character of ["0", "O", "1", "l", "I"]) {
    assert.equal(PASSWORD_ALPHABET.includes(character), false, `„${character}" gehört nicht ins Alphabet`);
  }
});

test("zwei Aufrufe liefern verschiedene Passwörter", () => {
  // Ein Erzeuger, der zweimal dasselbe liefert, wäre der stillste denkbare
  // Fehler: das Werkzeug meldet Erfolg, und das Passwort ist bekannt.
  const values = new Set(Array.from({ length: 50 }, () => createPassword()));
  assert.equal(values.size, 50);
});

test("jedes Zeichen stammt aus dem Alphabet", () => {
  for (const character of createPassword().replaceAll("-", "")) {
    assert.ok(PASSWORD_ALPHABET.includes(character), `„${character}" steht nicht im Alphabet`);
  }
});
