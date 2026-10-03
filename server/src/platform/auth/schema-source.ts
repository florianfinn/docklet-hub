import type { BetterAuthOptions } from "better-auth";

import { DEFAULT_LANGUAGE } from "./language.js";
import { DEFAULT_ROLE } from "./roles.js";

// Die Optionen, aus denen sich das SCHEMA von better-auth ergibt — und nur
// die.
//
// Warum getrennt von auth.ts: dort steht der Rest der Anmeldung, und der
// braucht einen Verbindungspool, ein Geheimnis und eine Adresse. Ein Wächter,
// der das Schema prüft (db/auth-schema.test.ts), braucht davon nichts — und
// eine Prüfung, die zuerst eine halbe Laufzeitumgebung aufbauen muss, wird
// beim nächsten Umbau still übersprungen.
//
// ⚠️ Was hier steht, muss dasselbe sein wie in auth.ts. Alles, was Tabellen
// oder Felder erzeugt, gehört deshalb hierher und wird dort eingesetzt, nicht
// abgeschrieben.
export const AUTH_OPTIONS_FOR_SCHEMA = {
  appName: "docklet-hub",
  emailAndPassword: { enabled: true },
  user: {
    additionalFields: {
      role: { type: "string", required: false, defaultValue: DEFAULT_ROLE, input: false },
      // ⚠️ `input: false` ist hier keine Bequemlichkeit, sondern der Riegel:
      // es hält die Sprache aus dem Aktualisierungsweg von better-auth
      // heraus. Ohne ihn nähme `updateUser` jeden Wert entgegen, den ein
      // Browser mitschickt — auch „fr" oder eine Zahl —, und der CHECK der
      // Spalte wäre die erste Stelle, die widerspricht. Geschrieben wird die
      // Sprache ausschließlich über PUT /session/language (features/account/routes.ts),
      // und die prüft den Wert, bevor sie ihn weitergibt.
      language: { type: "string", required: false, defaultValue: DEFAULT_LANGUAGE, input: false }
    }
  }
} as const satisfies BetterAuthOptions;
