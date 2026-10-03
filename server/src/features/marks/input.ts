import { MARK_IDS_MAX, MARK_NAME_MAX } from "contract";

import type { MarkThemePreset, StackDisplayPreset, ThemeKnobName } from "contract";

import { asRecord, knobsInScope, parseKnobSet, type ThemeInputResult } from "../../platform/theme/knob-input.js";

// The check of what the marks surface sends: an own mark, the marks of a stack
// or container, and the display of a stack (#268). The check of a set of knobs
// stands in `platform/theme/knob-input.ts`; the feature `appearance` uses the
// same.
//
// ⚠️ TWO LIMITS CHECKED HERE ARE NOT THEME KNOBS: the NAME of a mark
// (`MARK_NAME_MAX`) and the number of marks per target (`MARK_IDS_MAX`). They
// have no steps, no attribute and no default. They live in `contract`
// because the web enforces them as well, before a request is made.
//
// ⚠️ `hue` steht in BEIDEN Listen — in den Stellschrauben einer Marke und in
// denen eines Arms (`HOST_KNOBS`, `features/appearance/input.ts`). Das ist der
// Zweck der Liste in `scope`: derselbe Tonvorrat, zwei Reichweiten, eine
// Stufenliste (#62: „nicht vier Stellen mit demselben Standardwert").
export const MARK_KNOBS = knobsInScope("mark") as (keyof MarkThemePreset)[];

export const STACK_KNOBS = knobsInScope("stack") as (keyof StackDisplayPreset)[];

/** Was aus dem Rumpf von `POST`/`PUT /api/marks` herauskommt. */
export type MarkInput = MarkThemePreset & { name: string };

/**
 * Der Name einer Marke: eine nichtleere Zeichenkette, an den Rändern gekürzt,
 * höchstens `MARK_NAME_MAX` Zeichen.
 *
 * ⚠️ GEKÜRZT WIRD VOR DER PRÜFUNG UND DER GEKÜRZTE WERT REIST WEITER. Ein Name
 * aus lauter Leerzeichen ist damit leer und ein 400 — und nicht eine Marke,
 * die in der Liste als Lücke steht und sich nicht mehr benennen lässt. Aus
 * demselben Grund geht der gekürzte Wert in die Ablage: „ backup" und „backup"
 * sind sonst zwei Marken, die der eindeutige Index nicht auseinanderhält, weil
 * er das Leerzeichen mitzählt.
 */
function parseMarkName(value: unknown): ThemeInputResult<string> {
  if (typeof value !== "string") {
    return { ok: false, message: "„name“ fehlt in „mark“ oder ist keine Zeichenkette." };
  }
  const name = value.trim();
  if (name === "") {
    return { ok: false, message: "„name“ ist leer. Eine Marke ohne Namen ordnet nichts." };
  }
  if (name.length > MARK_NAME_MAX) {
    return {
      ok: false,
      message: `„name“ ist ${name.length} Zeichen lang. Erlaubt sind höchstens ${MARK_NAME_MAX}.`
    };
  }
  return { ok: true, value: name };
}

/**
 * Der Rumpf von `POST /api/marks` und `PUT /api/marks/:markId`:
 * `{ mark: { name, hue, style } }` — alle drei Felder.
 *
 * ⚠️ `hue` und `style` sind Stellschrauben und werden gegen `THEME_KNOBS`
 * geprüft; `name` ist keine und wird daneben geprüft. Der Umschlag `mark`
 * trägt beides, weil eine Marke aus beidem besteht — eine Marke ohne Namen
 * wäre ein Farbfleck.
 */
export function parseMarkInput(body: unknown): ThemeInputResult<MarkInput> {
  const parsed = parseKnobSet(body, "mark", MARK_KNOBS as readonly ThemeKnobName[], "Angabe einer Marke", [
    "name"
  ]);
  if (!parsed.ok) return parsed;

  const name = parseMarkName(parsed.value.inner.name);
  if (!name.ok) return name;

  return { ok: true, value: { ...(parsed.value.values as unknown as MarkThemePreset), name: name.value } };
}

/**
 * Der Rumpf von `PUT /api/hosts/:hostId/stacks/:project/display`:
 * `{ display: { indent } }`.
 */
export function parseStackDisplay(body: unknown): ThemeInputResult<StackDisplayPreset> {
  const parsed = parseKnobSet(
    body,
    "display",
    STACK_KNOBS as readonly ThemeKnobName[],
    "Stellschraube eines Stacks"
  );
  if (!parsed.ok) return parsed;
  return { ok: true, value: parsed.value.values as unknown as StackDisplayPreset };
}

/**
 * Der Rumpf der zwei Zuordnungsrouten: `{ markIds: string[] }`.
 *
 * ⚠️ DIE REIHENFOLGE IM FELD IST DIE REIHENFOLGE. Sie wird nicht sortiert und
 * nicht normalisiert — der Betreiber ordnet seine Marken, und eine Liste, die
 * der Server hinter seinem Rücken umstellt, ist keine Angabe mehr, sondern ein
 * Vorschlag.
 *
 * ⚠️ EINE DUBLETTE IST EIN 400 UND KEIN STILLES ZUSAMMENZIEHEN. Der
 * Primärschlüssel der Zuordnung lässt dieselbe Marke am selben Ziel nur einmal
 * zu; ein Server, der die zweite wegwirft, antwortete mit einer anderen Liste,
 * als er bekommen hat, und der Editor hielte seine Anzeige für den Stand.
 *
 * ⚠️ Die leere Liste ist GÜLTIG und heißt „dieses Ziel trägt keine Marke
 * mehr". Sie ist der einzige Weg, die letzte Marke wieder abzuziehen — der
 * Satz reist vollständig, wie überall in dieser Datei.
 */
export function parseMarkIds(body: unknown): ThemeInputResult<string[]> {
  const outer = asRecord(body);
  if (!outer) return { ok: false, message: "Der Rumpf der Anfrage ist kein JSON-Objekt." };

  for (const key of Object.keys(outer)) {
    if (key !== "markIds") {
      return { ok: false, message: `„${key}“ gehört nicht in den Rumpf. Erwartet wird „markIds“.` };
    }
  }

  const value = outer.markIds;
  if (!Array.isArray(value)) {
    return { ok: false, message: "„markIds“ fehlt im Rumpf der Anfrage oder ist kein Feld." };
  }
  if (value.length > MARK_IDS_MAX) {
    return {
      ok: false,
      message: `„markIds“ trägt ${value.length} Einträge. Erlaubt sind höchstens ${MARK_IDS_MAX}.`
    };
  }

  const ids: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry === "") {
      return { ok: false, message: "Jeder Eintrag in „markIds“ ist eine nichtleere Zeichenkette." };
    }
    if (ids.includes(entry)) {
      return { ok: false, message: `„${entry}“ steht zweimal in „markIds“. Ein Ziel trägt eine Marke einmal.` };
    }
    ids.push(entry);
  }

  return { ok: true, value: ids };
}
