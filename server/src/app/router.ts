import { Router } from "express";

import { FEATURES } from "./features.js";
import { requireTrustedOrigin } from "../platform/http/request-origin-guard.js";
import type { ApiOptions } from "./router-support.js";

// The assembly of the API. This file creates the router, mounts the origin
// check, registers the entries of the feature list (`../features.ts`) in their
// order and closes with the JSON 404. It carries no route itself.
//
// Which entry carries which surface, and why the order matters, is written
// at the list. Up to `8d85e59` the twelve `register…Routes` calls stood here;
// `app/router-routes.test.ts` holds the routes they registered, method, path
// and order, against what the list registers now (#249).
//
// ⚠️ Fast jede schreibende Route trägt `requireAdmin` als ERSTE
// Zwischenschicht, vor jedem Handler — das gilt je DATEI und nicht nur hier:
// eine Zwischenschicht wirkt nur dort, wo sie angemeldet ist, und die
// vergessene sieht im Diff aus wie die vorhandene. `web/tests/api-read-only
// .test.mjs` hält das über ALLE Dateien unter `routes/` UND über `router.ts`
// hinweg zusammen nach (`routerFiles()` in `web/tests/router-routes.mjs`
// liest beide seit A2 gemeinsam).
//
// Counted on 2026-10-02 for #271 (`grep -cE 'router\.(post|put|delete|patch)\('
// server/src/app/router.ts server/src/features/*/routes.ts`, sum over all
// files): TWENTY-NINE. Per file, so the next deviation says at once where it
// is: `features/marks/routes.ts` 7 (create, change, remove an own mark, and
// four assignment routes, #268), `features/files/routes.ts` 5 (two on the
// choice of share, three on the files inside it, step E3),
// `features/shell/routes.ts` 4 (the stream that opens a session and the three
// that work on an existing one, package B6, #5), `features/compose/routes.ts`
// 4 (the compose selection, set and removed, and the compose file of a stack,
// preview and apply, #35; the preview changes nothing and is a POST anyway,
// because the draft is in the body), `features/hosts/routes.ts` 3 (create,
// remove, and `POST /hosts/:hostId/agent-update`, #7),
// `features/appearance/routes.ts` 2 (the theme of the hub and the colour of
// an arm, D7a, #62), and one each in `features/settings/routes.ts` (the
// network, #4), `features/containers/routes.ts` (the container view),
// `features/logs/routes.ts` (the log lines, step G, #5) and
// `features/account/routes.ts` (the language of the own account, #70);
// `router.ts` and `features/metrics/routes.ts` report 0. Add the ELEVEN GETs
// with an effect from `GET_ROUTES_WITH_EFFECT`
// (`platform/http/request-origin.ts`, pinned in its test), such as the
// state-changing `GET /hosts/:hostId/archive` (§4: it rotates key, secret and
// token on every call), the log stream (B4b-K, #5: it takes one of the arm's
// streams and writes to its audit log) and the reading routes of the file and
// compose surfaces (each writes an audit entry at the arm under the name of
// the signed-in person).
//
// TWENTY-EIGHT of these twenty-nine carry `requireAdmin`. The one exception is
// `PUT /session/language` (`features/account/routes.ts`): it changes a display setting
// of the own account and nothing else (a user without admin rights must be
// able to switch their language), and so it sits behind `withSession` instead
// of `requireAdmin`. The guard names it in `SESSION_ONLY_WRITE`.
//
// ⚠️ DIESE ZAHL IST SCHON DREIMAL VERALTET, und jedes Mal auf dieselbe Weise.
// Die Fassung vom 2026-09-06 zählte „elf"; `PUT /settings/network` (§4) kam
// dazwischen dazu, ohne dass jemand nachzog. Die Fassung danach zählte
// „zwölf"; `PUT /settings/logs` (Etappe G, #5) kam dazwischen dazu, ohne dass
// jemand nachzog. Die dritte las „achtzehn" und war beim Nachmessen am
// 2026-09-08 (Paket B6, Etappe E3, #5) auf ZWANZIG gewachsen: die beiden POSTs
// der Compose-Fläche (`a3c27fd`, #35) kamen dazu, ohne dass jemand nachzog —
// und `compose-routes.ts` fehlte dazu in der Liste „Wer welche Fläche trägt"
// ganz. `git blame` bestätigt in allen drei Fällen, dass die Route jünger ist
// als der Kommentar. Eine gezählte Zahl veraltet, sobald eine Route dazu oder
// weg kommt; sie gehört deshalb an eine Stelle, die beim nächsten Umbau
// ohnehin angefasst wird, und trägt ihren Messweg, damit die nächste
// Abweichung derselben Prüfung standhält. Wer diesen Absatz liest und den
// Befehl nicht ausführt, schreibt die nächste falsche Zahl ab.
//
// `ApiOptions` lives in `router-support.ts` since this router was split (step
// B4a-A1, #5). `failWith` and `guarded` live in
// `platform/http/route-responses.ts` since #254: every route file needs them,
// a feature's included, and this router does not, as it calls no handler
// itself.

