// Die ANZEIGE der eigenen Marken und die Einrückung je Stack (D7b/C1, #62).
//
// ⚠️ Die Reihenfolge der Importe ist BEDEUTUNG und keine Formatierung: der DOM
// muss stehen, bevor React geladen wird (siehe `dom-harness.tsx`). Wer hier
// alphabetisch sortiert, bekommt „document is not defined".
import { renderInDom } from "./dom-harness.js";

// ⚠️ React steht hier NAMENTLICH, obwohl keine Zeile es aufruft — `tsx`
// übersetzt das JSX dieser Datei mit dem alten Laufzeitmodell
// (`React.createElement`). Die Begründung samt Messung steht im Kopf von
// `language-switch.test.tsx`.
import React from "react";

import assert from "node:assert/strict";
import test from "node:test";

import { MemoryRouter } from "react-router";

import type { MarkView } from "contract";
import type { OverviewContainer, StackView } from "contract";
import { AppLanguageProvider } from "../src/app/i18n/AppLanguageProvider.js";
import { OVERVIEW_SLOTS } from "../src/app/containers/container-slots.js";
import { StackSection } from "../src/features/containers/StackSection.js";
import { MarkList } from "../src/features/marks/MarkList.js";
import { StackRow } from "../src/features/containers/StackRow.js";

// WAS DIESE DATEI PRÜFT UND WARUM GERADE DAS
//
// Drei Fehler dieser Fläche sind gültiges JSX, gültiges HTML und gültiges CSS.
// Weder `tsc`, noch `vite build`, noch einer der Wächter über Dateitexte sieht
// sie — geprüft wird deshalb am gerenderten Baum:
//
//   1. DER GEERBTE MARKEN-FEHLER. Gibt man der Container-Zeile die Marken
//      ihres STACKS statt ihrer eigenen, sieht die Fläche voller und damit
//      besser aus — und die Zuordnung am Stack ist nicht mehr zu erkennen,
//      weil an jeder Zeile dasselbe steht (docs/design/hub-color-and-structure.md
//      §3: eine Marke hängt an einem Stack ODER an einem einzelnen Container).
//      ⚠️ Ein Test, der nur „drei Marken sind da" prüft, fängt genau das NICHT.
//      Deshalb steht unten eine Zählung je Namen über den ganzen Teilbaum.
//   2. DER DECKEL. Zwei Marken je Zeile, danach ein Zähler; auf der Seite eines
//      Stacks alle. Fällt der Deckel weg, wächst die Zeile still über ihre
//      Breite — auf einem breiten Schirm mit zwei Marken fällt das nie auf.
//   3. `data-indent` UND DIE KLASSE AUF VERSCHIEDENEN ELEMENTEN. Eine
//      CSS-Variable löst dort auf, wo sie DEKLARIERT ist (§8). Zieht jemand das
//      Attribut auf einen Vorfahren der Klasse, bleibt die Seite fehlerfrei und
//      die Stellschraube wirkungslos. Der Test prüft deshalb ausdrücklich, dass
//      BEIDES auf DEMSELBEN Element steht, und nicht nur, dass es irgendwo
//      vorkommt.
//
// NICHT geprüft: dass der Server diese Felder wirklich liefert. Es läuft in
// dieser Umgebung weder Postgres noch Docker. Die Stubs unten bilden den Typ
// aus `server/src/domain/containers/stacks.ts` nach — dass der Server ihn hält, prüft
// der `server`-Workspace.
//
// NICHT geprüft: die tatsächlichen Pixel der Einrückung. Ein DOM ohne
// Stylesheet rechnet kein `padding-left`; die zwei Stufen sind am gebauten
// Stylesheet gemessen und im Kopf von `StackRow.tsx` festgehalten.

function markOf(id: string, name: string): MarkView {
  // ⚠️ Der Typ wird hier NICHT nachgebaut, sondern erfüllt: `MarkView` kommt
  // aus `server/src/features/marks/types.ts` über `client.ts`. Fehlte ein Feld oder
  // stünde ein Ton darin, den `HUE_TONES` nicht kennt, wäre das ein Typfehler
  // und keine grüne Attrappe — gemessen: ein erfundenes `hue: "iris"` hat
  // `tsc -p tests` rot gemacht, während der Lauf unter `tsx` grün blieb.
  return { id, name, hue: "violet", style: "fill" };
}

function containerOf(id: string, service: string, marks: MarkView[]): OverviewContainer {
  return {
    id,
    name: `demo-${service}-1`,
    image: "demo:latest",
    status: "Up 2 hours",
    running: true,
    startedAt: null,
    health: null,
    compose: { project: "demo", service },
    stats: null,
    externalManagement: null,
    state: "ok",
    marks,
    system: false
  };
}

