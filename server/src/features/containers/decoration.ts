import type { IndentName, MarkView } from "contract";

// What an arm brings of its own, as the overview reads it: the marks of its
// stacks and containers, the indent of its stacks and the stacks the operator
// hid. Types and an empty value, nothing else.
//
// The feature `marks` owns the stock and the assignment (#268) and reads the
// values from its tables; the overview must not import it (a feature imports
// no other feature). `server/src/app/features.ts` hands the reader in as
// `decorationFor`, and the shape below is the one `marks` returns, written
// down a second time here because a type is the one thing both sides must
// agree on. The maps are keyed by NAME (compose project, container name), not
// by an id: there is none, a stack and a container come and go with the answer
// of the agent.

export type HostDecoration = {
  marksByStack: ReadonlyMap<string, MarkView[]>;
  marksByContainer: ReadonlyMap<string, MarkView[]>;
  indentByStack: ReadonlyMap<string, IndentName>;
  hiddenStacks: ReadonlySet<string>;
};

/** An arm with nothing assigned, the normal case. */
export const EMPTY_DECORATION: HostDecoration = {
  marksByStack: new Map(),
  marksByContainer: new Map(),
  indentByStack: new Map(),
  hiddenStacks: new Set()
};
