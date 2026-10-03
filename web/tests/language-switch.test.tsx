// Der Sprachumschalter am laufenden Baum — der erste Fall des DOM-Testlaufs
// (#78, Lücke 1; gemessen in #71).
//
// ⚠️ Die Reihenfolge der Importe ist BEDEUTUNG und keine Formatierung: der
// DOM muss stehen, bevor React geladen wird (siehe `dom-harness.tsx`). Wer
// hier alphabetisch sortiert, bekommt „document is not defined".
import { renderInDom, settle } from "./dom-harness.js";

// ⚠️ React steht hier NAMENTLICH, obwohl keine Zeile es aufruft. `tsx`
// übersetzt das JSX dieser Datei mit dem alten Laufzeitmodell
// (`React.createElement`) — die `jsx`-Einstellung aus `tests/tsconfig.json`
// erreicht es nicht, gemessen am 2026-09-06 über beide Wege (Programm-Datei
// und `TSX_TSCONFIG_PATH`). Ohne diesen Import bricht der Test mit „React is
// not defined". Kein `eslint-disable` nötig: der Bezeichner wird benutzt,
// nur nicht von Hand.
import React from "react";

import assert from "node:assert/strict";
import test from "node:test";

import { AppLanguageProvider } from "../src/app/i18n/AppLanguageProvider.js";
import { useLanguage } from "../src/platform/i18n/LanguageProvider.js";

// Was `LanguageBridge.change` tut, ist von außen nur an zwei Stellen zu sehen:
// an der Sprache, die die Oberfläche zeigt, und am `lang` des Dokuments. Diese
// Sonde zeigt die eine und klickt.
//
// ⚠️ Sie schaltet auf die jeweils ANDERE Sprache und nicht auf eine feste.
// Die Ausgangssprache kommt aus `browserLanguage`, also aus dem, was die
// Fensterwelt des Testlaufs meldet — ein fest verdrahtetes Ziel machte den
// Test davon abhängig und bräche, sobald happy-dom eine andere Sprache
// meldet.
function LanguageProbe() {
  const { language, change } = useLanguage();
  return (
    <button type="button" data-testid="switch" onClick={() => change(language === "de" ? "en" : "de")}>
      {language}
    </button>
  );
}

// Die Antwort des Servers, ohne Server. `PUT /session/language` ist die
// einzige Anfrage, die dieser Baum stellt — mehr als eine wäre selbst ein
// Befund, deshalb zählt der Test sie.
function stubFetch(status: number): { calls: string[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    calls.push(String(input));
    return Promise.resolve(
      status === 204
        ? new Response(null, { status })
        : new Response(JSON.stringify({ error: "unauthenticated" }), {
            status,
            headers: { "content-type": "application/json" }
          })
    );
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

async function clickSwitch(container: HTMLElement): Promise<void> {
  const button = container.querySelector("[data-testid=switch]");
  assert.ok(button instanceof HTMLButtonElement, "der Umschalter steht im Baum");
  button.click();
  await settle();
}

function switchLabel(container: HTMLElement): string {
  return container.querySelector("[data-testid=switch]")?.textContent ?? "";
}

function otherLanguage(language: string): string {
  return language === "de" ? "en" : "de";
}

test("bei 4xx stellt der Umschalter die Sprache zurück", async () => {
  // Der eigentliche Fall aus #71: ohne die Rückstellung zeigte der Bildschirm
  // eine Sprache, die im Konto nicht steht — beim nächsten Laden wäre sie
  // wieder weg, ohne dass jemand erführe, warum. Gegenprobe beim Bau: nimmt
  // man `setLanguageState(previous)` aus `LanguageProvider.tsx` heraus, wird
  // genau dieser Test rot.
  const server = stubFetch(401);
  const { container, unmount } = await renderInDom(
    <AppLanguageProvider>
      <LanguageProbe />
    </AppLanguageProvider>
  );

  try {
    const before = switchLabel(container);

    await clickSwitch(container);

    assert.equal(server.calls.length, 1, "es geht genau eine Anfrage hinaus");
    assert.match(server.calls[0] ?? "", /\/api\/session\/language$/);
    assert.equal(switchLabel(container), before, "die Oberfläche steht wieder auf der alten Sprache");
    assert.equal(document.documentElement.lang, before, "und das `lang` des Dokuments mit ihr");
  } finally {
    server.restore();
    await unmount();
  }
});

test("bei 204 bleibt die neue Sprache stehen", async () => {
  // Die Gegenprobe. Ohne sie wäre der Test oben auch mit einem Umschalter
  // grün, der überhaupt nichts umstellt.
  const server = stubFetch(204);
  const { container, unmount } = await renderInDom(
    <AppLanguageProvider>
      <LanguageProbe />
    </AppLanguageProvider>
  );

  try {
    const chosen = otherLanguage(switchLabel(container));

    await clickSwitch(container);

    assert.equal(server.calls.length, 1);
    assert.equal(switchLabel(container), chosen, "die gewählte Sprache steht");
    assert.equal(document.documentElement.lang, chosen, "und das `lang` des Dokuments mit ihr");
  } finally {
    server.restore();
    await unmount();
  }
});