function stackOf(options: {
  marks: MarkView[];
  indent: StackView["indent"];
  containers: OverviewContainer[];
}): StackView {
  return {
    project: "demo",
    state: "ok",
    running: options.containers.length,
    marks: options.marks,
    indent: options.indent,
    hidden: false,
    total: options.containers.length,
    system: false,
    containers: options.containers
  };
}

/** Die Namen aller gezeichneten Marken im Teilbaum, in Dokumentreihenfolge. */
function markNames(container: HTMLElement): string[] {
  return [...container.querySelectorAll("[data-mark]")].map((node) => node.textContent?.trim() ?? "");
}

async function mountStackRow(stack: StackView) {
  return renderInDom(
    <AppLanguageProvider>
      <MemoryRouter>
        {/* `open` ist der ANFANGSWERT des Aufklappers. Zugeklappt zeichnet
            Radix den Inhalt gar nicht, und die Container-Zeilen — der
            eigentliche Gegenstand von Prüfung 1 — wären nicht da. */}
        <StackRow hostId="host-1" stack={stack} open={true} slots={OVERVIEW_SLOTS} />
      </MemoryRouter>
    </AppLanguageProvider>
  );
}

test("die Container-Zeile zeigt ihre EIGENEN Marken und nicht die ihres Stacks", async () => {
  const stackMark = markOf("m-stack", "Produktion");
  const own = markOf("m-own", "Datenbank");
  const mounted = await mountStackRow(
    stackOf({
      marks: [stackMark],
      indent: "nested",
      containers: [containerOf("c-1", "web", []), containerOf("c-2", "db", [own])]
    })
  );

  try {
    const names = markNames(mounted.container);

    // ⚠️ DAS IST DIE ZÄHLUNG, DIE DEN GEERBTEN FEHLER FÄNGT. „Produktion"
    // hängt am Stack und darf im ganzen Teilbaum GENAU EINMAL stehen. Erbte
    // die Container-Zeile, stünde der Name dreimal da — einmal am Stack und
    // einmal an jeder der zwei Zeilen —, und eine Prüfung auf „ist da"
    // bliebe grün.
    assert.equal(
      names.filter((name) => name === "Produktion").length,
      1,
      "die Marke des Stacks steht am Stack und an keiner Container-Zeile"
    );

    // Und die eigene Marke des zweiten Containers ist da — sonst bestünde der
    // Test auch dann, wenn die Zeile überhaupt keine Marken zeichnete.
    assert.equal(names.filter((name) => name === "Datenbank").length, 1);

    // Die erste Zeile hat keine eigene Marke und bekommt deshalb auch keine.
    assert.equal(names.length, 2, `unerwartete Marken: ${names.join(", ")}`);
  } finally {
    await mounted.unmount();
  }
});

test("eine Zeile zeigt höchstens zwei Marken und danach den Zähler", async () => {
  const mounted = await mountStackRow(
    stackOf({
      marks: [markOf("m-1", "Produktion"), markOf("m-2", "Datenbank"), markOf("m-3", "Archiv")],
      indent: "nested",
      containers: []
    })
  );

  try {
    assert.deepEqual(markNames(mounted.container), ["Produktion", "Datenbank"]);

    const text = mounted.container.textContent ?? "";
    assert.match(text, /\+1/, "der Zähler über die übrigen Marken fehlt");
    // ⚠️ Der Zähler NENNT die übrige Marke. „+1" allein zwingt zum Suchen, und
    // ein Screenreader liest daraus „plus eins".
    assert.match(text, /Archiv/, "der Zähler nennt die Namen der übrigen Marken nicht");
    // Die dritte Marke steht als Name da, aber nicht als gezeichnete Marke.
    assert.equal(markNames(mounted.container).includes("Archiv"), false);
  } finally {
    await mounted.unmount();
  }
});

