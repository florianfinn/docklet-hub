// ⚠️ Die Reihenfolge der Importe ist BEDEUTUNG und keine Formatierung: der DOM
// muss stehen, bevor React geladen wird (siehe `dom-harness.tsx`). Wer hier
// alphabetisch sortiert, bekommt „document is not defined".
import { renderInDom, settle, settleQueries } from "./dom-harness.js";

// ⚠️ React steht hier NAMENTLICH, obwohl keine Zeile es aufruft — `tsx`
// übersetzt das JSX dieser Datei mit dem alten Laufzeitmodell
// (`React.createElement`). Die Begründung samt Messung steht im Kopf von
// `language-switch.test.tsx`.
import React from "react";

import { MemoryRouter, Route, Routes } from "react-router";

import type { ContainerShare, FileListing, ShareCandidate, WebftpEntry } from "../src/features/files/api.js";
import { AppLanguageProvider } from "../src/app/i18n/AppLanguageProvider.js";
import { FilesView } from "../src/features/files/FilesView.js";

// Der Prüfstand der Datei-Fläche: die Attrappe des Hubs, das Einhängen und die
// Gesten — seit Etappe B5-E5b (Nachtrag) aus `files-view.test.tsx`
// ausgelagert.
//
// Warum: jene Datei stand mit einundzwanzig Fällen bei 1.052 Zeilen und riss
// damit die Marke aus `source-file-size.test.mjs` (LIMIT 1000). Aufgeteilt ist
// nicht die Marke, sondern die Datei — dieselbe Bewegung wie bei
// `client-files.mjs` und (bis #248) `mirrored-shapes.mjs`: was VORRICHTUNG ist und kein
// Prüfschritt, wandert unter eigenem Namen daneben. Die Fälle liegen jetzt in
// zwei Dateien nach ihrer Frage: `files-view.test.tsx` fragt „welches
// Verzeichnis wird gezeigt?", `files-view-actions.test.tsx` fragt „was lässt
// sich darin tun?".
//
// ⚠️ DER DATEINAME TRÄGT KEIN `.test.` — der Weblauf ist
// `node --import tsx --test "tests/**/*.test.{mjs,tsx}"`, und eine Hilfsdatei,
// die dieses Muster träfe, würde als Testdatei eingesammelt und meldete „keine
// Tests" (dieselbe Erklärung steht am Kopf von `dom-harness.tsx`).
//
// ⚠️ HIER STEHT KEIN `assert` UND KEIN `test`. Diese Datei behauptet nichts,
// sie stellt nur her; jede Zusage steht in einer der beiden Falldateien. Eine
// Vorrichtung, die selbst prüft, prüft in jeder Datei mit, die sie einbindet —
// und niemand liest dann noch nach, was eigentlich zugesichert ist.
//
// ⚠️ KEIN `assert.equal(<DOM-Knoten>, null)` IN DEN FALLDATEIEN, und das ist
// gemessen: im grünen Fall geht es durch, im ROTEN reicht `assert` den
// gefundenen Knoten an seine Fehlerausgabe — und unter happy-dom hängt daran
// der halbe Fensterbaum mit Zyklen. Gemessen viermal am 2026-09-07: Läufe von
// 71, 82 und 840 Sekunden, zuletzt SIGKILL, ohne den Fall überhaupt zu nennen.
// Verglichen wird deshalb ein `boolean` (`assert.ok(x === null, "…")`).

export const HOST_ID = "host-1";
export const CONTAINER_ID = "container-1";

/** Ein Eintrag, wie der Arm ihn schickt. `changedAt` in SEKUNDEN. */
export function entry(overrides: Partial<WebftpEntry> & { name: string }): WebftpEntry {
  return {
    kind: "file",
    size: 512,
    // 2026-05-04T12:00:00Z in SEKUNDEN. Als Millisekunden gelesen ergäbe das
    // den 21. Januar 1970 — daran hängt Fall 3.
    changedAt: 1_777_982_400,
    uid: 0,
    gid: 0,
    ...overrides
  };
}

export function listing(overrides: Partial<FileListing> = {}): FileListing {
  return {
    share: "daten",
    path: "",
    entries: [],
    truncated: false,
    diagnostics: { readable: true, deletable: true, uid: 0, gid: 0, uploadable: true },
    ...overrides
  };
}

