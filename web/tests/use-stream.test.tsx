// ⚠️ The order of imports is MEANING, not formatting: the DOM must stand
// before React is loaded (see `dom-harness.tsx`).
import { renderInDom, settle } from "./dom-harness.js";

// ⚠️ React is named although no line calls it — `tsx` compiles the JSX of this
// file with the classic runtime (`React.createElement`). The reason and the
// measurement are in the head of `language-switch.test.tsx`.
import React, { StrictMode } from "react";

import assert from "node:assert/strict";
import test from "node:test";

const { useStream } = await import("../src/platform/streams/use-stream.js");
const { sharedStreamCount } = await import("../src/platform/streams/stream-store.js");

// WHAT THIS FILE CHECKS (#257)
//
// `useStream` binds the stream store to React. The pure rules are checked in
// `stream-store.test.mjs`; here only what needs a real React tree:
//
//   1. StrictMode mounts twice and still opens ONE stream.
//   2. Two components reading the same key share one stream.
//   3. Unmounting aborts the stream — no orphan at the arm after a tab switch.
//   4. A new key aborts the old stream and opens the new one.
//
// The source is a stub; what a real one sends is the business of the views.

type Run = { key: string; signal: AbortSignal; sink: { open(): void; line(line: string): void } };

const runs: Run[] = [];
const sourceFor = (key: string) => (signal: AbortSignal, sink: Run["sink"]) =>
  new Promise<void>((resolve) => {
    runs.push({ key, signal, sink });
    signal.addEventListener("abort", () => resolve());
  });

function Reader({ streamKey, testId = "reader" }: { streamKey: string; testId?: string }) {
  const stream = useStream(streamKey, sourceFor(streamKey), { cap: 10 });
  return (
    <p data-testid={testId} data-phase={stream.phase}>
      {stream.lines.join(",")}
    </p>
  );
}

test("StrictMode mounts twice and opens one stream; unmount aborts it", async () => {
  runs.length = 0;
  const mounted = await renderInDom(
    <StrictMode>
      <Reader streamKey="s1" />
    </StrictMode>
  );
  await settle();
  assert.equal(runs.length, 1, `StrictMode opened ${runs.length} streams`);
  const run = runs[0]!;
  assert.equal(run.signal.aborted, false);

  await mountedAct(() => {
    run.sink.open();
    run.sink.line("hello");
  });
  const node = mounted.container.querySelector('[data-testid="reader"]');
  assert.equal(node?.getAttribute("data-phase"), "open");
  assert.equal(node?.textContent, "hello");

  await mounted.unmount();
  await settle();
  assert.equal(run.signal.aborted, true, "a stream left open after the unmount holds a slot at the arm");
  assert.equal(sharedStreamCount(), 0);
});

test("two readers of one key share one stream", async () => {
  runs.length = 0;
  const mounted = await renderInDom(
    <>
      <Reader streamKey="s2" testId="a" />
      <Reader streamKey="s2" testId="b" />
    </>
  );
  await settle();
  assert.equal(runs.length, 1);
  await mountedAct(() => runs[0]!.sink.line("shared"));
  assert.equal(mounted.container.querySelector('[data-testid="a"]')?.textContent, "shared");
  assert.equal(mounted.container.querySelector('[data-testid="b"]')?.textContent, "shared");
  await mounted.unmount();
  await settle();
  assert.equal(runs[0]!.signal.aborted, true);
});

test("a new key aborts the old stream and opens the new one", async () => {
  runs.length = 0;
  let setKey: (key: string) => void = () => {};
  function Switcher() {
    const [key, set] = React.useState("s3");
    setKey = set;
    return <Reader streamKey={key} />;
  }
  const mounted = await renderInDom(<Switcher />);
  await settle();
  await mountedAct(() => setKey("s4"));
  await settle();
  assert.deepEqual(
    runs.map((run) => [run.key, run.signal.aborted]),
    [
      ["s3", true],
      ["s4", false]
    ]
  );
  await mounted.unmount();
  await settle();
});

async function mountedAct(run: () => void): Promise<void> {
  const { act } = await import("react");
  await act(async () => {
    run();
  });
}
