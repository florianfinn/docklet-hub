// Die Entscheidungslogik der Migrationen — ohne Datenbank.
//
// Warum getrennt vom Ausführen: AGENTS.md verlangt, dass Tests ohne echte
// Dienste laufen. Ein Migrationswerkzeug, das sich nur gegen ein laufendes
// Postgres prüfen lässt, wäre in diesem Repo ungeprüft. Alles, was schiefgehen
// kann, ohne dass eine Zeile SQL läuft — Reihenfolge, Lücken, nachträglich
// geänderte Migrationen, ein Rückschritt in der Nummerierung — wird deshalb
// hier entschieden und hier getestet. `migrate.ts` führt nur noch aus, was
// diese Datei beschlossen hat.
//
// Die vier Regeln aus AGENTS.md („Datenbank") sind hier Code, nicht Absatz:
//   1. nur vorwärts          → `PlanError` bei einer Nummer unter dem Stand
//   2. beim Start, nicht von Hand → siehe migrate.ts
//   3. Reihenfolge = Name    → sortiert wird nach der Nummer, nicht nach Text
//   4. Wahrheit ist die Folge → eine bereits angewandte Datei, die verschwindet
//                               oder sich ändert, hält den Start an

// `NNN-thema.sql`: mindestens drei Ziffern, damit die Sortierung nicht bei der
// zehnten Migration kippt, und ein Bindestrich als Trenner. Der Thementeil ist
// für Menschen da; entschieden wird über die Nummer.
const FILE_PATTERN = /^(\d{3,})-[a-z0-9]+(?:-[a-z0-9]+)*\.sql$/;

export type AvailableMigration = {
  filename: string;
  checksum: string;
};

export type AppliedMigration = {
  filename: string;
  checksum: string;
};

export type PlannedMigration = {
  filename: string;
  order: number;
  checksum: string;
};

export class PlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanError";
  }
}

function parseOrder(filename: string): number {
  const match = FILE_PATTERN.exec(filename);
  if (!match) {
    throw new PlanError(
      `Migrationsdatei „${filename}" folgt nicht dem Muster NNN-thema.sql (mindestens drei Ziffern, Kleinbuchstaben, Bindestriche).`
    );
  }
  return Number(match[1]);
}

/**
 * Entscheidet, welche Migrationen laufen — und ob überhaupt gestartet werden
 * darf. Wirft bei jeder Unstimmigkeit, statt sie zu übergehen: eine Migration,
 * die still übersprungen wird, hinterlässt ein Schema, das niemand mehr aus
 * der Folge herleiten kann.
 */
export function planMigrations(
  available: readonly AvailableMigration[],
  applied: readonly AppliedMigration[]
): PlannedMigration[] {
  // Kein einziger Kandidat ist kein gültiger Zustand, sondern ein Packfehler.
  //
  // Dieses Repo liefert seit der ersten Fassung mindestens eine Migration aus.
  // Ein leeres Verzeichnis entsteht deshalb nicht durch Absicht, sondern durch
  // ein Image, in das die .sql-Dateien nicht mitkopiert wurden — `tsc`
  // übersetzt nur TypeScript, das Dockerfile muss sie eigens holen.
  //
  // ⚠️ Ohne diese Prüfung ist genau das die gefährlichste Art zu scheitern:
  // der Hub startet, legt ein LEERES Schema an und meldet „Schema aktuell".
  // Der Fehler fällt dann erst der Phase auf, die die erste Tabelle erwartet —
  // und dort sieht er aus wie ein Fehler dieser Phase.
  if (available.length === 0) {
    throw new PlanError(
      "Kein Migrationsverzeichnis mit Inhalt gefunden. Dieses Repo liefert immer mindestens eine Migration aus — " +
        "ein leeres Verzeichnis bedeutet, dass die .sql-Dateien nicht mit ins Image kopiert wurden."
    );
  }

  const parsed = available.map((entry) => ({
    filename: entry.filename,
    checksum: entry.checksum,
    order: parseOrder(entry.filename)
  }));

  // Zwei Dateien mit derselben Nummer: welche zuerst läuft, entschiede das
  // Dateisystem. Das ist genau die Abhängigkeit von Namensglück, die die Regel
  // ausschließt.
  const byOrder = new Map<number, string>();
  for (const entry of parsed) {
    const existing = byOrder.get(entry.order);
    if (existing !== undefined) {
      throw new PlanError(
        `Zwei Migrationen tragen die Nummer ${entry.order}: „${existing}" und „${entry.filename}". Die Reihenfolge wäre nicht bestimmt.`
      );
    }
    byOrder.set(entry.order, entry.filename);
  }

  parsed.sort((a, b) => a.order - b.order);

  const availableByName = new Map(parsed.map((entry) => [entry.filename, entry]));

  // Was bereits lief, muss unverändert dastehen. Beides ist derselbe Befund
  // aus zwei Richtungen: das Schema in der Datenbank lässt sich aus den
  // vorliegenden Dateien nicht mehr herleiten.
  for (const done of applied) {
    const onDisk = availableByName.get(done.filename);
    if (!onDisk) {
      throw new PlanError(
        `Migration „${done.filename}" ist in dieser Datenbank angewandt, liegt aber nicht mehr im Verzeichnis. ` +
          "Eine ausgelieferte Migration wird nicht entfernt — was falsch war, korrigiert die nächste."
      );
    }
    if (onDisk.checksum !== done.checksum) {
      throw new PlanError(
        `Migration „${done.filename}" wurde nach dem Anwenden geändert (Prüfsumme weicht ab). ` +
          "Eine ausgelieferte Migration wird nicht mehr angefasst — was falsch war, korrigiert die nächste."
      );
    }
  }

  const appliedNames = new Set(applied.map((entry) => entry.filename));
  const pending = parsed.filter((entry) => !appliedNames.has(entry.filename));

  // Der Vorwärts-Riegel: eine neue Migration darf nicht unter dem bereits
  // erreichten Stand einsortiert werden. Sonst liefe sie auf einer frischen
  // Datenbank vor ihren Nachbarn und auf einer bestehenden nach ihnen — zwei
  // Datenbanken, dieselbe Folge, verschiedenes Ergebnis.
  const highestApplied = applied.reduce((highest, entry) => {
    const order = parseOrder(entry.filename);
    return order > highest ? order : highest;
  }, 0);
  for (const entry of pending) {
    if (entry.order < highestApplied) {
      throw new PlanError(
        `Migration „${entry.filename}" trägt die Nummer ${entry.order} und liegt damit unter dem bereits angewandten Stand ${highestApplied}. ` +
          "Migrationen laufen nur vorwärts; diese Datei bekommt eine Nummer über dem Stand."
      );
    }
  }

  return pending;
}