/**
 * Eine abgesendete Anfrage samt dem Status, mit dem sie beantwortet wurde.
 *
 * ⚠️ DER STATUS GEHÖRT DAZU, seit die Fläche die Freigabe direkt liest
 * (Etappe E5b, Nachtrag). Die Zusage „der Reiter zeigt die Wahl, OHNE dass eine
 * Anfrage gescheitert ist" lässt sich nur an ihm prüfen: eine Fassung, die
 * wieder über das Scheitern der Liste geht, zeigt dieselbe Wahl und wäre an
 * jedem Fall grün, der nur auf das Bild schaut.
 */
export type Call = { method: string; url: string; body: string | null; status: number };

/**
 * Was die Attrappe auf `GET …/file-text` antwortet.
 *
 * `hash` ist der Wert, der beim Speichern als `expectedHash` zurückkommen MUSS
 * — daran hängt der wichtigste Fall dieser Datei.
 */
export type TextFile = { content: string; hash: string };

/**
 * Was beim nächsten `PUT …/file-text` geschehen soll.
 *
 * `{ ok: hash }` heißt: gespeichert, und die Datei trägt jetzt diesen Hash.
 * `{ conflict: hash }` heißt: `409` mit `file-changed` UND dem JETZIGEN Hash —
 * genau die Form, die der Server sendet.
 */
export type SaveOutcome = { ok: string } | { conflict: string };

/**
 * Der Hub als Attrappe.
 *
 * ⚠️ SIE BILDET DIE ROUTEN NACH UND ERFINDET SIE NICHT. `GET …/files` gibt
 * `{ listing }` oder — ohne gewählte Freigabe — eine `409` mit
 * `{ error: "share-unset" }`; `GET …/share-candidates` gibt `{ candidates }`;
 * `PUT …/share` gibt `{ share }`; `DELETE …/share` gibt `204` ohne Rumpf.
 * Alles vier am Router abgelesen (`server/src/features/files/routes.ts`,
 * Freigaben wie Dateien), und `failWith` schickt `{ error, message }`
 * (`server/src/app/router-support.ts`).
 *
 * `listings` ist eine Zuordnung von Pfad zu Antwort — so lässt sich ein
 * Hineingehen prüfen, ohne dass die Attrappe raten müsste.
 *
 * ⚠️ SEIT ETAPPE E5b BILDET SIE AUCH DIE VIER SCHREIBENDEN WEGE NACH, und
 * zwar in ihrer echten Form: `GET …/file-text` gibt `{ text }`;
 * `PUT …/file-text` nimmt den TEXT als rohen Rumpf und gibt `{ hash }` oder
 * eine `409` mit `{ error: "file-changed", message, hash }`; `PUT …/file`
 * nimmt BYTES und gibt `{ uploaded }`; `POST …/files` nimmt JSON und gibt
 * `{ done }`. Eine Attrappe, die den Konflikt als schlichte `409` ohne Hash
 * schickte, ließe den Fall unten grün werden, obwohl der Editor dem Betreiber
 * nichts anzubieten hätte.
 *
 * ⚠️ DIE REIHENFOLGE DER VERGLEICHE IST BEDEUTUNG. `…/file-text` steht VOR
 * `…/file`, sonst schluckte der Upload-Zweig die Anfrage des Editors; und
 * `POST …/files` wird über die METHODE von `GET …/files` getrennt, nicht über
 * den Pfad — beide heißen gleich. Dasselbe an `…/share`: `GET` gibt die
 * GEWÄHLTE Freigabe (oder `null`), `PUT` die soeben gespeicherte.
 *
 * ⚠️ `share` STEHT VORGEGEBEN AUF „ES GIBT EINE, WENN ES LISTEN GIBT". Das ist
 * kein Trick, sondern die Lage nachgestellt: ein Container mit einer
 * Verzeichnisliste hat eine gewählte Freigabe, einer ohne hat keine. Ein Fall,
 * der beides auseinanderziehen will — Freigabe gesetzt, Liste antwortet
 * trotzdem `share-unset` —, gibt `share` ausdrücklich an; genau das ist der
 * Rückfall, den `FilesView` offen hält.
 */
/**
 * Ein laufender Upload, den der Fall von Hand weitertreibt.
 *
 * ⚠️ ER LÄUFT NICHT VON SELBST DURCH, und das ist der ganze Zweck: Fortschritt
 * und Abbruch sind Zustände MITTEN im Senden. Eine Attrappe, die sofort
 * antwortet, ließe beide Fälle nie entstehen — der Balken wäre schon weg,
 * bevor ein Fall ihn suchen kann, und die Abbruchtaste stünde nie da.
 */
