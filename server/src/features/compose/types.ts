import type { RequestOptions } from "../../platform/agent-transport/protocol.js";

// The shapes of the compose surface (moved here from `agent/compose.ts`, #264):
// what the agent says about a stack, what the hub sends when it applies, and
// the questions and results in between. They were MEASURED against the agent
// (v0.24.0), not copied from `docs/design/phase-5-write-access.md`.

/**
 * Der Aufrufer ist immer ein Mensch.
 *
 * ⚠️ Aus demselben Grund wie bei der Datei-Fläche: der Agent schreibt den Wert
 * in sein Audit-Log, und er ist dort die einzige Spur, die von diesem Hub auf
 * eine Person zeigt. Ein `system:hub` an einer dieser Routen löschte genau
 * diese Spur — unbemerkt, weil der Aufruf gelingt. Hier ist das ein Typfehler
 * und keine Verabredung.
 *
 * ⚠️ Er gilt auch für den LESEAUFRUF. Eine Compose-Datei nennt die Struktur des
 * Hosts; wer sie liest, soll im Audit-Log stehen.
 */
export type ComposeActor = { kind: "user"; id: string };

export type ComposeRequestOptions = Omit<RequestOptions, "actor"> & { actor: ComposeActor };

/** Was `GET /containers/:id/compose-raw` über einen Stack sagt. */
export type ComposeFile = {
  projectDir: string;
  composeFileName: string;
  /** Der Verzeichnisname. Der Hub setzt ihn beim Schreiben als `confirmName`. */
  stackName: string;
  content: string;
  composeHash: string;
  /** Der IST-Zustand: Services MIT Container. Siehe Festlegung 1. */
  services: readonly string[];
  /** Was die Datei nennt. Nur Auskunft — eine Abweichung ist Zustand, kein Fehler. */
  servicesInFile: readonly string[];
  fileReadable: boolean;
  containerIds: Readonly<Record<string, string>>;
  /** Bestehende Härtungsbefunde, Form `"service:regel"`. */
  inventoryViolations: readonly string[];
};

/**
 * Die acht Schritte, die das Anwenden wirklich fährt.
 *
 * ⚠️ SIE SIND NICHT ERFUNDEN, und das ist der Punkt. Jeder steht im Agenten an
 * einer Zeile: prüfen (`src/raw-apply.ts:96`), Fragen beantworten
 * (`src/index.ts:830`), Images ziehen (`src/index.ts:871`), Datei schreiben
 * (`src/raw-apply.ts:186`), `compose up` (`src/raw-apply.ts:217`), Container
 * auflösen (`:227`), Härtung messen (`:238`), Weggefallene entfernen (`:257`).
 *
 * ⚠️ EINE ANZEIGE DARF SIE BENENNEN, ABER KEINEN VERLAUF BEHAUPTEN. Der Agent
 * antwortet auf diesem Weg mit einem einzigen JSON und schickt keine
 * Zwischenmeldung (gemessen an `src/index.ts:6258`); der Sprung von einem
 * Schritt zum nächsten ist von außen nicht sichtbar. Ein Fortschrittsbalken
 * ohne Signal gäbe beim Hängen falsche Sicherheit und wäre schlechter als ein
 * ehrliches Wort. Der Vorgang für einen Strom ist
 * `dashboard-docker-agent#86`.
 */
export const COMPOSE_APPLY_STEPS = [
  "validate",
  "confirm",
  "pull-images",
  "write",
  "start",
  "resolve-containers",
  "measure-hardening",
  "remove-containers"
] as const;

export type ComposeApplyStep = (typeof COMPOSE_APPLY_STEPS)[number];

/**
 * Warum die Service-Liste der Vorschau unsicher ist.
 *
 * ⚠️ ABSICHTLICH ENG GEFASST. `${…}` steht in fast jeder echten Compose-Datei
 * (Zeitzonen, Pfade, Ports) und ändert dort nichts an der Service-MENGE. Wer
 * jede Interpolation als Unsicherheit meldete, machte die Marke zu Rauschen,
 * und Rauschen liest niemand. Gemeldet wird deshalb nur, was die Menge der
 * Services tatsächlich verschieben kann.
 */
