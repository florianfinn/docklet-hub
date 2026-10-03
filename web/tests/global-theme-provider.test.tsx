import test from "node:test";
import assert from "node:assert/strict";

import { renderInDom } from "./dom-harness.js";

import React, { useLayoutEffect } from "react";
import { DEFAULT_GLOBAL_THEME, THEME_KNOBS, type GlobalThemePreset } from "contract";
import { GlobalThemeProvider } from "../src/features/appearance/index.js";

// The global theme is on `<html>` before the first paint (#268, edge case of
// the step: "no flash").
//
// ⚠️ HOW THIS IS MEASURED, AND WHY NOT BY LOOKING AFTER THE RENDER. `renderInDom`
// returns after `act(…)` has flushed every effect, so a check made afterwards
// cannot tell a layout effect from a passive one — and only the first runs
// before the browser paints. A probe that stands AFTER the provider in the
// tree reads `<html>` in its own layout effect: all layout effects of one
// commit run before any passive effect, and siblings run in tree order. If the
// provider applied the attributes in a passive effect, the probe would see none.

function attributesOnRoot(): Record<string, string | null> {
  const root = document.documentElement;
  const seen: Record<string, string | null> = {};
  for (const name of Object.keys(DEFAULT_GLOBAL_THEME) as (keyof GlobalThemePreset)[]) {
    seen[name] = root.getAttribute(THEME_KNOBS[name].attribute);
  }
  return seen;
}

function clearRoot(): void {
  for (const name of Object.keys(DEFAULT_GLOBAL_THEME) as (keyof GlobalThemePreset)[]) {
    document.documentElement.removeAttribute(THEME_KNOBS[name].attribute);
  }
}

test("every knob of the default theme is on <html> in the layout phase of the first commit", async () => {
  clearRoot();
  let seenInLayout: Record<string, string | null> | null = null;

  function Probe() {
    useLayoutEffect(() => {
      seenInLayout = attributesOnRoot();
    }, []);
    return null;
  }

  const mounted = await renderInDom(
    <>
      <GlobalThemeProvider>{null}</GlobalThemeProvider>
      <Probe />
    </>
  );
  try {
    assert.ok(seenInLayout !== null, "the probe never ran");
    assert.deepEqual(seenInLayout, { ...DEFAULT_GLOBAL_THEME });
  } finally {
    await mounted.unmount();
    clearRoot();
  }
});

test("the counter-check: the probe sees nothing where nobody applied a theme", async () => {
  // A probe that cannot see an absence would make the first case green for
  // the wrong reason.
  clearRoot();
  let seenInLayout: Record<string, string | null> | null = null;

  function Probe() {
    useLayoutEffect(() => {
      seenInLayout = attributesOnRoot();
    }, []);
    return null;
  }

  const mounted = await renderInDom(<Probe />);
  try {
    assert.ok(seenInLayout !== null, "the probe never ran");
    assert.ok(Object.values(seenInLayout).every((value) => value === null));
  } finally {
    await mounted.unmount();
  }
});