export type Upload = {
  method: string;
  url: string;
  /** Wie viele Bytes gesendet wurden — für den Balken. */
  progress: (sent: number, total: number) => Promise<void>;
  /** Die Quittung des Servers: `{ uploaded }` mit `200`. */
  finish: (name: string, size: number) => Promise<void>;
  /** Eine Fehlerantwort, etwa die `413` des Arms. */
  fail: (status: number, body: unknown) => Promise<void>;
  /** Ob `xhr.abort()` gerufen wurde — die Zusage „die Leitung geht wirklich zu". */
  aborted: () => boolean;
};

/** Ein Empfänger von Ereignissen — so viel `EventTarget`, wie hier gebraucht wird. */
class Listeners {
  private readonly byType = new Map<string, ((event: unknown) => void)[]>();

  // ⚠️ DIE NAMEN SIND DIE DES BROWSERS und nicht kürzere: `uploadContainerFile`
  // ruft `xhr.upload.addEventListener` auf. Ein `add` daneben wäre ein
  // TypeError im Rumpf der Zusage — und der käme als abgelehnter Upload an,
  // nicht als kaputte Attrappe.
  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.byType.set(type, [...(this.byType.get(type) ?? []), listener]);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.byType.set(type, (this.byType.get(type) ?? []).filter((known) => known !== listener));
  }

  emit(type: string, event: unknown): void {
    for (const listener of [...(this.byType.get(type) ?? [])]) listener(event);
  }
}

/**
 * `XMLHttpRequest` als Attrappe — nur so viel davon, wie `uploadContainerFile`
 * benutzt.
 *
 * ⚠️ WARUM ÜBERHAUPT: der Upload läuft seit #136 über `XMLHttpRequest` und
 * nicht mehr über `fetch`, weil `fetch` den Fortschritt des SENDENS nicht
 * meldet (Begründung in `web/src/features/files/api.ts`). Eine Attrappe, die nur `fetch`
 * ersetzt, ließe den echten `XMLHttpRequest` von happy-dom gegen `hub.test`
 * laufen — der Fall bräuchte dann ein Netz und wäre damit keiner (AGENTS.md,
 * „Tests laufen ohne echte Dienste").
 */
class FakeUpload {
  status = 0;
  statusText = "";
  responseText = "";
  withCredentials = false;
  readonly upload = new Listeners();
  private readonly own = new Listeners();
  /** Adresse und Methode stehen offen: der Prüfstand schreibt sie in `calls`. */
  method = "";
  url = "";
  private closed = false;
  private wasAborted = false;

  constructor(private readonly register: (request: FakeUpload) => void) {}

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(): void {
    // Die Kopfzeilen prüft dieser Prüfstand nicht — der Fall liest Adresse,
    // Methode und Ausgang.
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.own.addEventListener(type, listener);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.own.removeEventListener(type, listener);
  }

  send(): void {
    this.register(this);
  }

  abort(): void {
    if (this.closed) return;
    this.closed = true;
    this.wasAborted = true;
    this.own.emit("abort", {});
  }

  /**
   * Der Griff, den der Fall bekommt.
   *
   * ⚠️ JEDE BEWEGUNG LÄUFT DURCH `React.act`, und das ist gemessen: ohne das
   * meldet React „An update to FileUpload inside a test was not wrapped in
   * act(…)" auf stderr, und der Fall liest danach einen Baum, der noch nicht
   * neu gezeichnet ist. Dasselbe tut `click` weiter unten für die Gesten.
   */
  handle(record: Call): Upload {
    const emit = async (target: Listeners, type: string, event: unknown) => {
      await React.act(async () => {
        target.emit(type, event);
      });
      await settle();
    };
    return {
      method: this.method,
      url: this.url,
      progress: (sent, total) =>
        emit(this.upload, "progress", { lengthComputable: true, loaded: sent, total }),
      finish: async (name, size) => {
        if (this.closed) return;
        this.closed = true;
        this.status = 200;
        record.status = 200;
        this.responseText = JSON.stringify({ uploaded: { ok: true, name, size } });
        await emit(this.own, "load", {});
      },
      fail: async (status, body) => {
        if (this.closed) return;
        this.closed = true;
        this.status = status;
        record.status = status;
        this.responseText = JSON.stringify(body);
        await emit(this.own, "load", {});
      },
      aborted: () => this.wasAborted
    };
  }
}

