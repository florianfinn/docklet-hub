// ESLint — die zweite Hälfte von `pnpm lint`.
//
// Bis hierher war `lint` nur `tsc --noEmit`. Der Compiler prüft Typen, aber
// keine Muster: ein leeres Dep-Array an einem `useEffect`, eine ungenutzte
// Variable, ein verschlucktes `catch {}` sind für ihn einwandfrei. Genau diese
// Klasse fängt ESLint ab.
//
// Diese Stufe ist bewusst NICHT typbewusst (`projectService` bleibt aus): ohne
// Typinformation läuft der Durchgang in Sekunden statt in einem Vielfachen
// davon. Die typbewussten Promise-Regeln kommen erst, wenn es echten
// asynchronen Bestand gibt, gegen den sie sich lohnen.

import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

import englishIdentifiers from "./eslint-rules/english-identifiers.mjs";
import noApiCallInEffect from "./eslint-rules/no-api-call-in-effect.mjs";

const localRules = { rules: { ...englishIdentifiers.rules, ...noApiCallInEffect.rules } };

export default tseslint.config(
  {
    // Ein `eslint-disable`, dessen Regel gar nicht mehr greift, ist eine Lüge
    // im Code: der nächste Leser hält die Stelle für eine bewusste Ausnahme,
    // obwohl dort nichts mehr ist.
    linterOptions: { reportUnusedDisableDirectives: "error" }
  },
  // `.claude/` trägt Arbeitsverzeichnisse paralleler Sitzungen — vollständige
  // Auschecken dieses Repos, mitsamt eigener tsconfig. Ohne diesen Eintrag
  // liest ESLint sie mit und bricht ab, weil dann mehrere Wurzeln in Frage
  // kommen. Der Lauf hinge damit davon ab, ob gerade jemand nebenher arbeitet,
  // und `pnpm run lint` ist hier die einzige Schranke vor dem Standard-Branch.
  { ignores: ["**/dist/**", "**/node_modules/**", ".claude/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx,mjs}"],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser }
    },
    plugins: { local: localRules },
    rules: {
      // Bezeichner sind englisch (AGENTS.md). Hart, nicht als Warnung: eine
      // Warnung sammelt sich an, und angesammelte Warnungen werden zu einer
      // Liste, die niemand mehr abarbeitet — im Hauptdashboard ist genau das
      // passiert und wird dort gerade nachgeholt.
      "local/english-identifiers": "error",
      // Ein ungenutztes Argument mit führendem _ ist eine Absichtserklärung,
      // kein Versehen — Express-Handler brauchen das laufend.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }
      ]
    }
  },
  {
    files: ["web/src/**/*.tsx"],
    plugins: { "react-hooks": reactHooks },
    rules: reactHooks.configs.recommended.rules
  },
  {
    // No call to the hub inside an effect (#271): the web loads through
    // TanStack Query. Why, and what the rule sees and what not, stands in
    // `eslint-rules/no-api-call-in-effect.mjs`; `web/tests/no-api-call-in-effect
    // .test.mjs` makes it fail at a wrong example.
    files: ["web/src/**/*.{ts,tsx}"],
    rules: { "local/no-api-call-in-effect": "error" }
  }
);