test("eine Marke in einer Zeile darf schrumpfen und ist in der Breite gedeckelt", async () => {
  // ⚠️ EIN KLASSENTEST UND KEINE MESSUNG, und das ist hier bewusst: der DOM
  // dieses Laufs hat kein Stylesheet und rechnet keine Breite. Gemessen ist
  // die Wirkung am gebauten Bild (2026-09-06, 375 px Fensterbreite): OHNE
  // `min-w-0` blieb die Marke bei 144 px, während ihr Feld auf 65 px
  // geschrumpft war — sie stand 79 px über dessen rechter Kante und quer über
  // dem Zähler „2/2". Mit `min-w-0`: 65 px und bündig. Die ganze Prüfkette war
  // dabei grün. Diese Zeile hält fest, was am Bild entschieden wurde.
  const mounted = await renderInDom(
    <AppLanguageProvider>
      <MarkList marks={[markOf("m-1", "Produktion")]} limit={2} />
    </AppLanguageProvider>
  );

  try {
    const chip = mounted.container.querySelector("[data-mark]");
    assert.ok(chip);
    assert.ok(chip.classList.contains("min-w-0"), "die Marke kann nicht schrumpfen und läuft aus der Zeile");
    assert.ok(chip.classList.contains("max-w-[9rem]"), "die Marke ist in der Breite nicht gedeckelt");
  } finally {
    await mounted.unmount();
  }
});

test("ohne Deckel stehen alle Marken da, und keine wird gezählt", async () => {
  // Der Fall der Stack-Seite: `limit` bleibt weg.
  const mounted = await renderInDom(
    <AppLanguageProvider>
      <MarkList marks={[markOf("m-1", "Produktion"), markOf("m-2", "Datenbank"), markOf("m-3", "Archiv")]} />
    </AppLanguageProvider>
  );

  try {
    assert.deepEqual(markNames(mounted.container), ["Produktion", "Datenbank", "Archiv"]);
    assert.doesNotMatch(mounted.container.textContent ?? "", /\+/, "auf der Seite wird nichts gezählt");
    // Und ohne Deckel auf der Anzahl auch keiner auf der Breite: ein
    // abgeschnittener Name wäre hier ein Fehler und keine Rücksicht.
    for (const chip of mounted.container.querySelectorAll("[data-mark]")) {
      assert.equal(chip.classList.contains("max-w-[9rem]"), false);
    }
  } finally {
    await mounted.unmount();
  }
});

test("ohne vergebene Marke steht kein leeres Element in der Zeile", async () => {
  const mounted = await renderInDom(
    <AppLanguageProvider>
      <MarkList marks={[]} limit={2} />
    </AppLanguageProvider>
  );

  try {
    // ⚠️ Nicht Kosmetik: das Elternelement arbeitet mit `gap`, und ein leeres
    // Kind risse eine Lücke in jede Zeile ohne Marke — also in fast jede.
    assert.equal(mounted.container.innerHTML, "");
  } finally {
    await mounted.unmount();
  }
});

// Die Einrückung. Beide Stufen, beide Flächen — und jedes Mal die Frage, auf
// welchem Element die zwei Dinge stehen.
for (const indent of ["nested", "flat"] as const) {
  test(`die Übersicht trägt data-indent="${indent}" auf demselben Element wie die Klasse`, async () => {
    const mounted = await mountStackRow(
      stackOf({ marks: [], indent, containers: [containerOf("c-1", "web", [])] })
    );

    try {
      const marked = mounted.container.querySelector(`[data-indent="${indent}"]`);
      assert.ok(marked, `kein Element mit data-indent="${indent}"`);
      // ⚠️ DIESE ZEILE IST DER TEST. Ein `querySelector("[data-indent]")` allein
      // bliebe grün, wenn jemand das Attribut auf einen Vorfahren der Klasse
      // zöge — und die Variable löste dann am falschen Element auf (§8).
      assert.ok(
        marked.classList.contains("pl-stack-indent"),
        `data-indent und pl-stack-indent stehen auf verschiedenen Elementen (Klassen: ${marked.className})`
      );
      // Und die feste Stufe von früher ist weg: `pl-5` neben der Stellschraube
      // wäre ein zweiter Wert, der immer gewinnt.
      assert.equal(marked.classList.contains("pl-5"), false);
    } finally {
      await mounted.unmount();
    }
  });

  test(`der Deepdive trägt data-indent="${indent}" auf demselben Element wie die Klasse`, async () => {
    const mounted = await renderInDom(
      <AppLanguageProvider>
        <MemoryRouter>
          <StackSection
            hostId="host-1"
            stack={stackOf({ marks: [], indent, containers: [containerOf("c-1", "web", [])] })}
            slots={OVERVIEW_SLOTS}
          />
        </MemoryRouter>
      </AppLanguageProvider>
    );

    try {
      const marked = mounted.container.querySelector(`[data-indent="${indent}"]`);
      assert.ok(marked, `kein Element mit data-indent="${indent}"`);
      assert.ok(
        marked.classList.contains("pl-stack-indent"),
        `data-indent und pl-stack-indent stehen auf verschiedenen Elementen (Klassen: ${marked.className})`
      );
      assert.equal(marked.classList.contains("pl-5"), false);
    } finally {
      await mounted.unmount();
    }
  });
}
