import test from "node:test";
import assert from "node:assert/strict";

import { GET_ROUTES_WITH_EFFECT, decideRequestOrigin, matchesRoutePattern } from "./request-origin.js";

// Die Bedingungsliste aus docs/design/phase-5-write-access.md §1, Zeile für
// Zeile. Die Nummer im Testnamen ist die Zeilennummer der Tabelle dort — wer
// eine Zeile ändert, findet den zugehörigen Fall damit ohne Suche.
//
// Warum die Prüfung hier ohne Server läuft: `decideRequestOrigin` ist eine
// reine Funktion über die Kopfzeilen. Ein Test über einen echten Listener
// prüfte die Verdrahtung mit, aber er könnte nicht acht Zeilen einzeln
// zeigen — er zeigte nur die Summe. Die Verdrahtung prüft
// `app/request-origin-routing.test.ts`, durch den echten
// `createApiRouter`.

const HOST = "hub.example.test";

type Headers = { secFetchSite?: string; origin?: string; referer?: string; host?: string };

// Eine Anfrage, wie sie an der Schranke ankommt. Der Pfad trägt kein `/api` —
// gemessen am 2026-09-07: innerhalb eines unter `/api` gemounteten Routers
// liefert Express 5.2.1 in `request.path` den Pfad OHNE das Präfix (der Beleg
// steht als eigener Fall in `request-origin-routing.test.ts`).
function request(method: string, path: string, headers: Headers = {}) {
  return { method, path, headers: { host: HOST, ...headers } };
}

// ── Die acht Zeilen der Tabelle ─────────────────────────────────────────────

test("Zeile 1: GET ohne Wirkung läuft durch, auch fremd ausgelöst", () => {
  const decision = decideRequestOrigin(request("GET", "/hosts", { secFetchSite: "cross-site" }));
  assert.deepEqual(decision, { allowed: true });
});

test("Zeile 1: ein GET AUS DER LISTE läuft nicht durch — die Methode ist nicht das Kriterium", () => {
  // Der Fall, den eine wörtliche Übernahme der Methodenregel verlöre:
  // `GET /hosts/:hostId/archive` rotiert bei jedem Aufruf Schlüsselpaar,
  // Agent-Secret und Token. Ein `<img src="…">` genügt.
  const decision = decideRequestOrigin(
    request("GET", "/hosts/abc123/archive", { secFetchSite: "cross-site" })
  );
  assert.deepEqual(decision, { allowed: false, reason: "sec-fetch-site" });
});

test("Zeile 2: Sec-Fetch-Site same-origin läuft durch", () => {
  const decision = decideRequestOrigin(request("POST", "/marks", { secFetchSite: "same-origin" }));
  assert.deepEqual(decision, { allowed: true });
});

test("Zeile 3: Sec-Fetch-Site none läuft durch", () => {
  const decision = decideRequestOrigin(request("POST", "/marks", { secFetchSite: "none" }));
  assert.deepEqual(decision, { allowed: true });
});

test("Zeile 4: Sec-Fetch-Site cross-site wird abgelehnt", () => {
  const decision = decideRequestOrigin(request("POST", "/marks", { secFetchSite: "cross-site" }));
  assert.deepEqual(decision, { allowed: false, reason: "sec-fetch-site" });
});

test("Zeile 4: ⚠️ Sec-Fetch-Site SAME-SITE wird ebenfalls abgelehnt", () => {
  // Genau hier geht die Regel über das `SameSite=Lax` des Sitzungs-Cookies
  // hinaus: Lax hält andere *Sites* ab, und das Hauptdashboard auf einer
  // Nachbar-Subdomain ist keine andere Site. Es ist die naheliegendste
  // Startrampe, die es hier gibt.
  const decision = decideRequestOrigin(request("POST", "/marks", { secFetchSite: "same-site" }));
  assert.deepEqual(decision, { allowed: false, reason: "sec-fetch-site" });
});

