import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applyEnvChanges,
  envView,
  secretsFromEnvFile,
  parseEnvFile,
  parseEnvLine,
  readEnvFile,
  serializeEnvValue,
  writeEnvFile
} from "./env-file.js";
import { redactKnownSecrets } from "./redact.js";

// --- Reading ----------------------------------------------------------------

test("parseEnvLine knows the spellings found in existing files", () => {
  assert.deepEqual(parseEnvLine("DB_PASSWORD=geheim"), { key: "DB_PASSWORD", value: "geheim" });
  assert.deepEqual(parseEnvLine("  export TOKEN=abc  "), { key: "TOKEN", value: "abc" });
  assert.deepEqual(parseEnvLine('QUOTED="mit Leerzeichen"'), {
    key: "QUOTED",
    value: "mit Leerzeichen"
  });
  assert.deepEqual(parseEnvLine("SINGLE='literal $VAR'"), { key: "SINGLE", value: "literal $VAR" });
  assert.deepEqual(parseEnvLine('ESCAPED="zeile1\\nzeile2"'), {
    key: "ESCAPED",
    value: "zeile1\nzeile2"
  });
  assert.deepEqual(parseEnvLine("LEER="), { key: "LEER", value: "" });
});

test("comments, blank lines and garbage are no assignment", () => {
  assert.equal(parseEnvLine("# nur ein Kommentar"), null);
  assert.equal(parseEnvLine(""), null);
  assert.equal(parseEnvLine("   "), null);
  assert.equal(parseEnvLine("kein Gleichheitszeichen"), null);
  assert.equal(parseEnvLine("=no-key"), null);
  // A key that Compose itself does not accept.
  assert.equal(parseEnvLine("MIT-BINDESTRICH=x"), null);
});

test("a `#` in the value stays, a comment after it does not", () => {
  // Passwords often contain a `#`; only a comment WITH whitespace before it
  // is cut off.
  assert.deepEqual(parseEnvLine("PW=ab#cd"), { key: "PW", value: "ab#cd" });
  assert.deepEqual(parseEnvLine("PW=abcd # Kommentar"), { key: "PW", value: "abcd" });
});

test("with duplicate keys the last one wins", () => {
  assert.deepEqual(parseEnvFile("A=eins\nA=zwei\n"), [{ key: "A", value: "zwei" }]);
});

// --- Serialising ------------------------------------------------------------

test("serializeEnvValue quotes only where necessary", () => {
  assert.equal(serializeEnvValue("einfach"), "einfach");
  assert.equal(serializeEnvValue("mit/pfad:1234"), "mit/pfad:1234");
  assert.equal(serializeEnvValue(""), "");
  assert.equal(serializeEnvValue("mit Leerzeichen"), '"mit Leerzeichen"');
  assert.equal(serializeEnvValue('an"fuehrung'), '"an\\"fuehrung"');
  assert.equal(serializeEnvValue("zeile1\nzeile2"), '"zeile1\\nzeile2"');
  assert.equal(serializeEnvValue("hash#drin"), '"hash#drin"');
});

test("every value survives the round trip serialise -> parse", () => {
  for (const value of ["", "einfach", "mit Leerzeichen", 'an"fuehrung', "a#b", "a\\b", "x\ny"]) {
    assert.deepEqual(parseEnvLine(`K=${serializeEnvValue(value)}`), { key: "K", value: value });
  }
});

// --- Surgical writing -------------------------------------------------------

test("applyEnvChanges keeps comments, order and blank lines", () => {
  const before = ["# Datenbank", "DB_USER=codex", "DB_PASSWORD=alt", "", "# Sonstiges", "PORT=8080", ""].join(
    "\n"
  );
  const after = applyEnvChanges(before, { set: { DB_PASSWORD: "neu" }, remove: [] });
  assert.equal(
    after,
    ["# Datenbank", "DB_USER=codex", "DB_PASSWORD=neu", "", "# Sonstiges", "PORT=8080", ""].join("\n")
  );
});

test("new keys are appended at the end, removed ones disappear", () => {
  const after = applyEnvChanges("A=1\nB=2\n", { set: { C: "3" }, remove: ["B"] });
  assert.equal(after, "A=1\n\nC=3\n");
});

test("the `export` prefix is preserved", () => {
  assert.equal(applyEnvChanges("export A=1\n", { set: { A: "2" }, remove: [] }), "export A=2\n");
});

test("a file without a trailing newline gets one", () => {
  assert.equal(applyEnvChanges("A=1", { set: { B: "2" }, remove: [] }), "A=1\n\nB=2\n");
});

