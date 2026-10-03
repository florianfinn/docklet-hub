// Die Herkunftsprüfung: eine reine Funktion über die Kopfzeilen einer Anfrage.
//
// Wogegen sie steht (docs/design/phase-5-write-access.md §1): der Betreiber
// sitzt im eigenen Netz und ist am Hub angemeldet. Eine fremde Seite in
// seinem Browser stellt eine Anfrage hierher, der Browser hängt das
// Sitzungs-Cookie an, die Sitzung ist gültig, die Rolle ist Admin — und die
// Wirkung tritt ein, ohne dass irgendwo ein Fehler steht.
//
// Warum `cors()` das nicht abdeckt: CORS regelt, wer eine Antwort LESEN darf,
// nicht, wer eine Wirkung AUSLÖSEN darf. Im Ablehnungsfall lässt es den
// Antwortkopf weg; die Anfrage selbst ist da längst gelaufen. Und warum
// `SameSite=Lax` am Sitzungs-Cookie nicht genügt: Lax hält andere *Sites* ab,
// und das Hauptdashboard auf einer Nachbar-Subdomain ist keine andere Site —
// es ist die naheliegendste Startrampe, die es hier gibt. Deshalb wird
// `same-site` abgelehnt und nicht nur `cross-site`.
//
// Diese Datei kennt weder Express noch das Netz. Das ist Absicht: so ist jede
// einzelne Zeile der Bedingungsliste aus §1 ohne Server prüfbar
// (`request-origin.test.ts`, ein Fall je Tabellenzeile). Die Zwischenschicht
// daneben (`request-origin-guard.ts`) trifft keine Entscheidung, sie fragt
// nur hier nach.
//
// ⚠️ Was NICHT hierher gehört: eine Protokollierung des Rumpfs einer
// abgelehnten Anfrage. Bei einer fremd ausgelösten Anfrage stammt der Rumpf
// von der fremden Seite; ein Log, das ihn aufnimmt, nimmt auf, was jemand
// anderes hineinschreibt (§1, „Was in kein Log gehört"). Der `Origin` darf
// hinaus — er steht ohnehin in jedem Proxy-Log dazwischen.

/**
 * Das Ergebnis der Prüfung. Der Grund benennt die Bedingung, an der die
 * Anfrage gescheitert ist, und wird nur zum Verstehen gebraucht — die Antwort
 * ist in allen vier Fällen dieselbe (`403`).
 */
export type OriginDecision =
  | { allowed: true }
  // `no-browser-headers`: ein eigener Grund des Hubs (Bezeichnerregel,
  // AGENTS.md) und keine gespiegelte Protokollangabe — anders als
  // `sec-fetch-site`, `origin` und `referer`, die die Kopfzeile benennen, an
  // der die Anfrage gescheitert ist, benennt dieser Wert das Fehlen ALLER
  // DREI: weder `Sec-Fetch-Site` noch `Origin` noch `Referer` war gesetzt.
  | { allowed: false; reason: "sec-fetch-site" | "origin" | "referer" | "no-browser-headers" };