test("Zeile 4: ein unbekannter Wert von Sec-Fetch-Site wird abgelehnt", () => {
  const decision = decideRequestOrigin(request("POST", "/marks", { secFetchSite: "irgendwas" }));
  assert.deepEqual(decision, { allowed: false, reason: "sec-fetch-site" });
});

test("Zeile 5: kein Sec-Fetch-Site, aber ein Origin über den Host der Anfrage", () => {
  // Ein Browser ohne diesen Kopf ist alt, nicht fremd.
  const decision = decideRequestOrigin(
    request("POST", "/marks", { origin: `https://${HOST}` })
  );
  assert.deepEqual(decision, { allowed: true });
});

test("Zeile 6: kein Sec-Fetch-Site, kein Origin, aber ein Referer über den Host der Anfrage", () => {
  // ⚠️ Der Regelfall der eigenen Oberfläche über reines HTTP: gemessen am
  // 2026-09-29 gegen `http://192.0.2.31:8090` sendet der Browser in einem
  // nicht sicheren Kontext kein `Sec-Fetch-Site`, und bei einem GET aus
  // derselben Herkunft kein `Origin`. Protokoll und Dateien standen dort auf
  // `403 forbidden-origin`.
  const decision = decideRequestOrigin(
    request("GET", "/hosts/abc/containers/def/logs-stream", {
      referer: `http://${HOST}/hosts/abc/containers/adguardhome`
    })
  );
  assert.deepEqual(decision, { allowed: true });
});

test("Zeile 6: ein Referer von einer fremden Seite wird abgelehnt", () => {
  const decision = decideRequestOrigin(
    request("GET", "/hosts/abc/containers/def/logs-stream", {
      referer: "http://fremde-seite.example/angriff.html"
    })
  );
  assert.deepEqual(decision, { allowed: false, reason: "referer" });
});

test("Zeile 6: ein Referer mit anderem PORT wird abgelehnt", () => {
  const decision = decideRequestOrigin(
    request("GET", "/hosts/abc/archive", { host: "hub.example.test:8090", referer: "http://hub.example.test:8080/" })
  );
  assert.deepEqual(decision, { allowed: false, reason: "referer" });
});

test("Zeile 6: ein Referer, der keine URL ist, wird abgelehnt", () => {
  const decision = decideRequestOrigin(request("POST", "/marks", { referer: "kein-url" }));
  assert.deepEqual(decision, { allowed: false, reason: "referer" });
});

test("Zeile 6: ein Referer zählt nicht, sobald ein Origin gesetzt ist", () => {
  // Ein fremder `Origin` bleibt fremd, auch wenn der `Referer` passte — der
  // `Origin` ist die genauere Angabe und wird zuerst gelesen.
  const decision = decideRequestOrigin(
    request("POST", "/marks", { origin: "https://fremde-seite.example", referer: `https://${HOST}/` })
  );
  assert.deepEqual(decision, { allowed: false, reason: "origin" });
});

test("Zeile 6: ein Referer zählt nicht, sobald Sec-Fetch-Site gesetzt ist", () => {
  const decision = decideRequestOrigin(
    request("POST", "/marks", { secFetchSite: "same-site", referer: `https://${HOST}/` })
  );
  assert.deepEqual(decision, { allowed: false, reason: "sec-fetch-site" });
});

test("Zeile 7: weder Sec-Fetch-Site noch Origin noch Referer wird abgelehnt", () => {
  // ⚠️ Anders als im Quellsystem, und ausdrücklich so: dieser Hub hat keinen
  // Maschinen-Aufrufer über diesen Router. Der Anmeldeweg der Arme ist eine
  // eigene Anwendung auf einem eigenen Listener. Headerlos ist die billigste
  // Anfrage, die ein Skript stellen kann.
  const decision = decideRequestOrigin(request("POST", "/marks"));
  assert.deepEqual(decision, { allowed: false, reason: "no-browser-headers" });
});

test("Zeile 8: sonst — ein Origin, der sich nicht ausweist, wird abgelehnt", () => {
  const decision = decideRequestOrigin(
    request("POST", "/marks", { origin: "https://fremde-seite.example" })
  );
  assert.deepEqual(decision, { allowed: false, reason: "origin" });
});

