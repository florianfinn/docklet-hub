import type { GlobalThemePreset, HostThemePreset, ThemeKnobName } from "contract";

import { knobsInScope, parseKnobSet, type ThemeInputResult } from "../../platform/theme/knob-input.js";

// The check of what the appearance editor sends: the global theme and the
// colour of an arm (#268). The checking itself, one knob against the steps of
// `THEME_KNOBS`, stands in `platform/theme/knob-input.ts`; the feature `marks`
// uses the same.
//
// ⚠️ `scope` ist seit D7b (#62) eine LISTE, und `hue` steht in BEIDEN Listen —
// in `HOST_KNOBS` und in den Stellschrauben einer Marke. Das ist der Zweck der
// Liste in `scope`: derselbe Tonvorrat, zwei Reichweiten, eine Stufenliste
// (#62: „nicht vier Stellen mit demselben Standardwert").

export const GLOBAL_KNOBS = knobsInScope("global") as (keyof GlobalThemePreset)[];

export const HOST_KNOBS = knobsInScope("host") as (keyof HostThemePreset)[];


/**
 * Der Rumpf von `PUT /api/settings/theme`: `{ theme: GlobalThemePreset }` —
 * alle sieben globalen Stellschrauben.
 */
export function parseGlobalTheme(body: unknown): ThemeInputResult<GlobalThemePreset> {
  const parsed = parseKnobSet(body, "theme", GLOBAL_KNOBS as readonly ThemeKnobName[], "Stellschraube des Hubs");
  if (!parsed.ok) return parsed;
  return { ok: true, value: parsed.value.values as unknown as GlobalThemePreset };
}

/**
 * Der Rumpf von `PUT /api/hosts/:hostId/display`:
 * `{ display: { hue, ink } }` — beide Felder.
 */
export function parseHostDisplay(body: unknown): ThemeInputResult<HostThemePreset> {
  const parsed = parseKnobSet(body, "display", HOST_KNOBS as readonly ThemeKnobName[], "Stellschraube eines Arms");
  if (!parsed.ok) return parsed;
  return { ok: true, value: parsed.value.values as unknown as HostThemePreset };
}