/**
 * Die GET-Routen MIT WIRKUNG — die eine Liste, die auch der Wächter
 * `web/tests/api-read-only.test.mjs` liest (§1: eine Liste an zwei Orten läuft
 * auseinander, und genau daraus entstand Befund S1 des Agenten).
 *
 * ⚠️ „WIRKUNG" MEINT HIER ZWEIERLEI, und seit Etappe B4b-K (#5) steht das
 * ausgeschrieben da, statt stillschweigend gedehnt zu werden. Bis dahin trug
 * diese Liste genau eine Sorte Route, und ihre Überschrift las sich danach
 * („die trotz GET den Zustand ändern"):
 *
 *   1. **Der Zustand ändert sich.** `GET /hosts/:hostId/archive` rotiert bei
 *      jedem Aufruf Schlüsselpaar, Agent-Secret und Token.
 *   2. **Eine gedeckelte, GETEILTE Ressource wird belegt — oder es entsteht
 *      eine Spur unter fremdem Namen.** `GET
 *      /hosts/:hostId/containers/:containerId/logs-stream` ändert am Host und
 *      am Container nichts und ist trotzdem keine Leseanfrage wie jede andere:
 *      sie nimmt einem Arm einen seiner gleichzeitigen Ströme weg und
 *      schreibt in dessen Audit-Log einen Eintrag unter der Kennung des
 *      angemeldeten Menschen.
 *
 * Der Grundsatz, aus dem die zweite Sorte folgt: **eine Fähigkeit, die ein
 * Fremder unter dem Namen des Betreibers auslösen kann, ist nicht dadurch
 * harmlos, dass er ihre Antwort nicht lesen kann.** Wer „Wirkung" auf
 * „Zustandsänderung" verengt, prüft am Ende genau die Routen nicht, deren
 * Schaden nicht im Datenbestand steht, sondern in einem Kontingent und in
 * einem fremden Protokoll.
 *
 * ⚠️ Die Bedeutung dieser Liste ist damit weiter als die Zusage, die der
 * Wächter je Eintrag prüft. Er verlangt für Sorte 1 `requireAdmin` und für
 * Sorte 2 `withSession` — nicht, weil die zweite schwächer geprüft wäre,
 * sondern weil Logs lesen eine Fähigkeit der Rolle User ist (§4). Für die
 * Herkunftsprüfung hier sind beide Sorten dasselbe: prüfpflichtig.
 *
 * Die Pfade sind Muster in der Schreibweise der Routenanmeldung
 * (`:name` je Parameter) und tragen KEIN `/api`: gemessen am 2026-09-07 mit
 * einem Wegwerf-Server (`app.use("/api", router)`, `router.use` schreibt die
 * Werte mit) liefert `request.path` innerhalb des gemounteten Routers
 * `/hosts/abc/archive`, während `/api/hosts/abc/archive` nur in
 * `request.originalUrl` steht. Belegt im Bestand durch den Fall
 * „request.path innerhalb des gemounteten Routers trägt kein /api" in
 * `request-origin-routing.test.ts`.
 */
