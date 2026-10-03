// The tidying-up of `dom-harness.tsx` itself (#286).
//
// ⚠️ The order of the imports is MEANING and not formatting: the DOM has to
// stand before React is loaded (see `dom-harness.tsx`).
import { renderInDom, settle } from "./dom-harness.js";

// ⚠️ React is named although no line calls it: `tsx` compiles the JSX of this
// file with the old runtime (`React.createElement`); see `language-switch.test.tsx`.
import React from "react";

import assert from "node:assert/strict";
import test from "node:test";

import { useQuery } from "@tanstack/react-query";

// WHAT THIS FILE CHECKS: that `unmount` leaves no long timer behind when a case
// ends with a fetch still open. Two cases of `files-view-actions.test.tsx` end
// that way on purpose; each left a five-minute gc timer of TanStack Query
// behind, and the file ended five minutes after its last case (measured
// 2026-10-02: `real 5m1s` for 18.7 s of tests). Nothing turned red — the run
// only waited, and every push waited with it.
//
// The timers are counted at `setTimeout` of the window, the one TanStack
// Query's `timeoutManager` calls under happy-dom.

const LONG_TIMER_MS = 60_000;

function NeverAnswers() {
  const query = useQuery({ queryKey: ["never-answers"], queryFn: () => new Promise<string>(() => {}) });
  return <p>{query.status}</p>;
}

test("unmount leaves no long timer behind when a fetch is still open", async () => {
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  const live = new Set<unknown>();
  globalThis.setTimeout = ((handler: () => void, delay?: number, ...rest: unknown[]) => {
    const id = realSet(handler, delay, ...rest);
    if ((delay ?? 0) >= LONG_TIMER_MS) live.add(id);
    return id;
  }) as typeof globalThis.setTimeout;
  globalThis.clearTimeout = ((id: Parameters<typeof clearTimeout>[0]) => {
    live.delete(id);
    realClear(id);
  }) as typeof globalThis.clearTimeout;

  try {
    const mounted = await renderInDom(<NeverAnswers />);
    await settle();
    assert.equal(mounted.queryClient.isFetching(), 1, "the fetch of the probe is not open");

    await mounted.unmount();
    await settle();

    assert.equal(live.size, 0, `unmount left ${live.size} timer(s) of a minute or more behind`);
  } finally {
    for (const id of live) realClear(id as Parameters<typeof clearTimeout>[0]);
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
  }
});