// ── Was die Tabelle nicht als Zeile führt, aber meint ────────────────────────

test("ein Origin, der keine URL ist, wird abgelehnt — fail closed", () => {
  const decision = decideRequestOrigin(request("POST", "/marks", { origin: "kein-schema" }));
  assert.deepEqual(decision, { allowed: false, reason: "origin" });
});

test("der Wortlaut null als Origin wird abgelehnt", () => {
  // Den sendet ein Browser bei undurchsichtiger Herkunft — etwa aus einem
  // sandboxed iframe oder nach einer Weiterleitung über ein fremdes Schema.
  const decision = decideRequestOrigin(request("POST", "/marks", { origin: "null" }));
  assert.deepEqual(decision, { allowed: false, reason: "origin" });
});

test("ein Origin mit anderem Host als dem Host der Anfrage wird abgelehnt", () => {
  const decision = decideRequestOrigin(
    request("POST", "/marks", { origin: "https://nachbar.example.test" })
  );
  assert.deepEqual(decision, { allowed: false, reason: "origin" });
});

test("ein Origin mit anderem PORT wird abgelehnt", () => {
  // Ein anderer Port ist eine andere Herkunft — deshalb vergleicht die Prüfung
  // `host` (Name UND Port) und nicht `hostname`.
  const decision = decideRequestOrigin(
    request("POST", "/marks", { origin: `https://${HOST}:8443`, host: HOST })
  );
  assert.deepEqual(decision, { allowed: false, reason: "origin" });
});

test("ein Origin mit demselben Port wie der Host der Anfrage läuft durch", () => {
  const decision = decideRequestOrigin(
    request("POST", "/marks", { origin: `http://${HOST}:8080`, host: `${HOST}:8080` })
  );
  assert.deepEqual(decision, { allowed: true });
});

test("ohne Host-Kopfzeile weist sich kein Origin aus", () => {
  const decision = decideRequestOrigin({
    method: "POST",
    path: "/marks",
    headers: { origin: `https://${HOST}` }
  });
  assert.deepEqual(decision, { allowed: false, reason: "origin" });
});

test("HEAD zählt wie GET", () => {
  assert.deepEqual(decideRequestOrigin(request("HEAD", "/hosts", { secFetchSite: "cross-site" })), {
    allowed: true
  });
});

test("OPTIONS zählt wie GET", () => {
  assert.deepEqual(decideRequestOrigin(request("OPTIONS", "/hosts", { secFetchSite: "cross-site" })), {
    allowed: true
  });
});

test("HEAD auf eine Route AUS DER LISTE wird trotzdem geprüft", () => {
  assert.deepEqual(
    decideRequestOrigin(request("HEAD", "/hosts/abc/archive", { secFetchSite: "cross-site" })),
    { allowed: false, reason: "sec-fetch-site" }
  );
});

test("die Methode wird ohne Rücksicht auf Groß- und Kleinschreibung gelesen", () => {
  // `request.method` ist bei Express groß geschrieben; ein Aufrufer dieser
  // reinen Funktion muss sich darauf nicht verlassen.
  assert.deepEqual(decideRequestOrigin(request("post", "/marks", { secFetchSite: "cross-site" })), {
    allowed: false,
    reason: "sec-fetch-site"
  });
});

test("eine leere Sec-Fetch-Site-Kopfzeile zählt als nicht vorhanden", () => {
  // Sonst fiele sie auf Zeile 4 und lehnte auch die eigene Oberfläche ab.
  assert.deepEqual(
    decideRequestOrigin(request("POST", "/marks", { secFetchSite: "", origin: `https://${HOST}` })),
    { allowed: true }
  );
});

