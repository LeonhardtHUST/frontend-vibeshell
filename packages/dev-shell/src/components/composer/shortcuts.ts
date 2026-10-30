import type { KeyboardEvent } from "react";

export type ComposerAction = "send" | "queue" | "newline" | null;

export function resolveComposerShortcut(event: Pick<KeyboardEvent, "key" | "shiftKey" | "ctrlKey" | "metaKey" | "nativeEvent">): ComposerAction {
  const native = event.nativeEvent as KeyboardEvent["nativeEvent"] & {isComposing?: boolean; keyCode?: number};
  if (native.isComposing || native.keyCode === 229 || event.key !== "Enter") return null;
  if (event.shiftKey) return "newline";
  if (event.ctrlKey || event.metaKey) return "queue";
  return "send";
}

export function newClientMessageId(): string {
  return typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
