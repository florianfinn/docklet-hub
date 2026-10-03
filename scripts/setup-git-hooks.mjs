// Install the local Git hooks for this checkout. Local checks supplement
// required GitHub PR checks and only run when core.hooksPath is configured.
// The test guard also verifies this setting when installation skips prepare.
//
// Läuft als `prepare`-Skript. Aber: gemessen (2026-09-03, drei Läufe in
// diesem Repo) feuert pnpms `prepare` NUR, wenn der Install tatsächlich etwas
// installiert — bei „Already up to date" (unveränderte Lockfile,
// vorhandenes `node_modules`) wird es übersprungen, mit und ohne
// `--frozen-lockfile`. Erst ein Install, der wirklich etwas tut (frischer
// Klon, gelöschtes `node_modules`), löst es aus.
//
// Damit deckt dieses Skript den Neuzugang ab (frischer Klon: `node_modules`
// fehlt, `prepare` läuft, `core.hooksPath` wird gesetzt), aber NICHT den
// Bestand: eine Arbeitskopie, die es schon vor diesem Skript gab, hat ein
// aktuelles `node_modules` und bekommt `core.hooksPath` erst beim nächsten
// Install gesetzt, der wirklich installiert — das kann Wochen dauern oder nie
// passieren. Für diesen Fall gibt es zusätzlich
// `web/tests/git-hooks-path.test.mjs`, der unabhängig von `prepare` bei jedem
// `pnpm run test` prüft, ob `core.hooksPath` steht.
//
// Zwei Fälle, in denen dieses Skript NICHT eingreifen darf:
//
//   1. Kein Git-Repository (entpackter Tarball, Docker-Build-Kontext ohne
//      `.git`). `pnpm install` muss dort trotzdem durchlaufen — ein
//      `prepare`, das hier scheitert, macht jeden Build kaputt, der aus
//      diesem Repo nur den Quellbaum kopiert, nicht die Git-Historie.
//   2. `core.hooksPath` steht LOKAL (`--local`, also in `.git/config` dieses
//      Klons) bereits auf einem ANDEREN Wert als `.githooks`. Das
//      überschreibt dieses Skript nie stillschweigend — es wird gewarnt, der
//      Install bricht auch dann nicht ab. Ein GLOBAL gesetzter abweichender
//      Pfad (z. B. ein geteilter Hook-Ordner für mehrere Repos, in
//      `~/.gitconfig`) fällt NICHT unter diesen Schutz: `--local` sieht ihn
//      nicht, und dieses Skript setzt dann lokal `.githooks` und übersteuert
//      den globalen Wert für diesen Klon — beabsichtigt, denn die Haken
//      dieses Repos sollen hier gewinnen, aber eben ohne Rücksicht auf einen
//      global konfigurierten Pfad.
//
// In jedem anderen Fall — kein Wert gesetzt, oder bereits `.githooks` — ist
// das Skript ein no-op oder setzt den Wert, ohne den Install je zu bremsen:
// `process.exit` wird nirgends mit einem Fehlercode aufgerufen.

import { execFileSync } from "node:child_process";

const HOOKS_PATH = ".githooks";

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function isInsideGitRepo() {
  try {
    return git(["rev-parse", "--is-inside-work-tree"]) === "true";
  } catch {
    // Kein Git installiert oder kein Repository (z. B. entpackter Tarball) —
    // beides ist hier kein Fehler, nur „nichts zu tun“.
    return false;
  }
}

function readCurrentHooksPath() {
  try {
    return git(["config", "--local", "core.hooksPath"]);
  } catch {
    // `git config` liefert einen Fehlercode, wenn der Schlüssel fehlt.
    return "";
  }
}

function main() {
  if (!isInsideGitRepo()) {
    console.log("setup-git-hooks: kein Git-Repository — übersprungen.");
    return;
  }

  const current = readCurrentHooksPath();

  if (current === HOOKS_PATH) {
    console.log(`setup-git-hooks: core.hooksPath steht bereits auf "${HOOKS_PATH}".`);
    return;
  }

  if (current !== "") {
    console.warn(
      `setup-git-hooks: core.hooksPath steht auf "${current}", nicht auf ` +
        `"${HOOKS_PATH}" — wird NICHT überschrieben. ".githooks/pre-push" ` +
        `läuft damit nicht bei "git push". Absichtlich abweichend? Dann ` +
        `nichts zu tun. Sonst von Hand: git config core.hooksPath ${HOOKS_PATH}`,
    );
    return;
  }

  try {
    execFileSync("git", ["config", "core.hooksPath", HOOKS_PATH]);
    console.log(`setup-git-hooks: core.hooksPath auf "${HOOKS_PATH}" gesetzt.`);
  } catch (error) {
    // Ein Install darf hieran nicht scheitern — z. B. ein schreibgeschütztes
    // `.git/config` in einem CI-Cache-Wiederherstellungsschritt.
    console.warn(`setup-git-hooks: core.hooksPath konnte nicht gesetzt werden: ${error.message}`);
  }
}

main();