export function stubHub(options: {
  listings?: Record<string, FileListing>;
  candidates?: ShareCandidate[];
  texts?: Record<string, TextFile>;
  /** Die Antworten auf die Speicherversuche, der Reihe nach. */
  saves?: SaveOutcome[];
  /** Was `GET …/share` antwortet. Vorgabe: aus `listings` abgeleitet. */
  share?: ContainerShare | null;
  /**
   * Die Grenze des Arms, die im Umschlag von `GET …/files` mitkommt (#136).
   *
   * ⚠️ SIE STEHT IM UMSCHLAG UND NICHT IN `listing` — am Router abgelesen
   * (`server/src/features/files/routes.ts`). Eine Attrappe, die sie in die
   * Liste legte, ließe eine Fläche grün werden, die im Betrieb `undefined`
   * bekommt.
   */
  maxUploadBytes?: number;
  /**
   * Ab der wievielten `GET …/files` die Antwort OFFEN bleibt — die erste ist
   * die `1`.
   *
   * ⚠️ EINE ANFRAGE, DIE OFFEN BLEIBT, IST DER EINZIGE WEG ZU EINEM
   * ZWISCHENSTAND. Die Attrappe antwortet sonst im selben Zug: was die Fläche
   * WÄHREND des Holens zeigt, entsteht gar nicht erst, und ein Fall darüber
   * wäre grün gegen jede Fassung.
   *
   * ⚠️ GEZÄHLT WIRD DIE ANFRAGE UND NICHT DER PFAD. Beide Fälle, die das
   * brauchen, unterscheiden sich nur darin, WELCHE Anfrage die zweite ist —
   * das Hineingehen in ein Verzeichnis und das Neuholen nach einer Handlung.
   * Ein Halten je Pfad träfe das Neuholen desselben Verzeichnisses nicht.
   */
  holdFrom?: number;
}): { calls: Call[]; uploads: Upload[]; restore: () => void } {
  const original = globalThis.fetch;
  const originalUpload = globalThis.XMLHttpRequest;
  const calls: Call[] = [];
  const uploads: Upload[] = [];
  // 64 MiB — der heutige Wert von `MAX_UPLOAD_BYTES`. Er steht hier als Zahl
  // und nicht als Import: die Attrappe spielt den SERVER, und was sie schickt,
  // ist eine Antwort und keine zweite Deklaration. Ein Fall, der an einer
  // bestimmten Grenze hängt, gibt sie selbst an.
  const maxUploadBytes = options.maxUploadBytes ?? 64 * 1024 * 1024;
  // Wie oft `GET …/files` schon gefragt wurde — gebraucht von `holdFrom`.
  let listed = 0;

  globalThis.XMLHttpRequest = class extends FakeUpload {
    constructor() {
      super((request) => {
        // Der Rumpf ist ein `File` und keine Zeichenkette — `Call.body` bleibt
        // deshalb `null`, wie bei jedem anderen rohen Rumpf auch. Was ein Fall
        // hier prüft, sind Adresse, Methode und Ausgang.
        const record: Call = { method: request.method, url: request.url, body: null, status: 0 };
        calls.push(record);
        uploads.push(request.handle(record));
      });
    }
  } as unknown as typeof XMLHttpRequest;
  const listings = options.listings ?? {};
  const texts = options.texts ?? {};
  const saves = [...(options.saves ?? [])];
  const chosen =
    options.share === undefined
      ? Object.keys(listings).length === 0
        ? null
        : { containerName: "demo", path: "daten" }
      : options.share;

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    // Der Rumpf wird MITGESCHRIEBEN: bei `POST …/files` steht die Aktion
    // darin, und ein Test, der nur die Adresse liest, könnte „anlegen" nicht
    // von „löschen" unterscheiden. Der STATUS ebenso — daran hängt die Zusage
    // „ohne dass eine Anfrage gescheitert ist".
    const seen: Call = { method, url, body: typeof init?.body === "string" ? init.body : null, status: 200 };
    calls.push(seen);

    const json = (payload: unknown, status = 200) => {
      seen.status = status;
      return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
    };

    const query = url.includes("?") ? new URLSearchParams(url.slice(url.indexOf("?") + 1)) : new URLSearchParams();
    const at = query.get("path") ?? "";

    if (url.includes("/file-sources")) return Promise.resolve(json({ sources: [] }));
    if (url.includes("/share-candidates")) {
      return Promise.resolve(json({ candidates: options.candidates ?? [] }));
    }
    if (url.includes("/share")) {
      if (method === "DELETE") {
        seen.status = 204;
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      // ⚠️ `GET` und `PUT` sind hier NICHT dasselbe: der eine liest die
      // gewählte Freigabe (`null`, wenn keine gewählt ist), der andere gibt die
      // gerade gespeicherte zurück und kann kein `null` liefern.
      if (method === "GET") return Promise.resolve(json({ share: chosen }));
      return Promise.resolve(json({ share: { containerName: "demo", path: "daten" } }));
    }
    if (url.includes("/file-text")) {
      if (method === "PUT") {
        const outcome = saves.shift() ?? { ok: "hash-danach" };
        if ("conflict" in outcome) {
          return Promise.resolve(
            json(
              {
                error: "file-changed",
                message: "Die Datei hat sich seit dem Laden geändert.",
                hash: outcome.conflict
              },
              409
            )
          );
        }
        return Promise.resolve(json({ hash: outcome.ok }));
      }
      const text = texts[at];
      if (text === undefined) {
        return Promise.resolve(json({ error: "not-found", message: "Diesen Pfad gibt es nicht." }, 404));
      }
      return Promise.resolve(json({ text: { path: at, content: text.content, hash: text.hash } }));
    }
    // ⚠️ HIER STAND DER ZWEIG FÜR `PUT …/file`, und er ist seit #136 weg: der
    // Upload läuft über `XMLHttpRequest` und nicht mehr über `fetch`. Ein
    // Rückfall auf `fetch` fiele damit in die `404` ganz unten — und das ist
    // die richtige Wirkung: eine Fassung, die den Fortschritt wieder verliert,
    // wird rot, statt still grün zu bleiben.
    if (url.includes("/files")) {
      if (method === "POST") return Promise.resolve(json({ done: { name: null, kind: null } }));
      // Die Anfrage, die offen bleibt — siehe `holdFrom`. Sie wird
      // mitgeschrieben (oben) und antwortet nie.
      listed += 1;
      if (options.holdFrom !== undefined && listed >= options.holdFrom) {
        return new Promise<Response>(() => undefined);
      }
      // Der Pfad steht als Abfrageteil, und ein fehlender bedeutet die Wurzel.
      const found = listings[at];
      if (found === undefined) {
        return Promise.resolve(
          json({ error: "share-unset", message: "Für diesen Container ist keine Freigabe gewählt." }, 409)
        );
      }
      return Promise.resolve(json({ listing: found, maxUploadBytes }));
    }
    return Promise.resolve(json({}, 404));
  }) as typeof fetch;

  return {
    calls,
    uploads,
    restore: () => {
      globalThis.fetch = original;
      globalThis.XMLHttpRequest = originalUpload;
    }
  };
}

