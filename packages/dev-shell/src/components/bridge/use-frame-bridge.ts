import { useCallback, useEffect, useRef, useState } from "react";
import { bridgeToParentSchema, type DomDescriptor, type FrameInfo } from "@hustradio/dev-shell-contract";
import { api } from "../../api/client";

export interface SelectedElement {descriptor: DomDescriptor; clientPoint: {x: number; y: number}}

export function useFrameBridge(frame: FrameInfo | null, onSelected: (selection: SelectedElement) => void) {
  const iframe = useRef<HTMLIFrameElement>(null);
  const [bridgeReady, setBridgeReady] = useState(false);
  const [armed, setArmed] = useState(false);
  const [title, setTitle] = useState("");
  const [viewport, setViewport] = useState<{width: number; height: number} | null>(null);
  const selectedCallback = useRef(onSelected);
  selectedCallback.current = onSelected;

  useEffect(() => {
    setBridgeReady(false); setArmed(false); setTitle(frame?.title ?? ""); setViewport(null);
    if (!frame) return;
    const expectedOrigin = new URL(frame.proxyOrigin).origin;
    const listener = (event: MessageEvent) => {
      if (event.origin !== expectedOrigin || event.source !== iframe.current?.contentWindow) return;
      const parsed = bridgeToParentSchema.safeParse(event.data);
      if (!parsed.success || parsed.data.frameId !== frame.frameId) return;
      const message = parsed.data;
      if (message.type === "bridge.ready" || message.type === "bridge.frame.info" || message.type === "bridge.error") {
        void api.frameBridge(frame.frameId, message).catch(() => undefined);
      }
      if (message.type === "bridge.ready") {setBridgeReady(true); setTitle(message.title);}
      if (message.type === "bridge.frame.info") {setBridgeReady(true); setTitle(message.title); setViewport(message.viewport);}
      if (message.type === "picker.armed") setArmed(message.armed);
      if (message.type === "picker.selected") {
        const bounds = iframe.current?.getBoundingClientRect();
        setArmed(false); selectedCallback.current({descriptor: message.descriptor,
          clientPoint: {x: message.clientPoint.x + (bounds?.left ?? 0), y: message.clientPoint.y + (bounds?.top ?? 0)}});
      }
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [frame]);

  const send = useCallback((type: "picker.arm" | "picker.disarm" | "frame.ping", mode?: "keyboard" | "explicit" | "long-press") => {
    if (!frame || !iframe.current?.contentWindow) return;
    iframe.current.contentWindow.postMessage({type, protocolVersion: 1, frameId: frame.frameId, ...(mode ? {mode} : {})}, new URL(frame.proxyOrigin).origin);
  }, [frame]);
  const togglePicker = useCallback(() => {
    if (armed) {send("picker.disarm"); setArmed(false);} else send("picker.arm", "explicit");
  }, [armed, send]);
  return {iframe, bridgeReady, armed, title, viewport, togglePicker};
}
