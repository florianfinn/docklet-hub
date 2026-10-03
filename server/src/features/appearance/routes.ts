import type { Router } from "express";
import type { Pool } from "pg";

import type { Auth } from "../../platform/auth/auth.js";
import { requireAdmin } from "../../platform/auth/require-admin.js";
import { failWith, guarded } from "../../platform/http/route-responses.js";
import { parseGlobalTheme, parseHostDisplay } from "./input.js";
import { appearanceDeps, setHostColor } from "./service.js";
import { writeGlobalTheme } from "./store.js";

// The routes of the feature `appearance` (#268): the theme of the hub and the
// colour of an arm (D7a, #62). They took the place of two of the routes in
// `appearance-routes.ts`; its other routes, the own marks, are the feature
// `marks` now.
//
// Beide Routen tragen `requireAdmin`: nach #17 schreibt ein Administrator,
// lesen alle — `GET /settings` liefert das Thema, und die Farbe eines Arms
// steht in `GET /hosts`.

export function registerAppearanceRoutes(router: Router, { auth, pool }: { auth: Auth; pool: Pool }): void {
  // Die Darstellung des Hubs ändern.
  //
  // Rumpf `{ theme: GlobalThemePreset }`, Antwort `{ theme: … }` — beide mit
  // dem VOLLEN Satz aller sieben Stellschrauben (Vertrag aus #64 in der Fassung
  // vom 2026-09-06).
  //
  // ⚠️ Vollständig und nicht als Teilmenge: ein Satz, der nur teilweise
  // ankommt, hinterlässt eine Mischung aus altem und neuem Stand, die niemand
  // mehr benennen kann. Ein unvollständiger Rumpf ist deshalb ein 400 und kein
  // Zusammenführen mit dem Gespeicherten.
  //
  // ⚠️ Die Antwort trägt den Stand und nicht ein 204: der Editor muss danach
  // wissen, was wirklich gilt — sonst zeichnet er aus dem, was er selbst
  // geschickt hat, und weiß nichts von einem zweiten Administrator, der
  // zwischendurch etwas anderes gestellt hat. Das ist der Unterschied zu
  // `PUT /session/language`, wo die Antwort nichts trüge, was der Aufrufer
  // nicht schon wüsste.
  //
  // ⚠️ Geprüft wird gegen `THEME_KNOBS` (`platform/theme/knob-input.ts`, `features/appearance/input.ts`) und nicht gegen
  // eine Liste in dieser Datei. Ein unbekannter Wert ODER ein unbekannter
  // Schlüssel ist ein 400 und kein stiller Rückfall auf die Vorgabe: ein
  // Editor, der einen Tippfehler schickt, soll ihn erfahren.
  router.put(
    "/settings/theme",
    requireAdmin(auth),
    guarded(async (request, response) => {
      const parsed = parseGlobalTheme(request.body);
      if (!parsed.ok) {
        failWith(response, 400, "invalid-input", parsed.message);
        return;
      }
      response.json({ theme: await writeGlobalTheme(pool, parsed.value) });
    })
  );

  // Farbton und Farbeinsatz eines Arms setzen (D0 §2: „der Betreiber
  // vergibt").
  //
  // Rumpf `{ display: { hue, ink } }` — beide Felder, unter dem Umschlag, wie
  // `PUT /session/language` es vormacht.
  //
  // Zurück kommt die HostView dieses Arms, in derselben Form wie aus
  // `POST /hosts` — unter `host`. Die Oberfläche kann damit ihre Zeile
  // ersetzen, statt sie aus dem zusammenzusetzen, was sie geschickt hat. Der
  // Zustand wird dafür neu erhoben, siehe `setHostColor` in `service.ts`.
  router.put(
    "/hosts/:hostId/display",
    requireAdmin(auth),
    guarded(async (request, response) => {
      const parsed = parseHostDisplay(request.body);
      if (!parsed.ok) {
        failWith(response, 400, "invalid-input", parsed.message);
        return;
      }
      const result = await setHostColor(appearanceDeps(pool), String(request.params.hostId), parsed.value);
      if (result.kind === "host-unknown") {
        response.status(404).json({ error: "host-unknown" });
        return;
      }
      response.json({ host: result.host });
    })
  );
}
