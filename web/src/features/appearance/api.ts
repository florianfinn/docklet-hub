// The calls of the feature `appearance` to the hub (#268): the global theme and
// the colour of an arm. Moved here from `web/src/api/client.ts` unchanged
// except for the read, which is new (see `fetchGlobalTheme`); the reasons stand
// at each call.
//
// ⚠️ THE MIRROR GUARD READS THIS FILE: `web/tests/client-files.mjs` collects
// every `api.ts` under `web/src/` next to `platform/http/`, so a
// call here is held against the routes of the server like any other.

import {
  hostResponseSchema,
  settingsSchema,
  themeResponseSchema,
  type GlobalThemePreset,
  type HostThemePreset
} from "contract";

import type { DockerHost } from "../../domain/hosts";
import { parseResponse, putJson, request } from "../../platform/http/transport";

/**
 * The global theme, read from `GET /api/settings`.
 *
 * ⚠️ THE SAME ROUTE AS the other readers of `GET /api/settings` (until #271
 * `fetchSettings` in `web/src/api/client.ts`), parsed with the same schema;
 * the provider only needs `theme`. A feature imports no other feature, and a
 * second route for one field would be a second truth on the server. `GET /api/settings` stands behind `withSession`: before the
 * sign-in the provider does not call it (`GlobalThemeProvider.tsx`).
 */
export async function fetchGlobalTheme(): Promise<GlobalThemePreset> {
  const settings = parseResponse("/api/settings", settingsSchema, await request("/api/settings"));
  return settings.theme;
}

// Die sieben globalen Stellschrauben speichern (Admin). Der Rumpf trägt den
// VOLLSTÄNDIGEN Satz und nicht die eine geänderte Stufe: ein Satz, der nur
// teilweise ankommt, hinterließe eine Mischung aus altem und neuem Stand, die
// niemand mehr benennen kann.
//
// `PUT` und nicht `POST`: derselbe Aufruf zweimal ergibt denselben Zustand.
export async function setGlobalTheme(theme: GlobalThemePreset): Promise<{ theme: GlobalThemePreset }> {
  const path = "/api/settings/theme";
  return parseResponse(path, themeResponseSchema, await putJson(path, { theme }));
}

// Die Farbe eines Arms speichern (Admin). Die Antwort ist der Arm selbst und
// nicht nur die gespeicherte Farbe — so trägt die Liste nach dem Speichern
// denselben Stand wie der Server, ohne einen zweiten Abruf.
export async function setHostDisplay(hostId: string, display: HostThemePreset): Promise<DockerHost> {
  const path = `/api/hosts/${encodeURIComponent(hostId)}/display`;
  const { host } = parseResponse(path, hostResponseSchema, await putJson(path, { display }));
  return host;
}
