import type {
  ComposeApplyInput,
  ComposeDryRun,
  ComposeQuestion
} from "./api";

// Der Zustand des Anwendens — als reine Rechnung, ohne React.
//
// ⚠️ WARUM DAS HIER UND NICHT IM BAUTEIL STEHT. Was ein Entwurf noch braucht,
// bevor er hinausgehen darf, ist die schwierigste Frage dieser Fläche: die
// Prüfung des Agenten ist GENAUE MENGENGLEICHHEIT, nicht Teilmenge. Eine
// Bestätigung für einen Namen, den der Diff nicht kennt, macht den Aufruf
// ungültig — genauso wie eine fehlende. In einem Bauteil zwischen Zustand und
// Auszeichnung wäre das nicht zu prüfen; hier ist es eine Funktion mit einem
// Test daneben.

/**
 * Was der Betreiber bestätigt hat.
 *
 * ⚠️ VIER LISTEN UND NICHT EIN HAKEN. Der Agent fragt vier verschiedene Dinge,
 * und sie entstehen zu verschiedenen Zeitpunkten: neue und entfallende
 * Services kennt die Vorschau, fehlende Images kennt nur der Arm (und auch er
 * erst, wenn der Entwurf die Prüfung besteht), und neue Härtungsverstösse
 * entstehen ERST NACH dem `up` — sie können vorher grundsätzlich nicht
 * dastehen.
 */
export type Confirmations = {
  services: ReadonlySet<string>;
  removed: ReadonlySet<string>;
  images: ReadonlySet<string>;
  hardening: ReadonlySet<string>;
};

export const NO_CONFIRMATIONS: Confirmations = {
  services: new Set(),
  removed: new Set(),
  images: new Set(),
  hardening: new Set()
};

/** Was ein Entwurf laut Vorschau bestätigen lassen muss. */
export type Demands = {
  services: readonly string[];
  removed: readonly string[];
  /**
   * Die fehlenden Images — oder `null`, wenn sie NICHT ERHOBEN wurden.
   *
   * ⚠️ `null` IST NICHT `[]`. Bei einem Arm ohne Trockenlauf und bei einem
   * Entwurf, der schon vorher scheitert, weiß niemand, welche Images fehlen.
   * Die Fläche darf dann nicht „keine" behaupten — sie sagt, dass der Arm
   * danach fragen wird.
   */
  images: readonly string[] | null;
};

export function demandsOf(preview: ComposeDryRun): Demands {
  return {
    services: preview.diff?.new ?? [],
    removed: preview.diff?.removed ?? [],
    images: preview.missingImages
  };
}

/**
 * Warum das Anwenden noch nicht gehen darf — oder `null`.
 *
 * ⚠️ SIE PRÜFT GENAUE MENGENGLEICHHEIT UND NICHT „ALLES ANGEHAKT". Ein Haken
 * an einem Namen, den die Vorschau gar nicht mehr nennt (der Betreiber hat
 * nach dem Anhaken weitergetippt), ist für den Agenten genauso ungültig wie
 * ein fehlender. Wer hier nur zählt, schickt einen Aufruf hinaus, der mit
 * `service-confirmation-missing` zurückkommt — und der Betreiber sieht eine
 * Ablehnung, obwohl er alles angehakt hat.
 */
export type Blocker =
  | { reason: "invalid"; detail: string }
  | { reason: "unconfirmed-services"; missing: readonly string[] }
  | { reason: "unconfirmed-removed"; missing: readonly string[] }
  | { reason: "unconfirmed-images"; missing: readonly string[] }
  | { reason: "stale-confirmation" }
  | { reason: "unchanged" };

export function blockerOf(
  preview: ComposeDryRun,
  confirmations: Confirmations,
  changed: boolean
): Blocker | null {
  if (!changed) return { reason: "unchanged" };
  if (!preview.valid) return { reason: "invalid", detail: preview.reason ?? "" };

  const demands = demandsOf(preview);

  const missingServices = demands.services.filter((name) => !confirmations.services.has(name));
  if (missingServices.length > 0) return { reason: "unconfirmed-services", missing: missingServices };

  const missingRemoved = demands.removed.filter((name) => !confirmations.removed.has(name));
  if (missingRemoved.length > 0) return { reason: "unconfirmed-removed", missing: missingRemoved };

  // ⚠️ `null` SPERRT NICHT. Sind die fehlenden Images nicht erhoben, kann der
  // Betreiber sie nicht bestätigen — der Arm fragt dann nach, und die Antwort
  // kommt aus SEINER Liste. Hier zu sperren hieße, einen Weg zu verschliessen,
  // der offen ist.
  if (demands.images !== null) {
    const missingImages = demands.images.filter((ref) => !confirmations.images.has(ref));
    if (missingImages.length > 0) return { reason: "unconfirmed-images", missing: missingImages };
  }

  // ⚠️ ÜBERZÄHLIGE HAKEN sind für die Service-Listen genauso tödlich wie
  // fehlende. Sie entstehen ganz gewöhnlich: anhaken, weitertippen, der Service
  // heißt jetzt anders.
  const known = new Set([...demands.services, ...demands.removed, ...(demands.images ?? [])]);
  const extra = [...confirmations.services, ...confirmations.removed, ...confirmations.images].some(
    (name) => !known.has(name)
  );
  if (extra) return { reason: "stale-confirmation" };

  return null;
}

