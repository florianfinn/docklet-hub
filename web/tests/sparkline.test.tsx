// The DOM must be registered before React and Recharts load.
import { renderInDom, settle } from "./dom-harness.js";
import React from "react";
import assert from "node:assert/strict";
import test from "node:test";
import { isolatedPointIndices } from "../src/platform/ui/metrics/isolated-points.js";
import { Sparkline } from "../src/platform/ui/metrics/Sparkline.js";

for (const [values, expected] of [
  [[35, null, 40, null, 50], 3],
  [[1, 2, 3], 0]
] as const) {
  test(`Sparkline renders ${expected} isolated points for ${JSON.stringify(values)}`, async (t) => {
    // happy-dom has no layout; supply the chart viewport to ResponsiveContainer.
    t.mock.method(HTMLElement.prototype, "getBoundingClientRect", () => new DOMRect(0, 0, 320, 48));
    const mounted = await renderInDom(
      <Sparkline
        points={values.map((value, index) => ({ sampledAt: String(index), value }))}
        label="CPU"
        color="var(--chart-1)"
        format={String}
      />
    );
    try {
      await settle();
      assert.equal(mounted.container.querySelectorAll("svg").length > 0, true);
      const dots = [...mounted.container.querySelectorAll(".recharts-line-dots circle")];
      assert.equal(dots.length, expected);
      assert.equal(dots.every((dot) => dot.getAttribute("fill") === "var(--color-value)"), true);
      assert.equal(dots.every((dot) => Number(dot.getAttribute("r")) === 2), true);
      if (expected === 0) {
        assert.equal(mounted.container.querySelectorAll(".recharts-line-curve").length, 1);
      } else {
        const curves = [...mounted.container.querySelectorAll(".recharts-line-curve")];
        assert.equal(curves.every((curve) => !/[LC]/.test(curve.getAttribute("d") ?? "")), true);
      }
    } finally {
      await mounted.unmount();
    }
  });
}

for (const [values, expected] of [
  [[1, null, 2], [0, 2]],
  [[null, 3, null], [1]],
  [[4], [0]],
  [[5, 6, null, 7], [3]],
  [[null, null], []],
  [[8, null], [0]],
  [[null, 9], [1]],
  [[0, null], [0]],
  [[null], []],
  [[], []],
  [[null, 1, 2, null], []]
] as const) {
  test(`isolatedPointIndices selects ${JSON.stringify(expected)} for ${JSON.stringify(values)}`, () => {
    assert.deepEqual([...isolatedPointIndices(values)], expected);
  });
}
