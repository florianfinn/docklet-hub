// ⚠️ Die Reihenfolge der Importe ist BEDEUTUNG und keine Formatierung: der DOM
// muss stehen, bevor React geladen wird (siehe `dom-harness.tsx`). Der
// Prüfstand daneben lädt ihn als erstes und wird deshalb VOR allem anderen
// eingebunden; wer hier alphabetisch sortiert, bekommt „document is not
// defined".
import {
  HOST_ID,
  asked,
  at,
  chooseFile,
  click,
  entry,
  fileOfSize,
  listing,
  mountAt,
  saysEither,
  stubHub,
  typeInto
} from "./files-view-harness.js";

import assert from "node:assert/strict";
import test from "node:test";

import { de, en } from "../src/app/i18n/messages.js";

// WAS DIESE DATEI PRÜFT UND WARUM GERADE DAS
//
// Was sich in einem Verzeichnis der Freigabe TUN lässt — Texteditor, Hochladen,
// Ordneroperationen (#5, Paket B5, Etappe E5b). Der Prüfstand (Attrappe des
// Hubs, Einhängen, Gesten) steht in `files-view-harness.tsx`; welches
// Verzeichnis überhaupt gezeigt wird, prüft `files-view.test.tsx`.
//
// Der Schnitt zwischen den beiden Dateien ist die FRAGE und nicht die
// Zeilenzahl — dass jene Datei mit einundzwanzig Fällen die Marke aus
// `source-file-size.test.mjs` riss, war der Anlass und ist nicht der Grund.

// ===========================================================================
// Etappe E5b: Texteditor, Hochladen, Ordneroperationen
// ===========================================================================
//
// VIER WEITERE FEHLER, die gültiges JSX, gültiges TypeScript und eine grüne
// Prüfkette sind:
//
//   7. GESPEICHERT WIRD OHNE DEN GELADENEN HASH — mit einem festen Wert, einem
//      leeren, oder gar keinem. Der Editor sieht dann tadellos aus und
//      überschreibt fremde Änderungen STILL. Das ist der teuerste der Fehler
//      dieser Fläche: er vernichtet die Arbeit eines anderen, und niemand
//      erfährt es.
//   8. DER `409` WIRD ALS ALLGEMEINER FEHLER GEZEIGT. `fileErrorKey` bildet
//      JEDEN `409` auf „unbekannter Freigabepfad" ab; wer den Konflikt nicht
//      vorher abfängt, sagt dem Betreiber einen falschen Satz über eine
//      richtige Lage — und lässt ihn seine Änderung neu tippen.
//   9. DAS HOCHLADEN STEHT OFFEN, OBWOHL `uploadable` FALSCH IST. Der Versuch
//      geht dann hinaus und scheitert beim Arm; die Auskunft, die das
//      verhindert hätte, lag die ganze Zeit in der Antwort.
//  10. DAS LÖSCHEN FRAGT NICHT NACH. Ein Klick daneben, und die Datei ist weg
//      — der Hub hält keine Kopie, der Arm hat keinen Papierkorb.

// ---------------------------------------------------------------------------
// 9. Der Editor lädt und speichert MIT DEM HASH, unter dem geladen wurde
// ---------------------------------------------------------------------------
//
// FÄNGT: Fehler 7. Eine Fassung, die `expectedHash` weglässt oder einen festen
// Wert einsetzt, besteht jeden Test, der nur auf „gespeichert" schaut — der
// Server antwortet ja `200`, solange der Wert zufällig stimmt. Rot wird sie
// erst hier, wo die ABGESENDETE Adresse gegen den GELADENEN Hash gehalten wird.

