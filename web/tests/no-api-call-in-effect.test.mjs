import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ESLint, Linter } from "eslint";
import tseslint from "typescript-eslint";

import plugin from "../../eslint-rules/no-api-call-in-effect.mjs";
import { stripComments } from "./strip-comments.mjs";

// The rule "no call to the hub inside useEffect" (#271), acceptance criterion
// of the milestone "Umbau: Ordnung nach Features". The rule itself and its
// limit stand in `eslint-rules/no-api-call-in-effect.mjs`. Three things are
// held here:
//
// 1. it fails at wrong example files and stays quiet at allowed ones;
// 2. it is switched on for `web/src` (`eslint.config.mjs`), so removing the
//    line there turns this red and not only the next review;
// 3. the naming it relies on holds: every module of the web that calls the
//    hub is an `api.ts` or the transport in `platform/http/`. Without this
//    case a call moved into `helpers.ts` would escape the rule by its name.

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const WEB_SRC = join(ROOT, "web", "src");

function lint(dir, file) {
  const linter = new Linter({ cwd: dir });
  const config = [
    {
      files: ["**/*.{ts,tsx}"],
      languageOptions: { parser: tseslint.parser, parserOptions: { ecmaFeatures: { jsx: true } } },
      plugins: { local: plugin },
      rules: { "local/no-api-call-in-effect": "error" }
    }
  ];
  const path = join(dir, file);
  return linter
    .verify(readFileSync(path, "utf8"), config, { filename: path })
    .map((message) => `${file}:${message.line} ${message.message.split(" ")[0]}`);
}

