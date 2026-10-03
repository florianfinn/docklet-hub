import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import express from "express";

import { createIndexFallback } from "./index-fallback.js";
import { CONTENT_SECURITY_POLICY_HEADER, createContentSecurityPolicyHeader } from "./content-security-policy-header.js";
import { CONTENT_SECURITY_POLICY_DIRECTIVES, buildContentSecurityPolicy } from "./content-security-policy.js";
import { listenOnFetchablePort } from "../testing/port-test-support.js";

// Die CSP — Direktive für Direktive, und dann über echte Anfragen.
//
// Warum Stück für Stück und nicht die ganze Zeile in einem Vergleich: ein
// einziger `assert.equal` über die fertige Zeichenkette wäre bei jeder Änderung
// rot und sagte nie, WELCHE Zusage gefallen ist. Er lüde außerdem dazu ein,
// die Erwartung nachzuziehen statt die Änderung zu prüfen — genau der Griff,
// gegen den die Fälle hier stehen.

/** Die Direktiven als Nachschlagewerk, aus der ausgelieferten Zeile gelesen. */
function parsePolicy(policy: string): Map<string, string> {
  const entries = policy.split(";").map((part) => part.trim());
  const parsed = new Map<string, string>();
  for (const entry of entries) {
    if (entry === "") continue;
    const separator = entry.indexOf(" ");
    assert.ok(separator > 0, `Die Direktive "${entry}" trägt keinen Wert.`);
    parsed.set(entry.slice(0, separator), entry.slice(separator + 1));
  }
  return parsed;
}

// ── Die Direktivenzeile ─────────────────────────────────────────────────────

test("jede beschlossene Direktive steht in der Zeile, mit ihrem Wert", () => {
  const directives = parsePolicy(buildContentSecurityPolicy());
  const expected: Record<string, string> = {
    "default-src": "'self'",
    "script-src": "'self'",
    "style-src": "'self' 'unsafe-inline'",
    "img-src": "'self' data:",
    "font-src": "'self'",
    "connect-src": "'self'",
    "object-src": "'none'",
    "base-uri": "'self'",
    "frame-ancestors": "'none'",
    "form-action": "'self'"
  };
  for (const [name, value] of Object.entries(expected)) {
    assert.equal(directives.get(name), value, `Die Direktive ${name} fehlt oder trägt einen anderen Wert.`);
  }
});

test("die Zeile trägt genau diese Direktiven und keine weitere", () => {
  // Die Gegenrichtung zum Fall oben: dort fiele eine still hinzugefügte
  // Direktive nicht auf.
  const directives = parsePolicy(buildContentSecurityPolicy());
  assert.equal(directives.size, 10);
  assert.equal(CONTENT_SECURITY_POLICY_DIRECTIVES.length, 10);
});

test("keine Direktive steht doppelt in der Liste", () => {
  // Bei zwei Zeilen desselben Namens gilt in der CSP die ERSTE, und die zweite
  // sähe im Diff aus wie eine Verschärfung, die längst wirkt.
  const names = CONTENT_SECURITY_POLICY_DIRECTIVES.map(([name]) => name);
  assert.equal(new Set(names).size, names.length, `Doppelte Direktive in: ${names.join(", ")}`);
});

test("script-src trägt weder unsafe-inline noch unsafe-eval", () => {
  // Die Zeile, die ein eingeschleustes `<script>` wirkungslos macht. Fiele
  // sie, wäre die ganze CSP eine Beschriftung.
  const scriptSrc = parsePolicy(buildContentSecurityPolicy()).get("script-src") ?? "";
  assert.ok(!scriptSrc.includes("'unsafe-inline'"), `script-src lautet: ${scriptSrc}`);
  assert.ok(!scriptSrc.includes("'unsafe-eval'"), `script-src lautet: ${scriptSrc}`);
});

test("object-src ist none", () => {
  assert.equal(parsePolicy(buildContentSecurityPolicy()).get("object-src"), "'none'");
});

test("frame-ancestors ist none", () => {
  assert.equal(parsePolicy(buildContentSecurityPolicy()).get("frame-ancestors"), "'none'");
});

// ⚠️ ─────────────────────────────────────────────────────────────────────────
//
// Die eine Zusage aus #28 (2026-09-04): `'unsafe-inline'` steht in `style-src`
// und in KEINER anderen Direktive. Sie ist der Teil, den jemand später
// versehentlich aufweicht — eine Bibliothek meldet einen Verstoß, das
// Schlüsselwort steht schon einmal in der Zeile, und es an eine zweite Stelle
// zu schreiben sieht aus wie dieselbe Entscheidung noch einmal. Ist es nicht:
// in `style-src` kostet es Stile, in `script-src` kostet es alles.
//
// Deshalb prüft dieser Fall die ganze Zeile und nicht nur `script-src` — er
// soll auch dann rot werden, wenn das Schlüsselwort an einer Stelle auftaucht,
// an die heute niemand denkt.

test("unsafe-inline steht NUR in style-src und in keiner anderen Direktive", () => {
  const policy = buildContentSecurityPolicy();
  const withUnsafeInline = [...parsePolicy(policy)]
    .filter(([, value]) => value.includes("'unsafe-inline'"))
    .map(([name]) => name);
  assert.deepEqual(
    withUnsafeInline,
    ["style-src"],
    "#28 hat 'unsafe-inline' genau EINER Direktive zugestanden: style-src, wegen der berechneten " +
      "<style>-Elemente von @xterm. Jede weitere Stelle ist eine andere Entscheidung und braucht eine."
  );
});