export type ComposeUncertainty =
  /** `extends` holt Services aus einer anderen Datei. */
  | "extends"
  /** `include` mischt ganze Dateien dazu. */
  | "include"
  /** `profiles` blendet Services aus, solange kein Profil aktiv ist. */
  | "profiles"
  /** Ein Servicename, der selbst eine Interpolation enthält. */
  | "interpolated-service-name";

/** Was den Entwurf schon vor dem Absenden ausschließt. */
export type ComposeBlocker =
  | { reason: "empty" }
  | { reason: "too-large"; bytes: number; limit: number }
  | { reason: "control-character" }
  | { reason: "invalid-yaml"; detail: string }
  | { reason: "no-services" };

/**
 * Was die Vorschau über einen Entwurf sagt.
 *
 * ⚠️ Der Entwurf in §6 von `docs/design/phase-5-write-access.md` trägt hier ein
 * `newViolations`. Das ist gemessen FALSCH: der Hub kann es nicht rechnen
 * (siehe Kopf). Statt eines Feldes, das immer leer wäre und dadurch beruhigt,
 * steht hier keines.
 */
export type ComposePreview = {
  services: {
    remaining: readonly string[];
    /** Geht als `confirmNew` hinaus. */
    added: readonly string[];
    /** Geht als `confirmRemoved` hinaus. */
    removed: readonly string[];
  };
  /** Die Befunde, die der Stack SCHON HAT. Nicht die, die er bekommen wird. */
  existingViolations: readonly string[];
  steps: readonly ComposeApplyStep[];
  uncertainties: readonly ComposeUncertainty[];
  blockers: readonly ComposeBlocker[];
};

/** Was der Hub beim Anwenden schickt. */
export type ComposeApplyInput = {
  content: string;
  expectedComposeHash: string;
  /** Der Hub setzt hier `ComposeFile.stackName` ein — der Mensch tippt ihn nicht ab. */
  stackName: string;
  confirmNew: readonly string[];
  confirmRemoved: readonly string[];
  /** Bildnamen aus dem `409` des Agenten. Der Hub bildet sie nicht selbst. */
  acknowledgeImagePull: readonly string[];
  acknowledgeHardening: readonly string[];
};

/**
 * Die Rückfragen, die der Agent stellt, statt zu schreiben.
 *
 * ⚠️ SIE SIND DER GRUND, WARUM DAS PAKET ÜBERHAUPT FUNKTIONIERT. Die Antwort
 * auf einen abgelehnten Versuch trägt die richtige Liste mit — der Aufrufer
 * muss nicht raten, sondern kann fragen. Wer sie als blanken `AgentError`
 * wegwirft, macht aus einer beantwortbaren Frage einen Fehlschlag.
 *
 * ⚠️ `rolledBack` ist nicht Zierrat. Bei `start`, `resolve-containers` und
 * `haertung` wurde die Datei BEREITS GESCHRIEBEN; `rolledBack: false` heißt,
 * dass der Host in einem Zustand steht, den niemand gewollt hat.
 *
 * ⚠️ `anchor-stale` und `image-ref-unreadable` sind Rückfragen OHNE Antwort.
 * Sie fallen in der Prüfphase, bevor ein Byte geschrieben ist, und tragen
 * deshalb kein `rolledBack`. Die Fläche zeigt sie als das, was sie sind, und
 * bietet keinen Knopf an (#113).
 */
export type ComposeQuestion =
  | { kind: "services"; added: readonly string[]; removed: readonly string[] }
  | { kind: "images"; missing: readonly string[] }
  // Only when creating a project (#3): every bind source outside its directory.
  | { kind: "external-sources"; sources: readonly string[] }
  | { kind: "hardening"; newViolations: readonly string[]; rolledBack: boolean }
  | { kind: "changed-elsewhere"; actualHash: string }
  | { kind: "start-failed"; detail: string; rolledBack: boolean }
  | { kind: "container-missing"; detail: string; rolledBack: boolean }
  | { kind: "invalid-draft"; detail: string }
  | { kind: "anchor-stale" }
  | { kind: "image-ref-unreadable"; ref: string };

export type ComposeApplyResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; question: ComposeQuestion };

