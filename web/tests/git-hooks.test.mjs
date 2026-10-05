import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

// Ein Haken unter `.githooks/` fällt still auf zwei unabhängigen Wegen aus,
// und keiner der beiden meldet sich von selbst:
//
//   1. `core.hooksPath` steht nicht auf `.githooks` — Git sucht die Haken gar
//      nicht erst dort. scripts/setup-git-hooks.mjs (aufgerufen als
//      `prepare`-Skript) setzt das bei `pnpm install`, aber pnpm führt
//      `prepare` nur aus, wenn der Install tatsächlich etwas zu tun hat. Bei
//      „Already up to date" bleibt es aus (gemessen 2026-09-03, drei Läufe,
//      Kommentar dort) — der Regelfall bei jeder schon länger bestehenden
//      Arbeitskopie.
//   2. `core.hooksPath` steht richtig, aber die Datei ist nicht ausführbar.
//      Git ruft sie dann klaglos nicht auf — kein Fehler, keine Warnung.
//      Gemessen 2026-09-03: `.githooks/commit-msg` stand seit seiner Anlage
//      mit Modus `100644` im INDEX (nicht nur im Arbeitsbaum eines einzelnen
//      Rechners) — der Haken lief seither in KEINEM Klon, nicht nur auf
//      diesem. `git ls-files -s .githooks/` zeigt den Modus, den jeder Klon
//      bekommt; ein lokales `chmod +x` allein reicht nicht, weil ein
//      frischer `git clone` den Modus aus dem Index übernimmt, nicht den
//      einer bereits laufenden Arbeitskopie.
//
// Beide Prüfungen laufen unabhängig vom Haken selbst und vom
// `prepare`-Skript: sonst prüfte der einzige Wächter für den Haken nur, wenn
// der Haken schon liefe, und das wäre der Zirkelschluss, den er gerade
// auflösen soll.

test("core.hooksPath zeigt auf .githooks", () => {
  let hooksPath = "";
  try {
    hooksPath = execFileSync("git", ["config", "--local", "core.hooksPath"], {
      encoding: "utf8"
    }).trim();
  } catch {
    // `git config` liefert einen Fehlercode, wenn der Schlüssel fehlt — dann
    // bleibt hooksPath leer, und die Assertion unten meldet das sauber.
  }

  assert.equal(
    hooksPath,
    ".githooks",
    "core.hooksPath steht nicht auf .githooks — .githooks/pre-push läuft " +
      "damit nicht bei `git push`. Beheben mit:\n" +
      "  git config core.hooksPath .githooks"
  );
});

test("jede Datei unter .githooks/ ist im Index ausführbar", () => {
  const ROOT = fileURLToPath(new URL("../../", import.meta.url));

  const entries = execFileSync("git", ["ls-files", "-s", ".githooks/"], {
    cwd: ROOT,
    encoding: "utf8"
  })
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [mode, , , path] = line.split(/\s+/);
      return { mode, path };
    });

  assert.ok(entries.length > 0, ".githooks/ enthält im Index nichts — der Wächter liefe ins Leere");

  const notExecutable = entries
    .filter((entry) => entry.mode !== "100755")
    .map((entry) => `${entry.path}: ${entry.mode}`);

  assert.deepEqual(
    notExecutable,
    [],
    "Nicht ausführbar im Index (dieser Modus geht in jeden Klon über, nicht " +
      `nur diese Arbeitskopie):\n${notExecutable.join("\n")}\n` +
      "Beheben mit: git update-index --chmod=+x <datei>"
  );
});

// ── The chain of `pre-push` runs without the hook's Git variables (#286) ────
//
// Under a hook pushed from a linked worktree, Git sets GIT_DIR to an absolute
// path into the shared repository; measured on 2026-10-02 with a throwaway
// repository (none in a main checkout). A test that ran Git on a repository
// of its own then wrote `core.bare = true` into this one. The real hook runs
// here with a stand-in `pnpm` that records what it inherits; the chain itself
// is not run again.

/** The `sh` that runs hooks: on PATH, or the one Git for Windows ships. */
function hookShell() {
  try {
    execFileSync("sh", ["-c", "exit 0"], { stdio: "ignore" });
    return "sh";
  } catch {
    const execPath = execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim();
    // `<git>/mingw64/libexec/git-core` → `<git>/usr/bin/sh.exe`
    return join(execPath, "..", "..", "..", "usr", "bin", "sh.exe");
  }
}

test("pre-push reicht der Prüfkette keine GIT_*-Variablen weiter", () => {
  const directory = mkdtempSync(join(tmpdir(), "pre-push-env-"));
  try {
    const record = join(directory, "pnpm-env.txt");
    const fakePnpm = join(directory, "pnpm");
    writeFileSync(fakePnpm, `#!/bin/sh\nenv | grep '^GIT_' >> '${record.replaceAll("\\", "/")}' || true\necho "call $*" >> '${record.replaceAll("\\", "/")}'\n`);
    chmodSync(fakePnpm, 0o755);

    const environment = {
      ...process.env,
      PATH: `${directory}${delimiter}${process.env.PATH ?? ""}`,
      GIT_DIR: join(directory, "decoy.git"),
      GIT_WORK_TREE: directory,
      GIT_INDEX_FILE: join(directory, "decoy-index")
    };
    execFileSync(hookShell(), [".githooks/pre-push"], { cwd: fileURLToPath(new URL("../../", import.meta.url)), env: environment, stdio: ["ignore", "pipe", "pipe"] });

    const lines = readFileSync(record, "utf8").split("\n").filter(Boolean);
    assert.deepEqual(
      lines.filter((line) => line.startsWith("call ")),
      ["call run lint", "call run test"],
      "the stand-in pnpm was not called as the chain"
    );
    assert.deepEqual(
      lines.filter((line) => line.startsWith("GIT_")),
      [],
      "the chain inherited Git variables of the hook"
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