export function createApiRouter(options: ApiOptions): Router {
  // ⚠️ `caseSensitive: true` — DIE BEHEBUNG AN DER WURZEL (Etappe B4b-F, #5).
  //
  // Express routet in der Vorgabe OHNE Rücksicht auf Groß- und
  // Kleinschreibung. Gemessen am 2026-09-07 gegen Express 5.2.1 (der Fund aus
  // B4a, `request-origin-routing.test.ts`): `/api/HOSTS/<id>/ARCHIVE` und
  // `/api/Hosts/<id>/Archive` erreichten beide den Handler. Die
  // Herkunftsprüfung verglich damals zeichengenau, ihre Musterliste traf
  // deshalb nicht — und ein `<img src="…/api/HOSTS/<id>/ARCHIVE">` auf einer
  // fremden Seite rotierte die Schlüssel eines Arms, ohne dass irgendwo ein
  // Fehler stand. Mit dieser Option trifft eine Route nur noch unter ihrer
  // eigenen Schreibweise.
  //
  // ⚠️ DIE PRÜFUNG IN `request-origin.ts` BLEIBT TROTZDEM UNEMPFINDLICH GEGEN
  // SCHREIBWEISE (`matchesRoutePattern` vergleicht weiter kleingeschrieben).
  // Das ist keine vergessene Hälfte, sondern der Grundsatz aus dem Fund: EINE
  // SCHRANKE DARF NIE ENGER TREFFEN ALS DER ROUTER. Wer beide Seiten
  // gleichzeitig verengt, hängt die Sicherheit wieder an ihrer
  // Übereinstimmung — und die nächste Route, die aus irgendeinem Grund doch
  // wieder unempfindlich routet (ein `use` mit Präfix, ein Proxy davor, eine
  // spätere Option), liefe an einer Schranke vorbei, die inzwischen zu eng
  // geworden ist. Die Schranke breiter zu lassen als den Router kostet nichts:
  // sie lehnt dann höchstens einen Pfad ab, den es gar nicht gibt.
  //
  // Gemessen, bevor es committet wurde (2026-09-07, Zählskript über
  // `web/src`, `server/src` und `web/tests`): 260 Zeichenketten treffen eine
  // angemeldete Route ohne Rücksicht auf Schreibweise, davon 18 zeichengenau
  // abweichend — und alle 18 stehen in `request-origin.ts`,
  // `request-origin.test.ts` und `request-origin-routing.test.ts`, wo sie
  // ABSICHTLICH die Unempfindlichkeit der Schranke belegen und eine 403
  // erwarten, keinen Handler. Kein einziger Aufruf aus einem `api.ts` des Webs
  // ist darunter.
  const router = Router({ caseSensitive: true });

  // ⚠️ DIE HERKUNFTSPRÜFUNG STEHT VOR ALLEM ANDEREN. Sie ist keine Tür zu
  // einer einzelnen Fläche, sondern eine Zwischenschicht vor dem GANZEN
  // `/api`-Router — auch vor den drei schreibenden Host-Routen aus Phase 4a
  // (docs/design/phase-5-write-access.md §1). Wer sie an die schreibenden
  // Routen einzeln hängt, hat sie an die zweite Hälfte gehängt, und die
  // vergessene sieht im Diff aus wie die vorhandene.
  //
  // Sie steht HIER und nicht in `index.ts` vor dem Mount. Beides greift vor
  // jeder Route; den Ausschlag gibt, wer es nachhält. Gezählt am 2026-09-08
  // (`grep -rln 'createApiRouter(' server/src --include=*.test.ts | wc -l`):
  // ZWÖLF Dateien. ⚠️ UND DIESER BEFEHL ZÄHLT SEIT DEMSELBEN TAG ZU NIEDRIG:
  // `exec-test-support.ts` baut den Router für DREI Testdateien und trägt
  // selbst keine Endung `.test.ts` — der Ausdruck sieht sie nicht. Gezählt am
  // 2026-09-08 mit
  // `grep -rln 'exec-test-support.js' server/src --include=*.test.ts | wc -l`:
  // drei. Testdateien, die echte Anfragen durch diese Funktion fahren, sind es
  // damit FÜNFZEHN. Ein Messweg, der die Aufrufstelle sucht statt der Aufrufer,
  // findet genau die nicht, die über einen gemeinsamen Prüfstand gehen.
  // Innerhalb
  // prüfen alle fünfzehn die Schranke bei jedem Lauf mit; draußen prüfte sie
  // dort niemand. ⚠️ Dieser Folgesatz las bis zum 2026-09-08 „alle elf" — die
  // Zahl von vorgestern, stehengeblieben in derselben Zeilengruppe, die den
  // Absatz darüber Zeile für Zeile neu gezählt hat. Wer eine Zahl nachzieht,
  // zieht auch ihre Wiederholung nach. Die Begründung im Langen steht im Kopf von
  // `request-origin-guard.ts`, samt dem Preis dieser Wahl.
  //
  // ⚠️ Die erste Fassung dieser Zahl las „FÜNF" und zählte mit
  // `server/src/app/*.test.ts` — nur das eigene Verzeichnis. Sie war damit
  // nicht falsch abgeschrieben, sondern zu eng GEMESSEN: zwei weitere
  // Aufrufer liegen daneben (`app/enrollment-integration.test.ts`,
  // `app/index-fallback.test.ts`), und der erste wurde beim ersten vollen
  // Testlauf rot. Ein Messweg, der nur den Ordner absucht, in dem man gerade
  // steht, findet genau die Aufrufer nicht, die man vergessen würde.
  //
  // ⚠️ Die zweite Fassung las „ACHT" und war beim Nachmessen am 2026-09-07
  // (Etappe B4b-K, #5) auf ZEHN gewachsen: `container-routes.test.ts` (B4b-F)
  // und `settings-logs-routes.test.ts` (Etappe G) kamen dazu. Die dritte las
  // „ZEHN" und war beim Nachmessen in Etappe B5-E3 (#5) auf ELF gewachsen:
  // `file-routes.test.ts` kam dazu. Die vierte las „ELF" und war beim
  // Nachmessen in Paket B6, Etappe E3 (#5) auf ZWÖLF gewachsen, ohne dass ein
  // Zutun nötig gewesen wäre: `compose-routes.test.ts` (#35) kam dazwischen
  // dazu. ⚠️ Der Satz endete bis zum 2026-09-08 mit „mit `exec-routes.test.ts`
  // derselben Etappe sind es DREIZEHN" — das stimmt für diesen Messweg nicht:
  // die drei Exec-Testdateien bauen den Router über `exec-test-support.ts` und
  // stehen deshalb NICHT in den zwölf, sondern in den drei daneben. Selbst
  // nachgezählt am 2026-09-08, beide Befehle namentlich gelesen statt gezählt:
  // zwölf plus drei ist fünfzehn, und dreizehn ist keine der beiden Zahlen.
  // Dieselbe Fehlerklasse wie bei der Routenzahl im Kopf dieser Datei, nur
  // eine Etage tiefer — eine gezählte Zahl veraltet ohne jedes Zutun, sobald
  // jemand eine Datei anlegt.
  router.use(requireTrustedOrigin);

  for (const registerFeature of FEATURES) registerFeature(router, options);

  // Der Abschluss: was unter `/api` keine Route trifft, ist ein 404 ALS JSON.
  //
  // ⚠️ Er steht hier, seit die Anwendung einen Rückfall auf `index.html`
  // kennt (D6b, platform/http/index-fallback.ts). Der Rückfall lässt `/api` zwar
  // ausdrücklich aus — aber die Zusage „eine unbekannte API-Route antwortet
  // niemals mit HTML" hing damit an einer Auslassliste in einer anderen
  // Datei. Sie gehört an das Ende dieses Routers: hier ist sie eine
  // Eigenschaft der API und nicht das Ergebnis eines vergessenen Präfixes.
  //
  // Vorher war die Antwort der HTML-Text von Express („Cannot GET /api/…"),
  // und ein `fetch`, das ihn als JSON las, bekam einen Parserfehler statt
  // einer Fehlermeldung.
  //
  // ⚠️ Als `use` und NICHT als angemeldete Route auf einem Sammelpfad. Der
  // Wächter `web/tests/api-read-only.test.mjs` liest die angemeldeten Routen
  // dieser Datei als Text; ein Auffangbecken auf einem Sammelpfad wäre dort
  // eine Route ohne Zwischenschicht und damit rot, obwohl es nichts tut, als
  // abzulehnen. (Gemessen am 2026-09-05: schon die ERWÄHNUNG einer solchen
  // Anmeldung in einem Kommentar zählt er mit — sein Ausdruck liest den Text
  // und nicht den Syntaxbaum, und er sagt das selbst.)
  router.use((_request, response) => {
    response.status(404).json({ error: "not-found" });
  });

  return router;
}
