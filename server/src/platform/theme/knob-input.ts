import { THEME_KNOBS, type KnobScope, type ThemeKnobName } from "contract";

// The check of a set of theme knobs that an editor sends, against `THEME_KNOBS`
// and nothing else. Moved here from `theme/theme-input.ts` with #268: the
// features `appearance` (global theme, colour of an arm) and `marks` (own
// marks, per-stack display) both check a set of knobs, and a feature imports
// no other feature, so what the two share lives below them.
//
// Eigene Datei und nicht im Router: hier steht die Entscheidung, im Router der
// Weg nach draußen. Dieselbe Trennung wie zwischen `setup-gate.ts` und
// `setup-store.ts` und aus demselben Grund — die Entscheidung ist die Stelle,
// an der man sich irren kann, und sie muss ohne Datenbank prüfbar sein
// (AGENTS.md, Tests).
//
// ⚠️ HIER STEHT KEINE ZWEITE LISTE. Jede erlaubte Stufe kommt aus
// `THEME_KNOBS`; welche Stellschraube global gilt und welche am Arm, an einer
// Marke oder an einem Stack hängt, kommt aus dem `scope` derselben Tabelle.
// Eine abgeschriebene Aufzählung wäre ein dritter Ort neben `presets.ts` und
// der Migration — und der Wächter `theme-schema.test.ts` hielte nur zwei davon
// gegeneinander.
//
// ⚠️ EIN UNBEKANNTER WERT IST EIN FEHLER UND KEIN STILLER RÜCKFALL AUF DIE
// VORGABE. Das ist der Unterschied zu `toLanguage` (auth/language.ts), das
// beim LESEN bewusst fail closed ist: wer eine Einstellung SCHREIBT, hat sie
// gewählt, und ein Tippfehler, der als Vorgabewert zurückkommt, sieht für ihn
// aus wie ein Fehler des Editors. Derselbe Gedanke wie bei
// `PUT /session/language`, wo der Vergleich mit dem Hereingekommenen genau
// deshalb vor dem Schreiben steht.

/** Was aus einer Prüfung herauskommt: der Wert oder der Grund. */
export type ThemeInputResult<T> = { ok: true; value: T } | { ok: false; message: string };

/**
 * Die Namen der Stufen einer Stellschraube.
 *
 * Die Umdeutung auf `{ name: string }` ist nötig, weil `steps` je Stellschraube
 * ein anderer Tupeltyp ist und `Array.prototype.map` über die Vereinigung
 * dieser Tupel nicht aufrufbar wäre. Gemeinsam haben alle das Feld `name` —
 * genau das steht hier.
 */
function stepNames(knob: ThemeKnobName): readonly string[] {
  return (THEME_KNOBS[knob].steps as readonly { name: string }[]).map((step) => step.name);
}

const KNOB_NAMES = Object.keys(THEME_KNOBS) as ThemeKnobName[];

/**
 * Die Stellschrauben einer Reichweite — abgeleitet, nicht aufgezählt.
 *
 * Each feature narrows the result to the type of its own set
 * (`keyof GlobalThemePreset` and so on); that the narrowing is true is a claim
 * about `presets.ts`, and it is not believed but checked:
 * `theme-schema.test.ts` holds `Object.keys(DEFAULT_GLOBAL_THEME)` and the
 * three other default sets against exactly this derivation. If one drifts, that
 * test goes red, not the feature that narrows silently wrong.
 *
 * ⚠️ `scope` ist seit D7b (#62) eine LISTE. Gefiltert wird deshalb mit
 * `includes` und nicht mit `===` — abgeleitet bleibt es trotzdem, und genau
 * das war die Bedingung: eine Stellschraube darf in mehr als einer Reichweite
 * gelten, ohne dass ihre Stufen ein zweites Mal dastehen.
 */
export function knobsInScope(scope: KnobScope): ThemeKnobName[] {
  return KNOB_NAMES.filter((knob) => (THEME_KNOBS[knob].scope as readonly KnobScope[]).includes(scope));
}

export function asRecord(body: unknown): Record<string, unknown> | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  return body as Record<string, unknown>;
}

/** Ein Wert gegen die Stufen SEINER Stellschraube. */
function checkStep(knob: ThemeKnobName, value: unknown): ThemeInputResult<string> {
  const allowed = stepNames(knob);
  if (typeof value !== "string" || !allowed.includes(value)) {
    return {
      ok: false,
      message:
        `„${knob}“ ist ${allowed.map((step) => `„${step}“`).join(", ")} — ` +
        `„${typeof value === "string" ? value : String(value)}“ gibt es nicht.`
    };
  }
  return { ok: true, value };
}

/**
 * Ein Satz Stellschrauben unter EINEM Umschlag — der gemeinsame Kern beider
 * Rümpfe.
 *
 * ⚠️ Der Umschlag (`{ theme: … }`, `{ display: … }`) ist das Hausmuster von
 * `PUT /api/session/language` und keine Zierde: ein Rumpf, der heute genau der
 * Satz ist, müsste umgebaut werden, sobald neben ihm ein zweites Feld steht.
 *
 * ⚠️ VOLLSTÄNDIG und nicht als Teilmenge. Ein Satz, der nur teilweise ankommt,
 * hinterlässt eine Mischung aus altem und neuem Stand, die niemand mehr
 * benennen kann — der Editor sähe eine Fläche, die weder das eine noch das
 * andere ist. Eine fehlende Stellschraube ist deshalb ein Fehler und kein
 * Zusammenführen mit dem Gespeicherten.
 */
export function parseKnobSet(
  body: unknown,
  envelope: string,
  knobs: readonly ThemeKnobName[],
  what: string,
  // Schlüssel, die neben den Stellschrauben im Umschlag stehen DÜRFEN und
  // anderswo geprüft werden. Heute genau einer: der Name einer Marke. Er hat
  // keine Stufen, kein Attribut und keinen Vorgabewert und ist deshalb keine
  // Stellschraube — er reist nur im selben Umschlag.
  extra: readonly string[] = []
): ThemeInputResult<{ values: Record<string, string>; inner: Record<string, unknown> }> {
  const outer = asRecord(body);
  if (!outer) return { ok: false, message: "Der Rumpf der Anfrage ist kein JSON-Objekt." };

  for (const key of Object.keys(outer)) {
    if (key !== envelope) {
      return { ok: false, message: `„${key}“ gehört nicht in den Rumpf. Erwartet wird „${envelope}“.` };
    }
  }

  const inner = asRecord(outer[envelope]);
  if (!inner) {
    return { ok: false, message: `„${envelope}“ fehlt im Rumpf der Anfrage oder ist kein JSON-Objekt.` };
  }

  const allowed = [...(knobs as readonly string[]), ...extra];
  for (const key of Object.keys(inner)) {
    if (!allowed.includes(key)) {
      return { ok: false, message: `„${key}“ ist keine ${what}. Es gibt: ${allowed.join(", ")}.` };
    }
  }

  const values: Record<string, string> = {};
  for (const knob of knobs) {
    if (!(knob in inner)) {
      return {
        ok: false,
        message:
          `„${knob}“ fehlt in „${envelope}“. Der Satz reist vollständig — ein halber Satz ließe ` +
          "einen Stand zurück, der weder der alte noch der neue ist."
      };
    }
    const step = checkStep(knob, inner[knob]);
    if (!step.ok) return step;
    values[knob] = step.value;
  }

  return { ok: true, value: { values, inner } };
}
