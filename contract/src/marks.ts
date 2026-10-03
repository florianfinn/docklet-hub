// Limits on marks. The server rejects input beyond them (`features/marks/input.ts`),
// the web disables the control before the user gets there.
//
// They are limits and not theme knobs: no steps, no attribute, no default.
// That is why they do not live next to `THEME_KNOBS` in `presets.ts`.

/**
 * Longest allowed mark name, in characters, after trimming.
 *
 * ⚠️ A decision, not a measurement: a mark sorts, it does not describe. It sits
 * in one row next to a stack name, and whatever no longer fits there is a
 * sentence rather than a mark.
 *
 * Counts JavaScript code units, not glyphs: an emoji made of two surrogates
 * counts as two. Imprecise and still right — segmenting by grapheme depends on
 * the ICU version of the running engine, and a limit that differs between two
 * machines is no limit.
 */
export const MARK_NAME_MAX = 40;

/**
 * How many marks one target carries at most.
 *
 * ⚠️ Also a decision: marks sit side by side in one row, and eight is more than
 * fits there legibly. The limit lives in code and not in the database because
 * it is a statement about the surface, not about the data — Postgres has no
 * `CHECK` over the row count of a group without a trigger anyway.
 */
export const MARK_IDS_MAX = 8;

// The shape `MarkView` itself is a schema in `api/marks.ts` (#248).
