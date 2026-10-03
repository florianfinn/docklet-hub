import type * as z from "zod/mini";

import type { NdjsonEvent } from "contract";

// One line of an agent stream, checked against its schema (#272).
//
// The schemas live in `contract/src/agent/streams.ts` and are the ones the
// agent types its lines with (`satisfies`). A line that does not fit is
// DROPPED, not repaired: a field filled with a made-up default would look
// like the agent's word, and the stream goes on to the browser.
//
// ⚠️ An unknown `kind` is dropped the same way, and that is the rule, not a
// gap: a kind a newer agent adds must not end a stream an older hub reads.
// What the reader does not know has nothing to do in the browser. `reason` and
// `step`, by contrast, are read as plain strings in the schemas, so that a new
// key reaches the operator verbatim instead of disappearing.
export function parseStreamLine<Schema extends z.ZodMiniType>(
  schema: Schema,
  record: NdjsonEvent
): z.output<Schema> | null {
  const parsed = schema.safeParse(record);
  return parsed.success ? parsed.data : null;
}