test("die Regel fällt an absichtlich falschen Beispieldateien und schweigt an erlaubten", () => {
  const dir = mkdtempSync(join(tmpdir(), "no-api-call-in-effect-"));
  try {
    const files = {
      "src/platform/http/transport.ts": "export async function request(path: string) { return fetch(path); }\n",
      "src/features/alpha/api.ts": 'export async function fetchThing() { return 1; }\nexport type Thing = number;\n',
      "src/features/alpha/index.ts": 'export { fetchThing } from "./api";\nexport type { Thing } from "./api";\n',
      "src/features/alpha/helpers.ts": "export function format(value: number) { return String(value); }\n",
      // Wrong: a call of an `api.ts`, directly and through the door, the
      // transport, the global `fetch` and `window.fetch`, in `useEffect` and
      // `React.useLayoutEffect`, also inside a promise chain of the effect.
      "src/app/Wrong.tsx": [
        'import React, { useEffect } from "react";',
        'import { fetchThing } from "../features/alpha/api";',
        'import { fetchThing as viaDoor } from "../features/alpha";',
        'import { request } from "../platform/http/transport";',
        "export function Wrong() {",
        "  useEffect(() => {",
        "    void fetchThing();",
        "    void viaDoor().then(() => request(\"/api/x\"));",
        "  }, []);",
        "  React.useLayoutEffect(() => {",
        "    void fetch(\"/api/y\");",
        "    void window.fetch(\"/api/z\");",
        "  });",
        "  return null;",
        "}",
        ""
      ].join("\n"),
      // Allowed: the same calls outside an effect, a helper that is no API
      // module, a type import, an effect without a call, a process started by
      // the effect from a module that is not `api.ts`.
      "src/app/Fine.tsx": [
        'import { useEffect } from "react";',
        'import { fetchThing, type Thing } from "../features/alpha";',
        'import { format } from "../features/alpha/helpers";',
        "export function Fine({ start }: { start: () => () => void }) {",
        "  const onClick = () => void fetchThing();",
        "  useEffect(() => {",
        "    document.title = format(1);",
        "  }, []);",
        "  useEffect(() => start(), [start]);",
        "  const value: Thing | null = null;",
        "  return onClick === null ? value : null;",
        "}",
        ""
      ].join("\n")
    };
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }

    assert.deepEqual(lint(dir, "src/app/Wrong.tsx"), [
      "src/app/Wrong.tsx:7 fetchThing",
      "src/app/Wrong.tsx:8 viaDoor",
      "src/app/Wrong.tsx:8 request",
      "src/app/Wrong.tsx:11 fetch",
      "src/app/Wrong.tsx:12 window.fetch"
    ]);
    assert.deepEqual(lint(dir, "src/app/Fine.tsx"), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("die Regel ist für web/src eingeschaltet", async () => {
  const eslint = new ESLint({ cwd: ROOT });
  for (const file of ["web/src/App.tsx", "web/src/domain/hosts/use-hosts.ts"]) {
    const config = await eslint.calculateConfigForFile(join(ROOT, file));
    const setting = config.rules?.["local/no-api-call-in-effect"];
    const level = Array.isArray(setting) ? setting[0] : setting;
    assert.ok(level === 2 || level === "error", `local/no-api-call-in-effect steht für ${file} auf ${String(level)}`);
  }
});

// ── The naming the rule relies on ───────────────────────────────────────────

// What calls the hub: the global `fetch`, or a request function of the
// transport. `ApiError`, `errorCode` and the other readers of an answer are
// not calls and may be imported anywhere.
const TRANSPORT_CALLS = ["request", "requestNoContent", "postJson", "putJson", "parseResponse"];
const TRANSPORT_IMPORT = /import\s*\{([^}]*)\}\s*from\s*["'][^"']*(?:^|\/)http\/transport["']/g;

/** The reasons a source calls the hub, empty if it does not. */
export function hubCallsIn(source) {
  const text = stripComments(source);
  const found = [];
  if (/(^|[^.\w])fetch\s*\(/.test(text) || /\b(window|globalThis)\.fetch\s*\(/.test(text)) found.push("fetch");
  for (const match of text.matchAll(TRANSPORT_IMPORT)) {
    for (const raw of match[1].split(",")) {
      const name = raw.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0];
      if (TRANSPORT_CALLS.includes(name) && !raw.trim().startsWith("type ")) found.push(name);
    }
  }
  return found;
}

/** True for the files allowed to call the hub. */
function mayCallHub(file) {
  return file === "api.ts" || file.endsWith("/api.ts") || file.startsWith("platform/http/");
}

test("nur api.ts und der Transport rufen den Hub", () => {
  const files = readdirSync(WEB_SRC, { recursive: true })
    .map((name) => name.split(sep).join("/"))
    .filter((name) => /\.tsx?$/.test(name) && !name.endsWith(".d.ts") && !name.includes(".test."));
  const callers = files.filter((file) => hubCallsIn(readFileSync(join(WEB_SRC, file), "utf8")).length > 0);
  // Present at all, or the case would run into the void: on 2026-10-02 the
  // transport and thirteen `api.ts` (#271).
  assert.ok(callers.length >= 10, `nur ${callers.length} Dateien rufen den Hub — der Leser liest nichts`);
  const misplaced = callers.filter((file) => !mayCallHub(file)).map((file) => `${file}: ${hubCallsIn(readFileSync(join(WEB_SRC, file), "utf8")).join(", ")}`);
  assert.deepEqual(
    misplaced,
    [],
    "Diese Dateien rufen den Hub, heißen aber nicht api.ts. Die Regel gegen Aufrufe in useEffect erkennt " +
      `einen Aufruf an seiner Herkunft; ein Aufruf hier entginge ihr:\n${misplaced.join("\n")}`
  );
});

test("der Leser der Aufrufe: was er sieht und was nicht", () => {
  assert.deepEqual(hubCallsIn('const x = await fetch("/api/a");'), ["fetch"]);
  assert.deepEqual(hubCallsIn('void window.fetch("/api/a");'), ["fetch"]);
  assert.deepEqual(hubCallsIn('import { request, ApiError } from "../../platform/http/transport";'), ["request"]);
  assert.deepEqual(hubCallsIn('import {\n  putJson as put,\n  errorCode\n} from "../http/transport";'), ["putJson"]);
  assert.deepEqual(hubCallsIn('import { ApiError, errorCode } from "../../platform/http/transport";'), []);
  assert.deepEqual(hubCallsIn("// fetch(\"/api/a\") in a comment\nconst refetch = () => query.refetch();"), []);
  assert.ok(mayCallHub("features/logs/api.ts"));
  assert.ok(mayCallHub("platform/http/transport.ts"));
  assert.ok(!mayCallHub("features/logs/log-stream.ts"));
});
