import { useEffect, useRef, useState } from "react";
import { BottomSheet, Button } from "@hustradio/unitary-ui";
import { X } from "lucide-react";
import type { DomDescriptor } from "@hustradio/dev-shell-contract";
import { api } from "../../api/client";
import { useWorkbench } from "../../api/workbench-store";
import { formatPrompt } from "../composer/format";
import { newClientMessageId } from "../composer/shortcuts";
import type { PromptComposerHandle } from "../composer/PromptComposer";
import type { SelectedElement } from "../bridge/use-frame-bridge";
import { useMedia } from "../../hooks/use-media";
import { ControlRail } from "./ControlRail";
import { FramePanel } from "./FramePanel";
import { FloatingDock } from "./FloatingDock";
import { SettingsDialog } from "./SettingsDialog";

export function WorkspaceShell() {
  const {snapshot, refresh} = useWorkbench();
  const desktop = useMedia("(min-width: 1024px)");
  const [tab, setTab] = useState("queue");
  const [sheetOpen, setSheetOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selected, setSelected] = useState<SelectedElement | null>(null);
  const [controlsHost, setControlsHost] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(() => Number(localStorage.getItem("dev-shell:rail-width")) || 380);
  const composer = useRef<PromptComposerHandle>(null);
  const selection: DomDescriptor | null = selected?.descriptor ?? null;

  useEffect(() => {if (selected) {if (!desktop) setSheetOpen(true); requestAnimationFrame(() => composer.current?.focus());}}, [selected, desktop]);
  const send = async (body: string) => {await api.createSession(formatPrompt(body, selection), newClientMessageId()); await refresh();};
  const queue = async (body: string) => {await api.enqueue(body, selection, newClientMessageId()); await refresh();};
  const rail = <ControlRail tab={tab} setTab={setTab} selection={selection} onRemoveSelection={() => setSelected(null)} onSend={send} onQueue={queue} onOpenSettings={() => setSettingsOpen(true)} composerRef={composer} />;
  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const element = event.currentTarget;
    const start = event.clientX; const original = width;
    const move = (next: PointerEvent) => {const value = Math.max(320, Math.min(520, original + next.clientX - start)); setWidth(value);};
    const up = () => {element.removeEventListener("pointermove", move); element.removeEventListener("pointerup", up); element.removeEventListener("pointercancel", up); setWidth((value) => {localStorage.setItem("dev-shell:rail-width", String(value)); return value;});};
    element.addEventListener("pointermove", move); element.addEventListener("pointerup", up); element.addEventListener("pointercancel", up);
  };
  return <div className="workspace" data-desktop={desktop}>
    {desktop && <div className="workspace__rail" style={{width}}>{rail}</div>}
    {desktop && <div className="rail-resizer" role="separator" aria-label="调整控制栏宽度" aria-orientation="vertical" onPointerDown={startResize} />}
    <FramePanel onSelected={setSelected} onOpenSettings={() => setSettingsOpen(true)} selection={selection} immersive={!desktop} controlsHost={controlsHost} />
    {!desktop && <FloatingDock open={sheetOpen} onToggle={() => setSheetOpen((value) => !value)} />}
    {!desktop && <BottomSheet open={sheetOpen} onOpenChange={setSheetOpen} detents={[0.92]} showIndicator={false} aria-label="协作控制面板"><div id="mobile-control-sheet" className="mobile-control-sheet"><div ref={setControlsHost} />{rail}</div></BottomSheet>}
    <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    {selected && desktop && <div className="anchored-selection" style={{left: Math.max(8, Math.min(selected.clientPoint.x + 20, window.innerWidth - 348)), top: Math.max(8, Math.min(selected.clientPoint.y + 20, window.innerHeight - 100))}}><div><strong>{selected.descriptor.tagName.toLowerCase()}</strong><code>{selected.descriptor.cssPath}</code></div><Button svgOnly size="small" type="tertiary" typeName="button" aria-label="清除选中元素" onClick={() => setSelected(null)}><X /></Button><div className="anchored-selection__actions"><Button size="small" typeName="button" onClick={() => {setTab("queue"); composer.current?.focus();}}>在编辑器中使用</Button></div></div>}
    <span className="sr-only">当前默认工作目录：{snapshot.settings.workspace}</span>
  </div>;
}