// ── Der segmentweise Abgleich ───────────────────────────────────────────────
//
// ⚠️ Diese Fälle sind der Grund, warum es `matchesRoutePattern` überhaupt
// gibt. In der Liste steht ein MUSTER (`/hosts/:hostId/archive`), an der
// Schranke kommt ein konkreter Pfad an (`/hosts/abc123/archive`). Ein
// Vergleich auf Gleichheit ginge damit IMMER ins Leere — und die Lücke sähe
// aus wie eine geschlossene Tür.

test("Muster: ein Parameter trifft genau ein Segment", () => {
  assert.ok(matchesRoutePattern("/hosts/:hostId/archive", "/hosts/abc/archive"));
});

test("Muster: ein längerer Pfad trifft nicht", () => {
  assert.ok(!matchesRoutePattern("/hosts/:hostId/archive", "/hosts/abc/archive/extra"));
});

test("Muster: ein kürzerer Pfad trifft nicht", () => {
  assert.ok(!matchesRoutePattern("/hosts/:hostId/archive", "/hosts/abc"));
});

test("Muster: ein leeres Segment trifft den Parameter nicht", () => {
  assert.ok(!matchesRoutePattern("/hosts/:hostId/archive", "/hosts//archive"));
});

// ⚠️ ZWEI Parameter in einem Muster — eine Form, die es in dieser Liste bis
// Etappe B4b-K (#5) nicht gab. Jeder Fall darüber hat genau einen, und ein
// Abgleich, der nur den ERSTEN Parameter als solchen behandelte, bliebe an
// ihnen allen grün und träfe den Log-Strom nie. Die Lücke sähe dann wieder aus
// wie eine geschlossene Tür: ein gepflegter Eintrag, ein Abgleich ins Leere.
test("Muster: zwei Parameter in einem Muster treffen beide je ein Segment", () => {
  const pattern = "/hosts/:hostId/containers/:containerId/logs-stream";
  assert.ok(matchesRoutePattern(pattern, "/hosts/host-1/containers/abc123/logs-stream"));
  assert.ok(matchesRoutePattern(pattern, "/HOSTS/host-1/CONTAINERS/abc123/LOGS-STREAM"));
  // Und keiner der beiden trifft ein leeres Segment.
  assert.ok(!matchesRoutePattern(pattern, "/hosts//containers/abc123/logs-stream"));
  assert.ok(!matchesRoutePattern(pattern, "/hosts/host-1/containers//logs-stream"));
  // Ein Parameter trifft GENAU EIN Segment und nicht zwei.
  assert.ok(!matchesRoutePattern(pattern, "/hosts/host-1/containers/abc/123/logs-stream"));
});

// ── Groß- und Kleinschreibung ──────────────────────────────────────────────
//
// ⚠️ Diese Fälle sind der Kern dieser Etappe. Vorher stand hier das Gegenteil
// („Grossschreibung trifft nicht — verglichen wird zeichengleich"), und das
// war eine Zusage, die eine offene Tür festhielt: gemessen am 2026-09-07
// gegen Express 5.2.1 antwortet `/api/HOSTS/abc/ARCHIVE` mit `200` und
// erreicht den Handler als `/HOSTS/abc/ARCHIVE` — Express routet in der
// Vorgabe ohne Rücksicht auf Groß- und Kleinschreibung. Ein zeichengenauer
// Abgleich ließ damit `<img src="…/api/HOSTS/<id>/ARCHIVE">` auf einer
// fremden Seite durch, geöffnet vom angemeldeten Betreiber — und der GET
// rotiert Schlüsselpaar, Agent-Secret und Token und setzt den Host auf
// `pending` zurück. Der Grundsatz dahinter: die Schranke darf nie enger
// treffen als der Router.
//
// Die Schreibweisen unten sind WÖRTLICH die gemessenen.

test("Muster: die gemessene Schreibweise /HOSTS/abc/ARCHIVE trifft", () => {
  assert.ok(matchesRoutePattern("/hosts/:hostId/archive", "/HOSTS/abc/ARCHIVE"));
});

test("Muster: die gemessene Schreibweise /Hosts/abc/Archive trifft", () => {
  assert.ok(matchesRoutePattern("/hosts/:hostId/archive", "/Hosts/abc/Archive"));
});

