import { describe, expect, it } from "vitest";
import { clampDockPosition, hasPassedDragThreshold, normalizeDockPosition, snapDockToEdge } from "../../src/hooks/gesture";

describe("floating dock gestures", () => {
  it("distinguishes a tap from a drag at five pixels", () => {
    expect(hasPassedDragThreshold({x: 10, y: 10}, {x: 13, y: 13})).toBe(false);
    expect(hasPassedDragThreshold({x: 10, y: 10}, {x: 13, y: 14})).toBe(true);
  });
  it("clamps to the visual viewport and snaps to the closest edge", () => {
    expect(clampDockPosition({x: -50, y: 1000}, {x: 390, y: 844})).toEqual({x: 12, y: 788});
    expect(snapDockToEdge({x: 40, y: 300}, {x: 390, y: 844}).x).toBe(12);
    expect(snapDockToEdge({x: 300, y: 300}, {x: 390, y: 844}).x).toBe(334);
  });
  it("stores a normalized position", () => {
    expect(normalizeDockPosition({x: 195, y: 422}, {x: 390, y: 844})).toEqual({x: .5, y: .5});
  });
  it("keeps the dock inside a shifted keyboard viewport and device safe areas", () => {
    const viewport = {x: 390, y: 360, offsetX: 20, offsetY: 120, safeTop: 30, safeRight: 8, safeBottom: 34, safeLeft: 6};
    expect(clampDockPosition({x: -50, y: 1000}, viewport)).toEqual({x: 38, y: 390});
    expect(snapDockToEdge({x: 300, y: 0}, viewport)).toEqual({x: 346, y: 162});
    expect(normalizeDockPosition({x: 215, y: 300}, viewport)).toEqual({x: .5, y: .5});
  });
});