/**
 * Die neun Schritte, die der Anwende-Strom meldet.
 *
 * ⚠️ SIE SIND NICHT DIESELBEN WIE `COMPOSE_APPLY_STEPS`, und die Verwechslung
 * wäre teuer. Jene Liste ist die des HUBS: acht englische Namen, die eine
 * Anzeige benennen darf, bevor irgendetwas läuft. Diese hier sind die WERTE
 * DES AGENTEN, wie sie über die Leitung kommen (`RawStep` in
 * `agent/src/raw-apply.ts`; englisch seit Vertrag 6, #278) — und es sind neun:
 * `roll-back` gibt es nur, wenn etwas schiefging, und deshalb steht es in
 * keiner Vorschau.
 *
 * ⚠️ EIN ZEHNTER WERT WIRD DURCHGEREICHT UND NICHT VERWORFEN. Diese Liste ist
 * eine gemessene Auskunft und keine Schranke: ein Schritt, den dieser Hub noch
 * nicht kennt, soll in der Anzeige stehen und nicht verschwinden. Deshalb ist
 * `ComposeStreamStep.step` eine Zeichenkette und keine Aufzählung.
 */
export const COMPOSE_STREAM_STEPS = [
  "check",
  "confirmations",
  "pull-images",
  "resolve-containers",
  "write-file",
  "start",
  "check-hardening",
  "clean-up",
  "roll-back"
] as const;

/** Die erste Zeile: die Projektsperre steht, es geht los. */
export type ComposeStreamStart = {
  projectDir: string;
  composeFileName: string;
  stackName: string;
};

/** Eine Schrittmeldung. `detail` nennt den Gegenstand, wo es einen gibt. */
export type ComposeStreamStep = { step: string; detail: string | null };

/**
 * Was der Strom melden kann, außer dem Ergebnis.
 *
 * ⚠️ `failure` HEISST ETWAS ANDERES ALS EIN ERGEBNIS MIT FEHLER. Bei einem
 * Ergebnis ist der Ausgang benannt und `rolledBack` sagt, wo der Stack steht.
 * Hier ist er UNBEKANNT: eine Ausnahme hat den Ablauf verlassen. Der Aufrufer
 * muss den Stand neu lesen, und die Fläche darf nicht „nicht angewandt" zeigen.
 */
export type ComposeStreamOptions = ComposeRequestOptions & {
  signal: AbortSignal;
  onStart?: (start: ComposeStreamStart) => void;
  /**
   * ⚠️ GIBT ER EIN PROMISE, WIRD ES ABGEWARTET (#131). Ein Arm, der viele
   * Schritte hintereinander meldet, schreibt sie über den Aufrufer an einen
   * Browser; dessen Gegendruck bremst hier das Lesen.
   */
  onStep?: (step: ComposeStreamStep) => void | Promise<void>;
  /**
   * Die `error`-Zeile des Agenten. `reason` ist sein Wort und roh; `null`,
   * wenn die Zeile keines trug (#176).
   */
  onFailure?: (failure: { reason: string | null }) => void;
  /** Der Strom steht: der Agent hat mit `200` geantwortet. */
  onOpen?: () => void;
};

// ---------------------------------------------------------------------------
// Trockenlauf — die Vorschau, die der AGENT rechnet
// ---------------------------------------------------------------------------

/** Der Service-Vergleich, wie der Agent ihn schickt. */
export type ComposeServiceDiff = {
  remaining: readonly string[];
  /**
   * ⚠️ HEISST AUF DER LEITUNG `new` UND WIRD NICHT UMBENANNT. Es ist das Feld
   * der Gegenseite, und die Namen der Gegenseite werden gespiegelt, nicht
   * übersetzt — genau wie `line` und `progress`. Ein `added` hier wäre eine
   * zweite Wahrheit, die beim ersten Vergleich mit dem Agenten auffiele.
   */
  new: readonly string[];
  removed: readonly string[];
};