test("Muster: gemischte Schreibweise trifft auch mit abschliessendem Schrägstrich", () => {
  assert.ok(matchesRoutePattern("/hosts/:hostId/archive", "/Hosts/abc/ARCHIVE/"));
});

test("Muster: die Schreibweise des Parameters bleibt unangetastet", () => {
  // Der Parameter trifft ohnehin jedes nicht leere Segment — die Lockerung
  // gilt den FESTEN Segmenten und darf am Parameter nichts ändern.
  assert.ok(matchesRoutePattern("/hosts/:hostId/archive", "/hosts/AbC-123/archive"));
});

test("Muster: ein anderer Pfad trifft auch in anderer Schreibweise nicht", () => {
  // ⚠️ Die Gegenprobe zur Lockerung: sie darf NUR die Schreibweise weiten und
  // nicht den Pfad. Ohne diesen Fall wäre ein `matchesRoutePattern`, das immer
  // `true` liefert, in allen Fällen oben grün.
  assert.ok(!matchesRoutePattern("/hosts/:hostId/archive", "/HOSTS/abc/DISPLAY"));
  assert.ok(!matchesRoutePattern("/hosts/:hostId/archive", "/USERS/abc/ARCHIVE"));
});

test("die Entscheidung weist /HOSTS/abc/ARCHIVE bei cross-site ab", () => {
  // ⚠️ Der Fall, der ohne die Änderung FALSCH ist: vorher lautete das Urteil
  // hier `{ allowed: true }` — die Anfrage lief durch, der Handler rotierte,
  // und nirgends stand ein Fehler.
  assert.deepEqual(decideRequestOrigin(request("GET", "/HOSTS/abc/ARCHIVE", { secFetchSite: "cross-site" })), {
    allowed: false,
    reason: "sec-fetch-site"
  });
});

test("die Entscheidung weist /Hosts/abc/Archive bei cross-site ab", () => {
  assert.deepEqual(decideRequestOrigin(request("GET", "/Hosts/abc/Archive", { secFetchSite: "cross-site" })), {
    allowed: false,
    reason: "sec-fetch-site"
  });
});

test("Muster: ein abschliessender Schrägstrich trifft trotzdem", () => {
  // Gemessen am 2026-09-07 gegen Express 5.2.1: `/api/hosts/abc/archive/`
  // erreicht denselben Handler wie `/api/hosts/abc/archive` (beide `200`).
  // Ohne diese Zeile liefe die Schranke an genau dieser Schreibweise vorbei,
  // während die Wirkung eintritt.
  assert.ok(matchesRoutePattern("/hosts/:hostId/archive", "/hosts/abc/archive/"));
});

test("Muster: ein anderer Pfad derselben Länge trifft nicht", () => {
  assert.ok(!matchesRoutePattern("/hosts/:hostId/archive", "/hosts/abc/display"));
});

test("die Entscheidung nutzt denselben Abgleich wie das Muster", () => {
  // Ohne diesen Fall könnte `matchesRoutePattern` richtig sein und trotzdem
  // an der Entscheidung vorbeilaufen.
  assert.deepEqual(
    decideRequestOrigin(request("GET", "/hosts/abc/archive/", { secFetchSite: "cross-site" })),
    { allowed: false, reason: "sec-fetch-site" }
  );
});

// ── Die Liste selbst ────────────────────────────────────────────────────────

