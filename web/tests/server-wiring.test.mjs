import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { stripComments } from "./strip-comments.mjs";

// Wächter über die VERDRAHTUNG in `server/src/index.ts`.
//
// Warum es ihn gibt, gemessen in Etappe B4a-C1 (#5): wer die eine Zeile
// `app.use(createContentSecurityPolicyHeader())` aus `server/src/index.ts`
// entfernt, bekommt eine GRÜNE Kette — `lint 0`, `test` auf der Grundlinie,
// `build 0`. Unter `server/src/` gibt es zu dieser Datei keine Testdatei; sie
// wird von keinem Testlauf ausgeführt, weil sie beim Import sofort einen
// Server startet und eine Datenbank sucht. Alles, was dort steht, ist damit
// eine Zusage, die niemand nachhält — und die vergessene Zeile sieht im Diff
// aus wie die vorhandene.
//
// Mit dem Hintergrundlauf (Etappe B4a-C2, #5) kommt eine zweite solche Zeile
// dazu, und eine dritte, die ihn erst wirksam macht. Deshalb dieser Wächter.
//
// ⚠️ WAS ER IST UND WAS NICHT: er liest den TEXT der Datei und keinen
// Syntaxbaum — wie seine Geschwister `api-read-only.test.mjs` und
// `ui-texts.test.mjs` hält er die GEWOHNHEIT, nicht die Absicht. Wer den
// Aufruf hinter eine Bedingung oder in eine Hilfsfunktion legt, kommt an ihm
// vorbei. Das eigentliche Mittel wäre ein Ausführungstest, der `main()` gegen
// Attrappen fährt; den gibt es nicht, und er wäre ein eigenes Paket. Bis dahin
// ist dieser Wächter die Sperrklinke gegen den Normalfall — nicht der Beweis.
//
// ⚠️ Er darf nicht an einer Umformatierung zerbrechen. Jedes Muster unten
// lässt zwischen allen Bestandteilen beliebigen Leerraum zu, also auch einen
// Zeilenumbruch und eine andere Einrückung.

const INDEX_FILE = fileURLToPath(new URL("../../server/src/index.ts", import.meta.url));

// Kommentare fallen weg, Zeichenketten bleiben. Ohne das genügte die blosse
// ERWÄHNUNG einer Zeile in einem Kommentar — und ausgerechnet die Kommentare
// dieser Datei nennen jede dieser Zeilen namentlich mitsamt ihrer Begründung.
function wiring() {
  return stripComments(readFileSync(INDEX_FILE, "utf8"));
}