/**
 * Die Fläche unter einer Adresse einhängen — das, was ein NEULADEN tut.
 *
 * ⚠️ DER ROUTENPFAD STEHT HIER ALS LITERAL und ist aus
 * `web/src/app/routes/AppRoutes.tsx` übernommen. Zwei Fassungen derselben Adresse,
 * die gegeneinander laufen: wer die Route dort ändert, ohne hier nachzuziehen,
 * findet unten nichts mehr.
 */
export async function mountAt(path: string) {
  const mounted = await renderInDom(
    <AppLanguageProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path="/container/:hostId/:name/files"
            element={<FilesView hostId={HOST_ID} containerId={CONTAINER_ID} />}
          />
        </Routes>
      </MemoryRouter>
    </AppLanguageProvider>
  );
  // The first pass hangs on a promise: without it only "querying" stands
  // there. Settled until no query is in flight (`settleQueries`): the editor
  // reads its text through Query since #271, one step after the listing.
  await settleQueries(mounted.queryClient);
  return mounted;
}

export function at(testId: string): HTMLElement | null {
  const element = document.body.querySelector(`[data-testid="${testId}"]`);
  return element instanceof HTMLElement ? element : null;
}

export function all(testId: string): HTMLElement[] {
  return [...document.body.querySelectorAll(`[data-testid="${testId}"]`)].filter(
    (node): node is HTMLElement => node instanceof HTMLElement
  );
}

/** Der sichtbare Text der ganzen Fläche — für die Sätze aus den Sprachdateien. */
export function shownText(): string {
  return document.body.textContent ?? "";
}