test("duplicate occurrences are all set, no line silently disappears", () => {
  assert.equal(applyEnvChanges("A=1\n# dazwischen\nA=2\n", { set: { A: "3" }, remove: [] }), "A=3\n# dazwischen\nA=3\n");
});

// --- File level with hash mechanics -----------------------------------------

// The agent runs on Linux and works with POSIX paths everywhere
// (normalizePath in hardening.ts). On a Windows development machine mkdtemp
// returned backslashes — the traversal check would then test not the rule but
// the path format.
function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "envfile-")).replace(/\\/g, "/");
}

function under(dir: string, name: string): string {
  return `${dir}/${name}`;
}

test("writeEnvFile creates the file when no hash is expected", () => {
  const base = tempDir();
  const dir = under(base, "projekt");
  fs.mkdirSync(dir);

  const result = writeEnvFile(dir, { set: { A: "1" }, remove: [] }, {
    expectedHash: null,
    basePath: base
  });
  assert.equal(result.ok, true);
  assert.equal(fs.readFileSync(under(dir, ".env"), "utf8"), "A=1\n");
});

test("writeEnvFile rejects when the file was edited elsewhere", () => {
  const base = tempDir();
  const dir = under(base, "projekt");
  fs.mkdirSync(dir);
  fs.writeFileSync(under(dir, ".env"), "A=1\n");

  const loaded = readEnvFile(dir);
  fs.writeFileSync(under(dir, ".env"), "A=1\nB=2\n"); // someone via SSH

  const result = writeEnvFile(dir, { set: { A: "9" }, remove: [] }, {
    expectedHash: loaded.hash,
    basePath: base
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "file-changed-externally");
  // And the foreign change is still there.
  assert.equal(fs.readFileSync(under(dir, ".env"), "utf8"), "A=1\nB=2\n");
});

test("writeEnvFile rejects an existing file when creation was requested", () => {
  const base = tempDir();
  const dir = under(base, "projekt");
  fs.mkdirSync(dir);
  fs.writeFileSync(under(dir, ".env"), "A=1\n");

  const result = writeEnvFile(dir, { set: { A: "2" }, remove: [] }, {
    expectedHash: null,
    basePath: base
  });
  assert.equal(result.ok === false && result.reason, "file-already-exists");
});

test("writeEnvFile never writes outside the base path", () => {
  const base = tempDir();
  assert.throws(
    () => writeEnvFile("/etc", { set: { A: "1" }, remove: [] }, { expectedHash: null, basePath: base }),
    /lies outside/
  );
});

test("writeEnvFile rejects invalid keys", () => {
  const base = tempDir();
  const dir = under(base, "projekt");
  fs.mkdirSync(dir);
  assert.throws(
    () =>
      writeEnvFile(dir, { set: { "A B": "1" }, remove: [] }, { expectedHash: null, basePath: base }),
    /invalid/
  );
});

test("writeEnvFile does not overwrite a temp file created beforehand", () => {
  const base = tempDir();
  const project = under(base, "app");
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(under(project, ".env.tmp"), "fremd", "utf8");
  assert.throws(
    () => writeEnvFile(project, { set: { SECRET: "value" }, remove: [] }, { expectedHash: null, basePath: base }),
    /EEXIST/
  );
  assert.equal(fs.readFileSync(under(project, ".env.tmp"), "utf8"), "fremd");
  assert.equal(fs.existsSync(under(project, ".env")), false);
});

// --- Origin ---------------------------------------------------------------

test("envView assigns every line to its source", () => {
  const lines = envView({
    file: [
      { key: "DB_PASSWORD", value: "geheim" },
      { key: "NUR_DATEI", value: "wird-interpoliert" }
    ],
    containerEnv: [
      { key: "DB_PASSWORD", value: "geheim" },
      { key: "PATH", value: "/usr/bin" },
      { key: "AUS_COMPOSE", value: "fest" }
    ],
    imageEnv: [{ key: "PATH", value: "/usr/bin" }],
    plaintext: false
  });

  const after = new Map(lines.map((line) => [line.key, line]));
  assert.equal(after.get("DB_PASSWORD")?.origin, "env-file");
  assert.equal(after.get("DB_PASSWORD")?.inFile, true);
  assert.equal(after.get("DB_PASSWORD")?.inContainer, true);
  // In the file, but not set in the container at all — purely an
  // interpolation source. That is a statement, not a gap.
  assert.equal(after.get("NUR_DATEI")?.origin, "env-file");
  assert.equal(after.get("NUR_DATEI")?.inContainer, false);
  assert.equal(after.get("PATH")?.origin, "image");
  assert.equal(after.get("AUS_COMPOSE")?.origin, "compose");
});

test("a .env value overridden in the Compose file counts as compose", () => {
  const [line] = envView({
    file: [{ key: "PORT", value: "8080" }],
    containerEnv: [{ key: "PORT", value: "9090" }],
    imageEnv: [],
    plaintext: false
  });
  assert.equal(line.origin, "compose");
  assert.equal(line.inFile, true);
});

test("without an explicit request the view contains not a single value", () => {
  const lines = envView({
    file: [{ key: "TOKEN", value: "sehr-geheim" }],
    containerEnv: [],
    imageEnv: [],
    plaintext: false
  });
  assert.equal(lines[0].value, undefined);
  assert.equal(lines[0].empty, false);
  assert.ok(!JSON.stringify(lines).includes("sehr-geheim"));

  const withPlaintext = envView({
    file: [{ key: "TOKEN", value: "sehr-geheim" }],
    containerEnv: [],
    imageEnv: [],
    plaintext: true
  });
  assert.equal(withPlaintext[0].value, "sehr-geheim");
});

test("plaintext is only available for lines from the .env, not for the whole container env", () => {
  // Otherwise the tab would be the first route in the system through which
  // the full environment of a running container leaves in plaintext —
  // including values that are hard-coded in the Compose file and cannot be
  // edited here at all.
  const lines = envView({
    file: [{ key: "AUS_DATEI", value: "darf-raus" }],
    containerEnv: [
      { key: "AUS_COMPOSE", value: "hardcodiertes-passwort" },
      { key: "PATH", value: "/usr/bin" }
    ],
    imageEnv: [{ key: "PATH", value: "/usr/bin" }],
    plaintext: true
  });

  const after = new Map(lines.map((line) => [line.key, line]));
  assert.equal(after.get("AUS_DATEI")?.value, "darf-raus");
  assert.equal(after.get("AUS_COMPOSE")?.value, undefined);
  assert.equal(after.get("PATH")?.value, undefined);
  assert.ok(!JSON.stringify(lines).includes("hardcodiertes-passwort"));
  // The "empty" flag is still correct — it is a bit, not a value.
  assert.equal(after.get("AUS_COMPOSE")?.empty, false);
});

// --- Redaction (§16.4, point 1) ---------------------------------------------

test("the .env values feed the same redaction as the container env", () => {
  const base = tempDir();
  const dir = under(base, "projekt");
  fs.mkdirSync(dir);
  fs.writeFileSync(under(dir, ".env"), "DB_PASSWORD=hunter2-sehr-geheim\nLEER=\n");

  const secrets = secretsFromEnvFile(dir);
  assert.deepEqual(secrets, ["hunter2-sehr-geheim"]);

  const log = "connect: postgres://codex:hunter2-sehr-geheim@db:5432";
  assert.equal(redactKnownSecrets(log, secrets), "connect: postgres://codex:••••@db:5432");
});

test("a missing .env yields no secrets instead of throwing", () => {
  assert.deepEqual(secretsFromEnvFile(under(tempDir(), "gibtsnicht")), []);
});

test("an unreadable or unparsable .env stops log redaction fail-closed", () => {
  for (const error of [
    Object.assign(new Error("keine Rechte"), { code: "EACCES" }),
    new SyntaxError("kaputte Datei")
  ]) {
    assert.throws(
      () => secretsFromEnvFile("/projekt", () => { throw error; }),
      /redaction-unavailable/
    );
  }
});

test("env reading and writing enforce UTF-8 byte limits and reject non-text entries", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "env-boundary-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, ".env");
  const limit = 262144;
  fs.writeFileSync(file, "x".repeat(limit));
  assert.equal(readEnvFile(directory).content?.length, limit);
  fs.writeFileSync(file, "x".repeat(limit + 1));
  assert.throws(() => readEnvFile(directory), /too-large/);
  for (const bytes of [Buffer.from([0]), Buffer.from([255])]) {
    fs.writeFileSync(file, bytes);
    assert.throws(() => readEnvFile(directory), /not-a-text-file/);
  }
  fs.unlinkSync(file);
  fs.symlinkSync(path.join(directory, "missing"), file);
  assert.throws(() => readEnvFile(directory));
  fs.unlinkSync(file);
  fs.writeFileSync(file, "PUBLIC=value\n");
  const current = readEnvFile(directory);
  assert.throws(() => writeEnvFile(directory, { set: { PUBLIC: "ä".repeat(limit / 2) }, remove: [] }, { expectedHash: current.hash, basePath: path.dirname(directory) }), /too-large/);
  assert.equal(readEnvFile(directory).content, current.content);
});