// Was in `index.ts` stehen MUSS, jede Zeile mit dem Grund, aus dem sie dort
// steht. Der Grund ist hier das Produkt: eine Meldung „Zeile fehlt" schickte
// den nächsten Leser auf die Suche nach dem Warum, und genau dieses Warum ist
// der Grund, aus dem die Zeile nicht wegdarf.
const REQUIRED = [
  {
    what: "die Content-Security-Policy als app-weite Zwischenschicht",
    pattern: /app\s*\.\s*use\s*\(\s*createContentSecurityPolicyHeader\s*\(\s*\)\s*\)/,
    source: "app.use(createContentSecurityPolicyHeader())",
    why:
      "Ohne sie liefert der Hub jedes Dokument ohne Content-Security-Policy aus: `frame-ancestors 'none'` " +
      "fällt weg, und ein eingeschleustes `<script>` hätte keine Schranke mehr. Nichts daran meldet sich " +
      "von selbst — die Anwendung sieht im Browser genauso aus wie vorher (#28)."
  },
  {
    what: "der Start des Hintergrundlaufs",
    pattern: /startHostCycleService\s*\(/,
    source: "startHostCycleService({ … })",
    why:
      "Ohne ihn fragt der Hub seine Arme nie von sich aus. Ein stiller Arm fällt erst auf, wenn jemand die " +
      "Übersicht öffnet, und ein frisch aufgesetzter Arm bleibt ohne Allowlist — beim Agenten also ohne einen " +
      "einzigen sichtbaren Container, und auch das meldet sich nicht von selbst (B4a-C2, #5)."
  },
  {
    what: "die abgelegte Erreichbarkeit an der API",
    pattern: /probeHost\s*:\s*createObservedProbe\s*\(/,
    source: "probeHost: createObservedProbe({ … }) im Aufruf von createApiRouter",
    why:
      "Ohne sie ist der Hintergrundlauf für die Oberfläche wirkungslos: `GET /overview` fragt weiter bei " +
      "JEDER Anfrage jeden Arm einzeln mit 3 s Frist, und die Fläche nach der Anmeldung wird langsamer, je " +
      "mehr Arme es gibt. Der Lauf liefe dabei weiter und niemand sähe, dass er nichts bewirkt (B4a-C2, #5)."
  },
  {
    what: "der sofortige Abgleich nach einem angewandten Compose-Entwurf",
    pattern: /resyncHost\s*:\s*hostCycle\s*\.\s*syncHost/,
    source: "resyncHost: hostCycle.syncHost im Aufruf von createApiRouter",
    why:
      "Ohne ihn trägt der Arm nach dem Anwenden bis zum nächsten Takt die ALTE Allowlist — mit den " +
      "Container-Ids von vor dem `compose up`. Der Agent lehnt danach jede weitere Aktion an diesem Stack ab, " +
      "und die Ablehnung sieht aus wie ein Rechteproblem. Anders als bei `probeHost` ist die Antwort ohne " +
      "diese Zeile nicht dieselbe und nur langsamer, sondern falsch (#35)."
  },
  {
    what: "die Ausstattung der Arme an der API",
    pattern: /readHostInfo\s*:\s*\(\s*hostId\s*\)\s*=>\s*hostCycle\s*\.\s*observations\s*\.\s*read\s*\(/,
    source: "readHostInfo: (hostId) => hostCycle.observations.read(hostId)?.hostInfo ?? null im Aufruf von createApiRouter",
    why:
      "Ohne sie kennt keine Route die Kerne und den Arbeitsspeicher eines Arms, und die Host-Karte zeigt nie " +
      "eine Last durch Container — still, denn eine fehlende Ausstattung ist dort der vorgesehene Fall " +
      "„nicht ermittelbar“ und kein Fehler (#214)."
  },
  {
    what: "der eigene JSON-Deckel der Compose-Fläche",
    pattern: /app\s*\.\s*use\s*\(\s*["'`]\/api\/hosts\/:hostId\/containers\/:containerId\/compose["'`]\s*,/,
    source: 'app.use("/api/hosts/:hostId/containers/:containerId/compose", express.json({ limit: "512kb" }))',
    why:
      "Ohne ihn greift der allgemeine Deckel von 64 kB auch für den Compose-Editor. Der Agent lässt für den " +
      "Inhalt 256 KB zu; eine erlaubte Datei bricht dann mitten im Speichern mit einem 413 ab, das nach einem " +
      "Fehler des Betreibers aussieht. Kein Routentest sieht das: die Testfassungen melden ihren Parser selbst " +
      "an, und diese Zeile steht nur hier (#35)."
  }
];

test("jede Zeile, die den Hub verdrahtet, steht in server/src/index.ts", () => {
  const text = wiring();
  const missing = REQUIRED.filter((entry) => !entry.pattern.test(text)).map(
    (entry) => `${entry.what} — erwartet wird ${entry.source}.\n  ${entry.why}`
  );

  assert.deepEqual(
    missing,
    [],
    "In server/src/index.ts fehlt eine Zeile, die diese Datei als Einzige trägt. Sie wird von keinem " +
      "Testlauf ausgeführt; ohne diesen Wächter bliebe die Kette grün:\n" +
      missing.join("\n")
  );
});

// ── Die Stellung der CSP ────────────────────────────────────────────────────
//
// ⚠️ WAS DIESER FALL PRÜFT UND WAS ER NICHT KANN: er vergleicht die TEXTLICHE
// Reihenfolge im kommentarfreien Quelltext. Das ist hier keine Raterei,
// sondern deckungsgleich mit der Anmeldereihenfolge — solange alle drei
// Anweisungen als schlichte Anweisungen im selben Rumpf von `main()` stehen,
// wie sie es tun. Ein Aufruf hinter einer Bedingung oder aus einer
// Hilfsfunktion heraus wäre für diesen Vergleich unsichtbar; dann ist die
// Meldung falsch, nicht die Prüfung überflüssig.
//
// Warum die Stellung überhaupt zählt: Express führt Zwischenschichten in der
// Reihenfolge ihrer Anmeldung aus. Eine CSP, die HINTER der Auslieferung des
// Dokuments hängt, kommt zu spät — die Antwort ist dann längst unterwegs, und
// der Kopf fehlt genau dort, wo er wirken müsste.
const ORDER = [
  {
    later: "der API-Router",
    pattern: /createApiRouter\s*\(/,
    why: "sonst trüge die Antwort des Anmeldewegs und jeder API-Route den Kopf nicht mehr"
  },
  {
    later: "die Auslieferung der Weboberfläche",
    pattern: /express\s*\.\s*static\s*\(/,
    why:
      "und das ist der Fall, auf den es ankommt: nur dort gibt es ein Dokument, auf das ein Browser die " +
      "Direktiven anwendet"
  }
];

test("die Content-Security-Policy hängt VOR allem, was eine Antwort schickt", () => {
  const text = wiring();
  const csp = text.search(/app\s*\.\s*use\s*\(\s*createContentSecurityPolicyHeader\s*\(\s*\)\s*\)/);

  // Kein grünes Ergebnis aus einem blinden Leser: findet dieser Fall die
  // Zwischenschicht nicht, prüft er NICHTS — und der Fall oben sagt, warum.
  assert.ok(csp >= 0, "Die CSP-Zwischenschicht steht nicht in server/src/index.ts — siehe den Fall darüber.");

  const findings = [];
  for (const entry of ORDER) {
    const position = text.search(entry.pattern);
    if (position < 0) {
      findings.push(`${entry.later} steht nicht mehr in server/src/index.ts — dieser Fall prüft dafür nichts.`);
      continue;
    }
    if (position < csp) {
      findings.push(
        `${entry.later} wird VOR der Content-Security-Policy angemeldet — ${entry.why}. ` +
          "Express führt Zwischenschichten in der Reihenfolge ihrer Anmeldung aus."
      );
    }
  }

  assert.deepEqual(findings, [], `Die Stellung der CSP in server/src/index.ts stimmt nicht:\n${findings.join("\n")}`);
});

// ⚠️ DIE STELLUNG DES COMPOSE-PARSERS IST DIE GANZE SACHE. Express führt
// Zwischenschichten in der Reihenfolge ihrer Anmeldung aus, und `express.json`
// lässt eine Anfrage unberührt, deren Rumpf schon gelesen ist. Steht der
// allgemeine Deckel VOR dem eigenen, liest er zuerst — und wirft bei 64 kB,
// bevor der grosszügigere überhaupt drankommt. Die Datei sähe danach aus wie
// vorher: zwei Zeilen, beide vorhanden, in der falschen Reihenfolge.
test("der eigene JSON-Deckel der Compose-Fläche hängt VOR dem allgemeinen", () => {
  const text = wiring();
  const scoped = text.search(
    /app\s*\.\s*use\s*\(\s*["'`]\/api\/hosts\/:hostId\/containers\/:containerId\/compose["'`]\s*,/
  );
  const general = text.search(/app\s*\.\s*use\s*\(\s*express\s*\.\s*json\s*\(/);

  // Kein grünes Ergebnis aus einem blinden Leser.
  assert.ok(scoped >= 0, "Der eigene JSON-Deckel der Compose-Fläche fehlt — siehe den Fall darüber.");
  assert.ok(general >= 0, "Der allgemeine JSON-Deckel steht nicht mehr in server/src/index.ts.");

  assert.ok(
    scoped < general,
    "Der allgemeine JSON-Deckel (64 kB) wird VOR dem der Compose-Fläche angemeldet. Er liest den Rumpf dann " +
      "zuerst und weist eine erlaubte Compose-Datei mit 413 ab, bevor der grosszügigere Parser greift."
  );
});

test("der Wächter selbst: was seine Muster sehen müssen und was nicht", () => {
  // Ein Wächter ohne eigenen Test ist eine Behauptung — und diese Muster sind
  // die riskante Hälfte: sie sollen eine Umformatierung überleben und
  // trotzdem nicht auf eine blosse Erwähnung hereinfallen.
  const findings = [];
  const check = (description, actual, expected) => {
    if (actual !== expected) findings.push(`${description}: bekam ${String(actual)}, erwartet ${String(expected)}`);
  };

  const csp = REQUIRED[0].pattern;
  check("die Zeile, wie sie dasteht", csp.test("app.use(createContentSecurityPolicyHeader());"), true);
  check("mit Leerraum dazwischen", csp.test("app . use( createContentSecurityPolicyHeader( ) );"), true);
  check(
    "über zwei Zeilen umgebrochen",
    csp.test("app.use(\n  createContentSecurityPolicyHeader()\n);"),
    true
  );
  check("eine andere Zwischenschicht zählt nicht", csp.test("app.use(express.json());"), false);
  check("der blosse Import zählt nicht", csp.test('import { createContentSecurityPolicyHeader } from "./x.js";'), false);

  const cycle = REQUIRED[1].pattern;
  check("der Start des Laufs", cycle.test("const hostCycle = startHostCycleService({"), true);
  check("ein anderer Name zählt nicht", cycle.test("startSomethingElse({"), false);

  const probe = REQUIRED[2].pattern;
  check("die Sonde am Router", probe.test("probeHost: createObservedProbe({ store })"), true);
  check(
    "mit Umbruch zwischen Doppelpunkt und Aufruf",
    probe.test("probeHost:\n        createObservedProbe({"),
    true
  );
  check("der Aufruf ohne die Übergabe zählt nicht", probe.test("const p = createObservedProbe({"), false);

  // ⚠️ Der Kommentar-Entferner ist der Grund, aus dem eine Erwähnung nicht
  // zählt. Ohne ihn wäre dieser Wächter dauerhaft grün: die Kommentare in
  // `index.ts` nennen jede dieser drei Zeilen namentlich.
  check(
    "eine Erwähnung im Kommentar zählt nicht",
    csp.test(stripComments("// app.use(createContentSecurityPolicyHeader());\nconst x = 1;")),
    false
  );

  assert.deepEqual(findings, [], `Ein Muster dieses Wächters liest anders als zugesagt:\n${findings.join("\n")}`);
});