/**
 * Ob einer der beiden Sätze dasteht.
 *
 * ⚠️ BEIDE SPRACHEN, denn welche gilt, hängt am Browser des Laufs
 * (`LanguageProvider` nimmt ohne Anmeldung die des Browsers). Ein Test, der
 * sich auf eine festlegte, wäre auf einem anders eingestellten Rechner rot,
 * ohne dass etwas kaputt wäre. Dieselbe Bauart wie in
 * `container-screen.test.tsx`.
 */
export function saysEither(german: string, english: string): boolean {
  return shownText().includes(german) || shownText().includes(english);
}

/**
 * Ein Klick — die Geste, auf die ein Radix-`Dialog` wirklich hört.
 *
 * ⚠️ GEMESSEN AM 2026-09-07 UND NICHT ANGENOMMEN: der Auslöser eines
 * Radix-`Dialog` hängt an `click` und öffnet auf `pointerdown` NICHT (dieser
 * Fall meldete „die Rückfrage vor dem Löschen steht nicht da"). Das ist der
 * Unterschied zum `DropdownMenu` und zum `Select` aus
 * `marks-assign.test.tsx`, die umgekehrt auf `pointerdown` hören und auf einen
 * Klick nicht reagieren. Wer die Geste von dort hierher überträgt, bekommt
 * einen Test, der gegen einen nie geöffneten Dialog rot wird — und das sieht
 * aus, als sei der Dialog kaputt.
 *
 * ⚠️ DER TEST PASST SICH DEM ERZEUGNIS AN UND NICHT UMGEKEHRT. Der
 * Bestätigungsdialog ist ein Radix-`Dialog` wie der beim Entfernen eines Arms
 * (`features/hosts/HostCard.tsx`, D4) — ein eigenes Menü daneben zu bauen, weil
 * der Prüfstand mit dem echten nicht umgeht, brächte dem Betreiber eine
 * Bedienung ohne Tastatur ein.
 */
export async function click(element: HTMLElement): Promise<void> {
  await React.act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await settle();
}

/**
 * Eine Datei im versteckten Dateifeld wählen — die Geste, die sonst der
 * Dateidialog des Browsers macht.
 *
 * ⚠️ `input.files` WIRD ÜBER `defineProperty` GESETZT und nicht zugewiesen.
 * Die Eigenschaft ist in jedem Browser schreibgeschützt, und happy-dom hält
 * sich daran; eine schlichte Zuweisung liefe still ins Leere, und der Fall
 * prüfte danach eine Fläche, an der nie eine Datei gewählt wurde.
 *
 * ⚠️ DAS EREIGNIS HEISST `change`. Für ein `<input type="file">` hört React
 * darauf und nicht auf `input` — mit dem falschen Namen liefe `onChange` nie,
 * und der Fall wäre grün gegen eine Fläche, die die Wahl gar nicht bemerkt.
 */
export async function chooseFile(field: HTMLInputElement, file: File): Promise<void> {
  Object.defineProperty(field, "files", { value: [file], configurable: true });
  await React.act(async () => {
    field.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settle();
}

/**
 * Eine Datei bekannter Größe — der Inhalt ist gleichgültig, die Bytezahl nicht.
 *
 * ⚠️ DIE GRÖSSE ENTSTEHT AUS DEM INHALT und wird nicht behauptet: `File.size`
 * ist abgeleitet und lässt sich nicht setzen. Ein `x` ist ein Byte in UTF-8.
 */
export function fileOfSize(name: string, bytes: number): File {
  return new File(["x".repeat(bytes)], name);
}

/**
 * In ein Textfeld schreiben, so wie React es mitbekommt.
 *
 * ⚠️ EIN `element.value = …` REICHT NICHT. React merkt sich den zuletzt
 * gesetzten Wert am Knoten; eine direkte Zuweisung sähe für den nächsten
 * `input` wie „unverändert" aus, und `onChange` liefe nie. Deshalb der Setter
 * vom Prototyp und danach ein echtes `input`-Ereignis.
 */
export async function typeInto(element: HTMLTextAreaElement | HTMLInputElement, value: string): Promise<void> {
  const prototype =
    element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  await React.act(async () => {
    setter?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
}

/** Die Anfragen an eine Route, in der Reihenfolge ihres Absendens. */
export function asked(server: { calls: Call[] }, method: string, part: string): Call[] {
  return server.calls.filter((call) => call.method === method && call.url.includes(part));
}
