export interface Point { x: number; y: number }
export interface DockViewport extends Point {
  offsetX?: number; offsetY?: number;
  safeTop?: number; safeRight?: number; safeBottom?: number; safeLeft?: number;
}

export function clampDockPosition(point: Point, viewport: DockViewport, size = 44, margin = 12): Point {
  const left = (viewport.offsetX ?? 0) + margin + (viewport.safeLeft ?? 0);
  const top = (viewport.offsetY ?? 0) + margin + (viewport.safeTop ?? 0);
  return {
    x: Math.max(left, Math.min((viewport.offsetX ?? 0) + viewport.x - size - margin - (viewport.safeRight ?? 0), point.x)),
    y: Math.max(top, Math.min((viewport.offsetY ?? 0) + viewport.y - size - margin - (viewport.safeBottom ?? 0), point.y)),
  };
}

export function snapDockToEdge(point: Point, viewport: DockViewport, size = 44, margin = 12): Point {
  const clamped = clampDockPosition(point, viewport, size, margin);
  const offset = viewport.offsetX ?? 0;
  return clampDockPosition({...clamped, x: point.x + size / 2 < offset + viewport.x / 2 ? offset : offset + viewport.x}, viewport, size, margin);
}

export function normalizeDockPosition(point: Point, viewport: DockViewport): Point {
  return {x: viewport.x ? (point.x - (viewport.offsetX ?? 0)) / viewport.x : 0.85, y: viewport.y ? (point.y - (viewport.offsetY ?? 0)) / viewport.y : 0.65};
}

export function hasPassedDragThreshold(start: Point, current: Point, threshold = 5): boolean {
  return Math.hypot(current.x - start.x, current.y - start.y) >= threshold;
}
