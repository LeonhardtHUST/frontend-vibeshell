import { useEffect, useRef, useState } from "react";
import { PanelLeft } from "lucide-react";
import { clampDockPosition, hasPassedDragThreshold, normalizeDockPosition, snapDockToEdge, type DockViewport, type Point } from "../../hooks/gesture";

const STORAGE_KEY = "dev-shell:dock-position:v1";

function viewportSize(probe: HTMLElement | null = null): DockViewport {
  const viewport = window.visualViewport;
  const style = probe ? getComputedStyle(probe) : null;
  const inset = (value: string | undefined) => Number.parseFloat(value ?? "0") || 0;
  return {x: viewport?.width ?? window.innerWidth, y: viewport?.height ?? window.innerHeight,
    offsetX: viewport?.offsetLeft ?? 0, offsetY: viewport?.offsetTop ?? 0,
    safeTop: inset(style?.paddingTop), safeRight: inset(style?.paddingRight), safeBottom: inset(style?.paddingBottom), safeLeft: inset(style?.paddingLeft)};
}

export function FloatingDock({open, onToggle}: {open: boolean; onToggle: () => void}) {
  const safeArea = useRef<HTMLSpanElement>(null);
  const [position, setPosition] = useState<Point>(() => {
    try {const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Point | null; if (value && Number.isFinite(value.x) && Number.isFinite(value.y)) {const viewport = viewportSize(); return clampDockPosition({x: (viewport.offsetX ?? 0) + value.x * viewport.x, y: (viewport.offsetY ?? 0) + value.y * viewport.y}, viewport);}} catch { /* Use default. */ }
    return {x: window.innerWidth - 60, y: window.innerHeight * 0.64};
  });
  const gesture = useRef<{id: number; start: Point; origin: Point; dragging: boolean} | null>(null);
  useEffect(() => {
    const clamp = () => setPosition((current) => clampDockPosition(current, viewportSize(safeArea.current)));
    clamp();
    window.addEventListener("resize", clamp); window.visualViewport?.addEventListener("resize", clamp);
    window.visualViewport?.addEventListener("scroll", clamp);
    return () => {window.removeEventListener("resize", clamp); window.visualViewport?.removeEventListener("resize", clamp); window.visualViewport?.removeEventListener("scroll", clamp);};
  }, []);
  return <button
    type="button" className="floating-dock" style={{left: position.x, top: position.y}} aria-label={open ? "关闭控制面板" : "打开控制面板"} aria-expanded={open} aria-controls="mobile-control-sheet"
    onClick={(event) => {if (event.detail === 0) onToggle();}}
    onPointerDown={(event) => {if (event.button !== 0) return; event.currentTarget.setPointerCapture(event.pointerId); gesture.current = {id: event.pointerId, start: {x: event.clientX, y: event.clientY}, origin: position, dragging: false};}}
    onPointerMove={(event) => {const current = gesture.current; if (!current || current.id !== event.pointerId) return; const point = {x: event.clientX, y: event.clientY}; if (!current.dragging && !hasPassedDragThreshold(current.start, point)) return; current.dragging = true; setPosition(clampDockPosition({x: current.origin.x + point.x - current.start.x, y: current.origin.y + point.y - current.start.y}, viewportSize(safeArea.current)));}}
    onPointerUp={(event) => {const current = gesture.current; if (!current) return; if (current.dragging) {setPosition((point) => {const viewport = viewportSize(safeArea.current); const snapped = snapDockToEdge(point, viewport); try {localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeDockPosition(snapped, viewport)));} catch { /* Ignore storage failures. */ } return snapped;});} else onToggle(); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); gesture.current = null;}}
    onPointerCancel={() => {gesture.current = null;}}
  ><PanelLeft size={20} /><span className="dock-safe-area" ref={safeArea} aria-hidden="true" /><span className="sr-only">协作控制</span></button>;
}
