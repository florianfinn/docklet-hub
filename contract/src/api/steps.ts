// `zod/mini` and not `zod`: see `contract/README.md` and `api/hosts.ts`.
import * as z from "zod/mini";

/**
 * A knob of the theme on the wire: one of the names of its step list in
 * `presets.ts`, falling back to `fallback` when the bundle does not know the
 * value.
 *
 * Every knob is cosmetic. A newer hub may offer a step a cached bundle does
 * not know, and drawing it in the default is a loss of colour, not a false
 * statement (`contract/README.md`, "Leitung statt Laufzeit"). The server test
 * still sees an invalid value: it compares the parse result with the body.
 *
 * The steps are read from the list and not repeated: a step added there is
 * accepted here without a second edit.
 */
export function stepSchema<const Name extends string>(steps: readonly { readonly name: Name }[], fallback: Name) {
  // `z.enum` needs a non-empty tuple; `map` yields an array. Every step list
  // in `presets.ts` has at least two entries.
  const names = steps.map((step) => step.name) as [Name, ...Name[]];
  return z.catch(z.enum(names), fallback);
}