export const GET_ROUTES_WITH_EFFECT: readonly string[] = [
  // `GET /hosts/:hostId/archive`, denn er rotiert bei jedem Aufruf
  // Schlüsselpaar, Agent-Secret und Token und setzt den Host auf `pending`
  // zurück (docs/design/phase-4-bootstrap-and-registration.md §4). Ein
  // `<img src="…/hosts/<id>/archive">` auf einer fremden Seite, geöffnet vom
  // angemeldeten Betreiber, sperrt damit einen Arm aus.
  "/hosts/:hostId/archive",

  // `GET /hosts/:hostId/containers/:containerId/logs-stream` (Etappe B4b-K,
  // #5) — der Eintrag der Sorte 2 aus dem Kopf dieser Liste.
  //
  // GEMESSEN, nicht angenommen: ohne diesen Eintrag griff `hasEffect` nicht,
  // und eine fremd ausgelöste Anfrage erreichte den Arm in JEDER Herkunft —
  // `cross-site`, `same-site`, `same-origin` und ganz ohne
  // `Sec-Fetch-Site` antworteten alle mit `200`, der Arm wurde kontaktiert,
  // und der Aufrufer im Kopf `x-docker-agent-actor` lautete auf den
  // angemeldeten Menschen. Der realistische Weg ist der, den §1 selbst als
  // „naheliegendste Startrampe" benennt: eine Nachbar-Subdomain ist
  // `same-site`, das Sitzungsmerkmal geht bei `SameSite=Lax` mit ihr mit, und
  // die Herkunftsprüfung griff bei einem GET ohne Wirkungseintrag nicht.
  //
  // Was am Arm dann zweierlei geschieht:
  //
  //   1. Die Anfrage belegt einen der `openStreams`-Plätze, und die sind
  //      nicht für Logs reserviert: `tryAcquire()` steht am Agenten an drei
  //      Stellen (`logs-stream`, `log-file`, `pull-stream`). `MAX_OPEN_STREAMS` gehaltene
  //      Ströme legen ALLE DREI Endpunkte für ALLE Nutzer dieses Arms auf
  //      `429`.
  //   2. Sie schreibt einen Audit-Eintrag mit `outcome: "allowed"` unter der
  //      Kennung des angemeldeten Menschen. Der Wert aus
  //      `x-docker-agent-actor` ist im Audit-Log des Arms die einzige Spur,
  //      die auf eine Person zeigt — und sie zeigte auf jemanden, der nichts
  //      getan hat.
  //
  // ⚠️ UND WAS NICHT GESCHIEHT, damit es nicht größer klingt, als es ist:
  // es gibt KEINE AUSLEITUNG. Die fremde Seite kann den Rumpf des Stroms
  // nicht lesen (dagegen steht die Same-Origin-Policy, und genau dafür ist
  // sie da), und weder Container- noch Host-Zustand ändern sich. Der Schaden
  // ist Ressourcenbelegung plus falsch zugeordnete Audit-Einträge — das ist
  // Grund genug für diesen Eintrag und kein Grund für ein grösseres Wort.
  //
  // ⚠️ WAS DIESER EINTRAG NICHT AUSSPERRT, und auch das ist gemessen (Etappe
  // B4b-K, 2026-09-07): den eigenen Aufrufer. `streamContainerLogs`
  // (`web/src/features/logs/api.ts`) ruft den Pfad RELATIV zum Dokument auf; der
  // Browser setzt damit `Sec-Fetch-Site: same-origin`, und das ist Zeile 2
  // der Tabelle aus §1 — durchlassen. Einen Aufrufer von `/api` ohne
  // Browser-Kopfzeilen gibt es im Bestand nicht: die Healthchecks aus
  // `docker-compose.yml` und `server/Dockerfile` fahren auf `/health` und
  // nicht auf `/api`, und der Anmeldeweg der Arme ist eine eigene Anwendung
  // auf einem eigenen Zuhörer (`server/src/index.ts`, `registrationServer`).
  "/hosts/:hostId/containers/:containerId/logs-stream",

  // `GET /hosts/:hostId/containers/:containerId/stats` (#213) — Sorte 2. Sie
  // ruft die Einzelansicht des Agenten (`GET /containers/:id`), und die
  // schreibt bei einer Ablehnung einen Audit-Eintrag unter der Kennung des
  // angemeldeten Menschen. Eine fremde Seite könnte so Einträge zu beliebigen
  // Container-Kennungen unter seinem Namen erzeugen.
  "/hosts/:hostId/containers/:containerId/stats",

  // ── Die vier lesenden Routen der Datei-Fläche (Paket B5, Etappe E3, #5) ───
  //
  // Alle vier sind Sorte 2 aus dem Kopf dieser Liste, und zwar in ihrer
  // zweiten Hälfte: ES ENTSTEHT EINE SPUR UNTER FREMDEM NAMEN. Gemessen an
  // `src/index.ts` des Agenten (v0.19.1), an den `audit.write`-Aufrufen der
  // vier Handler: jede dieser Anfragen schreibt beim Arm ein Audit-Ereignis mit
  // `outcome: "allowed"` unter dem Wert aus `x-docker-agent-actor` — und der
  // lautet auf den angemeldeten Menschen (`domain/hosts/container-access.ts` setzt ihn aus
  // der Sitzung). Ohne diese Einträge griffe `hasEffect` nicht, und eine fremde
  // Seite könnte im Protokoll eines Arms Zeilen erzeugen, die auf jemanden
  // zeigen, der nichts getan hat.
  //
  // Der Grundsatz, wörtlich aus docs/design/phase-5-write-access.md §1: EINE
  // FÄHIGKEIT, DIE EIN FREMDER UNTER DEM NAMEN DES BETREIBERS AUSLÖSEN KANN,
  // IST NICHT DADURCH HARMLOS, DASS ER IHRE ANTWORT NICHT LESEN KANN.
  //
  // ⚠️ DER PREIS EINES EINTRAGS, und er ist hier VOR dem Eintragen geprüft:
  // diese Liste lässt nur `same-origin`, `none` und einen `Origin` durch, der
  // sich über den `Host` ausweist — ein Aufrufer OHNE Browser-Kopfzeilen wird
  // abgelehnt. Wer eine Route hier einträgt, muss also wissen, wer sie ruft.
  // Für diese vier ist die Antwort dieselbe wie beim Log-Strom: die eigene
  // Oberfläche über ein relatives `fetch`, also `same-origin` (Zeile 2 der
  // Tabelle aus §1). Etappe E5 baut sie; einen Aufrufer von `/api` ohne
  // Browser-Kopfzeilen gibt es im Bestand nicht — die Healthchecks fahren auf
  // `/health`, und der Anmeldeweg der Arme ist eine eigene Anwendung auf einem
  // eigenen Zuhörer.
  //
  // ⚠️ SIE STEHEN HIER ZUSÄTZLICH ZU `requireAdmin` UND NICHT AN DESSEN
  // STELLE. Diese Liste beantwortet „welche Herkunft darf auslösen?", nicht
  // „wer darf?"; beide Fragen an derselben Liste zu beantworten, wird beim
  // ersten Sonderfall falsch. Keiner dieser vier Pfade steht deshalb in
  // `SESSION_ONLY_GET_WITH_EFFECT` (`web/tests/api-read-only.test.mjs`) — sie
  // tragen `requireAdmin` als erste Zwischenschicht, weil eine Freigabe eine
  // Betreiberentscheidung ist (§4, Tabelle „Fähigkeit / Rolle").

  // Nennt die Bind-Mounts des Containers, also die Struktur des Hosts. Beim
  // Agenten deshalb `intern-only`; Audit-Handler `share-candidates`.
  "/hosts/:hostId/containers/:containerId/share-candidates",

  // Die Verzeichnisliste der Freigabe; Audit-Handler `webftp-list`.
  "/hosts/:hostId/containers/:containerId/files",

  // Der Download einer Datei; Audit-Handler `webftp-download`. Er belegt
  // zusätzlich Übertragungszeit des Arms, und zwar für eine Datei beliebiger
  // Größe: `MAX_UPLOAD_BYTES` deckelt nur die Gegenrichtung — Sorte 2 in
  // BEIDEN Hälften.
  "/hosts/:hostId/containers/:containerId/file",

  // Die Textdatei im Editor; Audit-Handler `webftp-text-read`.
  "/hosts/:hostId/containers/:containerId/file-text",

  // ── Die gewählte Freigabe lesen (Paket B5, Etappe E5b, #5) ───────────────
  //
  // ⚠️ SIE STEHT HIER AN EINER MESSUNG UND NICHT AM GEFÜHL, und die Messung
  // ist die einzige Frage, die zählt: SPRICHT DER HANDLER DEN ARM AN? Er tut
  // es. `GET …/share` beantwortet zwar eine Frage an die eigene Datenbank,
  // ruft dafür aber `openContainerAccess` (`domain/hosts/container-access.ts`) — und das holt die
  // Container-Liste beim Arm, weil `container_share` je CONTAINERNAME liegt
  // und der Pfad eine Container-ID trägt. Dieser Aufruf schreibt beim Agenten
  // einen Audit-Eintrag mit `outcome: "allowed"` unter dem Wert aus
  // `x-docker-agent-actor`, also unter dem angemeldeten Menschen. Damit ist es
  // dieselbe Sorte 2 wie die vier darüber: eine Spur unter fremdem Namen.
  //
  // ⚠️ HÄTTE DER HANDLER DEN ARM NICHT ANGESPROCHEN, GEHÖRTE ER NICHT HIERHER.
  // Ein GET, der nur die eigene Ablage liest, hinterlässt keine Spur und
  // belegt keine gedeckelte Ressource. Diese Liste beantwortet „darf eine
  // fremde Seite das auslösen?" und nicht „wer darf?" — die Rollenfrage steht
  // eine Zwischenschicht weiter vorn (`requireAdmin`), und beide an derselben
  // Liste zu beantworten ist die Falle, an der `api-read-only` schon einmal
  // falsch wurde.
  "/hosts/:hostId/containers/:containerId/share",

  // ── Die Compose-Datei lesen (Befund 1 aus #117, #118) ────────────────────
  //
  // `GET /hosts/:hostId/containers/:containerId/compose` fehlte hier und hing
  // allein hinter `requireAdmin`. GEMESSEN gegen den echten Router: eine
  // Anfrage ohne Browser-Kopfzeilen wurde mit `200` beantwortet, der Arm unter
  // `actor=user:<admin>` kontaktiert, und in seinem Audit-Log stand
  // `compose-raw-read` mit `outcome: "allowed"`.
  //
  // Sie ist Sorte 2 in ihrer zweiten Hälfte — ES ENTSTEHT EINE SPUR UNTER
  // FREMDEM NAMEN —, und zwar an zwei Aufrufen: der Handler ruft
  // `openContainerAccess` (`domain/hosts/container-access.ts`) für die Zuordnung
  // Container-Id zu Container und danach `readComposeFile`
  // (`features/compose/agent-client.ts`,
  // `GET /containers/:id/compose-raw`). Beide tragen den Wert aus
  // `x-docker-agent-actor`, und der lautet auf den angemeldeten Menschen.
  //
  // ⚠️ WAS NICHT GESCHIEHT, damit der Eintrag seine Größe behält: die fremde
  // Seite LIEST die Compose-Datei nicht. Sie steht im Rumpf einer Antwort, an
  // die jene Seite nicht herankommt — dagegen steht die Same-Origin-Policy, und
  // genau dafür ist sie da. Ein Kontingent belegt dieser Leseaufruf ebenfalls
  // nicht: `openStreams.tryAcquire()` steht am Agenten am ANWENDE-STROM
  // (`compose-raw-stream`, v0.22.0) und nicht am lesenden `compose-raw`. Der
  // Schaden ist die Spur unter fremdem Namen — dieselbe wie bei den fünf
  // Einträgen darüber und Grund genug für diese Zeile.
  //
  // ⚠️ DER PREIS, wie bei den anderen VOR dem Eintragen geprüft: `fetchCompose`
  // (`web/src/features/compose/api.ts`) ruft den Pfad relativ zum Dokument auf, der
  // Browser setzt damit `Sec-Fetch-Site: same-origin`, und das ist Zeile 2 der
  // Tabelle aus §1 — durchlassen. Einen Aufrufer von `/api` ohne
  // Browser-Kopfzeilen gibt es im Bestand nicht.
  //
  // ⚠️ NUR DER LESENDE PFAD STEHT HIER. `POST …/compose` und
  // `POST …/compose/preview` sind ohnehin prüfpflichtig (die Methode genügt),
  // und `/compose/preview` trägt ein Segment mehr — der Abgleich ist
  // segmentweise, dieser Eintrag trifft ihn also nicht.
  "/hosts/:hostId/containers/:containerId/compose",
  "/hosts/:hostId/containers/:containerId/compose/env",
  // The candidates of the compose selection (#185): `openContainerAccess` and
  // then `GET /containers/:id/compose-candidates` at the arm, which logs the
  // call under the name of the signed-in person (`audit: "compose-candidates"`
  // in `agent/src/route-policy.ts`). Sort 2, like the two above.
  "/hosts/:hostId/containers/:containerId/compose/candidates"
];

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Trifft ein konkreter Anfragepfad ein Routenmuster?
 *
 * ⚠️ Diese Funktion gibt es, weil ein Vergleich auf Gleichheit hier IMMER ins
 * Leere liefe: in der Liste steht das Muster `/hosts/:hostId/archive`, an der
 * Schranke kommt `/hosts/abc123/archive` an. Die Lücke sähe dabei aus wie eine
 * geschlossene Tür — die Liste wäre gepflegt, der Abgleich träfe nie.
 *
 * Die Regel: segmentweise, `:name` trifft genau ein nicht leeres Segment,
 * jedes feste Segment wird OHNE Rücksicht auf Groß- und Kleinschreibung
 * verglichen.
 *
 * ⚠️ DER GRUNDSATZ, an dem diese Funktion hängt: **die Schranke darf nie
 * enger treffen als der Router.** Sie muss mindestens alles erfassen, was
 * Express auf dieselbe Route führt — sonst ist jede Schreibweise, die der
 * Router noch annimmt und die Schranke schon nicht mehr, eine offene Tür.
 *
 * Gemessen am 2026-09-07 gegen Express 5.2.1 (echter Server, Router unter
 * `/api` gemountet, `app.get("/hosts/:hostId/archive", …)`, ein mitzählender
 * Handler; Urteil von `decideRequestOrigin` bei `Sec-Fetch-Site: cross-site`):
 *
 * | angefragt                       | Status | im Router als        |
 * | ------------------------------- | ------ | -------------------- |
 * | `/api/hosts/abc/archive`        | 200    | `/hosts/abc/archive` |
 * | `/api/HOSTS/abc/ARCHIVE`        | 200    | `/HOSTS/abc/ARCHIVE` |
 * | `/api/Hosts/abc/Archive`        | 200    | `/Hosts/abc/Archive` |
 * | `/api/hosts/abc/%61rchive`      | 404    | —                    |
 * | `/api/%68osts/abc/archive`      | 404    | —                    |
 * | `/api/hosts/abc/archive/`       | 200    | `/hosts/abc/archive/`|
 * | `/api/hosts/abc/archive?x=1`    | 200    | `/hosts/abc/archive` |
 * | `/api//hosts/abc/archive`       | 404    | —                    |
 *
 * Daraus folgen genau drei Dinge, und nur diese drei:
 *
 *   1. **Groß- und Kleinschreibung.** Express routet in der Vorgabe ohne
 *      Rücksicht darauf (`caseSensitive` steht auf `false`). Ein
 *      zeichengenauer Vergleich ließe `<img src="…/api/HOSTS/<id>/ARCHIVE">`
 *      auf einer fremden Seite durch — und der GET rotiert Schlüsselpaar,
 *      Agent-Secret und Token. Deshalb `toLowerCase()` auf den FESTEN
 *      Segmenten.
 *   2. **Ein abschliessender `/`** wird vorher abgeschnitten, und zwar genau
 *      einer: `/api/hosts/abc/archive/` erreicht denselben Handler (`200`).
 *   3. **Die Abfrage (`?…`)** steht gar nicht erst in `request.path` — der
 *      Router sieht `/hosts/abc/archive`. Hier ist nichts zu tun.
 *
 * ⚠️ Die PROZENTKODIERUNG ist ausdrücklich KEIN Fall, und das ist gemessen
 * und nicht angenommen: `/api/hosts/abc/%61rchive` und
 * `/api/%68osts/abc/archive` beantwortet Express mit `404` — sie erreichen
 * den Handler nie, also gibt es dort auch nichts abzuwehren. Der Messweg für
 * die nächste Etappe, damit sie es nicht erneut herleiten muss: einen
 * Express-Server mit dieser einen Route starten, `app.use("/api", router)`,
 * die acht Zeilen oben per `fetch` abfragen und Status plus `request.path`
 * mitschreiben. Eine Entkodierung hier hinzuzufügen wäre eine Schranke, die
 * WEITER trifft als der Router — sie wehrte Pfade ab, die es nicht gibt, und
 * verdeckte die Frage, welche Schreibweise wirklich ankommt.
 *
 * ⚠️ DER ZWEITE WEG IST INZWISCHEN GEGANGEN, und dieser hier bleibt trotzdem.
 * Seit Etappe B4b-F (#5) legt `createApiRouter` den Router als
 * `Router({ caseSensitive: true })` an — die Behebung an der Wurzel: eine
 * Route trifft nur noch unter ihrer eigenen Schreibweise. Die Zeilen 2 und 3
 * der Tabelle oben messen damit die VORGABE von Express und nicht mehr diesen
 * Router.
 *
 * Der Vergleich HIER bleibt davon unberührt und wird ausdrücklich NICHT
 * zeichengenau gemacht. Der Grundsatz oben sagt warum: die Schranke darf nie
 * enger treffen als der Router. Wer beide Seiten gleichzeitig verengt, hängt
 * die Sicherheit wieder an ihrer Übereinstimmung — und die nächste Stelle, die
 * doch wieder unempfindlich routet (ein zweiter Router ohne die Option, ein
 * Proxy davor, ein `use` mit Präfix), liefe an einer Schranke vorbei, die
 * inzwischen zu eng geworden ist. Breiter zu treffen als der Router kostet
 * hier nichts: die Schranke lehnt dann höchstens einen Pfad ab, den es
 * ohnehin nicht gibt.
 */
export function matchesRoutePattern(pattern: string, path: string): boolean {
  const patternSegments = trimTrailingSlash(pattern).split("/");
  const pathSegments = trimTrailingSlash(path).split("/");
  if (patternSegments.length !== pathSegments.length) return false;

  for (let index = 0; index < patternSegments.length; index += 1) {
    const expected = patternSegments[index] ?? "";
    const actual = pathSegments[index] ?? "";
    if (expected.startsWith(":")) {
      // Ein Parameter trifft genau EIN Segment — und kein leeres. Ohne diese
      // zweite Hälfte träfe `/hosts//archive` das Muster, obwohl Express es
      // (gemessen am 2026-09-07) mit `404` beantwortet.
      if (actual === "") return false;
      continue;
    }
    // Ein festes Segment: ohne Rücksicht auf Groß- und Kleinschreibung, weil
    // der Router es genauso liest (Messung oben, Zeile 2 und 3 der Tabelle).
    // `toLowerCase` und nicht `toLocaleLowerCase`: der Vergleich darf nicht
    // von der Spracheinstellung des Servers abhängen.
    if (expected.toLowerCase() !== actual.toLowerCase()) return false;
  }
  return true;
}

function trimTrailingSlash(value: string): string {
  return value.length > 1 && value.endsWith("/") ? value.slice(0, -1) : value;
}

/**
 * Ändert diese Anfrage etwas — und ist damit prüfpflichtig?
 *
 * Die Methode ist hier NICHT das alleinige Kriterium: geprüft wird jede
 * Methode ausser GET/HEAD/OPTIONS **und zusätzlich** jede Route aus
 * `GET_ROUTES_WITH_EFFECT`. Eine wörtliche Übernahme der Methodenregel wäre
 * ein Loch mit Namen (§1).
 */
function hasEffect(method: string, path: string): boolean {
  if (!SAFE_METHODS.has(method.toUpperCase())) return true;
  return GET_ROUTES_WITH_EFFECT.some((pattern) => matchesRoutePattern(pattern, path));
}

/**
 * Weist sich der `Origin` über den `Host` der Anfrage aus?
 *
 * Verglichen wird `host` der URL und damit Name UND Port — ein `Origin` mit
 * anderem Port ist eine andere Herkunft. Ein `Origin`, der keine URL ist
 * (etwa der Wortlaut `null`, den ein Browser bei undurchsichtiger Herkunft
 * sendet), scheitert hier und fällt damit auf Zeile 8 der Tabelle: fail
 * closed.
 *
 * Dieselbe Prüfung dient dem `Referer` (Zeile 6). Er ist eine volle URL mit
 * Pfad und Abfrage, aber `host` liest daraus genau dasselbe wie aus einem
 * `Origin` — Name und Port, sonst nichts.
 */
function originMatchesHost(origin: string, host: string | undefined): boolean {
  if (!host) return false;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  return parsed.host.toLowerCase() === host.toLowerCase();
}

/**
 * Die Bedingungsliste aus §1, in ihrer Reihenfolge. Die Nummern sind die
 * Zeilennummern der Tabelle dort; die Tests tragen sie im Namen.
 */
export function decideRequestOrigin(request: {
  method: string;
  path: string;
  headers: { secFetchSite?: string; origin?: string; referer?: string; host?: string };
}): OriginDecision {
  // Zeile 1 — GET/HEAD/OPTIONS und nicht in der Liste der GETs mit Wirkung:
  // durchlassen. Ohne Wirkung gibt es nichts auszulösen.
  if (!hasEffect(request.method, request.path)) return { allowed: true };

  const secFetchSite = request.headers.secFetchSite;

  if (secFetchSite !== undefined && secFetchSite !== "") {
    // Zeile 2 — die eigene Oberfläche.
    if (secFetchSite === "same-origin") return { allowed: true };
    // Zeile 3 — kein Seitenkontext, also vom Menschen selbst ausgelöst
    // (Adresszeile, Lesezeichen). Eine fremde Seite kann diesen Wert nicht
    // erzeugen: Link, Formular, Skript und selbst eine Weiterleitungskette
    // tragen immer den auslösenden Kontext.
    if (secFetchSite === "none") return { allowed: true };
    // Zeile 4 — jeder andere Wert: 403. ⚠️ Auch `same-site`. Genau hier geht
    // die Regel über das `SameSite=Lax` des Sitzungs-Cookies hinaus.
    return { allowed: false, reason: "sec-fetch-site" };
  }

  const origin = request.headers.origin;

  if (origin === undefined || origin === "") {
    // ⚠️ DER REGELFALL DER EIGENEN OBERFLÄCHE ÜBER REINES HTTP, und nicht ein
    // alter Browser. Ein Browser sendet `Sec-Fetch-Site` nur in einem sicheren
    // Kontext (HTTPS oder `localhost`), und `Origin` setzt er bei einem GET
    // aus derselben Herkunft gar nicht. Gemessen am 2026-09-29 im Browser
    // gegen `http://192.0.2.31:8090`: `isSecureContext` war `false`, und
    // der relative `fetch` auf `…/logs-stream` wie auf `…/files` bekam
    // `403 forbidden-origin` — Protokoll- und Datei-Reiter gingen auf JEDEM
    // Arm nicht, die Anfrage erreichte den Arm nie.
    //
    // Zeile 6 — dann trägt der `Referer`: weist er sich über den `Host` der
    // Anfrage aus, durchlassen. Ein Skript kann ihn nicht setzen (verbotene
    // Kopfzeile), und eine fremde Seite kann ihn nur UNTERDRÜCKEN — dann fällt
    // die Anfrage auf Zeile 7. Er deckt auch die Navigationen ab, bei denen
    // ein eigener Kopf der Oberfläche nicht hülfe: `<a download>` für Dateien
    // und das Setup-Archiv.
    const referer = request.headers.referer;
    if (referer !== undefined && referer !== "") {
      if (originMatchesHost(referer, request.headers.host)) return { allowed: true };
      return { allowed: false, reason: "referer" };
    }

    // Zeile 7 — weder `Sec-Fetch-Site` noch `Origin` noch `Referer`: 403.
    // Anders als im Quellsystem, und der Grund steht in §1 („Der
    // Maschinen-Aufrufer"): dieser Hub hat keinen. Der Anmeldeweg der Arme ist
    // eine eigene Anwendung mit genau einer Route auf einem eigenen Listener
    // und läuft nicht über diesen Router. Was über `/api` kommt, kommt aus
    // einem Browser — und headerlos ist die billigste Anfrage, die ein Skript
    // stellen kann.
    return { allowed: false, reason: "no-browser-headers" };
  }

  // Zeile 5 — kein `Sec-Fetch-Site`, aber ein `Origin`, der sich über den
  // `Host` der Anfrage ausweist: durchlassen. Über reines HTTP ist das der
  // Weg jeder schreibenden Anfrage der eigenen Oberfläche.
  if (originMatchesHost(origin, request.headers.host)) return { allowed: true };

  // Zeile 8 — sonst: 403. Fail closed, auch bei einem `Origin`, der keine
  // URL ist.
  return { allowed: false, reason: "origin" };
}
