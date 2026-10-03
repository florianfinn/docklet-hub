// ⚠️ Die Reihenfolge der Importe ist BEDEUTUNG und keine Formatierung: der DOM
// muss stehen, bevor React geladen wird (siehe `dom-harness.tsx`). Der
// Prüfstand daneben lädt ihn als erstes und wird deshalb VOR allem anderen
// eingebunden; wer hier alphabetisch sortiert, bekommt „document is not
// defined".
import {
  HOST_ID,
  all,
  asked,
  at,
  entry,
  listing,
  mountAt,
  saysEither,
  shownText,
  stubHub
} from "./files-view-harness.js";
import { settle } from "./dom-harness.js";

import assert from "node:assert/strict";
import test from "node:test";

import { entryChangedAt } from "../src/features/files/api.js";
import { de, en } from "../src/app/i18n/messages.js";

// WAS DIESE DATEI PRÜFT UND WARUM GERADE DAS
//
// Die Datei-Fläche (#5, Paket B5, Etappe E5a) hat sechs Fehler, die gültiges
// JSX, gültiges TypeScript und eine grüne Prüfkette sind. Weder `tsc` noch
// `vite build` noch ein Wächter über Dateitexte sieht einen davon:
//
//   1. DIE FREIGABEWAHL FEHLT. Eine Fassung, die auf die `409` mit einem
//      allgemeinen Fehlersatz antwortet, ist syntaktisch tadellos — und der
//      Betreiber sieht „konnte nicht geholt werden" statt der Wahl, die er
//      treffen soll. Die `409` mit `share-unset` ist der NORMALFALL vor der
//      ersten Wahl und keine Störung.
//   2. `truncated` VERSCHWIEGEN. Eine Liste, die an der Obergrenze des Arms
//      endet, sieht vollständig aus. Nichts an ihr fällt auf — deshalb prüft
//      Fall 3 unten den Hinweis und nicht die Liste.
//   3. `changedAt` ALS MILLISEKUNDEN GELESEN. Der gefährlichste der sechs:
//      `new Date(<Sekunden>)` wirft nicht, sondern liefert einen Zeitpunkt
//      kurz nach 1970. Jede Datei trüge ein falsches Datum, und keine
//      Prüfkette dieses Repos würde davon rot. Der Agent schreibt
//      `Math.floor(stat.mtimeMs / 1000)` (`agent/src/webftp.ts`).
//   4. EIN `symlink` ALS DAS, WORAUF ER ZEIGT. Der Agent löst Symlinks
//      ausdrücklich NICHT auf. Ein Verweis, der als Verzeichnis dasteht,
//      verspricht ein Hineingehen, das der Arm verweigert; einer, der als
//      Datei dasteht, verspricht einen Inhalt, den es hier nicht gibt.
//   5. `diagnostics: null` ALS „NEIN" GELESEN. „Keine Auskunft" ist nicht
//      dasselbe wie „nicht erlaubt" — eine Fläche, die daraus ein „nein"
//      macht, behauptet etwas über eine Prüfung, die nie stattgefunden hat.
//   6. EIN CONTAINER OHNE KANDIDATEN MIT EINER LEEREN LISTE. Die leere Antwort
//      ist vollständig und richtig; eine leere Tabelle sähe aus wie eine
//      Störung oder wie ein halbes Laden.
//
// ⚠️ KEIN `assert.equal(<DOM-Knoten>, null)` IN DIESER DATEI, und das ist
// gemessen: im grünen Fall geht es durch, im ROTEN reicht `assert` den
// gefundenen Knoten an seine Fehlerausgabe — und unter happy-dom hängt daran
// der halbe Fensterbaum mit Zyklen. Gemessen viermal am 2026-09-07: Läufe von
// 71, 82 und 840 Sekunden, zuletzt SIGKILL, ohne den Fall überhaupt zu nennen.
// Verglichen wird deshalb ein `boolean` (`assert.ok(x === null, "…")`).

// ---------------------------------------------------------------------------
// 1. Ohne gewählte Freigabe steht die WAHL da und kein Fehlersatz
// ---------------------------------------------------------------------------

