import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { planMigrations } from "./migration-plan.js";

// Wächter über die FOLGE der Migrationen — nicht über eine einzelne.
//
// Er stand bis 005 als letzter Fall in host-schema.test.ts und war dort auf
// „004-host-enrollment.sql" festgeschrieben: er sicherte zu, dass diese Datei
// die neueste ist und dass sie auf einer bestehenden Datenbank als einzige
// nachläuft. Beide Zusicherungen sind richtig — aber sie gelten immer nur für
// die JEWEILS neueste Datei. Mit jeder neuen Migration hätte man sie
// umschreiben müssen, und ein Fall, den man bei jeder Änderung mitzieht, wird
// irgendwann mitgezogen, ohne dass jemand liest, was er behauptet.
//
// ⚠️ Der Fall ist deshalb nicht abgeschaltet, sondern verallgemeinert: er
// bestimmt die neueste Datei SELBST aus dem Verzeichnis. Was vorher für eine
// Datei galt, gilt jetzt für jede — auch für die nächste, die niemand mehr
// hier eintragen muss.
//
// Geprüft werden die beiden Wege, auf denen eine Datenbank in dieses Schema
// kommt:
//
//   1. frisch — es läuft alles, in der Reihenfolge der Nummern;
//   2. bestehend — es läuft genau das nach, was noch fehlt.
//
// Der zweite Weg ist der, der still schiefgeht: eine neue Migration mit einer
// zu niedrigen Nummer liefe auf einer frischen Datenbank vor ihren Nachbarn
// und auf einer bestehenden nach ihnen. Der Vorwärts-Riegel in
// migration-plan.ts wirft dann — dieser Fall ist die Stelle, an der das
// auffällt.

const DIRECTORY = new URL("./migrations/", import.meta.url);

/** Die Nummer, über die entschieden wird. Der Thementeil ist für Menschen da. */
function orderOf(filename: string): number {
  const match = /^(\d{3,})-/.exec(filename);
  assert.ok(match, `Migrationsdatei „${filename}" beginnt nicht mit einer Nummer aus mindestens drei Ziffern`);
  return Number(match[1]);
}

/** Alle Migrationen des Verzeichnisses, sortiert nach der Nummer. */
function available(): { filename: string; checksum: string }[] {
  return readdirSync(fileURLToPath(DIRECTORY))
    .filter((name) => name.endsWith(".sql"))
    .sort((a, b) => orderOf(a) - orderOf(b))
    .map((filename) => ({
      filename,
      // Dieselbe Prüfsumme wie in migrate.ts: Zeilenenden vereinheitlicht,
      // damit ein Auschecken unter Windows keine Abweichung meldet.
      checksum: createHash("sha256")
        .update(readFileSync(fileURLToPath(new URL(filename, DIRECTORY)), "utf8").replace(/\r\n/g, "\n"), "utf8")
        .digest("hex")
    }));
}

test("das Verzeichnis trägt überhaupt Migrationen", () => {
  // Ohne diesen Fall würden die beiden darunter grün, weil es nichts zu prüfen
  // gibt — genau der Zustand, den migration-plan.ts als Packfehler behandelt.
  assert.ok(available().length > 0, "Das Migrationsverzeichnis ist leer; dieser Wächter liefe ins Leere.");
});

test("keine Migration fügt eine Spalte mit NOT NULL und ohne Vorgabe hinzu", () => {
  // ⚠️ Der Fall trifft ausschließlich einen BESTEHENDEN Betrieb: die Zeilen
  // stehen schon da und haben den neuen Wert nicht, also hält `ALTER TABLE`
  // an — und mit ihm der Start des Hubs. Dieselbe Migration kommt auf einer
  // frischen Datenbank grün durch; in keiner Prüfumgebung fällt sie auf.
  //
  // Die Regel stand bisher über genau einer Datei (004, host-schema.test.ts).
  // Sie gilt für jede — geprüft wird sie deshalb hier, wo ohnehin alle
  // gelesen werden, statt in jeder Migration noch einmal.
  //
  // `ADD COLUMN` und nicht „NOT NULL" allgemein: in einem `CREATE TABLE` ist
  // NOT NULL ohne Vorgabe richtig, dort gibt es keine Altzeile.
  const offenders: string[] = [];
  for (const { filename } of available()) {
    const sql = readFileSync(fileURLToPath(new URL(filename, DIRECTORY)), "utf8");
    for (const match of sql.matchAll(/ADD COLUMN\s+(\w+)[^,;]*/g)) {
      if (/NOT NULL/.test(match[0]) && !/DEFAULT/.test(match[0])) {
        offenders.push(`${filename}: ${match[1]}`);
      }
    }
  }
  assert.deepEqual(offenders, [], "Diese Spalten hielten den Start eines bestehenden Hubs an");
});

test("auf einer frischen Datenbank laufen alle Migrationen in der Reihenfolge der Nummern", () => {
  const files = available();
  const planned = planMigrations(files, []).map((entry) => entry.filename);
  assert.deepEqual(
    planned,
    files.map((entry) => entry.filename),
    "Die Folge läuft nicht in der Reihenfolge ihrer Nummern — entschieden wird über die Nummer, nicht über den Text."
  );
});