test("unsafe-eval steht in keiner Direktive", () => {
  assert.ok(!buildContentSecurityPolicy().includes("'unsafe-eval'"));
});

test("die Zeile öffnet nirgends auf einen fremden Ursprung", () => {
  // Gemessen am 2026-09-07 lädt die Anwendung nichts von außen:
  // `grep -rn "https://" web/src --include=*.css --include=*.ts --include=*.tsx | grep -v "^\\S*: *[*/]"`
  // findet keine Zeile, die Schriften liegen als Datei im Paket
  // (`web/src/platform/theme/fonts.css`, @fontsource), und `web/index.html` verweist
  // nur auf `/src/main.tsx`. Ein `*` oder ein `http`-Ursprung in dieser Zeile
  // wäre damit immer eine neue Entscheidung und nie eine Anpassung an den
  // Bestand.
  const policy = buildContentSecurityPolicy();
  assert.ok(!policy.includes("*"), `Ein Platzhalter in der CSP: ${policy}`);
  assert.ok(!policy.includes("http:"), `Ein http-Ursprung in der CSP: ${policy}`);
  assert.ok(!policy.includes("https:"), `Ein fremder Ursprung in der CSP: ${policy}`);
});

// ── Über die echte Auslieferung ─────────────────────────────────────────────
//
// Der Aufbau ist der aus `server/src/index.ts`: die Schicht app-weit als
// erstes, dahinter eine JSON-Route, `express.static` über einem echten
// Verzeichnis und der Rückfall auf `index.html`. Was hier fällt, ist der Fall,
// den die Fälle oben nicht sehen: eine richtige Zeile, die nie an einer
// Antwort ankommt.

function webRoot(): string {
  const directory = mkdtempSync(join(tmpdir(), "hub-csp-"));
  writeFileSync(join(directory, "index.html"), "<!doctype html><title>Hub</title>", "utf8");
  mkdirSync(join(directory, "assets"));
  writeFileSync(join(directory, "assets", "index-a1b2.js"), "export const mark = 1;\n", "utf8");
  return directory;
}

async function stack(): Promise<{ port: number; close: () => Promise<void> }> {
  const app = express();
  app.use(createContentSecurityPolicyHeader());
  app.get("/health", (_request, response) => {
    response.json({ status: "ok" });
  });
  const root = webRoot();
  app.use(express.static(root));
  app.use(createIndexFallback(root));

  const server = http.createServer(app);
  await listenOnFetchablePort(server);
  return {
    port: (server.address() as AddressInfo).port,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  };
}

test("das ausgelieferte Dokument trägt die CSP", async () => {
  const running = await stack();
  try {
    // `/containers` ist der Weg über den Rückfall auf `index.html` — die
    // Adresse, unter der ein Neuladen die Anwendung bekommt.
    const response = await fetch(`http://127.0.0.1:${running.port}/containers`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get(CONTENT_SECURITY_POLICY_HEADER.toLowerCase()), buildContentSecurityPolicy());
  } finally {
    await running.close();
  }
});

test("auch die Datei aus express.static trägt die CSP", async () => {
  const running = await stack();
  try {
    const response = await fetch(`http://127.0.0.1:${running.port}/assets/index-a1b2.js`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get(CONTENT_SECURITY_POLICY_HEADER.toLowerCase()), buildContentSecurityPolicy());
  } finally {
    await running.close();
  }
});

test("auch eine JSON-Antwort trägt die CSP", async () => {
  // Die Antwort auf „auch auf /api?": ja. Ein Kopf auf einer JSON-Antwort
  // schadet nicht, `frame-ancestors 'none'` wirkt sogar, und eine Schicht, die
  // überall liegt, kann beim nächsten Auslieferungsweg nicht vergessen werden.
  const running = await stack();
  try {
    const response = await fetch(`http://127.0.0.1:${running.port}/health`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get(CONTENT_SECURITY_POLICY_HEADER.toLowerCase()), buildContentSecurityPolicy());
  } finally {
    await running.close();
  }
});

test("der eingebaute 404 von Express trägt eine STRENGERE CSP, nicht gar keine", async () => {
  // ⚠️ Gemessen am 2026-09-07 und hier festgehalten, weil es überrascht: fällt
  // eine Anfrage durch alle Schichten, antwortet nicht ein Handler dieses
  // Repos, sondern der `finalhandler` von Express 5 — und der setzt an seiner
  // eigenen Fehlerseite `Content-Security-Policy: default-src 'none'` und
  // ÜBERSCHREIBT damit den Kopf, den die Schicht oben gesetzt hat.
  //
  // Das ist kein Verlust: `default-src 'none'` ist strenger als alles, was
  // diese Anwendung ausliefert — auf einer Seite, die nur den Wortlaut
  // „Cannot GET …" trägt, ist das genau richtig. Ohne diesen Fall stünde die
  // Beobachtung nirgends, und die nächste Etappe hielte den abweichenden Kopf
  // für einen Fehler in der eigenen Schicht.
  //
  // ⚠️ Betroffen ist NUR dieser Weg. Ein 404 aus einem echten Handler — etwa
  // das JSON-Sammelbecken am Ende von `createApiRouter` — schreibt die Antwort
  // selbst und behält den Kopf von oben.
  const running = await stack();
  try {
    const response = await fetch(`http://127.0.0.1:${running.port}/assets/fehlt.js`);
    assert.equal(response.status, 404);
    const delivered = response.headers.get(CONTENT_SECURITY_POLICY_HEADER.toLowerCase());
    assert.equal(delivered, "default-src 'none'", "Erwartet war die Fehlerseiten-CSP von finalhandler.");
  } finally {
    await running.close();
  }
});
