import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_SELF_HEALING_CONFIG } from "contract";
import { SelfHealingConfigStore } from "./self-healing-config.js";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "healing-config-"));
  return { root, file: path.join(root, "state", "self-healing-config.json"),
    close: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("ohne erste Übertragung gelten die Werkswerte; Leser geben keine veränderbare Referenz aus", () => {
  const f = fixture();
  try {
    const store = new SelfHealingConfigStore(f.file);
    assert.deepEqual(store.read(), DEFAULT_SELF_HEALING_CONFIG);
    store.read().retryDelaysSeconds[0] = 99;
    assert.equal(store.read().retryDelaysSeconds[0], 10);
    assert.equal(fs.existsSync(f.file), false);
  } finally { f.close(); }
});

test("gespeicherte Werte überleben einen Neustart mit Modus 0600 und ohne temporäre Dateien", () => {
  const f = fixture();
  try {
    const config = { ...DEFAULT_SELF_HEALING_CONFIG, enabled: false, attempts: 2, retryDelaysSeconds: [5, 20], maintenanceDurationSeconds: null };
    const store = new SelfHealingConfigStore(f.file);
    assert.deepEqual(store.write(config), config);
    assert.deepEqual(new SelfHealingConfigStore(f.file).read(), config);
    assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(path.dirname(f.file)), ["self-healing-config.json"]);
    config.retryDelaysSeconds[0] = 999;
    assert.equal(store.read().retryDelaysSeconds[0], 5);
  } finally { f.close(); }
});

test("ungültige Werte ersetzen weder Speicher noch Datei", () => {
  const f = fixture();
  try {
    const store = new SelfHealingConfigStore(f.file);
    store.write(DEFAULT_SELF_HEALING_CONFIG);
    const before = fs.readFileSync(f.file, "utf8");
    assert.throws(() => store.write({ ...DEFAULT_SELF_HEALING_CONFIG, attempts: 1 }));
    assert.equal(fs.readFileSync(f.file, "utf8"), before);
    assert.deepEqual(store.read(), DEFAULT_SELF_HEALING_CONFIG);
  } finally { f.close(); }
});

test("ein fehlgeschlagener atomarer Ersatz behält die vorherige Konfiguration im Speicher", () => {
  const f = fixture();
  try {
    const store = new SelfHealingConfigStore(f.file);
    fs.mkdirSync(f.file, { recursive: true });
    assert.throws(() => store.write({ ...DEFAULT_SELF_HEALING_CONFIG, enabled: false }));
    assert.deepEqual(store.read(), DEFAULT_SELF_HEALING_CONFIG);
    assert.deepEqual(fs.readdirSync(path.dirname(f.file)), ["self-healing-config.json"]);
  } finally { f.close(); }
});

test("eine beschädigte gespeicherte Konfiguration fällt beim Laden statt Selbstheilung neu einzuschalten", () => {
  const f = fixture();
  try {
    fs.mkdirSync(path.dirname(f.file));
    fs.writeFileSync(f.file, "{broken");
    assert.throws(() => new SelfHealingConfigStore(f.file));
  } finally { f.close(); }
});
