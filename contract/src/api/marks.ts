// `zod/mini` and not `zod`: see `contract/README.md` and `api/hosts.ts`.
import * as z from "zod/mini";

import { DEFAULT_MARK_THEME, HUE_TONES, MARK_STYLE_STEPS } from "../presets.js";
import { stepSchema } from "./steps.js";

// The shape of a mark of one's own, as every route hands it out (#248): in
// the mark editor and attached to stacks and containers on the overview.

/**
 * A mark of one's own, as the UI receives it.
 *
 * ⚠️ An ENUMERATION of fields, not the row. `created_at` is left out on
 * purpose: it does not order the list in the editor (the operator orders by
 * name) and would be a column that ends up in the browser because it exists.
 * Same promise as `toHostView` (server `domain/hosts/host-store.ts`).
 *
 * Hue and style fall back to `DEFAULT_MARK_THEME` when the bundle does not
 * know the step — the same reasoning as `hostDisplaySchema`: a mark drawn as
 * a neutral label is a cosmetic loss, not a false statement.
 */
export const markViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  hue: stepSchema(HUE_TONES, DEFAULT_MARK_THEME.hue),
  style: stepSchema(MARK_STYLE_STEPS, DEFAULT_MARK_THEME.style)
});
export type MarkView = z.infer<typeof markViewSchema>;