/** Der Rumpf, der hinausgeht. */
export function applyInputOf(
  content: string,
  expectedComposeHash: string,
  confirmations: Confirmations
): ComposeApplyInput {
  return {
    content,
    expectedComposeHash,
    confirmNew: [...confirmations.services],
    confirmRemoved: [...confirmations.removed],
    acknowledgeImagePull: [...confirmations.images],
    acknowledgeHardening: [...confirmations.hardening]
  };
}

/**
 * Was eine Rückfrage des Arms an den Bestätigungen ändert.
 *
 * ⚠️ SIE ÜBERNIMMT DIE LISTEN DES ARMS UNVERÄNDERT und bildet keine eigenen.
 * Welche Images fehlen und welche Härtungsverstösse neu sind, weiß nur er; die
 * Prüfung ist Mengengleichheit, und eine selbst zusammengestellte Liste wird
 * abgelehnt. Was diese Funktion tut, ist ausschliesslich: die Antwort des Arms
 * an die Stelle legen, an der der nächste Versuch sie mitschickt.
 *
 * ⚠️ SIE BEANTWORTET NICHT JEDE FRAGE. `changed-elsewhere` heißt, dass jemand
 * anderes die Datei geschrieben hat — dagegen hilft keine Bestätigung, sondern
 * nur neu laden. `start-failed` und `container-missing` sind Zustände des
 * Hosts. Für die gibt es `null`, und die Fläche zeigt sie als das, was sie
 * sind. `anchor-stale` heißt, dass der Stack aus der Übersicht neu zu öffnen
 * ist, `image-ref-unreadable`, dass die Angabe im Entwurf zu berichtigen ist —
 * auch dafür gibt es `null`.
 */
export function answered(current: Confirmations, question: ComposeQuestion): Confirmations | null {
  switch (question.kind) {
    case "services":
      return {
        ...current,
        services: new Set(question.added),
        removed: new Set(question.removed)
      };
    case "images":
      return { ...current, images: new Set(question.missing) };
    case "hardening":
      return { ...current, hardening: new Set(question.newViolations) };
    default:
      return null;
  }
}

/**
 * Einen Namen an- oder abhaken.
 *
 * ⚠️ SIE STEHT HIER UND NICHT IM BAUTEIL, und dafür gibt es zwei Gründe. Der
 * eine ist sachlich: sie ist reine Mengenlogik und gehört zu den Rechnungen
 * dieser Datei. Der andere ist gemessen — `web/tests/ui-texts.test.mjs` sucht
 * in `.tsx`-Dateien nach Textknoten (`>Text<`) und hielt die Typannotation
 * `ReadonlySet<string>, value: string): Set<string>` für einen: zwischen dem
 * schliessenden und dem öffnenden spitzen Klammerpaar steht Text. Der
 * Fehlalarm ist im Kopf jenes Wächters als bekannte Grenze benannt. Hier
 * erreicht er die Funktion nicht, weil er `.ts` gar nicht liest.
 */
export function toggled(set: ReadonlySet<string>, value: string): Set<string> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

/**
 * Ob nach dem Anwenden die Warnung über den Abgleich der Allowlist steht (#179).
 *
 * Jeder Status, den der Hub liefern kann, ist hier entschieden: die fünf aus
 * `HostCycleStatus` (`server/src/domain/hosts/host-cycle.ts`), dazu `skipped`
 * aus `server/src/features/compose/service.ts`, wenn kein Abgleich verdrahtet ist, und `null`, wenn
 * die Ergebniszeile keinen trug (#176).
 *
 * ⚠️ `unchanged` WARNT NICHT. Der Hub hat die Liste frisch aus dem Bestand des
 * Arms gerechnet, und sie gleicht der, die dieser Prozess zuletzt geschickt
 * und der Agent quittiert hat. Der Fingerabdruck ist nach `containerId`
 * sortiert (`registryFingerprint`): hat das Anwenden Container neu erzeugt,
 * sind die Ids neu und der Status heißt `synced`. `unchanged` bleibt nur, wenn
 * die Ids dieselben sind — dann steht beim Agenten schon die richtige Liste.
 *
 * Die eine Lücke, die `unchanged` offen lässt, ist #123: ein Agent, der seine
 * Liste seit der Quittung verloren hat. Sie hat mit dem Anwenden nichts zu
 * tun, und die Warnung hier sähe sie nicht — sie hat keine andere Quelle als
 * denselben Fingerabdruck.
 *
 * Unbekannte Werte warnen: ein Status, den diese Tabelle nicht kennt, ist kein
 * Beleg für eine stimmende Liste.
 */
export const RESYNC_SETTLED: Readonly<Record<string, boolean>> = {
  synced: true,
  unchanged: true,
  pending: false,
  unreachable: false,
  failed: false,
  skipped: false
};

export function resyncWarns(status: string | null): boolean {
  if (status === null) return true;
  return !Object.hasOwn(RESYNC_SETTLED, status) || !RESYNC_SETTLED[status];
}