test("ohne gewählte Freigabe erscheint die Freigabewahl mit ihren Kandidaten", async () => {
  const server = stubHub({
    // Keine Liste zu keinem Pfad: die Attrappe antwortet damit wie der Server
    // ohne gewählte Freigabe — `409` mit `share-unset`.
    candidates: [
      { relative: "daten", destination: "/var/lib/app", writable: true },
      { relative: "conf", destination: "/etc/app", writable: false }
    ]
  });
  const mounted = await mountAt(`/container/${HOST_ID}/demo/files`);

  try {
    assert.ok(at("files-share-chooser") !== null, "die Freigabewahl steht nicht da");
    assert.equal(all("files-share-candidate").length, 2, "es stehen nicht beide Kandidaten da");
    assert.ok(shownText().includes("daten"), "der Pfad des ersten Kandidaten fehlt");

    // ⚠️ UND KEIN FEHLERSATZ DANEBEN. Die `409` ist der Normalfall vor der
    // ersten Wahl; ein roter Satz schickte den Betreiber auf die Suche nach
    // einer Störung, die es nicht gibt.
    assert.ok(at("files-error") === null, "neben der Wahl steht ein Fehlersatz");
    assert.ok(
      !saysEither(de.fileErrorUnknown, en.fileErrorUnknown),
      "der allgemeine Fehlersatz steht da, obwohl nur keine Freigabe gewählt ist"
    );
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

// ---------------------------------------------------------------------------
// 2. Ein Container OHNE Kandidaten bekommt eine Erklärung, keine leere Liste
// ---------------------------------------------------------------------------

test("ein Container ohne Bind-Mounts bekommt eine Erklärung und keine leere Liste", async () => {
  const server = stubHub({ candidates: [] });
  const mounted = await mountAt(`/container/${HOST_ID}/demo/files`);

  try {
    assert.ok(at("files-share-none") !== null, "die Erklärung für „keine Kandidaten“ fehlt");
    assert.ok(at("files-share-chooser") === null, "es steht eine leere Wahl da");
    assert.ok(
      saysEither(de.filesShareNoneBody, en.filesShareNoneBody),
      "der Satz, warum es hier nichts zu wählen gibt, fehlt"
    );
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

// ---------------------------------------------------------------------------
// 3. Mit gewählter Freigabe steht die LISTE da
// ---------------------------------------------------------------------------

test("mit gewählter Freigabe erscheint die Dateiliste mit ihren Einträgen", async () => {
  const server = stubHub({
    listings: {
      "": listing({
        entries: [entry({ name: "app.log" }), entry({ name: "backup", kind: "directory" })]
      })
    }
  });
  const mounted = await mountAt(`/container/${HOST_ID}/demo/files`);

  try {
    assert.ok(at("files-list") !== null, "die Dateiliste steht nicht da");
    assert.ok(at("files-share-chooser") === null, "die Freigabewahl steht trotz gewählter Freigabe da");
    assert.equal(all("files-entry").length, 2, "es stehen nicht beide Einträge da");
    assert.ok(shownText().includes("app.log"), "der Name der Datei fehlt");

    // Ein Verzeichnis führt weiter, eine Datei nicht — und der Verweis trägt
    // den Pfad in der ADRESSE, damit ein Neuladen dort landet.
    const links = all("files-entry-link");
    assert.equal(links.length, 1, "nicht genau das Verzeichnis führt weiter");
    assert.ok(
      (links[0].getAttribute("href") ?? "").includes("path=backup"),
      `der Verweis trägt den Pfad nicht in der Adresse: ${links[0].getAttribute("href") ?? "—"}`
    );
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

// ---------------------------------------------------------------------------
// 4. `truncated` wird nicht verschwiegen
// ---------------------------------------------------------------------------
//
// FÄNGT: eine Fassung, die das Feld wegwirft. Sie zeigt eine Liste, die
// vollständig AUSSIEHT — jeder Test, der nur Einträge zählt, bliebe grün.

test("eine gekürzte Liste sagt, dass sie gekürzt ist", async () => {
  const server = stubHub({
    listings: { "": listing({ entries: [entry({ name: "a" })], truncated: true }) }
  });
  const mounted = await mountAt(`/container/${HOST_ID}/demo/files`);

  try {
    assert.ok(at("files-truncated") !== null, "der Hinweis auf die gekürzte Liste fehlt");
    assert.ok(saysEither(de.filesTruncated, en.filesTruncated), "der Satz zur Kürzung fehlt");
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

test("eine vollständige Liste behauptet keine Kürzung", async () => {
  // Die Gegenprobe: ohne sie wäre ein fest eingebauter Hinweis grün, und die
  // Fläche behauptete an jedem Verzeichnis, es sei gekürzt.
  const server = stubHub({ listings: { "": listing({ entries: [entry({ name: "a" })] }) } });
  const mounted = await mountAt(`/container/${HOST_ID}/demo/files`);

  try {
    assert.ok(at("files-truncated") === null, "die vollständige Liste behauptet eine Kürzung");
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

// ---------------------------------------------------------------------------
// 5. Ein `symlink` steht als Verweis da — nicht als das, worauf er zeigt
// ---------------------------------------------------------------------------

test("ein Verweis wird als Verweis gezeigt und führt weder hinein noch zum Download", async () => {
  const server = stubHub({
    listings: {
      "": listing({
        entries: [
          entry({ name: "irgendwohin", kind: "symlink" }),
          entry({ name: "echt.txt" }),
          entry({ name: "unterordner", kind: "directory" })
        ]
      })
    }
  });
  const mounted = await mountAt(`/container/${HOST_ID}/demo/files`);

  try {
    const kinds = all("files-entry-kind").map((node) => node.textContent ?? "");
    assert.ok(
      kinds.includes(de.fileKindSymlink) || kinds.includes(en.fileKindSymlink),
      `der Verweis steht nicht als Verweis da: ${kinds.join(", ")}`
    );

    // ⚠️ UND ER FÜHRT NICHT WEITER. Der Agent löst Symlinks nicht auf; ein
    // Verweis, der wie ein Verzeichnis anklickbar wäre, verspräche ein
    // Hineingehen, das der Arm verweigert. Geprüft am HREF und nicht am Text:
    // ein Test, der nur die Beschriftung liest, bliebe grün.
    const linked = all("files-entry-link").map((node) => node.textContent ?? "");
    assert.deepEqual(linked, ["unterordner"], "es führt etwas anderes als das Verzeichnis weiter");

    // ⚠️ UND ER IST KEIN DOWNLOAD. Ein Download davon wäre der Inhalt, den es
    // hier nicht gibt.
    const downloads = all("files-entry-download").map((node) => node.getAttribute("href") ?? "");
    assert.equal(downloads.length, 1, "es steht nicht genau ein Download da");
    assert.ok(
      downloads[0].includes("path=echt.txt"),
      `der Download hängt am falschen Eintrag: ${downloads[0]}`
    );
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

// ---------------------------------------------------------------------------
// 6. `changedAt` wird als SEKUNDEN gelesen
// ---------------------------------------------------------------------------
//
// FÄNGT: `new Date(entry.changedAt)` statt `* 1000`. Diese Fassung wirft
// nicht, sie liefert 1970 — und keine andere Prüfung dieses Repos wird davon
// rot. Der Fehler stand in diesem Paket schon einmal in drei Dateien.

test("die Änderungszeit wird als Sekunden gelesen und nicht als Millisekunden", async () => {
  const server = stubHub({
    listings: { "": listing({ entries: [entry({ name: "a.txt", changedAt: 1_777_982_400 })] }) }
  });
  const mounted = await mountAt(`/container/${HOST_ID}/demo/files`);

  try {
    const cell = at("files-entry-changed");
    assert.ok(cell !== null, "die Spalte mit der Änderungszeit fehlt");
    const text = cell === null ? "" : (cell.textContent ?? "");

    assert.ok(
      text.includes("2026"),
      `die Änderungszeit steht nicht im Jahr 2026, sondern als „${text}“ — als Millisekunden gelesen ` +
        "ergäbe 1777982400 den 21. Januar 1970."
    );
    assert.ok(!text.includes("1970"), `die Änderungszeit steht im Jahr 1970: „${text}“`);
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

test("entryChangedAt rechnet Sekunden in Millisekunden um", () => {
  // Dieselbe Zusage ohne DOM — sie sagt, WO die Umrechnung steht, und macht
  // aus einem roten Fall oben eine Fundstelle statt einer Suche.
  assert.equal(
    entryChangedAt(entry({ name: "a", changedAt: 1_777_982_400 })).getTime(),
    1_777_982_400_000,
    "entryChangedAt multipliziert nicht mit 1000"
  );
});

// ---------------------------------------------------------------------------
// 7. `diagnostics: null` heißt „keine Auskunft" und nicht „nein"
// ---------------------------------------------------------------------------

test("ohne Diagnose steht „keine Auskunft“ da und nicht „nicht erlaubt“", async () => {
  const server = stubHub({
    listings: { "": listing({ entries: [entry({ name: "a" })], diagnostics: null }) }
  });
  const mounted = await mountAt(`/container/${HOST_ID}/demo/files`);

  try {
    assert.ok(at("files-diagnostics-none") !== null, "der Satz für die fehlende Auskunft fehlt");
    assert.ok(at("files-diagnostics") === null, "es steht eine Diagnose da, die es nicht gibt");
    assert.ok(
      !saysEither(de.filesDiagnosticsNotReadable, en.filesDiagnosticsNotReadable),
      "aus „keine Auskunft“ ist „nicht lesbar“ geworden"
    );
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

test("die Diagnose zeigt lesbar, beschreibbar und im Container schreibbar getrennt", async () => {
  // ⚠️ `uploadable` HÄNGT NICHT AN `deletable`: die beiden anderen sind die
  // Rechte des Agenten am Host, hochgeladen wird über den Daemon. Diese
  // Antwort stellt beide gegeneinander — eine Fläche, die aus dem einen auf
  // das andere schlösse, wäre hier rot.
  const server = stubHub({
    listings: {
      "": listing({
        entries: [entry({ name: "a" })],
        diagnostics: { readable: true, deletable: true, uid: 1000, gid: 1000, uploadable: false }
      })
    }
  });
  const mounted = await mountAt(`/container/${HOST_ID}/demo/files`);

  try {
    assert.ok(at("files-diagnostics") !== null, "die Diagnose fehlt");
    assert.ok(
      saysEither(de.filesDiagnosticsDeletable, en.filesDiagnosticsDeletable),
      "„beschreibbar“ fehlt, obwohl deletable gilt"
    );
    assert.ok(
      saysEither(de.filesDiagnosticsNotUploadable, en.filesDiagnosticsNotUploadable),
      "aus deletable ist ein „im Container schreibbar“ geworden, das nicht gilt"
    );
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

// ---------------------------------------------------------------------------
// 8. Der Pfad steht in der ADRESSE und übersteht ein Neuladen
// ---------------------------------------------------------------------------
//
// FÄNGT: den Pfad in einem `useState`. Eine solche Fassung besteht jeden Test,
// der KLICKT — der Klick setzt ja den Zustand. Rot wird sie erst hier, wo
// unter der Adresse eines Unterverzeichnisses FRISCH eingehängt wird.

test("die Adresse mit ?path zeigt nach einem Neuladen dieses Verzeichnis", async () => {
  const server = stubHub({
    listings: {
      "": listing({ entries: [entry({ name: "unten", kind: "directory" })] }),
      unten: listing({ path: "unten", entries: [entry({ name: "tief.txt" })] })
    }
  });
  const mounted = await mountAt(`/container/${HOST_ID}/demo/files?path=unten`);

  try {
    assert.ok(shownText().includes("tief.txt"), "das Unterverzeichnis steht nicht da");
    assert.ok(at("files-up") !== null, "der Weg nach oben fehlt");

    const asked = server.calls.filter((call) => call.url.includes("/files"));
    assert.ok(
      asked.some((call) => call.url.includes("path=unten")),
      `die Anfrage ging nicht an das Unterverzeichnis: ${asked.map((call) => call.url).join(", ")}`
    );
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

test("in der Wurzel der Freigabe gibt es keinen Weg nach oben", async () => {
  const server = stubHub({ listings: { "": listing({ entries: [entry({ name: "a" })] }) } });
  const mounted = await mountAt(`/container/${HOST_ID}/demo/files`);

  try {
    assert.ok(at("files-up") === null, "in der Wurzel steht ein Weg nach oben, der ins Nichts führt");
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

// ===========================================================================
// Nachtrag zu E5b: die Freigabe wird GEFRAGT und nicht aus einem Fehler
// erschlossen
// ===========================================================================
//
//  11. DER ANFANGSZUSTAND HÄNGT AN EINEM FEHLERCODE. Bis zum Nachtrag erkannte
//      die Fläche „keine Freigabe gewählt" daran, dass `GET …/files` mit
//      `409 share-unset` SCHEITERTE. Auf dem Bild ist das nicht zu
//      unterscheiden: beide Bauarten zeigen dieselbe Wahl. Brüchig ist es
//      trotzdem, und zwar gemessen — derselbe Statuscode trägt auf dieser
//      Fläche DREI Bedeutungen (`share-unset`, `share-unknown`,
//      `agent-conflict`), und `fileErrorKey` bildete lange jeden davon auf
//      denselben, falschen Satz ab. Der Fall unten prüft deshalb nicht das
//      Bild, sondern die STATUSCODES der abgesendeten Anfragen.

test("der Reiter zeigt die Freigabewahl, ohne dass eine Anfrage gescheitert ist", async () => {
  const server = stubHub({
    // ⚠️ AUSDRÜCKLICH `null` und nicht bloß „keine Listen": geprüft wird, dass
    // die Fläche die Auskunft HOLT und nicht aus einem Scheitern erschließt.
    share: null,
    candidates: [
      { relative: "daten", destination: "/var/lib/app", writable: true },
      { relative: "conf", destination: "/etc/app", writable: false }
    ]
  });
  const mounted = await mountAt(`/container/${HOST_ID}/demo/files`);

  try {
    assert.ok(at("files-share-chooser") !== null, "die Freigabewahl steht nicht da");
    assert.equal(all("files-share-candidate").length, 2, "es stehen nicht beide Kandidaten da");

    // ⚠️ DIE EIGENTLICHE ZUSAGE. Nimmt jemand die Verdrahtung heraus, holt die
    // Fläche zuerst die Liste, die mit `409` antwortet — und dieser Fall wird
    // rot, während das Bild unverändert aussieht.
    const failed = server.calls.filter((call) => call.status >= 400);
    assert.deepEqual(
      failed.map((call) => `${call.method} ${call.url} → ${String(call.status)}`),
      [],
      "eine Anfrage ist gescheitert, obwohl die Freigabe direkt gefragt werden kann"
    );

    // Und die Frage IST gestellt worden — sonst wäre der Fall auch grün, wenn
    // die Fläche gar nichts holte.
    assert.equal(
      asked(server, "GET", "/share").filter((call) => !call.url.includes("/share-candidates")).length,
      1,
      "die gewählte Freigabe wurde nicht gelesen"
    );
    assert.equal(
      asked(server, "GET", "/files").length,
      0,
      "die Liste wurde geholt, obwohl gar keine Freigabe gewählt ist"
    );
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

test("verschwindet die Freigabe zwischen den beiden Anfragen, steht die Wahl trotzdem da", async () => {
  // ⚠️ DER RÜCKFALL, UND ER IST KEINE DOPPELUNG. Zwischen der Frage nach der
  // Freigabe und dem Holen der Liste liegt Zeit: sie kann in einem zweiten
  // Reiter zurückgenommen werden, oder ein Registry-Abgleich lässt sie fallen.
  // Die Attrappe stellt genau das nach — `GET …/share` sagt „gesetzt", die
  // Liste antwortet `409 share-unset`.
  const server = stubHub({
    share: { containerName: "demo", path: "daten" },
    listings: {},
    candidates: [{ relative: "daten", destination: "/var/lib/app", writable: true }]
  });
  const mounted = await mountAt(`/container/${HOST_ID}/demo/files`);
  // ⚠️ ONE TICK MORE THAN `mountAt` GIVES, and it is the third request. Since
  // #263 the candidates are a query that is switched on by the failed listing;
  // it starts after the render that saw the `409`, not in the same promise
  // chain as before. Measured on 2026-10-02: the same three requests
  // (share 200, files 409, share-candidates 200), the choice one tick later.
  await settle();

  try {
    assert.ok(at("files-share-chooser") !== null, "nach dem Wegfall der Freigabe steht die Wahl nicht da");
    assert.ok(
      at("files-error") === null,
      "statt der Wahl steht ein Fehlersatz da — der Rückfall über share-unset fehlt"
    );
    assert.equal(asked(server, "GET", "/files").length, 1, "die Liste wurde nicht geholt");
  } finally {
    await mounted.unmount();
    server.restore();
  }
});