test("auf einer bestehenden Datenbank läuft genau die neueste Migration nach", () => {
  const files = available();
  // Die neueste bestimmt dieser Fall selbst. Damit muss ihn keine künftige
  // Migration mehr anfassen.
  const newest = files.at(-1);
  assert.ok(newest, "Es gibt keine neueste Migration");

  const older = files.filter((entry) => entry.filename !== newest.filename);
  assert.deepEqual(
    planMigrations(files, older).map((entry) => entry.filename),
    [newest.filename],
    `Die neueste Migration „${newest.filename}" läuft auf einer bestehenden Datenbank nicht als einzige nach. ` +
      "Trägt sie eine Nummer unter dem bereits angewandten Stand, hält der Vorwärts-Riegel aus migration-plan.ts an."
  );
});

test("jede Migration trägt eine eigene Nummer und den Namen, den der Plan verlangt", () => {
  const files = available();
  // Zwei Dateien mit derselben Nummer: welche zuerst liefe, entschiede das
  // Dateisystem. `planMigrations` wirft dann — hier steht der Befund mit dem
  // Namen der Datei, statt erst beim Start des Hubs.
  const numbers = files.map((entry) => orderOf(entry.filename));
  assert.equal(new Set(numbers).size, numbers.length, `Zwei Migrationen tragen dieselbe Nummer: ${numbers.join(", ")}`);

  for (const { filename } of files) {
    assert.match(filename, /^\d{3,}-[a-z0-9]+(?:-[a-z0-9]+)*\.sql$/, `Migrationsdatei „${filename}"`);
  }
});

test("die Neuinstallationsgrundlage bleibt Byte für Byte erhalten", () => {
  // Fresh public baseline: only new installations are supported.
  // Privacy cleanup changed the comment in 009 without changing its SQL.
  // From this root onward, shipped checksums remain immutable.
  const shipped: Record<string, string> = {
    "001-foundation.sql": "72671ca551db2cbb1efd48eb3db7ca5a63563dc59d7d8e342292c4fb71ce787d",
    "002-auth.sql": "3015e1988c96009add649b9fe5edc72f790f89f2305e7c52161d78349fbfb25d",
    "003-hosts.sql": "0dfe2f8b5ab71cdfb2531c0e3d30d34feddb13a20f95d78d986b6223443db20b",
    "004-host-enrollment.sql": "b27994f6c7deb7d33f4bb115f97c03c7bb17fb04b7f4f3f2e66bafba93177cc3",
    "005-user-language.sql": "871958f434217772151c028408d6b89723a7a6aa857b56d09d25a23b9723db9f",
    "006-hub-theme.sql": "1e7ff81edf051f6f98093a519b9b900bf1b959985b612c46a7ccda96ea38a4c3",
    "007-marks.sql": "a32523aa1f6daba59119e1375dd0c4c85c0b59855978f067b23e2f42ac68eed3",
    "008-host-setup.sql": "116a3db357486703230521f43a268c217b8f1bf4b4a9995d8efe0c992b27cfe1",
    "009-hub-network.sql": "7e545c25c09c9dcb0a41a7b7118746eadc97f59fec8ce9487cae9c1805d7be31",
    "010-log-tail-lines.sql": "ce260bb55dbb05aadcc4efd61dabef8aacbd4c9289a460db3d72737d726a0593",
    "011-container-shares.sql": "969af05ef34c78fe3c21f9248a9bf3403480136a00cea1ae581bdd28527f698d",
    "012-terminal-theme.sql": "bda72216d55841e6fb6d904511ceeb963473f14516bfa46628aca92ca20b229f",
    "013-host-last-seen.sql": "a545a4f9e1367720fc2b06e2c7cd269f8cad218687cab8cba43bbb75e58e14d2",
    "014-container-view-settings.sql": "83c6cd51939b21d10aca68acf12c4d4552a1ececc2d91d1ac17e91003ea4e1b9",
    "015-stack-hidden.sql": "dd44aca17722d23fd81f89080a5da29b5155f7396e1681da0c99f9419b10d224",
    "016-account-issuer.sql": "09c5333914b90d3602ced0d566905106e3ae8a34d4d3743c0ae3849f0472b34d",
    "017-runtime-settings.sql": "c17d3d7fa68c24b9977cfb5251357c3c2dbed3c96270a2dae577f1253c23f5e1",
    "018-container-updates.sql": "02740ed82361314aef243bf6848cde72366a68b2d133954958bb7df56dadeb5e",
    "019-notifications.sql": "30a2ed04e859adaeeacc7fb3a07b9dff54217a8c1fcc7bc32cb38835189409b2",
    "020-notification-deliveries.sql": "3f88db3189a09a8897f0575e96292fbe629b4f65de5a4cd68e33ee22156b635d"
  };
  const files = new Map(available().map((entry) => [entry.filename, entry.checksum]));
  for (const [filename, expected] of Object.entries(shipped)) {
    assert.equal(files.get(filename), expected, `${filename} weicht von der öffentlichen Neuinstallationsgrundlage ab`);
  }
  const unpinned = [...files.keys()].filter((filename) => !(filename in shipped));
  assert.deepEqual(unpinned, [], "Eine neue Migration trägt ihre Prüfsumme hier ein");
});

test("update migration contains only durable deadline settings", () => {
  const source = readFileSync(new URL("./migrations/018-container-updates.sql", import.meta.url), "utf8");
  assert.match(source, /CREATE TABLE container_update_setting/);
  assert.doesNotMatch(source, /container_update_job/);
  assert.equal((source.match(/CREATE TABLE/g) ?? []).length, 1);
});