test("der Editor lädt eine Datei und speichert sie mit dem Hash, unter dem er sie geladen hat", async () => {
  const server = stubHub({
    listings: { "": listing({ entries: [entry({ name: "app.conf" })] }) },
    texts: { "app.conf": { content: "port = 80", hash: "hash-beim-laden" } },
    saves: [{ ok: "hash-danach" }]
  });
  const mounted = await mountAt(`/container/${HOST_ID}/demo/files?edit=app.conf`);

  try {
    assert.ok(at("files-editor") !== null, "der Editor steht nicht da");
    const field = at("files-editor-input");
    assert.ok(field instanceof HTMLTextAreaElement, "das Textfeld des Editors fehlt");
    assert.equal(field.value, "port = 80", "der Editor zeigt nicht den geladenen Inhalt");

    await typeInto(field, "port = 8080");

    const save = at("files-editor-save");
    assert.ok(save !== null, "der Knopf zum Speichern fehlt");
    await click(save);

    const sent = asked(server, "PUT", "/file-text");
    assert.equal(sent.length, 1, `es ging nicht genau ein Speichern hinaus: ${sent.length}`);
    // ⚠️ DIE EIGENTLICHE ZUSAGE. Ohne diesen Hash gäbe es keine Sperre gegen
    // das stille Überschreiben fremder Änderungen.
    assert.ok(
      sent[0].url.includes("expectedHash=hash-beim-laden"),
      `der geladene Hash steht nicht in der Anfrage: ${sent[0].url}`
    );
    assert.equal(sent[0].body, "port = 8080", "der geänderte Text ging nicht als Rumpf hinaus");
    assert.ok(at("files-editor-saved") !== null, "die Quittung „gespeichert“ fehlt");
    assert.ok(at("files-editor-conflict") === null, "es steht ein Konflikt da, obwohl das Speichern glückte");
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

// ---------------------------------------------------------------------------
// 10. Der `409` ist ein KONFLIKT und kein allgemeiner Fehler
// ---------------------------------------------------------------------------
//
// FÄNGT: Fehler 8, den wichtigsten Fall dieser Etappe. Eine Fassung, die den
// `409` an `fileErrorKey` durchreicht, zeigt „Dieser Pfad ist kein Bind-Mount
// dieses Containers" — einen Satz, der mit der Lage nichts zu tun hat — und
// bietet keinen der beiden Auswege an.

test("ein Speicherkonflikt wird als Konflikt gezeigt und nicht als allgemeiner Fehler", async () => {
  const server = stubHub({
    listings: { "": listing({ entries: [entry({ name: "app.conf" })] }) },
    texts: { "app.conf": { content: "port = 80", hash: "hash-beim-laden" } },
    // Erst der Konflikt mit dem JETZIGEN Hash, dann das Speichern dagegen.
    saves: [{ conflict: "hash-von-jemand-anderem" }, { ok: "hash-zuletzt" }]
  });
  const mounted = await mountAt(`/container/${HOST_ID}/demo/files?edit=app.conf`);

  try {
    const field = at("files-editor-input");
    assert.ok(field instanceof HTMLTextAreaElement, "das Textfeld des Editors fehlt");
    await typeInto(field, "port = 8080");

    const save = at("files-editor-save");
    assert.ok(save !== null, "der Knopf zum Speichern fehlt");
    await click(save);

    assert.ok(at("files-editor-conflict") !== null, "der Konflikt wird nicht als Konflikt gezeigt");
    assert.ok(
      saysEither(de.filesEditorConflictTitle, en.filesEditorConflictTitle),
      "der Satz zum Konflikt fehlt"
    );
    // ⚠️ UND KEIN ALLGEMEINER FEHLERSATZ DANEBEN. `fileErrorKey` bildet jeden
    // `409` auf `fileErrorShareUnknown` ab — genau dieser Satz darf hier nicht
    // stehen.
    assert.ok(at("files-editor-error") === null, "neben dem Konflikt steht ein allgemeiner Fehlersatz");
    assert.ok(
      !saysEither(de.fileErrorShareUnknown, en.fileErrorShareUnknown),
      "der Satz für einen unbekannten Freigabepfad steht da, obwohl es ein Speicherkonflikt ist"
    );

    // Der Text des Betreibers steht unverändert im Feld — er muss ihn nicht
    // neu tippen. Das ist der halbe Zweck dieses Falls.
    assert.equal(field.value, "port = 8080", "die eigene Änderung ist beim Konflikt verlorengegangen");

    // Und der zweite Weg führt gegen den JETZIGEN Hash, nicht gegen den alten.
    const overwrite = at("files-editor-conflict-overwrite");
    assert.ok(overwrite !== null, "der Weg „meine Fassung speichern“ fehlt");
    await click(overwrite);

    const sent = asked(server, "PUT", "/file-text");
    assert.equal(sent.length, 2, `es gingen nicht zwei Speicherversuche hinaus: ${sent.length}`);
    assert.ok(
      sent[1].url.includes("expectedHash=hash-von-jemand-anderem"),
      `der zweite Versuch ging nicht gegen den jetzigen Hash: ${sent[1].url}`
    );
    assert.ok(at("files-editor-conflict") === null, "der Konflikt steht noch da, obwohl er gelöst ist");
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

test("der Weg „neu laden“ holt die Datei noch einmal und verwirft die eigene Änderung", async () => {
  const server = stubHub({
    listings: { "": listing({ entries: [entry({ name: "app.conf" })] }) },
    texts: { "app.conf": { content: "port = 80", hash: "hash-beim-laden" } },
    saves: [{ conflict: "hash-von-jemand-anderem" }]
  });
  const mounted = await mountAt(`/container/${HOST_ID}/demo/files?edit=app.conf`);

  try {
    const field = at("files-editor-input");
    assert.ok(field instanceof HTMLTextAreaElement, "das Textfeld des Editors fehlt");
    await typeInto(field, "port = 8080");
    const save = at("files-editor-save");
    assert.ok(save !== null, "der Knopf zum Speichern fehlt");
    await click(save);

    const reload = at("files-editor-conflict-reload");
    assert.ok(reload !== null, "der Weg „neu laden und verwerfen“ fehlt");
    await click(reload);

    const loads = asked(server, "GET", "/file-text");
    assert.equal(loads.length, 2, `die Datei wurde nicht ein zweites Mal geholt: ${loads.length}`);
    const after = at("files-editor-input");
    assert.ok(after instanceof HTMLTextAreaElement, "das Textfeld ist nach dem Neuladen weg");
    assert.equal(after.value, "port = 80", "nach dem Verwerfen steht immer noch die eigene Änderung da");
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

// ---------------------------------------------------------------------------
// 11. Das Hochladen ist gesperrt, wenn `uploadable` falsch ist
// ---------------------------------------------------------------------------
//
// FÄNGT: Fehler 9. Und die Gegenprobe gleich mit: `diagnostics: null` heißt
// „keine Auskunft" und darf NICHT sperren — eine Fassung, die aus beidem
// dasselbe macht, besteht die halbe Prüfung und fällt an der anderen Hälfte.

test("das Hochladen ist gesperrt, wenn der Container das Verzeichnis nur lesbar gemountet hat", async () => {
  const server = stubHub({
    listings: {
      "": listing({
        entries: [entry({ name: "a" })],
        diagnostics: { readable: true, deletable: true, uid: 0, gid: 0, uploadable: false }
      })
    }
  });
  const mounted = await mountAt(`/container/${HOST_ID}/demo/files`);

  try {
    const field = at("files-upload-input");
    const submit = at("files-upload-submit");
    assert.ok(field instanceof HTMLInputElement, "das Feld zum Wählen einer Datei fehlt");
    assert.ok(submit instanceof HTMLButtonElement, "der Knopf zum Hochladen fehlt");
    // ⚠️ Ein `boolean` und kein DOM-Knoten im Vergleich: `assert` reicht im
    // roten Fall seinen Gegenstand an die Fehlerausgabe, und unter happy-dom
    // hängt an einem Knoten der halbe Fensterbaum mit Zyklen.
    assert.equal(field.disabled, true, "die Datei lässt sich wählen, obwohl nicht hochgeladen werden kann");
    assert.equal(submit.disabled, true, "der Knopf zum Hochladen steht offen, obwohl es nicht geht");
    assert.ok(at("files-upload-blocked") !== null, "der Satz, warum hier nichts geht, fehlt");
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

test("ohne Diagnose ist das Hochladen NICHT gesperrt — „keine Auskunft“ ist kein Nein", async () => {
  const server = stubHub({
    listings: { "": listing({ entries: [entry({ name: "a" })], diagnostics: null }) }
  });
  const mounted = await mountAt(`/container/${HOST_ID}/demo/files`);

  try {
    const field = at("files-upload-input");
    assert.ok(field instanceof HTMLInputElement, "das Feld zum Wählen einer Datei fehlt");
    assert.equal(field.disabled, false, "aus „keine Auskunft“ ist eine Sperre geworden");
    assert.ok(at("files-upload-blocked") === null, "der Satz „geht nicht“ steht da, obwohl niemand das geprüft hat");
    assert.ok(at("files-upload-unknown") !== null, "der Satz zur fehlenden Auskunft fehlt");
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

// ---------------------------------------------------------------------------
// 12. Das Löschen fragt nach — und schickt vorher nichts
// ---------------------------------------------------------------------------
//
// FÄNGT: Fehler 10. Die Zusage hat ZWEI Hälften, und die erste ist die
// wichtigere: vor der Bestätigung geht KEINE Anfrage hinaus. Ein Test, der nur
// nachsieht, ob ein Dialog aufgeht, wäre grün gegen eine Fassung, die schon
// beim Öffnen löscht.

test("das Löschen fragt nach und schickt vor der Bestätigung nichts", async () => {
  const server = stubHub({
    listings: { "": listing({ entries: [entry({ name: "alt.log" })] }) }
  });
  const mounted = await mountAt(`/container/${HOST_ID}/demo/files`);

  try {
    const trigger = at("files-delete-alt.log");
    assert.ok(trigger !== null, "der Knopf zum Löschen fehlt");
    await click(trigger);

    assert.ok(
      saysEither(de.filesDeleteTitle, en.filesDeleteTitle),
      "die Rückfrage vor dem Löschen steht nicht da"
    );
    assert.equal(
      asked(server, "POST", "/files").length,
      0,
      "es ging schon vor der Bestätigung eine Anweisung hinaus"
    );

    const confirm = at("files-delete-submit");
    assert.ok(confirm !== null, "der Knopf in der Rückfrage fehlt");
    await click(confirm);

    const sent = asked(server, "POST", "/files");
    assert.equal(sent.length, 1, `nach der Bestätigung ging nicht genau eine Anweisung hinaus: ${sent.length}`);
    // The hub's action, not the arm's — the translation lives in the
    // server.
    assert.deepEqual(
      JSON.parse(sent[0].body ?? "{}"),
      { action: "delete", path: "alt.log" },
      `die Anweisung sah anders aus: ${String(sent[0].body)}`
    );

    // Und danach wird die Liste noch einmal geholt: ohne das stünde die
    // gelöschte Datei weiter da, und der nächste Klick liefe in eine `404`.
    assert.ok(
      asked(server, "GET", "/files").length >= 2,
      "nach dem Löschen wurde die Liste nicht noch einmal geholt"
    );
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

test("Löschen und Umbenennen sind gesperrt, wenn im Verzeichnis nicht geschrieben werden darf", async () => {
  // Sources outside the visible base allow uploads while rename/delete stay blocked.
  const server = stubHub({
    listings: {
      "": listing({
        entries: [entry({ name: "alt.log" })],
        diagnostics: { readable: true, deletable: false, uid: 0, gid: 0, uploadable: true }
      })
    }
  });
  const mounted = await mountAt(`/container/${HOST_ID}/demo/files`);

  try {
    const remove = at("files-delete-alt.log");
    const rename = at("files-rename-alt.log");
    assert.ok(remove instanceof HTMLButtonElement, "der Knopf zum Löschen fehlt");
    assert.ok(rename instanceof HTMLButtonElement, "der Knopf zum Umbenennen fehlt");
    assert.equal(remove.disabled, true, "das Löschen steht offen, obwohl im Verzeichnis nicht geschrieben werden darf");
    assert.equal(rename.disabled, true, "das Umbenennen steht offen, obwohl es am Verzeichnis scheitern wird");
    assert.ok(at("files-write-blocked") !== null, "der Sperrgrund fehlt");
    assert.equal(saysEither(de.filesWriteBlocked, en.filesWriteBlocked), true);
    assert.equal(de.filesWriteBlocked.includes("Basispfad"), true);
    assert.equal(en.filesWriteBlocked.includes("base path"), true);
    const nameInput = at("files-create-directory-name");
    assert.ok(nameInput instanceof HTMLInputElement);
    assert.equal(nameInput.disabled, false);
    await typeInto(nameInput, "new-folder");
    const create = at("files-create-directory-submit");
    assert.ok(create instanceof HTMLButtonElement);
    assert.equal(create.disabled, false);
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

// ===========================================================================
// #136: Größe vor dem Senden, Fortschritt, Abbruch
// ===========================================================================
//
// DREI WEITERE FEHLER, die gültiges JSX, gültiges TypeScript und eine grüne
// Prüfkette sind:
//
//  11. DIE GRÖSSE WIRD ERST VOM SERVER GEPRÜFT. Eine 500-MB-Datei geht
//      vollständig hinaus, und der Betreiber sieht nach Minuten eine `413`.
//      Die Auskunft, die das verhindert, kommt im Umschlag der Liste mit.
//  12. DER FORTSCHRITT FEHLT. „Wird hochgeladen …" steht da, solange es
//      dauert; ob etwas geschieht, ist daran nicht zu erkennen — und genau das
//      ist die Frage bei einer großen Datei über eine schmale Leitung.
//  13. DER ABBRUCH IST NUR EINE ANZEIGE. Eine Fassung, die den Balken
//      zurückstellt und die Bytes weiter hinausschickt, sieht in jedem Test
//      richtig aus, der nur auf das Bild schaut — die Datei landet trotzdem
//      beim Arm.

// ---------------------------------------------------------------------------
// 13. Eine zu große Datei geht gar nicht erst hinaus
// ---------------------------------------------------------------------------
//
// FÄNGT: Fehler 11. Die Zusage hat ZWEI Hälften, und die erste ist die
// wichtigere: es geht KEINE Anfrage hinaus. Ein Fall, der nur nach dem Satz
// sieht, wäre grün gegen eine Fassung, die den Satz zeigt UND sendet.

test("eine Datei über der Grenze des Arms wird vor dem Senden abgewiesen", async () => {
  // Die Grenze kommt vom Server und steht nicht in der Fläche — deshalb gibt
  // dieser Fall sie an, und zwar klein genug, dass eine Datei aus zwölf Bytes
  // sie reißt.
  const server = stubHub({
    listings: { "": listing({ entries: [entry({ name: "a" })] }) },
    maxUploadBytes: 10
  });
  const mounted = await mountAt(`/container/${HOST_ID}/demo/files`);

  try {
    const field = at("files-upload-input");
    assert.ok(field instanceof HTMLInputElement, "das Feld zum Wählen einer Datei fehlt");
    await chooseFile(field, fileOfSize("over-limit.bin", 12));

    assert.ok(at("files-upload-too-large") !== null, "der Satz zur Größe fehlt");
    const submit = at("files-upload-submit");
    assert.ok(submit instanceof HTMLButtonElement, "der Knopf zum Hochladen fehlt");
    assert.equal(submit.disabled, true, "der Knopf steht offen, obwohl die Datei zu groß ist");

    // ⚠️ DIE EIGENTLICHE ZUSAGE: gesendet wird nichts. Der Klick geht trotzdem
    // hinaus — eine Fassung, die nur den Knopf sperrt, aber im Rumpf weiter
    // sendet, wird hier rot.
    await click(submit);
    assert.equal(server.uploads.length, 0, "es ging ein Upload hinaus, obwohl die Datei zu groß ist");
    assert.equal(asked(server, "PUT", "/file").length, 0, "es ging eine Anfrage an die Upload-Route hinaus");
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

test("eine Datei unter der Grenze geht hinaus und zeigt ihren Fortschritt", async () => {
  const server = stubHub({
    listings: { "": listing({ entries: [entry({ name: "a" })] }) },
    maxUploadBytes: 100
  });
  const mounted = await mountAt(`/container/${HOST_ID}/demo/files`);

  try {
    const field = at("files-upload-input");
    assert.ok(field instanceof HTMLInputElement, "das Feld zum Wählen einer Datei fehlt");
    await chooseFile(field, fileOfSize("small.bin", 40));
    assert.ok(at("files-upload-too-large") === null, "der Satz zur Größe steht da, obwohl die Datei passt");

    const submit = at("files-upload-submit");
    assert.ok(submit !== null, "der Knopf zum Hochladen fehlt");
    await click(submit);

    assert.equal(server.uploads.length, 1, `es ging nicht genau ein Upload hinaus: ${server.uploads.length}`);
    const upload = server.uploads[0];
    assert.equal(upload.method, "PUT", `der Upload ging nicht als PUT hinaus: ${upload.method}`);
    assert.ok(upload.url.includes("name=small.bin"), `der Dateiname steht nicht in der Adresse: ${upload.url}`);

    // FÄNGT Fehler 12: der Balken trägt die gesendeten Bytes und nicht nur
    // einen Satz „wird hochgeladen".
    await upload.progress(10, 40);
    const bar = at("files-upload-progress")?.querySelector("[role=\"progressbar\"]") ?? null;
    assert.ok(bar !== null, "der Fortschrittsbalken fehlt");
    assert.equal(bar.getAttribute("aria-valuenow"), "10", "der Balken zeigt nicht die gesendeten Bytes");
    assert.equal(bar.getAttribute("aria-valuemax"), "40", "der Balken kennt die Gesamtgröße nicht");

    await upload.finish("small.bin", 40);
    assert.ok(at("files-upload-progress") === null, "der Balken steht noch da, obwohl der Upload durch ist");
    assert.ok(at("files-upload-error") === null, "ein geglückter Upload steht als Fehler da");
    // Und danach wird die Liste noch einmal geholt — sonst fehlte die soeben
    // hochgeladene Datei darin.
    assert.ok(asked(server, "GET", "/files").length >= 2, "nach dem Upload wurde die Liste nicht neu geholt");
    // ⚠️ DIE QUITTUNG STEHT DA, UND ZWAR BIS ZUM ENDE DES NEUHOLENS. Sie war
    // bis zum Nachtrag zu #136 nicht zu sehen: `onUploaded` erhöhte `round`,
    // die Fläche verschwand für die Dauer der Anfrage hinter „wird geholt",
    // und `FileUpload` kam ohne seinen Zustand zurück. Ein Fall, der nur den
    // Ausgang am Neuholen prüft, bliebe dagegen grün.
    assert.ok(at("files-upload-done") !== null, "die Quittung nach dem Upload fehlt");
    // ⚠️ UND DIE ANGABE ÜBER DAS NEUHOLEN IST DANACH WEG. Ohne diese Zeile
    // dürfte `data-refreshing` fest auf „true" stehen — der Fall, der es
    // während des Holens prüft, wäre gegen eine solche Fassung grün.
    assert.equal(
      at("files-view")?.dataset.refreshing,
      undefined,
      "die Fläche meldet ein laufendes Neuholen, obwohl die Liste längst da ist"
    );
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

// ---------------------------------------------------------------------------
// 14. Der Abbruch schließt die Leitung
// ---------------------------------------------------------------------------
//
// FÄNGT: Fehler 13. Geprüft wird `xhr.abort()` an der Attrappe und nicht der
// Satz auf dem Bild: eine Fassung, die nur den Balken zurückstellt, zeigt
// denselben Satz und schickt die Datei trotzdem zu Ende.

test("ein laufender Upload lässt sich abbrechen, und die Leitung geht dabei wirklich zu", async () => {
  const server = stubHub({ listings: { "": listing({ entries: [entry({ name: "a" })] }) } });
  const mounted = await mountAt(`/container/${HOST_ID}/demo/files`);

  try {
    const field = at("files-upload-input");
    assert.ok(field instanceof HTMLInputElement, "das Feld zum Wählen einer Datei fehlt");
    await chooseFile(field, fileOfSize("slow.bin", 40));

    const submit = at("files-upload-submit");
    assert.ok(submit !== null, "der Knopf zum Hochladen fehlt");
    await click(submit);

    const upload = server.uploads[0];
    assert.ok(upload !== undefined, "es ging kein Upload hinaus");
    await upload.progress(10, 40);

    const cancel = at("files-upload-cancel");
    assert.ok(cancel !== null, "die Abbruchtaste fehlt, obwohl ein Upload läuft");
    await click(cancel);

    assert.equal(upload.aborted(), true, "die Verbindung wurde nicht geschlossen — nur die Anzeige");
    assert.ok(at("files-upload-aborted") !== null, "der Vermerk zum Abbruch fehlt");
    assert.ok(at("files-upload-error") === null, "der Abbruch steht als Fehler da, obwohl er eine Entscheidung war");
    assert.ok(at("files-upload-done") === null, "es steht eine Quittung da, obwohl abgebrochen wurde");
    // Die Datei bleibt gewählt: ein zweiter Versuch ist ein Klick und keine
    // zweite Wahl im Dateidialog.
    const submitAgain = at("files-upload-submit");
    assert.ok(submitAgain instanceof HTMLButtonElement, "der Knopf zum Hochladen fehlt nach dem Abbruch");
    assert.equal(submitAgain.disabled, false, "nach dem Abbruch lässt sich nichts mehr senden");
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

// ---------------------------------------------------------------------------
// 15. Das Neuholen nach einer Handlung lässt die Fläche stehen
// ---------------------------------------------------------------------------
//
// FÄNGT den Fehler, den die Quittung oben nur an ihrer Wirkung zeigt: eine
// Fassung, die nach einer Handlung im Verzeichnis die ganze Fläche gegen „wird
// geholt" tauscht, hängt jedes Bauteil darin aus — mit seinem Zustand. Geprüft
// wird deshalb der Ort, an dem es entsteht, und beide Hälften gehören dazu: die
// Liste BLEIBT stehen, und geholt wird trotzdem.
//
// ⚠️ DER WECHSEL DES VERZEICHNISSES BLEIBT DAVON UNBERÜHRT, und das ist die
// Gegenprobe im selben Fall: dort steht die Liste des vorigen Verzeichnisses
// gerade NICHT weiter da. Eine Fassung, die den Vergleich ganz herausnimmt,
// besteht die erste Hälfte und fällt an dieser.

test("nach einer Handlung im Verzeichnis bleibt die Liste stehen, WÄHREND neu geholt wird", async () => {
  // ⚠️ DIE ZWEITE ANFRAGE BLEIBT OFFEN. Genau in dieser Zeit entscheidet sich
  // die Zusage: eine Fassung, die die Fläche gegen „wird geholt" tauscht, ist
  // erst danach wieder von dieser zu unterscheiden — und dann hat sie jedes
  // Bauteil darin samt Zustand ausgehängt.
  const server = stubHub({
    listings: { "": listing({ entries: [entry({ name: "alt.log" })] }) },
    holdFrom: 2
  });
  const mounted = await mountAt(`/container/${HOST_ID}/demo/files`);

  try {
    const trigger = at("files-delete-alt.log");
    assert.ok(trigger !== null, "der Knopf zum Löschen fehlt");
    await click(trigger);
    const confirm = at("files-delete-submit");
    assert.ok(confirm !== null, "der Knopf in der Rückfrage fehlt");
    await click(confirm);

    const surface = at("files-view");
    assert.ok(surface !== null, "die Fläche ist während des Neuholens verschwunden");
    assert.ok(at("files-upload") !== null, "das Hochladen ist während des Neuholens ausgehängt worden");
    // Und es wird wirklich geholt — sonst wäre die stehende Liste keine
    // Zusage, sondern eine Fassung, die gar nichts mehr nachfragt.
    assert.equal(surface.dataset.refreshing, "true", "die Fläche steht, aber es läuft keine Anfrage");
    assert.equal(asked(server, "GET", "/files").length, 2, "nach der Handlung wurde die Liste nicht neu geholt");
    // ⚠️ UND DIE FREIGABE WIRD DABEI NICHT NOCH EINMAL GEFRAGT. Sie hängt am
    // Container und nicht am Inhalt des Verzeichnisses; eine zweite Anfrage je
    // Handlung wäre eine Antwort, die gar nicht anders ausfallen kann.
    assert.equal(
      asked(server, "GET", "/share").filter((call) => !call.url.includes("/share-candidates")).length,
      1,
      "nach der Handlung wurde die gewählte Freigabe ein zweites Mal geholt"
    );
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

// ---------------------------------------------------------------------------
// 16. Beim Wechsel des Verzeichnisses verschwindet sie sehr wohl
// ---------------------------------------------------------------------------
//
// DIE GEGENPROBE ZU FALL 15, und ohne sie wäre die Änderung an `FilesView`
// halb geprüft: eine Fassung, die den Vergleich ganz herausnimmt, besteht Fall
// 15 und lässt beim Hineingehen die Liste des VORIGEN Verzeichnisses stehen,
// als wäre sie die des neuen.
//
// ⚠️ DIE ANFRAGE MUSS DAFÜR OFFEN BLEIBEN (`pending`). Die Attrappe antwortet
// sonst im selben Zug, der Zwischenstand entsteht gar nicht, und dieser Fall
// wäre grün gegen jede Fassung.

test("beim Wechsel des Verzeichnisses steht die alte Liste nicht weiter da", async () => {
  const server = stubHub({
    listings: { "": listing({ entries: [entry({ name: "unten", kind: "directory" })] }) },
    holdFrom: 2
  });
  const mounted = await mountAt(`/container/${HOST_ID}/demo/files`);

  try {
    const into = at("files-entry-link");
    assert.ok(into !== null, "der Weg in das Verzeichnis fehlt");
    await click(into);

    assert.ok(
      at("files-view") === null,
      "die Liste des vorigen Verzeichnisses steht weiter da, während die des neuen noch geholt wird"
    );
    assert.ok(saysEither(de.loading, en.loading), "„wird geholt“ steht nicht da");
    assert.equal(asked(server, "GET", "/files").length, 2, "das neue Verzeichnis wurde nicht geholt");
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

test("Archiv-Ersetzen erklärt den Verlust und speichert erst nach Bestätigung", async () => {
  const server = stubHub({
    listings: { "": listing({ entries: [entry({ name: "archive.txt" })], diagnostics: { readable: true, deletable: false, uid: 2100, gid: 2200, uploadable: true } }) },
    texts: { "archive.txt": { content: "old", hash: "actual-hash" } }, saves: [{ ok: "new-hash" }]
  });
  const original = window.confirm;
  let confirmed = false;
  const questions: string[] = [];
  window.confirm = (message) => { questions.push(message ?? ""); return confirmed; };
  const mounted = await mountAt(`/container/${HOST_ID}/demo/files?edit=archive.txt`);
  try {
    assert.equal(at("files-editor-replacement-warning") !== null, true);
    assert.equal(saysEither(de.filesArchiveReplaceWarning, en.filesArchiveReplaceWarning), true);
    const field = at("files-editor-input");
    assert.ok(field instanceof HTMLTextAreaElement);
    await typeInto(field, "draft");
    await click(at("files-editor-save")!);
    assert.equal(asked(server, "PUT", "/file-text").length, 0);
    assert.equal(field.value, "draft");
    assert.equal(questions.length, 1);
    assert.equal([de.filesArchiveReplaceConfirm, en.filesArchiveReplaceConfirm].includes(questions[0]), true);
    confirmed = true;
    await click(at("files-editor-save")!);
    assert.equal(asked(server, "PUT", "/file-text").length, 1);
    assert.equal(asked(server, "PUT", "/file-text")[0].body, "draft");
    assert.equal(questions.length, 2);
  } finally { await mounted.unmount(); window.confirm = original; server.restore(); }
});
