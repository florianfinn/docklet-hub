import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { contrastRatio, hexToLinearSrgb, oklchToLinearSrgb, parseOklch } from "./ansi-contrast.mjs";
import { stripCssComments } from "./strip-comments.mjs";

// Die Syntaxfarben stehen unabhängig von der Host-Palette. Dieser Wächter
// liest die tatsächlich gesetzten Werte und prüft ihre Lesbarkeit auf der
// Karte des dunklen und des hellen Schemas.
const syntax = stripCssComments(readFileSync(new URL("../src/platform/editor/syntax.css", import.meta.url), "utf8"));
const tokens = stripCssComments(readFileSync(new URL("../src/platform/theme/tokens.css", import.meta.url), "utf8"));

function block(source, selector) {
  const start = source.indexOf(`${selector} {`);
  assert.ok(start >= 0, `${selector} fehlt`);
  const open = source.indexOf("{", start);
  return source.slice(open + 1, source.indexOf("}", open));
}

function colors(source) {
  return new Map([...source.matchAll(/--editor-syntax-([a-z-]+):\s*(#[0-9a-f]{6})\s*;/g)].map((match) => [match[1], match[2]]));
}

for (const [scheme, selector] of [["dunkel", ":root"], ["hell", '[data-scheme="light"]']]) {
  test(`Compose-Syntaxfarben sind im Schema ${scheme} auf der Karte lesbar`, () => {
    const codeColors = colors(block(syntax, selector));
    assert.equal(codeColors.size, 6);
    const cardText = /--card:\s*(oklch\([^;]+\))\s*;/.exec(block(tokens, selector));
    assert.ok(cardText, `Kartenfarbe für ${scheme} fehlt`);
    const card = parseOklch(cardText[1]);
    assert.ok(card);
    for (const [kind, value] of codeColors) {
      const foreground = hexToLinearSrgb(value);
      assert.ok(foreground);
      assert.ok(contrastRatio(foreground, oklchToLinearSrgb(...card)) >= 4.5, `${kind} auf ${scheme} zu schwach`);
    }
  });
}
