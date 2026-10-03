import type { Messages } from "use-intl";

// Die Schritte der Anwende-Strecke als Text für Menschen (Befund vom
// 2026-09-30 am Arm `local`: die Fläche zeigte die Schlüssel roh — im Ablauf
// `check` und `resolve-containers`, in der Vorschau `validate` und
// `pull-images`). Dieselbe Bauart wie `compose-errors.ts`: keine Komponente,
// `t` steht beim Aufrufer, hier steht nur die Zuordnung.
//
// ⚠️ TWO VOCABULARIES, ONE TEXT PER STEP. The preview names the steps with
// the hub's names (`COMPOSE_APPLY_STEPS` in
// `server/src/features/compose/types.ts`), the stream with the agent's values
// (`COMPOSE_STREAM_STEPS`). Both are English since #278 (`check`,
// `pull-images`, …); the agent's values stand here verbatim, a different
// spelling would match no step the agent sends.
//
// ⚠️ EIN UNBEKANNTER SCHRITT BLEIBT STEHEN. `composeStepKey` liefert dafür
// `null`, und der Aufrufer zeigt den Wert wörtlich: ein zehnter Schritt eines
// neueren Agenten soll in der Anzeige stehen und nicht verschwinden.

type StepKey = keyof Messages & `composeStep${string}`;

const STEP_KEYS = new Map<string, StepKey>([
  // Vorschau — Namen des Hubs.
  ["validate", "composeStepValidate"],
  ["confirm", "composeStepConfirm"],
  ["pull-images", "composeStepPullImages"],
  ["write", "composeStepWrite"],
  ["start", "composeStepStart"],
  ["resolve-containers", "composeStepResolveContainers"],
  ["measure-hardening", "composeStepHardening"],
  ["remove-containers", "composeStepRemoveContainers"],
  // Strom — Werte des Agenten.
  ["check", "composeStepValidate"],
  ["confirmations", "composeStepConfirm"],
  ["pull-images", "composeStepPullImages"],
  ["write-file", "composeStepWrite"],
  ["start", "composeStepStart"],
  ["resolve-containers", "composeStepResolveContainers"],
  ["check-hardening", "composeStepHardening"],
  ["clean-up", "composeStepCleanUp"],
  ["roll-back", "composeStepRollBack"]
]);

/** Der Textschlüssel zu einem Schritt, oder `null` für einen unbekannten. */
export function composeStepKey(step: string): StepKey | null {
  return STEP_KEYS.get(step) ?? null;
}