/**
 * Was ein Entwurf bewirken würde — die vollständige Auskunft.
 *
 * ⚠️ `source` IST KEINE ZIERDE, SONDERN DIE WICHTIGSTE ANGABE DIESER FORM.
 * Sie sagt, WER gerechnet hat, und davon hängt ab, wie belastbar der Rest ist:
 *
 *   `agent`  Der Trockenlauf `POST /containers/:id/compose-raw-preview`
 *            (v0.21.0). Er fährt DIESELBE `inspectRawApply` wie das Anwenden;
 *            sein Urteil kann vom Anwenden nicht abweichen. `extends`,
 *            `include`, Profile und `${VAR}` sind aufgelöst, weil `docker
 *            compose config` sie auflöst.
 *   `hub`    Der eigene YAML-Parser dieses Hubs, als Rückfall für Arme unter
 *            v0.21.0. Er kennt den Bildbestand des Hosts NICHT
 *            (`missingImages: null`) und rät bei `extends` — was er nicht
 *            sicher weiß, steht in `uncertainties`.
 *
 * ⚠️ WARUM ES DEN RÜCKFALL ÜBERHAUPT NOCH GIBT. Er entstand für Arme zwischen
 * der Marke und v0.20.x: die kennen die Route nicht, und ohne Rückfall wäre
 * der Compose-Reiter dort schlicht kaputt — mit einer `404`, die wie ein
 * Fehler des Hubs aussieht.
 *
 * ⚠️ SEIT #130 IST DIESE GRUPPE LEER. `MIN_AGENT_VERSION` steht seit #279 auf `0.32.0`,
 * und ein Arm darunter wird rot und schreibgesperrt, bevor er hier ankommt —
 * der Rückfall ist damit unerreichbar. Er bleibt trotzdem stehen: die Marke
 * ist eine Zahl, die wieder sinken kann, und ein ausgebauter Rückfall wäre
 * dann ein Compose-Reiter, der nicht mehr lädt. Sein Ausbau ist ein eigener
 * Vorgang mit einer eigenen Messung, kein Nebenschritt eines Nachzugs.
 *
 * Der Preis ist ein zweiter Rechenweg; bezahlt wird er mit `source`, das ihn
 * benennt, statt beide Auskünfte gleich aussehen zu lassen.
 */
export type ComposeDryRun = {
  source: "agent" | "hub";
  /** Ob dieser Entwurf die Prüfkette bestünde. */
  valid: boolean;
  /**
   * Warum nicht — wortgleich der Fehlerschlüssel, mit dem das Anwenden
   * abbräche (`invalid-compose-file`, `no-services`,
   * `service-without-image`, `invalid-content`), der Wert des Agenten.
   */
  reason: string | null;
  /** Formfehler des Rohtexts, aus `validateRawContent`. */
  errors: readonly string[];
  /** Die Meldung von `docker compose config`, `null` wenn er durchlief. */
  configError: string | null;
  /** Die Services der normalisierten Ausgabe. `null` heißt: nicht gelesen. */
  services: readonly string[] | null;
  diff: ComposeServiceDiff | null;
  imagesByService: Readonly<Record<string, string>>;
  /**
   * Die Refs, die auf dem Host FEHLEN — beim Anwenden gehören genau sie in
   * `acknowledgeImagePull`.
   *
   * ⚠️ `null` HEISST „NICHT ERHOBEN" UND NICHT „KEINE FEHLEN". Der Unterschied
   * ist der zwischen einer beruhigenden und einer ehrlichen Anzeige: der Agent
   * erhebt sie erst, wenn der Entwurf die Schritte davor bestanden hat, und
   * der Hub kann sie nie erheben. Wer `null` wie `[]` behandelt, zeigt „nichts
   * zu ziehen" für einen Entwurf, über den das niemand weiß.
   */
  missingImages: readonly string[] | null;
  /** Services, die die Datei nennt, ohne dass sie starten könnten. */
  servicesWithoutImage: readonly string[];
  /** Was JETZT schon verletzt ist — nicht, was der Entwurf einführt. */
  inventoryViolations: readonly string[];
  /** Der Stand, auf den sich all das bezieht. */
  composeHash: string;
  stackName: string;
  currentServices: readonly string[];
  /** Die acht Schritte, die das Anwenden fährt. Immer dieselben. */
  steps: readonly ComposeApplyStep[];
  /**
   * Wo diese Auskunft raten musste.
   *
   * ⚠️ BEI `source: "agent"` IST SIE IMMER LEER, und das ist kein Versäumnis:
   * der Agent rät nicht, er führt `docker compose config` aus. Eine
   * Unsicherheit, die dort stünde, wäre erfunden.
   */
  uncertainties: readonly ComposeUncertainty[];
};

// The project `.env`, as the arm's env route answers it. The arm checks
// the compose anchor, every service and the self-management lock.
export type ProjectEnv = {
  envHash?: string | null;
  projectDir: string;
  composeFileName: string;
  filePresent: boolean;
  plaintext: boolean;
  entries: Array<{
    key: string;
    inFile: boolean;
    empty: boolean;
    value?: string;
  }>;
};
