import { runtimeSettingsSchema, type RuntimeSettings } from "contract";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import type { Pool } from "pg";

import { AUTH_OPTIONS_FOR_SCHEMA } from "./schema-source.js";
import { claimSetupSlot, releaseSetupSlot } from "./setup-store.js";

// Die Anmeldung dieses Systems.
//
// better-auth trägt Passwörter, Sitzungen und Cookies; die Regel des
// Hauptdashboards („keine eigene Logik für Passwörter" — das macht authentik)
// gilt hier ausdrücklich NICHT (concept-and-plan.md §2). Sie zöge genau die
// Abhängigkeit wieder ein, deretwegen dieses Repo überhaupt getrennt wurde.
// Was daraus folgt, trägt dieses Repo selbst: der Weg zurück in ein
// ausgesperrtes System steht in break-glass.ts.
//
// Was hier bewusst NICHT steht:
//   - kein Scope-Katalog. Zwei Rollen, roles.ts.
//   - kein Anbieter außer E-Mail und Passwort. Ein Heimnetz-Werkzeug, das
//     seinen Login an einen fremden Dienst hängt, ist beim Ausfall dieses
//     Dienstes zu — und dieses System ist genau das, worüber man sich sonst
//     wieder hereinließe.
//   - keine offene Registrierung. Der einzige Weg, über den ein Konto durch
//     better-auth entsteht, ist die Erstanmeldung unten, und die steht nur
//     offen, solange es kein Konto gibt.

// Der einzige Pfad, über den bei dieser Konfiguration ein Konto entsteht.
//
// ⚠️ Er ist eine Konstante und keine Liste, weil eine Liste die Bauart wäre,
// die SECURITY.md (Grundsatz 2) für den Registrierungsweg ausdrücklich
// verwirft: sie muss bei jeder neuen Route nachgepflegt werden und öffnet beim
// Vergessen still. Hier ist der Schutz umgekehrt gebaut — es gibt keinen
// zweiten Anlegepfad, weil kein zweiter Anbieter eingeschaltet ist, und
// `server/src/platform/auth/auth.test.ts` hält das nach.
export const SIGN_UP_PATH = "/sign-up/email";

// Deutlich über den acht Zeichen der Vorgabe. Der Grund ist nicht Strenge,
// sondern der Ort: dieses Konto öffnet eine Shell auf dem Host (Phase 5). Ein
// Passwort, das man sich in drei Sekunden ausdenkt, wäre hier die schwächste
// Stelle einer Kette, deren übrige Glieder gewürfelt sind.
const MIN_PASSWORD_LENGTH = 12;

export type AuthOptions = {
  writeSetupRuntime?: (runtime: RuntimeSettings) => Promise<void>;
  pool: Pool;
  secret: string;
  baseUrl: string;
};

/**
 * Die Optionen der Anmeldung, als schlichtes Objekt.
 *
 * Getrennt von `createAuth`, damit sie prüfbar sind, ohne dass eine Anmeldung
 * entsteht: `betterAuth()` baut beim Erzeugen seinen Datenbank-Adapter auf und
 * scheitert ohne echten Pool. Ein Test, der dafür erst ein Postgres bräuchte,
 * liefe in diesem Repo nicht (AGENTS.md, Tests) — und genau die Zusage, die
 * hier zu halten ist, stünde dann ungeprüft da: dass es keinen zweiten Weg
 * gibt, auf dem ein Konto entsteht.
 */
export function authOptions({ pool, secret, baseUrl, writeSetupRuntime }: AuthOptions) {
  return {
    // ⚠️ Alles, was Tabellen oder Felder erzeugt, kommt aus schema-source.ts —
    // dieselbe Beschreibung, gegen die db/auth-schema.test.ts die Migration
    // prüft. Wer hier ein Feld ergänzt statt dort, hängt es an der Prüfung
    // vorbei.
    ...AUTH_OPTIONS_FOR_SCHEMA,
    baseURL: baseUrl,
    secret,
    // Ohne diesen Pool spräche better-auth eine eigene Verbindungsmenge an,
    // die niemand mitzählt — Postgres zählt sie sehr wohl (db/pool.ts).
    database: pool,
    // Ein System, das Fremde in ihrem eigenen Netz betreiben sollen, meldet
    // nichts nach außen, was sie nicht angeordnet haben.
    telemetry: { enabled: false },
    emailAndPassword: {
      ...AUTH_OPTIONS_FOR_SCHEMA.emailAndPassword,
      minPasswordLength: MIN_PASSWORD_LENGTH,
      // Nach der Erstanmeldung sofort angemeldet: der Betreiber hat gerade
      // sein Passwort gesetzt, ein zweites Formular danach ist nur ein Schritt,
      // an dem etwas schiefgehen kann.
      autoSignIn: true
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== SIGN_UP_PATH) return;

        const runtime = runtimeSettingsSchema.safeParse({
          applyComposeDefinition: ctx.body?.applyComposeDefinition === undefined ? true : ctx.body.applyComposeDefinition
        });
        if (!runtime.success) throw new APIError("BAD_REQUEST", { code: "INVALID_RUNTIME_SETTINGS",
          message: "Die Wahl zum Anwenden der Compose-Definition muss ein Boolean sein." });

        // Belegen statt fragen: die Prüfung „gibt es schon ein Konto?" und das
        // Anlegen wären sonst zwei Schritte mit einem Fenster dazwischen
        // (setup-store.ts).
        const claimed = await claimSetupSlot(pool);
        if (!claimed) {
          throw new APIError("FORBIDDEN", {
            code: "SETUP_CLOSED",
            message:
              "Die Erstanmeldung steht nur offen, solange kein Konto existiert. " +
              "Wer ausgesperrt ist, kommt über das Break-Glass herein: " +
              "docker compose exec hub node server/dist/platform/auth/break-glass.js --help"
          });
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== SIGN_UP_PATH) return;
        // Die Erstanmeldung ist durch — der Platz bleibt belegt, weil jetzt
        // ein Konto existiert. `releaseSetupSlot` prüft genau das und tut
        // hier deshalb nichts; der Aufruf steht trotzdem, damit ein Vorgang,
        // der ohne Konto endete, den Weg nicht zehn Minuten lang zuhält.
        await releaseSetupSlot(pool);
      })
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user, ctx) => {
            await writeSetupRuntime?.(runtimeSettingsSchema.parse({
              applyComposeDefinition: ctx?.body?.applyComposeDefinition === undefined ? true : ctx.body.applyComposeDefinition
            }));
            // The setup gate permits exactly one account, always an administrator.
            return { data: { ...user, role: "admin" } };
          }
        }
      }
    }
    // ⚠️ Kein `socialProviders`, keine `plugins`. Beides brächte einen
    // zweiten Weg mit, auf dem better-auth ein Konto anlegt — und der
    // `databaseHooks`-Haken oben macht JEDES so entstandene Konto zum Admin.
    // auth.test.ts hält das nach.
  } satisfies BetterAuthOptions;
}

export function createAuth(options: AuthOptions) {
  return betterAuth(authOptions(options));
}

export type Auth = ReturnType<typeof createAuth>;