test("GET_ROUTES_WITH_EFFECT trägt beide Sorten und keinen Pfad mit /api", () => {
  // ⚠️ Die Erwartung nennt die Einträge WÖRTLICH und zählt sie nicht nur.
  // Genau das ist ihr Zweck: ein Eintrag, der still dazukommt, ist eine
  // Entscheidung darüber, was diese Schranke prüft — und die soll nicht
  // unbemerkt fallen. Seit Etappe B4b-K (#5) sind es zwei Sorten:
  // `/hosts/:hostId/archive` ändert den Zustand, der Log-Strom belegt einen
  // der Ströme des Arms und schreibt in dessen Audit-Log unter dem Namen
  // des angemeldeten Menschen. Die Begründung je Eintrag steht neben ihm in
  // `request-origin.ts`.
  //
  // Seit Etappe B5-E3 (#5) kommen die vier lesenden Routen der Datei-Fläche
  // dazu — alle vier Sorte 2 in ihrer zweiten Hälfte: der Agent schreibt für
  // jede von ihnen einen Audit-Eintrag mit `outcome: "allowed"` unter dem Wert
  // aus `x-docker-agent-actor`, und der lautet auf den angemeldeten Menschen.
  //
  // Seit Etappe B5-E5b (#5) steht `…/share` daneben — die Auskunft über die
  // GEWÄHLTE Freigabe. Sie ist der Grenzfall dieser Liste und deshalb
  // ausdrücklich genannt: sie beantwortet eine Frage an die eigene Datenbank
  // und gehörte danach NICHT hierher. Sie ruft aber `openContainer`, und das
  // holt die Container-Liste beim Arm — die Ablage liegt je Containername, der
  // Pfad trägt eine Id, und die Zuordnung hat im Hub keine andere Quelle.
  // Damit entsteht dieselbe Spur unter fremdem Namen wie bei den vier darüber.
  // Entschieden ist das an dieser Messung und nicht am Gefühl; spräche der
  // Handler den Arm nicht an, stünde die Zeile hier nicht.
  //
  // Seit Befund 1 aus #117 (#118) steht `…/compose` am Ende — dieselbe Sorte 2
  // und dieselbe Messung: der Handler ruft `openContainer` und danach
  // `GET /containers/:id/compose-raw` beim Arm, beide unter dem Namen des
  // angemeldeten Menschen. Nur der LESENDE Pfad gehört hierher; die beiden
  // `POST` derselben Fläche sind über die Methode ohnehin prüfpflichtig.
  // Der `.env`-Reiter fragt den Agenten ebenfalls unter dem Namen des
  // angemeldeten Menschen; sein Klartextaufruf ist derselbe GET-Pfad.
  //
  // Seit #213 steht `…/stats` hinter dem Log-Strom — Sorte 2: die
  // Einzelansicht des Agenten schreibt bei einer Ablehnung einen Audit-Eintrag
  // unter dem Namen des angemeldeten Menschen.
  //
  // Seit #10 steht `…/resources` am Ende — Sorte 2: der Agent schreibt für
  // jeden Aufruf einen Audit-Eintrag unter dem Namen des angemeldeten
  // Menschen und liest dafür die Größe jedes Volumes von der Platte.
  assert.deepEqual(
    [...GET_ROUTES_WITH_EFFECT],
    [
      "/hosts/:hostId/archive",
      "/hosts/:hostId/containers/:containerId/logs-stream",
      "/hosts/:hostId/containers/:containerId/stats",
      "/hosts/:hostId/containers/:containerId/share-candidates",
      "/hosts/:hostId/containers/:containerId/files",
      "/hosts/:hostId/containers/:containerId/file",
      "/hosts/:hostId/containers/:containerId/file-text",
      "/hosts/:hostId/containers/:containerId/share",
      "/hosts/:hostId/containers/:containerId/compose",
      "/hosts/:hostId/containers/:containerId/compose/env",
      "/hosts/:hostId/containers/:containerId/compose/candidates",
      "/hosts/:hostId/resources"
    ]
  );
  const withPrefix = GET_ROUTES_WITH_EFFECT.filter((path) => path.startsWith("/api/"));
  assert.deepEqual(
    withPrefix,
    [],
    "Innerhalb des unter /api gemounteten Routers kommt der Pfad OHNE /api an — " +
      "ein Eintrag mit Präfix träfe nie."
  );
});

test("die Liste darf nicht leer sein", () => {
  // Eine leere Liste machte jeden Fall oben grün, ohne dass die Schranke noch
  // eine einzige GET-Route mit Wirkung kennte.
  assert.ok(GET_ROUTES_WITH_EFFECT.length > 0);
});
